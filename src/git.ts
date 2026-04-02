import {exec} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execAsync = promisify(exec);

/**
 * Git operations for whitesmith.
 */
export class GitManager {
	private workDir: string;

	constructor(workDir: string) {
		this.workDir = workDir;
	}

	private async git(args: string): Promise<string> {
		const {stdout} = await execAsync(`git ${args}`, {cwd: this.workDir});
		return stdout.trim();
	}

	/**
	 * Get the current branch name
	 */
	async getCurrentBranch(): Promise<string> {
		return this.git('rev-parse --abbrev-ref HEAD');
	}

	/**
	 * Remove all .whitesmith-* temp files from the working directory.
	 */
	cleanupTempFiles(): void {
		for (const entry of fs.readdirSync(this.workDir)) {
			if (entry.startsWith('.whitesmith-')) {
				try {
					fs.unlinkSync(path.join(this.workDir, entry));
				} catch {
					// ignore
				}
			}
		}
	}

	/**
	 * Fetch latest from origin
	 */
	async fetch(): Promise<void> {
		await this.git('fetch origin');
	}

	/**
	 * Checkout a branch (create if it doesn't exist)
	 */
	async checkout(branch: string, options?: {create?: boolean; startPoint?: string}): Promise<void> {
		if (options?.create) {
			const startPoint = options.startPoint || 'origin/main';
			await this.git(`checkout -b ${branch} ${startPoint}`);
		} else {
			await this.git(`checkout ${branch}`);
		}
	}

	/**
	 * Checkout main and pull latest
	 */
	async checkoutMain(): Promise<void> {
		await this.git('checkout main');
		await this.git('pull origin main');
	}

	/**
	 * Stage all changes and commit
	 */
	async commitAll(message: string, exclude?: string[]): Promise<boolean> {
		// Always exclude whitesmith temp files
		const allExclude = ['.whitesmith-*', ...(exclude || [])];

		// Remove any whitesmith temp files from the working tree
		this.cleanupTempFiles();

		// Check if there are changes
		const status = await this.git('status --porcelain');
		if (!status) return false;

		// Add all then unstage excluded patterns
		await this.git('add -A');
		for (const pattern of allExclude) {
			try {
				await this.git(`reset HEAD -- ${pattern}`);
			} catch {
				// File might not be staged
			}
		}

		// Check if anything is still staged after exclusions
		const staged = await this.git('diff --cached --name-only');
		if (!staged) return false;

		await this.git(`commit -m "${message.replace(/"/g, '\\"')}"`);
		return true;
	}

	/**
	 * Push branch to origin
	 */
	async push(branch: string): Promise<void> {
		await this.git(`push origin ${branch}`);
	}

	/**
	 * Force push branch to origin
	 */
	async forcePush(branch: string): Promise<void> {
		await this.git(`push --force-with-lease origin ${branch}`);
	}

	/**
	 * Check if there are uncommitted changes
	 */
	async hasChanges(): Promise<boolean> {
		const status = await this.git('status --porcelain');
		return status.length > 0;
	}

	/**
	 * Check if a local branch exists
	 */
	async localBranchExists(branch: string): Promise<boolean> {
		try {
			await this.git(`rev-parse --verify ${branch}`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Delete a local branch
	 */
	async deleteLocalBranch(branch: string): Promise<void> {
		try {
			await this.git(`branch -D ${branch}`);
		} catch {
			// Branch might not exist
		}
	}

	/**
	 * Get the default branch (usually main)
	 */
	async getDefaultBranch(): Promise<string> {
		try {
			const ref = await this.git('symbolic-ref refs/remotes/origin/HEAD');
			return ref.replace('refs/remotes/origin/', '');
		} catch {
			return 'main';
		}
	}

	/**
	 * Check if a file exists on a remote ref (without checking out)
	 */
	async remoteFileExists(ref: string, filePath: string): Promise<boolean> {
		try {
			await this.git(`show ${ref}:${filePath}`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if a path has any files on a remote ref (without checking out)
	 */
	async remotePathHasFiles(ref: string, dirPath: string): Promise<boolean> {
		try {
			const result = await this.git(`ls-tree ${ref} -- ${dirPath}`);
			return result.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Verify we're on the expected branch
	 */
	async verifyBranch(expected: string): Promise<void> {
		const current = await this.getCurrentBranch();
		if (current !== expected) {
			throw new Error(`Expected to be on branch '${expected}' but on '${current}'`);
		}
	}
}
