import * as fs from 'node:fs';
import * as path from 'node:path';
import type {DevPulseConfig, Issue, Task, Action} from './types.js';
import {LABELS} from './types.js';
import type {IssueProvider} from './providers/issue-provider.js';
import type {AgentHarness} from './harnesses/agent-harness.js';
import {TaskManager} from './task-manager.js';
import {GitManager} from './git.js';
import {buildInvestigatePrompt, buildImplementPrompt, buildClarificationComment, buildEscalationComment} from './prompts.js';
import {isAutoWorkEnabled} from './auto-work.js';
import {performReview} from './review.js';
import type {ReviewResult} from './review.js';

/**
 * Check whether the agent signaled ambiguity during investigation.
 *
 * Looks for `.whitesmith-ambiguity.md` in the given working directory.
 * If found, reads its contents, deletes the file, and returns the trimmed content.
 * If not found, returns null.
 */
export function checkForAmbiguity(workDir: string): string | null {
	const ambiguityPath = path.join(workDir, '.whitesmith-ambiguity.md');
	if (!fs.existsSync(ambiguityPath)) {
		return null;
	}
	const content = fs.readFileSync(ambiguityPath, 'utf-8').trim();
	try {
		fs.unlinkSync(ambiguityPath);
	} catch {
		// ignore
	}
	return content;
}

/**
 * Main orchestrator for whitesmith.
 *
 * The loop:
 * 1. Reconcile — check if any issues with tasks-accepted have all tasks done
 * 2. Investigate — pick an unlabeled issue, generate tasks
 * 3. Implement — pick an available task, implement it on the issue/<number> branch
 *
 * Implementation uses a single branch per issue (`issue/<number>`). Each task
 * adds one commit to the branch. When the last task completes, a PR is created
 * immediately. `reconcile()` is a safety net for crash recovery.
 */
export class Orchestrator {
	private config: DevPulseConfig;
	private issues: IssueProvider;
	private agent: AgentHarness;
	private tasks: TaskManager;
	private git: GitManager;

	constructor(config: DevPulseConfig, issues: IssueProvider, agent: AgentHarness) {
		this.config = config;
		this.issues = issues;
		this.agent = agent;
		this.tasks = new TaskManager(config.workDir);
		this.git = new GitManager(config.workDir);
	}

	/**
	 * Run the main loop
	 */
	async run(): Promise<void> {
		console.log('=== whitesmith ===');
		console.log(`Working directory: ${this.config.workDir}`);
		console.log(`Max iterations: ${this.config.maxIterations}`);
		console.log(`Agent command: ${this.config.agentCmd}`);
		console.log(`Provider: ${this.config.provider}`);
		console.log(`Model: ${this.config.model}`);
		if (this.config.issueNumber !== undefined) {
			console.log(`Target issue: #${this.config.issueNumber}`);
		}
		console.log('');

		// Skip agent validation and label creation in dry-run mode
		if (!this.config.dryRun) {
			// Validate agent is available before doing anything
			await this.agent.validate();
			console.log('Agent validated successfully.');
			console.log('');

			// Ensure labels exist
			await this.issues.ensureLabels(Object.values(LABELS));
		}

		// Delegate to single-issue mode if --issue is set
		if (this.config.issueNumber !== undefined) {
			await this.runForIssue(this.config.issueNumber);
			return;
		}

		for (let i = 1; i <= this.config.maxIterations; i++) {
			console.log('');
			console.log(`=== Iteration ${i}/${this.config.maxIterations} ===`);

			// Make sure we're on main with latest
			await this.git.fetch();
			await this.git.checkoutMain();

			// Decide what to do
			const action = await this.decideAction();
			console.log(`Action: ${action.type}`);

			if (this.config.dryRun) {
				switch (action.type) {
					case 'reconcile':
						console.log(`Would reconcile issue #${action.issue.number}: ${action.issue.title}`);
						break;
					case 'auto-approve':
						console.log(
							`Would auto-approve task PR for issue #${action.issue.number}: ${action.issue.title}`,
						);
						break;
					case 'investigate':
						console.log(`Would investigate issue #${action.issue.number}: ${action.issue.title}`);
						break;
					case 'implement':
						console.log(
							`Would implement task ${action.task.id}: ${action.task.title} (issue #${action.issue.number})`,
						);
						break;
					case 'idle':
						console.log('Nothing to do. All issues are either in-progress or completed.');
						break;
				}
				return;
			}

			switch (action.type) {
				case 'reconcile':
					await this.reconcile(action.issue);
					break;
				case 'auto-approve':
					await this.autoApprove(action.issue);
					break;
				case 'investigate':
					await this.investigate(action.issue);
					break;
				case 'implement':
					await this.implement(action.task, action.issue);
					break;
				case 'idle':
					console.log('Nothing to do. All issues are either in-progress or completed.');
					return;
			}

			if (!this.config.noSleep && i < this.config.maxIterations) {
				console.log('Sleeping 5s...');
				await new Promise((r) => setTimeout(r, 5000));
			}
		}

		console.log('');
		console.log('=== Iteration limit reached ===');
	}

