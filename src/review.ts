import * as fs from 'node:fs';
import * as path from 'node:path';
import type {AgentHarness} from './harnesses/agent-harness.js';
import type {IssueProvider} from './providers/issue-provider.js';
import {GitManager} from './git.js';
import {TaskManager} from './task-manager.js';
import {
	buildReviewTaskProposalPrompt,
	buildReviewImplementationPRPrompt,
	buildReviewTaskCompletionPrompt,
} from './prompts.js';

export type ReviewVerdict = 'approve' | 'request_changes' | 'unknown';

export interface ReviewResult {
	/** The full review text (null if agent produced no output) */
	response: string | null;
	/** Parsed verdict from the review response */
	verdict: ReviewVerdict;
}

export interface ReviewConfig {
	/** Working directory (the repo) */
	workDir: string;
	/** GitHub repo in "owner/repo" format (auto-detected if not set) */
	repo?: string;
	/** Log file path */
	logFile?: string;
	/** Whether to post the review as a GitHub comment */
	post: boolean;
}

export type ReviewTarget =
	| {type: 'pr'; number: number}
	| {type: 'issue-tasks'; issueNumber: number}
	| {type: 'issue-tasks-completed'; issueNumber: number};

/**
 * Perform a review.
 *
 * - `pr`: Review a PR (examine the diff, check for bugs, quality, etc.)
 * - `issue-tasks`: Review that proposed tasks are detailed and precise enough
 * - `issue-tasks-completed`: Review that completed tasks were followed properly and check for bugs
 */
/**
 * Parse the verdict from the review response text.
 * Looks for a "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES" line.
 */
export function parseReviewVerdict(response: string | null): ReviewVerdict {
	if (!response) return 'unknown';

	// Look for explicit verdict line (case-insensitive)
	const verdictMatch = response.match(/^\s*\*{0,2}VERDICT\*{0,2}\s*[:：]\s*(\S+)/im);
	if (verdictMatch) {
		const v = verdictMatch[1].toLowerCase().replace(/[^a-z_]/g, '');
		if (v === 'approve' || v === 'approved') return 'approve';
		if (v.includes('request') || v.includes('change') || v.includes('reject')) {
			return 'request_changes';
		}
	}

	// Fallback: look for common patterns
	const lower = response.toLowerCase();
	if (lower.includes('overall assessment: approve') || lower.includes('✅ approved')) {
		return 'approve';
	}
	if (
		lower.includes('overall assessment: request changes') ||
		lower.includes('❌ request changes')
	) {
		return 'request_changes';
	}

	return 'unknown';
}

