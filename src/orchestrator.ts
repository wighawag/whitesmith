import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RalphConfig, Epic, RalphState } from './types.js';
import type { TaskProvider } from './providers/task-provider.js';
import { StateManager } from './state-manager.js';
import { GitManager } from './git-manager.js';
import { AgentRunner } from './agent-runner.js';
import { PromptBuilder } from './prompt-builder.js';

const execAsync = promisify(exec);

/**
 * Main orchestrator that runs the epic-based autonomous coding workflow
 */
export class Orchestrator {
	private config: RalphConfig;
	private provider: TaskProvider;
	private stateManager: StateManager;
	private gitManager: GitManager;
	private agentRunner: AgentRunner;
	private promptBuilder: PromptBuilder;

	constructor(config: RalphConfig, provider: TaskProvider) {
		this.config = config;
		this.provider = provider;
		this.stateManager = new StateManager(config.workDir);
		this.gitManager = new GitManager(config.workDir, config.branchPrefix);
		this.agentRunner = new AgentRunner(config.logFile);
		this.promptBuilder = new PromptBuilder();
	}

	/**
	 * Run the main orchestration loop
	 */
	async run(): Promise<void> {
		console.log('=== Ralph Wiggum Coding Agent (Epic Mode) ===');
		console.log(`Working directory: ${this.config.workDir}`);
		console.log(`Max iterations: ${this.config.maxIterations}`);
		console.log(`Branch prefix: ${this.config.branchPrefix}`);
		console.log(`Agent command: ${this.config.agentCmd}`);
		console.log(`Log file: ${this.config.logFile || '<none>'}`);
		console.log(`No push mode: ${this.config.noPush}`);
		console.log('');

		// Initialize log file
		this.agentRunner.initLogFile(this.config.workDir);

		// Fetch latest from origin
		await this.gitManager.fetchOrigin();

		// Main loop
		for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
			console.log('');
			console.log('==========================================');
			console.log(`=== Iteration ${iteration} of ${this.config.maxIterations} ===`);
			console.log('==========================================');

			const result = await this.runIteration();

			if (result === 'complete') {
				console.log('');
				console.log('=== ALL EPICS COMPLETED! ===');
				console.log('All tasks in all epics have been implemented.');
				console.log('');
				await this.listPRs();
				this.stateManager.clearState();
				return;
			}

			// Sleep between iterations (unless disabled for testing)
			if (!this.config.noSleep) {
				await this.sleep(5000);
			}
		}