	/**
	 * Run the full pipeline for a single issue.
	 *
	 * Re-fetches the issue after each action to get updated labels, then decides
	 * the next action based on the current state. Loops until idle or the
	 * iteration limit is reached.
	 */
	private async runForIssue(issueNumber: number): Promise<void> {
		console.log(`Running single-issue mode for issue #${issueNumber}`);

		for (let i = 1; i <= this.config.maxIterations; i++) {
			console.log('');
			console.log(`=== Iteration ${i}/${this.config.maxIterations} ===`);

			// Make sure we're on main with latest
			await this.git.fetch();
			await this.git.checkoutMain();

			// Re-fetch the issue to get current labels
			const issue = await this.issues.getIssue(issueNumber);

			// Determine the action based on the issue's current state
			const action = await this.decideActionForIssue(issue);
			console.log(`Action: ${action.type}`);

			if (this.config.dryRun) {
				switch (action.type) {
					case 'reconcile':
						console.log(`Would reconcile issue #${action.issue.number}: ${action.issue.title}`);
						break;
					case 'auto-approve':
						console.log(
							`Would auto-approve task PR for issue #${action.issue.number}: ${action.issue.title}`,
						);
						break;
					case 'investigate':
						console.log(`Would investigate issue #${action.issue.number}: ${action.issue.title}`);
						break;
					case 'implement':
						console.log(
							`Would implement task ${action.task.id}: ${action.task.title} (issue #${action.issue.number})`,
						);
						break;
					case 'idle':
						console.log('Nothing to do. Issue is either completed or no actions are applicable.');
						break;
				}
				return;
			}

			switch (action.type) {
				case 'reconcile':
					await this.reconcile(action.issue);
					break;
				case 'auto-approve':
					await this.autoApprove(action.issue);
					break;
				case 'investigate':
					await this.investigate(action.issue);
					break;
				case 'implement':
					await this.implement(action.task, action.issue);
					break;
				case 'idle':
					console.log('Nothing to do. Issue is either completed or no actions are applicable.');
					return;
			}

			if (!this.config.noSleep && i < this.config.maxIterations) {
				console.log('Sleeping 5s...');
				await new Promise((r) => setTimeout(r, 5000));
			}
		}

		console.log('');
		console.log('=== Iteration limit reached ===');
	}

