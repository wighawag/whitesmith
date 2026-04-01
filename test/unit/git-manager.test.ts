import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { GitManager } from '../../src/git-manager.js';

describe('GitManager', () => {
	let testDir: string;
	let gitManager: GitManager;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-manager-test-'));
		process.chdir(testDir);

		// Initialize git repo
		execSync('git init', { cwd: testDir, stdio: 'pipe' });
		execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
		execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

		// Create initial commit
		fs.writeFileSync(path.join(testDir, 'README.md'), '# Test');
		execSync('git add .', { cwd: testDir, stdio: 'pipe' });
		execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
		execSync('git branch -M main', { cwd: testDir, stdio: 'pipe' });

		gitManager = new GitManager(testDir, 'ralph');
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	describe('sanitizeBranchName', () => {
		it('should convert to lowercase', () => {
			expect(gitManager.sanitizeBranchName('User Authentication')).toBe('user-authentication');
		});

		it('should replace non-alphanumeric with hyphens', () => {
			expect(gitManager.sanitizeBranchName('Test_Feature.v2')).toBe('test-feature-v2');
		});

		it('should collapse multiple hyphens', () => {
			expect(gitManager.sanitizeBranchName('Test---Feature')).toBe('test-feature');
		});

		it('should remove leading and trailing hyphens', () => {
			expect(gitManager.sanitizeBranchName('-Test Feature-')).toBe('test-feature');
		});

		it('should handle complex names', () => {
			expect(gitManager.sanitizeBranchName('API Integration (v2.0)')).toBe('api-integration-v2-0');
		});
	});

	describe('getEpicBranchName', () => {
		it('should create proper branch name format', () => {
			const branchName = gitManager.getEpicBranchName('EPIC-001', 'User Authentication');
			expect(branchName).toBe('ralph/epic-EPIC-001-user-authentication');
		});

		it('should handle custom prefix', () => {
			const customGitManager = new GitManager(testDir, 'custom');
			const branchName = customGitManager.getEpicBranchName('EPIC-001', 'Test');
			expect(branchName).toBe('custom/epic-EPIC-001-test');
		});
	});

	describe('getCurrentBranch', () => {
		it('should return current branch name', async () => {
			const branch = await gitManager.getCurrentBranch();
			expect(branch).toBe('main');
		});

		it('should return epic branch name when on it', async () => {
			execSync('git checkout -b ralph/epic-EPIC-001-test', { cwd: testDir, stdio: 'pipe' });
			const branch = await gitManager.getCurrentBranch();
			expect(branch).toBe('ralph/epic-EPIC-001-test');
		});
	});

	describe('setupEpicBranch', () => {
		it('should create new branch when it does not exist', async () => {
			const branchName = await gitManager.setupEpicBranch('EPIC-001', 'User Auth', undefined);

			expect(branchName).toBe('ralph/epic-EPIC-001-user-auth');

			const currentBranch = await gitManager.getCurrentBranch();
			expect(currentBranch).toBe(branchName);
		});

		it('should switch to existing branch', async () => {
			// Create branch first
			execSync('git checkout -b ralph/epic-EPIC-001-test', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });

			const branchName = await gitManager.setupEpicBranch('EPIC-001', 'Test', undefined);
			expect(branchName).toBe('ralph/epic-EPIC-001-test');

			const currentBranch = await gitManager.getCurrentBranch();
			expect(currentBranch).toBe(branchName);
		});

		it('should not switch when already on correct branch', async () => {
			execSync('git checkout -b ralph/epic-EPIC-001-test', { cwd: testDir, stdio: 'pipe' });

			const branchName = await gitManager.setupEpicBranch('EPIC-001', 'Test', undefined);
			expect(branchName).toBe('ralph/epic-EPIC-001-test');
		});
	});

	describe('getCompletedEpicBranches', () => {
		it('should return empty array when no epic branches exist', async () => {
			const completed = await gitManager.getCompletedEpicBranches();
			expect(completed).toEqual([]);
		});

		it('should return epic IDs from branch names', async () => {
			execSync('git checkout -b ralph/epic-EPIC-001-user-auth', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout -b ralph/epic-EPIC-002-dashboard', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });

			const completed = await gitManager.getCompletedEpicBranches();
			expect(completed).toContain('EPIC-001');
			expect(completed).toContain('EPIC-002');
		});

		it('should exclude in-progress epic', async () => {
			execSync('git checkout -b ralph/epic-EPIC-001-user-auth', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout -b ralph/epic-EPIC-002-dashboard', { cwd: testDir, stdio: 'pipe' });
			execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });

			const completed = await gitManager.getCompletedEpicBranches('EPIC-002');
			expect(completed).toContain('EPIC-001');
			expect(completed).not.toContain('EPIC-002');
		});
	});

	describe('hasUncommittedChanges', () => {
		it('should return false when working directory is clean', async () => {
			const hasChanges = await gitManager.hasUncommittedChanges();
			expect(hasChanges).toBe(false);
		});

		it('should return true when there are uncommitted changes', async () => {
			fs.writeFileSync(path.join(testDir, 'new-file.txt'), 'content');
			const hasChanges = await gitManager.hasUncommittedChanges();
			expect(hasChanges).toBe(true);
		});

		it('should return true when there are staged changes', async () => {
			fs.writeFileSync(path.join(testDir, 'new-file.txt'), 'content');
			execSync('git add .', { cwd: testDir, stdio: 'pipe' });
			const hasChanges = await gitManager.hasUncommittedChanges();
			expect(hasChanges).toBe(true);
		});
	});

	describe('verifyBranch', () => {
		it('should return true when on expected branch', async () => {
			const result = await gitManager.verifyBranch('main');
			expect(result).toBe(true);
		});

		it('should switch back and return false when on wrong branch', async () => {
			execSync('git checkout -b other-branch', { cwd: testDir, stdio: 'pipe' });
			const result = await gitManager.verifyBranch('main');
			expect(result).toBe(false);

			const currentBranch = await gitManager.getCurrentBranch();
			expect(currentBranch).toBe('main');
		});
	});
});