		console.log('');
		console.log('=== Iteration limit reached ===');
		console.log('Check markplane for current status.');
		console.log('');
		console.log('Active Ralph branches:');
		await this.listRalphBranches();
	}

	/**
	 * Run a single iteration
	 * Returns 'complete' if all epics are done, 'continue' otherwise
	 */
	private async runIteration(): Promise<'complete' | 'continue'> {
		// STEP 1: Determine which epic to work on
		let state = this.stateManager.loadState();
		let epic: Epic;
		let branchName: string;

		if (state && state.epicId && state.branchName) {
			// Resume existing epic
			epic = {
				id: state.epicId,
				name: state.epicName,
				status: 'in-progress',
				dependsOn: state.dependsOn,
			};
			branchName = state.branchName;
			console.log(`Resuming epic: ${epic.id} (${epic.name})`);
		} else {
			// Discover next epic
			console.log('No saved state - discovering next epic...');
			const discoveryResult = await this.discoverNextEpic();

			if (discoveryResult.isComplete) {
				return 'complete';
			}

			if (!discoveryResult.epicId || !discoveryResult.epicName) {
				throw new Error('Could not extract epic information from discovery');
			}

			epic = {
				id: discoveryResult.epicId,
				name: discoveryResult.epicName,
				status: 'pending',
				dependsOn: discoveryResult.dependsOn,
			};

			console.log('');
			console.log(`Discovered epic: ${epic.id} - ${epic.name}`);
			if (epic.dependsOn) {
				console.log(`Depends on: ${epic.dependsOn}`);
			}

			// Set up the branch
			branchName = await this.gitManager.setupEpicBranch(epic.id, epic.name, epic.dependsOn);
		}

		// STEP 2: Ensure we're on the correct branch
		const currentBranch = await this.gitManager.getCurrentBranch();
		if (currentBranch !== branchName) {
			console.log(`Switching to branch: ${branchName}`);
			await this.gitManager.checkout(branchName);
		}

		// Save state
		const newState: RalphState = {
			epicId: epic.id,
			epicName: epic.name,
			dependsOn: epic.dependsOn,
			branchName,
		};
		this.stateManager.saveState(newState);

		console.log('');
		console.log(`Working on branch: ${branchName}`);
		console.log('');

		// STEP 3: Run agent to work on tasks
		const workPrompt = this.promptBuilder.buildWorkPrompt(epic, branchName, this.provider);
		const { output, exitCode } = await this.agentRunner.runAgent(workPrompt, this.config.agentCmd);

		if (exitCode !== 0) {
			throw new Error(`Agent command failed with exit code ${exitCode}`);
		}

		// STEP 4: Verify we're still on the correct branch
		await this.gitManager.verifyBranch(branchName);

		// STEP 5: Safety commit for any uncommitted changes
		if (await this.gitManager.hasUncommittedChanges()) {
			console.log('Found uncommitted changes - committing as safety net');
			await this.gitManager.commitChanges(
				`feat(${epic.id}): implement task (auto-commit)`,
				this.stateManager.getStateFileName()
			);
		}

		// STEP 6: Check for completion
		const workResult = this.promptBuilder.parseWorkOutput(output);

		if (workResult.isEpicComplete) {
			console.log('');
			console.log(`=== EPIC COMPLETED: ${epic.name} ===`);

			// Create PR for this epic
			await this.createEpicPR(branchName, epic.name, epic.dependsOn, workResult.prDescription);

			// Clear state so next iteration discovers the next epic
			this.stateManager.clearState();

			console.log('');
			console.log('Epic complete! Will discover next epic on next iteration.');
			console.log('');
		}

		if (workResult.isAllComplete) {
			return 'complete';
		}

		return 'continue';
	}

	/**
	 * Discover the next epic to work on
	 */
	private async discoverNextEpic(): Promise<{
		isComplete: boolean;
		epicId?: string;
		epicName?: string;
		dependsOn?: string;
	}> {
		console.error('=== Discovering next epic ===');

		// Get list of epics that already have branches
		const inProgressEpicId = this.stateManager.getInProgressEpicId();
		const completedEpics = await this.gitManager.getCompletedEpicBranches(inProgressEpicId);

		if (completedEpics.length > 0) {
			console.error(`Epics with existing branches (considered complete): ${completedEpics.join(' ')}`);
		}

		const discoveryPrompt = this.promptBuilder.buildDiscoveryPrompt(completedEpics, this.provider);
		const { output } = await this.agentRunner.runAgent(discoveryPrompt, this.config.agentCmd);

		console.log(output);

		return this.promptBuilder.parseDiscoveryOutput(output);
	}

	/**
	 * Create a PR for a completed epic
	 */
	private async createEpicPR(
		branchName: string,
		epicName: string,
		dependsOn?: string,
		prDescription?: string
	): Promise<void> {
		if (this.config.noPush) {
			console.log('Skipping push and PR creation (--no-push mode)');
			console.log(`Branch '${branchName}' is ready for manual push`);
			return;
		}

		console.log(`Pushing branch '${branchName}' to origin...`);

		try {
			await this.gitManager.pushBranch(branchName);
		} catch (error) {
			console.error('ERROR: Failed to push branch to origin');
			return;
		}

		// Determine base branch for PR
		let baseBranch = 'main';
		if (dependsOn) {
			// Try to find the dependency branch
			const completedEpics = await this.gitManager.getCompletedEpicBranches();
			const branchPrefix = this.gitManager.getBranchPrefix();
			// Note: In a real implementation, we'd look up the actual branch name
			// For now, just use main
		}

		// Build PR body
		let body: string;
		if (prDescription) {
			body = `${prDescription}

---
*Automated PR created by Ralph autonomous coding agent.*`;
		} else {
			const depNote = dependsOn
				? `This PR depends on the PR for epic ${dependsOn}`
				: 'No dependencies - can be merged directly to main';

			body = `## Epic: ${epicName}

## Changes
This PR contains all tasks completed for this epic.

## Dependencies
${depNote}

## Review
Please review the changes and merge when ready.

---
*Automated PR created by Ralph autonomous coding agent.*`;
		}

		console.log(`Creating Pull Request (base: ${baseBranch})...`);

		try {
			await execAsync(
				`gh pr create --base "${baseBranch}" --head "${branchName}" --title "feat: ${epicName}" --body "${body.replace(/"/g, '\\"')}"`,
				{ cwd: this.config.workDir }
			);
			console.log('PR created successfully!');
		} catch (error) {
			console.log('WARNING: Failed to create PR. You may need to create it manually.');
			console.log(`Branch '${branchName}' has been pushed to origin.`);
		}
	}

	/**
	 * List PRs created by Ralph
	 */
	private async listPRs(): Promise<void> {
		console.log('Created PRs:');
		try {
			const { stdout } = await execAsync(`gh pr list --search "head:${this.config.branchPrefix}/epic-"`, {
				cwd: this.config.workDir,
			});
			console.log(stdout || "Use 'gh pr list' to see all Ralph PRs");
		} catch {
			console.log("Use 'gh pr list' to see all Ralph PRs");
		}
	}

	/**
	 * List Ralph branches
	 */
	private async listRalphBranches(): Promise<void> {
		try {
			const { stdout } = await execAsync(`git branch | grep "${this.config.branchPrefix}/"`, {
				cwd: this.config.workDir,
			});
			console.log(stdout);
		} catch {
			console.log('(no branches found)');
		}
	}

	/**
	 * Sleep for a given number of milliseconds
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