	/**
	 * Decide the next action for a single issue based on its current labels.
	 */
	private async decideActionForIssue(issue: Issue): Promise<Action> {
		const labels = issue.labels;

		// Handle stale investigating label (crashed previous run)
		if (labels.includes(LABELS.INVESTIGATING)) {
			console.log(`Issue #${issue.number} has stale '${LABELS.INVESTIGATING}' label, clearing it`);
			await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
			// Treat as uninvestigated — re-investigate
			return {type: 'investigate', issue};
		}

		// needs-human-review: stop auto-investigating, wait for human
		if (labels.includes(LABELS.NEEDS_HUMAN_REVIEW)) {
			return {type: 'idle'};
		}

		// needs-clarification: re-investigate with updated issue body
		if (labels.includes(LABELS.NEEDS_CLARIFICATION)) {
			return {type: 'investigate', issue};
		}

		// tasks-accepted: check if all tasks are done (reconcile) or implement next task
		if (labels.includes(LABELS.TASKS_ACCEPTED)) {
			const allDone = await this.allTasksCompletedOnBranch(issue.number);
			if (allDone) {
				return {type: 'reconcile', issue};
			}

			// Find an available task to implement
			const implementAction = await this.findAvailableTask([issue]);
			if (implementAction) {
				return implementAction;
			}

			return {type: 'idle'};
		}

		// tasks-proposed: check if PR was already merged (tasks on main) → transition inline
		if (labels.includes(LABELS.TASKS_PROPOSED)) {
			if (this.tasks.hasRemainingTasks(issue.number)) {
				// Tasks exist on main = investigate PR was merged
				console.log(`Issue #${issue.number}: tasks PR merged, transitioning to tasks-accepted`);
				await this.issues.removeLabel(issue.number, LABELS.TASKS_PROPOSED);
				await this.issues.addLabel(issue.number, LABELS.TASKS_ACCEPTED);
				// Find an available task to implement
				const implementAction = await this.findAvailableTask([issue]);
				if (implementAction) {
					return implementAction;
				}
				return {type: 'idle'};
			}

			// PR not yet merged — auto-approve if auto-work is enabled
			if (isAutoWorkEnabled(this.config, issue)) {
				return {type: 'auto-approve', issue};
			}

			return {type: 'idle'};
		}

		// completed: nothing to do
		if (labels.includes(LABELS.COMPLETED)) {
			return {type: 'idle'};
		}

		// No whitesmith labels — investigate
		return {type: 'investigate', issue};
	}

	/**
	 * Check whether all tasks for an issue have been completed on the issue branch.
	 * Works without checking out the branch by inspecting the remote via git ls-tree.
	 */
	private async allTasksCompletedOnBranch(issueNumber: number): Promise<boolean> {
		const branch = `issue/${issueNumber}`;
		const branchExists = await this.issues.remoteBranchExists(branch);
		if (!branchExists) return false;

		// Check if any task files remain on the issue branch
		const hasFiles = await this.git.remotePathHasFiles(`origin/${branch}`, `tasks/${issueNumber}/`);
		return !hasFiles;
	}

	/**
	 * Decide the next action to take
	 */
	private async decideAction(): Promise<Action> {
		// Priority 1: Reconcile — issues with tasks-accepted where all tasks are done
		// but no PR exists yet (safety net for crash recovery).
		const acceptedIssues = await this.issues.listIssues({labels: [LABELS.TASKS_ACCEPTED]});
		for (const issue of acceptedIssues) {
			const allDone = await this.allTasksCompletedOnBranch(issue.number);
			if (allDone) {
				// Only reconcile if no PR exists yet — if a PR is already open,
				// the issue is waiting for merge and there's nothing more to do.
				const branch = `issue/${issue.number}`;
				const existingPR = await this.issues.getPRForBranch(branch);
				if (!existingPR || existingPR.state === 'closed') {
					return {type: 'reconcile', issue};
				}
				// PR exists and is open or merged — skip
			}
		}

		// Priority 2: Auto-approve — merge task PRs for issues with auto-work enabled
		const proposedIssues = await this.issues.listIssues({labels: [LABELS.TASKS_PROPOSED]});
		for (const issue of proposedIssues) {
			if (isAutoWorkEnabled(this.config, issue)) {
				return {type: 'auto-approve' as const, issue};
			}
		}

		// Priority 3: Implement — find an available task
		const implementAction = await this.findAvailableTask(acceptedIssues);
		if (implementAction) {
			return implementAction;
		}

		// Priority 4: Investigate — find a new issue (no whitesmith labels)
		const allDevPulseLabels = Object.values(LABELS);
		const newIssues = await this.issues.listIssues({noLabels: allDevPulseLabels});
		if (newIssues.length > 0) {
			// Pick the oldest issue
			const issue = newIssues[newIssues.length - 1];
			return {type: 'investigate', issue};
		}

		return {type: 'idle'};
	}

