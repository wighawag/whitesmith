import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../src/state-manager.js';

describe('StateManager', () => {
	let testDir: string;
	let stateManager: StateManager;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-manager-test-'));
		stateManager = new StateManager(testDir);
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	describe('saveState', () => {
		it('should save state to JSON file', () => {
			const state = {
				epicId: 'EPIC-001',
				epicName: 'User Authentication',
				branchName: 'ralph/epic-EPIC-001-user-authentication',
			};

			stateManager.saveState(state);

			const filePath = path.join(testDir, '.ralph-epic-state');
			expect(fs.existsSync(filePath)).toBe(true);

			const content = fs.readFileSync(filePath, 'utf-8');
			const parsed = JSON.parse(content);
			expect(parsed.epicId).toBe('EPIC-001');
			expect(parsed.epicName).toBe('User Authentication');
			expect(parsed.branchName).toBe('ralph/epic-EPIC-001-user-authentication');
		});

		it('should save state with dependsOn', () => {
			const state = {
				epicId: 'EPIC-002',
				epicName: 'Dashboard UI',
				dependsOn: 'EPIC-001',
				branchName: 'ralph/epic-EPIC-002-dashboard-ui',
			};

			stateManager.saveState(state);

			const loaded = stateManager.loadState();
			expect(loaded?.dependsOn).toBe('EPIC-001');
		});
	});

	describe('loadState', () => {
		it('should return undefined when no state file exists', () => {
			const state = stateManager.loadState();
			expect(state).toBeUndefined();
		});

		it('should load JSON state file', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(
				filePath,
				JSON.stringify({
					epicId: 'EPIC-001',
					epicName: 'Test Epic',
					branchName: 'ralph/epic-EPIC-001-test',
				})
			);

			const state = stateManager.loadState();
			expect(state?.epicId).toBe('EPIC-001');
			expect(state?.epicName).toBe('Test Epic');
			expect(state?.branchName).toBe('ralph/epic-EPIC-001-test');
		});

		it('should load bash format state file for backward compatibility', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(
				filePath,
				`SAVED_EPIC_ID="EPIC-001"
SAVED_EPIC_NAME="Test Epic"
SAVED_DEPENDS_ON=""
SAVED_BRANCH_NAME="ralph/epic-EPIC-001-test"`
			);

			const state = stateManager.loadState();
			expect(state?.epicId).toBe('EPIC-001');
			expect(state?.epicName).toBe('Test Epic');
			expect(state?.branchName).toBe('ralph/epic-EPIC-001-test');
		});

		it('should handle bash format with dependsOn', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(
				filePath,
				`SAVED_EPIC_ID="EPIC-002"
SAVED_EPIC_NAME="Dashboard"
SAVED_DEPENDS_ON="EPIC-001"
SAVED_BRANCH_NAME="ralph/epic-EPIC-002-dashboard"`
			);

			const state = stateManager.loadState();
			expect(state?.epicId).toBe('EPIC-002');
			expect(state?.dependsOn).toBe('EPIC-001');
		});
	});

	describe('clearState', () => {
		it('should remove the state file', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(filePath, '{}');

			expect(fs.existsSync(filePath)).toBe(true);
			stateManager.clearState();
			expect(fs.existsSync(filePath)).toBe(false);
		});

		it('should not throw if state file does not exist', () => {
			expect(() => stateManager.clearState()).not.toThrow();
		});
	});

	describe('hasState', () => {
		it('should return false when no state file exists', () => {
			expect(stateManager.hasState()).toBe(false);
		});

		it('should return true when state file exists', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(filePath, '{}');
			expect(stateManager.hasState()).toBe(true);
		});
	});

	describe('getInProgressEpicId', () => {
		it('should return undefined when no state file exists', () => {
			expect(stateManager.getInProgressEpicId()).toBeUndefined();
		});

		it('should return epic ID from JSON state', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(filePath, JSON.stringify({ epicId: 'EPIC-001' }));

			expect(stateManager.getInProgressEpicId()).toBe('EPIC-001');
		});

		it('should return epic ID from bash format state', () => {
			const filePath = path.join(testDir, '.ralph-epic-state');
			fs.writeFileSync(filePath, 'SAVED_EPIC_ID="EPIC-002"');

			expect(stateManager.getInProgressEpicId()).toBe('EPIC-002');
		});
	});
});
