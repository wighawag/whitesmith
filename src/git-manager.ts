import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

/**
 * Manages all git operations for the ralph-epic workflow
 */
export class GitManager {
	private git: SimpleGit;
	private branchPrefix: string;

	constructor(workDir: string, branchPrefix: string = 'ralph') {
		const options: Partial<SimpleGitOptions> = {
			baseDir: workDir,
			binary: 'git',
			maxConcurrentProcesses: 1,
		};
		this.git = simpleGit(options);
		this.branchPrefix = branchPrefix;
	}

	/**
	 * Sanitize an epic name for use in a branch name
	 * Converts to lowercase, replaces non-alphanumeric chars with hyphens
	 */
	sanitizeBranchName(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-/, '')
			.replace(/-$/, '');
	}

	/**
	 * Get the full branch name for an epic
	 */
	getEpicBranchName(epicId: string, epicName: string): string {
		return `${this.branchPrefix}/epic-${epicId}-${this.sanitizeBranchName(epicName)}`;
	}

	/**
	 * Set up the branch for an epic (create or checkout)
	 * Returns the branch name
	 */
	async setupEpicBranch(epicId: string, epicName: string, dependsOn?: string): Promise<string> {
		const branchName = this.getEpicBranchName(epicId, epicName);

		console.error(`Setting up branch for epic: ${epicName}`);
		console.error(`Branch name: ${branchName}`);

		const currentBranch = await this.getCurrentBranch();
		if (currentBranch === branchName) {
			console.error(`Already on correct branch: ${branchName}`);
			return branchName;
		}

		// Check if branch exists locally
		const branches = await this.git.branchLocal();
		if (branches.all.includes(branchName)) {
			console.error(`Switching to existing branch '${branchName}'`);
			await this.git.checkout(branchName);
			return branchName;
		}

		// Determine base branch
		let baseBranch = 'main';

		// Check if origin/main exists
		try {
			const remoteBranches = await this.git.branch(['-r']);
			if (remoteBranches.all.includes('origin/main')) {
				baseBranch = 'origin/main';
			}
		} catch {
			// Remote branches unavailable, use local main
		}

		// If there's a dependency, try to branch from it
		if (dependsOn) {
			const depBranchPattern = `${this.branchPrefix}/epic-${dependsOn}-`;
			const allBranches = await this.git.branch(['-a']);
			const depBranch = allBranches.all.find((b) => b.includes(depBranchPattern));

			if (depBranch) {
				baseBranch = depBranch.replace('remotes/', '');
				console.error(`Branching from dependency: ${baseBranch}`);
			} else {
				console.error(`WARNING: Dependency branch not found, using ${baseBranch}`);
			}
		}

		console.error(`Creating new branch '${branchName}' from ${baseBranch}`);
		await this.git.checkoutBranch(branchName, baseBranch);

		return branchName;
	}

	/**
	 * Get the current branch name
	 */
	async getCurrentBranch(): Promise<string> {
		const result = await this.git.revparse(['--abbrev-ref', 'HEAD']);
		return result.trim();
	}

	/**
	 * Get list of epic IDs that have existing branches (considered complete)
	 * Excludes the given in-progress epic ID if provided
	 */
	async getCompletedEpicBranches(inProgressEpicId?: string): Promise<string[]> {
		const allBranches = await this.git.branch(['-a']);

		// Pattern: ralph/epic-EPIC-XXX-name or origin/ralph/epic-EPIC-XXX-name
		// Extract epic ID (e.g., EPIC-001) from branch name
		const epicIdPattern = new RegExp(`${this.branchPrefix}/epic-([A-Za-z]+-[0-9]+)-`);

		const epicIds = new Set<string>();
		for (const branch of allBranches.all) {
			const match = branch.match(epicIdPattern);
			if (match) {
				epicIds.add(match[1]);
			}
		}

		// Exclude in-progress epic
		if (inProgressEpicId) {
			console.error(`Excluding in-progress epic from completed list: ${inProgressEpicId}`);
			epicIds.delete(inProgressEpicId);
		}

		return Array.from(epicIds).sort();
	}

	/**
	 * Check if there are uncommitted changes
	 */
	async hasUncommittedChanges(): Promise<boolean> {
		const status = await this.git.status();
		return !status.isClean();
	}

	/**
	 * Commit all changes with the given message
	 * Excludes the state file from the commit
	 */
	async commitChanges(message: string, stateFileName: string): Promise<void> {
		// Add all files except state file
		await this.git.add(['.', `:!${stateFileName}`]);

		// Check if there's anything to commit
		const status = await this.git.status();
		if (status.staged.length > 0) {
			await this.git.commit(message);
			console.log(`Committed: ${message}`);
		}
	}

	/**
	 * Push branch to origin
	 */
	async pushBranch(branchName: string): Promise<void> {
		await this.git.push(['-u', 'origin', branchName]);
		console.log(`Pushed branch '${branchName}' to origin`);
	}

	/**
	 * Fetch from origin (if available)
	 */
	async fetchOrigin(): Promise<void> {
		try {
			const remotes = await this.git.getRemotes();
			if (remotes.some((r) => r.name === 'origin')) {
				await this.git.fetch(['origin', 'main']);
			}
		} catch (error) {
			console.error('WARNING: Could not fetch from origin');
		}
	}

	/**
	 * Checkout a specific branch
	 */
	async checkout(branchName: string): Promise<void> {
		await this.git.checkout(branchName);
	}

	/**
	 * Verify we're on the expected branch, switch back if not
	 */
	async verifyBranch(expectedBranch: string): Promise<boolean> {
		const currentBranch = await this.getCurrentBranch();
		if (currentBranch !== expectedBranch) {
			console.error(`!!! WARNING: Branch changed unexpectedly to '${currentBranch}' !!!`);
			console.error(`Switching back to ${expectedBranch}`);
			await this.git.checkout(expectedBranch);
			return false;
		}
		return true;
	}

	/**
	 * Get the branch prefix
	 */
	getBranchPrefix(): string {
		return this.branchPrefix;
	}
}