	/**
	 * Find an available task to implement.
	 *
	 * Uses task files on `main` as the canonical list of pending tasks.
	 * If an issue branch exists, checks which task files have been deleted
	 * on it (= completed) and skips those.
	 */
	private async findAvailableTask(
		acceptedIssues: Issue[],
	): Promise<{type: 'implement'; task: Task; issue: Issue} | null> {
		for (const issue of acceptedIssues) {
			const issueTasks = this.tasks.listTasks(issue.number);
			if (issueTasks.length === 0) continue;

			// Determine which tasks are already completed on the issue branch
			const branch = `issue/${issue.number}`;
			const branchExists = await this.issues.remoteBranchExists(branch);
			const completedTaskFiles = new Set<string>();

			if (branchExists) {
				// Check each task file's existence on the remote issue branch
				for (const task of issueTasks) {
					const existsOnBranch = await this.git.remoteFileExists(`origin/${branch}`, task.filePath);
					if (!existsOnBranch) {
						// Task file deleted on issue branch = completed
						completedTaskFiles.add(task.filePath);
					}
				}
			}

			for (const task of issueTasks) {
				// Skip completed tasks
				if (completedTaskFiles.has(task.filePath)) continue;

				// Check dependencies are satisfied
				// A dependency is satisfied if its task file is gone from main OR completed on the issue branch
				const depsOk = task.dependsOn.every((depId) => {
					const depTask = issueTasks.find((t) => t.id === depId);
					if (!depTask) return true; // dep not in pending list on main = already merged
					return completedTaskFiles.has(depTask.filePath);
				});
				if (!depsOk) continue;

				return {type: 'implement', task, issue};
			}
		}

		return null;
	}

	/**
	 * Phase 1: Reconcile — safety net for crash recovery.
	 * Creates PR if all tasks are done on the issue branch but no PR exists
	 * (e.g. agent crashed after last task push but before PR creation).
	 *
	 * Does NOT close the issue — that happens when the PR is merged and the
	 * CLI `reconcile` command detects that task files are gone from main.
	 */
	private async reconcile(issue: Issue): Promise<void> {
		console.log(`Reconciling issue #${issue.number}: ${issue.title}`);
		console.log('All tasks completed on branch. Ensuring PR exists.');

		// Safety net: ensure a PR exists for the issue branch
		const branch = `issue/${issue.number}`;
		const branchExists = await this.issues.remoteBranchExists(branch);
		if (branchExists && !this.config.noPush) {
			const existingPR = await this.issues.getPRForBranch(branch);
			if (!existingPR) {
				console.log(`Safety net: creating PR for ${branch} (missed during implement)`);
				const issueTasks = this.tasks.listTasks(issue.number);
				const taskSummary =
					issueTasks.length > 0
						? issueTasks.map((t) => `- ✅ **${t.id}**: ${t.title}`).join('\n')
						: '- All tasks completed';
				const prUrl = await this.issues.createPR({
					head: branch,
					base: 'main',
					title: `feat(#${issue.number}): ${issue.title}`,
					body: `## Implementation for #${issue.number}\n\n${taskSummary}\n\n---\n*Implemented by whitesmith*\n\nCloses #${issue.number}`,
				});
				console.log(`Safety net PR created: ${prUrl}`);
			} else {
				console.log(`PR already exists: ${existingPR.url}`);
			}
		}

		console.log(`Issue #${issue.number} awaiting PR merge.`);
	}