export async function performReview(
	target: ReviewTarget,
	config: ReviewConfig,
	issues: IssueProvider,
	agent: AgentHarness,
): Promise<ReviewResult> {
	const git = new GitManager(config.workDir);
	const responseFile = '.whitesmith-review.md';

	await git.fetch();

	let prompt: string;
	let postTarget: number; // issue/PR number to post the comment on

	switch (target.type) {
		case 'pr': {
			const pr = await issues.getPR(target.number);
			if (!pr) {
				throw new Error(`Could not find PR #${target.number}`);
			}

			console.log(`Reviewing PR #${target.number}: ${pr.title}`);
			console.log(`Branch: ${pr.branch}`);

			// Checkout the PR branch so the agent can inspect the code
			await git.checkout(pr.branch);

			// Try to find the parent issue number from the branch name
			const issueMatch = pr.branch.match(/^(?:issue|investigate)\/(\d+)$/);
			let parentIssue = null;
			if (issueMatch) {
				try {
					parentIssue = await issues.getIssue(parseInt(issueMatch[1], 10));
				} catch {
					// Issue might not exist
				}
			}

			prompt = buildReviewImplementationPRPrompt({
				prNumber: target.number,
				prTitle: pr.title,
				prBody: pr.body,
				prBranch: pr.branch,
				prUrl: pr.url,
				parentIssue: parentIssue
					? {
							number: parentIssue.number,
							title: parentIssue.title,
							body: parentIssue.body,
							url: parentIssue.url,
						}
					: undefined,
				responseFile,
			});

			postTarget = target.number;
			break;
		}

		case 'issue-tasks': {
			const issue = await issues.getIssue(target.issueNumber);
			console.log(`Reviewing task proposal for issue #${target.issueNumber}: ${issue.title}`);

			// Find the task proposal PR
			const taskPR = await issues.getPRForBranch(`investigate/${target.issueNumber}`);
			if (taskPR) {
				// Checkout the investigate branch to see the tasks
				await git.checkout(`investigate/${target.issueNumber}`);
			}

			const taskManager = new TaskManager(config.workDir);
			const tasks = taskManager.listTasks(target.issueNumber);

			prompt = buildReviewTaskProposalPrompt({
				issueNumber: target.issueNumber,
				issueTitle: issue.title,
				issueBody: issue.body,
				issueUrl: issue.url,
				tasks: tasks.map((t) => ({
					id: t.id,
					title: t.title,
					content: t.content,
					filePath: t.filePath,
				})),
				taskPRUrl: taskPR?.url,
				responseFile,
			});

			postTarget = taskPR?.number ?? target.issueNumber;
			break;
		}

		case 'issue-tasks-completed': {
			const issue = await issues.getIssue(target.issueNumber);
			console.log(`Reviewing completed tasks for issue #${target.issueNumber}: ${issue.title}`);

			// Find the implementation PR
			const implPR = await issues.getPRForBranch(`issue/${target.issueNumber}`);
			if (implPR) {
				// Checkout the issue branch
				await git.checkout(`issue/${target.issueNumber}`);
			}

			prompt = buildReviewTaskCompletionPrompt({
				issueNumber: target.issueNumber,
				issueTitle: issue.title,
				issueBody: issue.body,
				issueUrl: issue.url,
				implPRUrl: implPR?.url,
				implBranch: `issue/${target.issueNumber}`,
				responseFile,
			});

			postTarget = implPR?.number ?? target.issueNumber;
			break;
		}
	}

	const {exitCode} = await agent.run({
		prompt,
		workDir: config.workDir,
		logFile: config.logFile,
	});

	if (exitCode !== 0) {
		throw new Error(`Agent failed with exit code ${exitCode}`);
	}

	// Read the response file
	const responsePath = path.join(config.workDir, responseFile);
	let response: string | null = null;
	if (fs.existsSync(responsePath)) {
		response = fs.readFileSync(responsePath, 'utf-8');
		try {
			fs.unlinkSync(responsePath);
		} catch {
			// ignore
		}
	}

	// Discard any changes the agent made (review is read-only)
	try {
		const hasChanges = await git.hasChanges();
		if (hasChanges) {
			// Reset any modifications — reviews should not change code
			const {exec: execAsync} = await import('node:child_process');
			const {promisify} = await import('node:util');
			const execP = promisify(execAsync);
			await execP('git checkout -- .', {cwd: config.workDir});
			await execP('git clean -fd', {cwd: config.workDir});
		}
	} catch {
		// ignore
	}

	// Return to main
	await git.checkoutMain();

	const verdict = parseReviewVerdict(response);

	if (response) {
		if (config.post) {
			await issues.comment(postTarget, response);
			console.log(`Review posted as comment on #${postTarget} (verdict: ${verdict})`);
		} else {
			process.stdout.write(response);
		}
	} else {
		console.log('Agent did not produce a review response.');
	}

	return {response, verdict};
}

/**
 * Auto-detect what kind of review to perform based on a PR number.
 * Inspects the branch name to determine if it's a task proposal or implementation.
 */
export async function detectReviewTarget(
	number: number,
	issues: IssueProvider,
): Promise<ReviewTarget> {
	const pr = await issues.getPR(number);
	if (pr) {
		// It's a PR — check the branch name
		const investigateMatch = pr.branch.match(/^investigate\/(\d+)$/);
		if (investigateMatch) {
			return {type: 'issue-tasks', issueNumber: parseInt(investigateMatch[1], 10)};
		}

		const issueMatch = pr.branch.match(/^issue\/(\d+)$/);
		if (issueMatch) {
			return {type: 'issue-tasks-completed', issueNumber: parseInt(issueMatch[1], 10)};
		}

		// Generic PR review
		return {type: 'pr', number};
	}

	// It's an issue — check if it has tasks
	const issue = await issues.getIssue(number);
	const hasTasksAccepted = issue.labels.some((l) => l.includes('tasks-accepted'));
	const hasTasksProposed = issue.labels.some((l) => l.includes('tasks-proposed'));

	if (hasTasksAccepted) {
		return {type: 'issue-tasks-completed', issueNumber: number};
	}
	if (hasTasksProposed) {
		return {type: 'issue-tasks', issueNumber: number};
	}

	// Default: treat as issue tasks review
	return {type: 'issue-tasks', issueNumber: number};
}