	/**
	 * Phase 1.5: Auto-approve — merge the task-proposal PR when auto-work is enabled.
	 * When review is enabled, runs a review first and only merges if approved.
	 */
	private async autoApprove(issue: Issue): Promise<void> {
		console.log(`Auto-approving task PR for issue #${issue.number}: ${issue.title}`);

		const branch = `investigate/${issue.number}`;
		const pr = await this.issues.getPRForBranch(branch);

		if (!pr || pr.state !== 'open') {
			console.log(`No open PR found for branch '${branch}', skipping auto-approve`);
			return;
		}

		// Run review before merging (if review is enabled)
		if (this.config.review) {
			let reviewResult: ReviewResult | null = null;
			try {
				reviewResult = await this.reviewTaskProposal(issue.number);
			} catch (error) {
				console.error('Review failed:', error instanceof Error ? error.message : error);
			}

			if (reviewResult && reviewResult.verdict === 'request_changes') {
				console.log(`Review requested changes for task PR #${pr.number}. Skipping auto-merge.`);
				await this.issues.comment(
					issue.number,
					`🔍 Review of task PR #${pr.number} requested changes. Auto-merge skipped — please review manually.`,
				);
				// Remove tasks-proposed so auto-approve doesn't retry every iteration
				await this.issues.removeLabel(issue.number, LABELS.TASKS_PROPOSED);
				return;
			}
		}

		await this.issues.mergePR(pr.number);
		console.log(`Merged PR #${pr.number}: ${pr.url}`);

		await this.issues.removeLabel(issue.number, LABELS.TASKS_PROPOSED);
		await this.issues.addLabel(issue.number, LABELS.TASKS_ACCEPTED);
		await this.issues.comment(
			issue.number,
			`🤖 Task PR #${pr.number} has been auto-approved and merged. Tasks are now on \`main\`.`,
		);

		console.log(`Issue #${issue.number} transitioned to tasks-accepted.`);
	}

	/**
	 * Phase 2: Investigate — generate tasks for a new issue
	 */
	private async investigate(issue: Issue): Promise<void> {
		console.log(`Investigating issue #${issue.number}: ${issue.title}`);

		// Claim the issue
		await this.issues.addLabel(issue.number, LABELS.INVESTIGATING);

		// If re-investigating after clarification, remove the needs-clarification label
		if (issue.labels.includes(LABELS.NEEDS_CLARIFICATION)) {
			await this.issues.removeLabel(issue.number, LABELS.NEEDS_CLARIFICATION);
		}

		const branch = `investigate/${issue.number}`;
		const issueTasksDir = `tasks/${issue.number}`;

		try {
			// Check if a previous attempt already produced work on this branch
			const remoteBranchExists = await this.issues.remoteBranchExists(branch);
			let agentNeeded = true;

			await this.git.deleteLocalBranch(branch);

			if (remoteBranchExists) {
				// Checkout the existing remote branch to inspect it
				await this.git.checkout(branch, {create: true, startPoint: `origin/${branch}`});
				const existingTasks = this.tasks.listTasks(issue.number);
				if (existingTasks.length > 0) {
					// Previous attempt completed the work — skip the agent
					console.log(
						`Branch '${branch}' already exists with ${existingTasks.length} task(s), skipping agent`,
					);
					agentNeeded = false;
				} else {
					// Branch exists but no task files — start fresh
					console.log(`Branch '${branch}' exists but has no tasks, starting fresh`);
					await this.git.deleteLocalBranch(branch);
					await this.git.checkout(branch, {create: true, startPoint: 'origin/main'});
				}
			} else {
				await this.git.checkout(branch, {create: true, startPoint: 'origin/main'});
			}

			if (agentNeeded) {
				// Run agent to generate tasks
				const prompt = buildInvestigatePrompt(issue, issueTasksDir);
				const {exitCode} = await this.agent.run({
					prompt,
					workDir: this.config.workDir,
					logFile: this.config.logFile,
				});

				if (exitCode !== 0) {
					console.error(`Agent failed with exit code ${exitCode}`);
					await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
					await this.git.checkoutMain();
					return;
				}
			}

			// Check if the agent signaled ambiguity
			const clarificationText = checkForAmbiguity(this.config.workDir);
			if (clarificationText) {
				console.log(`Agent signaled ambiguity for issue #${issue.number}`);
				await this.git.checkoutMain();
				await this.git.deleteLocalBranch(branch);

				// Check if we've hit the ambiguity cycle limit before posting another clarification
				const maxCycles = this.config.maxAmbiguityCycles ?? 3;
				const comments = await this.issues.listComments(issue.number);
				const botUsernames = ['whitesmith[bot]', 'github-actions[bot]'];
				const clarificationCount = comments.filter(
					(c) => botUsernames.includes(c.author) && c.body.startsWith('🤔 I\'ve analyzed this issue'),
				).length;

				if (clarificationCount >= maxCycles - 1) {
					// Escalate: too many cycles, need human review
					console.log(`Ambiguity cycle limit reached (${clarificationCount + 1}/${maxCycles}) for issue #${issue.number}, escalating`);
					await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
					await this.issues.addLabel(issue.number, LABELS.NEEDS_CLARIFICATION);
					await this.issues.addLabel(issue.number, LABELS.NEEDS_HUMAN_REVIEW);
					await this.issues.comment(issue.number, buildEscalationComment());
					return;
				}

				await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
				await this.issues.addLabel(issue.number, LABELS.NEEDS_CLARIFICATION);
				await this.issues.comment(
					issue.number,
					buildClarificationComment(clarificationText),
				);
				return;
			}

			// Verify task files were created
			await this.git.verifyBranch(branch);
			const tasks = this.tasks.listTasks(issue.number);
			if (tasks.length === 0) {
				console.error('Agent did not create any task files');
				await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
				await this.git.checkoutMain();
				return;
			}

			// Ensure changes are committed
			await this.git.commitAll(`tasks(#${issue.number}): generate implementation tasks`);

			console.log(`Generated ${tasks.length} task(s) for issue #${issue.number}`);

			if (this.config.noPush) {
				console.log(`Branch '${branch}' ready (--no-push mode)`);
			} else {
				// Force push since the branch may exist from a previous failed attempt
				await this.git.forcePush(branch);

				// Check if a PR already exists for this branch
				const existingPR = await this.issues.getPRForBranch(branch);
				let prUrl: string;

				if (existingPR && existingPR.state === 'open') {
					prUrl = existingPR.url;
					console.log(`PR already exists: ${prUrl}`);
				} else {
					const taskList = tasks.map((t) => `- [ ] **${t.id}**: ${t.title}`).join('\n');
					prUrl = await this.issues.createPR({
						head: branch,
						base: 'main',
						title: `tasks(#${issue.number}): ${issue.title}`,
						body: `## Generated Tasks for #${issue.number}\n\n${taskList}\n\n---\n*Generated by whitesmith from issue #${issue.number}*`,
					});
				}

				await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
				await this.issues.addLabel(issue.number, LABELS.TASKS_PROPOSED);
				await this.issues.comment(
					issue.number,
					`📋 Tasks have been generated. Review the PR: ${prUrl}`,
				);

				console.log(`PR created: ${prUrl}`);

				// Queue review of the task proposal (skip if auto-work — auto-approve will review)
				if (this.config.review && !isAutoWorkEnabled(this.config, issue)) {
					await this.git.checkoutMain();
					try {
						await this.reviewTaskProposal(issue.number);
					} catch (error) {
						console.error('Review failed:', error instanceof Error ? error.message : error);
					}
					return; // Already on main after review
				}
			}
		} catch (error) {
			console.error('Investigation failed:', error instanceof Error ? error.message : error);
			await this.issues.removeLabel(issue.number, LABELS.INVESTIGATING);
		}

		// Return to main
		await this.git.checkoutMain();
	}

	/**
	 * Phase 3: Implement — implement a task on the issue/<number> branch.
	 * Each task adds one commit. When all tasks are done, a PR is created immediately.
	 */
	private async implement(task: Task, issue: Issue): Promise<void> {
		console.log(`Implementing task ${task.id}: ${task.title}`);
		console.log(`For issue #${issue.number}: ${issue.title}`);

		const branch = `issue/${issue.number}`;

		try {
			// Check if the issue branch already exists (previous tasks may have committed to it)
			const remoteBranchExists = await this.issues.remoteBranchExists(branch);
			let agentNeeded = true;

			await this.git.deleteLocalBranch(branch);

			if (remoteBranchExists) {
				// Continue from existing issue branch (accumulate commits)
				await this.git.checkout(branch, {create: true, startPoint: `origin/${branch}`});

				// Check if this specific task was already completed on the branch
				const taskFileExists = this.tasks.taskFileExists(task.filePath);
				if (!taskFileExists) {
					console.log(
						`Task file '${task.filePath}' already deleted on branch '${branch}', skipping agent`,
					);
					agentNeeded = false;
				}
			} else {
				await this.git.checkout(branch, {create: true, startPoint: 'origin/main'});
			}

			if (agentNeeded) {
				const prompt = buildImplementPrompt(task, issue);
				const {exitCode} = await this.agent.run({
					prompt,
					workDir: this.config.workDir,
					logFile: this.config.logFile,
				});

				if (exitCode !== 0) {
					console.error(`Agent failed with exit code ${exitCode}`);
					await this.git.checkoutMain();
					return;
				}

				// Verify the agent actually deleted the task file
				if (this.tasks.taskFileExists(task.filePath)) {
					console.error(
						`Agent exited successfully but did not delete task file '${task.filePath}'. Treating as incomplete.`,
					);
					await this.git.checkoutMain();
					return;
				}
			}

			// Verify we're still on the right branch
			await this.git.verifyBranch(branch);

			// Ensure changes are committed
			await this.git.commitAll(`feat(#${issue.number}): ${task.title}`);

			if (this.config.noPush) {
				console.log(`Branch '${branch}' ready (--no-push mode)`);
			} else {
				// Force push since the branch may exist from a previous failed attempt
				await this.git.forcePush(branch);

				// Check if all tasks for this issue are now complete
				// (task files deleted on the current working tree = issue branch)
				const remainingTasks = this.tasks.listTasks(issue.number);
				if (remainingTasks.length === 0) {
					// All tasks done — create PR immediately
					const existingPR = await this.issues.getPRForBranch(branch);
					let prUrl: string;

					if (existingPR && existingPR.state === 'open') {
						prUrl = existingPR.url;
						console.log(`PR already exists: ${prUrl}`);
					} else {
						prUrl = await this.issues.createPR({
							head: branch,
							base: 'main',
							title: `feat(#${issue.number}): ${issue.title}`,
							body: `## Implementation for #${issue.number}\n\nAll tasks completed.\n\n---\n*Implemented by whitesmith*\n\nCloses #${issue.number}`,
						});
					}

					console.log(`PR created: ${prUrl}`);
					// Queue review of the implementation PR
					if (this.config.review) {
						await this.git.checkoutMain();
						try {
							await this.reviewImplementationPR(issue.number);
						} catch (error) {
							console.error('Review failed:', error instanceof Error ? error.message : error);
						}
						return; // Already on main after review
					}
				} else {
					console.log(
						`Task ${task.id} committed. ${remainingTasks.length} task(s) remaining for issue #${issue.number}.`,
					);
				}
			}
		} catch (error) {
			console.error('Implementation failed:', error instanceof Error ? error.message : error);
		}

		// Return to main
		await this.git.checkoutMain();
	}

	/**
	 * Review a task proposal (investigate PR).
	 * Posts the review as a comment on the task proposal PR.
	 * Returns the review result so callers can check the verdict.
	 */
	private async reviewTaskProposal(issueNumber: number): Promise<ReviewResult> {
		console.log(`Reviewing task proposal for issue #${issueNumber}...`);
		return performReview(
			{type: 'issue-tasks', issueNumber},
			{
				workDir: this.config.workDir,
				repo: this.config.repo,
				logFile: this.config.logFile,
				post: !this.config.noPush,
			},
			this.issues,
			this.agent,
		);
	}

	/**
	 * Review an implementation PR (all tasks completed for an issue).
	 * Posts the review as a comment on the implementation PR.
	 * Returns the review result so callers can check the verdict.
	 */
	private async reviewImplementationPR(issueNumber: number): Promise<ReviewResult> {
		console.log(`Reviewing implementation for issue #${issueNumber}...`);
		return performReview(
			{type: 'issue-tasks-completed', issueNumber},
			{
				workDir: this.config.workDir,
				repo: this.config.repo,
				logFile: this.config.logFile,
				post: !this.config.noPush,
			},
			this.issues,
			this.agent,
		);
	}
}
