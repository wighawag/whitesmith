import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {Orchestrator} from '../src/orchestrator.js';
import {LABELS} from '../src/types.js';
import type {Issue, DevPulseConfig, Task} from '../src/types.js';
import type {IssueProvider} from '../src/providers/issue-provider.js';
import type {AgentHarness} from '../src/harnesses/agent-harness.js';

// --- Helpers ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
	return {
		number: 1,
		title: 'Test issue',
		body: 'Test body',
		labels: [],
		url: 'https://github.com/test/repo/issues/1',
		...overrides,
	};
}

function createMockIssueProvider(overrides: Partial<IssueProvider> = {}): IssueProvider {
	return {
		listIssues: vi.fn().mockResolvedValue([]),
		getIssue: vi.fn().mockResolvedValue(makeIssue()),
		addLabel: vi.fn().mockResolvedValue(undefined),
		removeLabel: vi.fn().mockResolvedValue(undefined),
		comment: vi.fn().mockResolvedValue(undefined),
		closeIssue: vi.fn().mockResolvedValue(undefined),
		createPR: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
		remoteBranchExists: vi.fn().mockResolvedValue(false),
		getPRForBranch: vi.fn().mockResolvedValue(null),
		mergePR: vi.fn().mockResolvedValue(undefined),
		ensureLabels: vi.fn().mockResolvedValue(undefined),
		listPRsByBranchPrefix: vi.fn().mockResolvedValue([]),
		getPR: vi.fn().mockResolvedValue(null),
		...overrides,
	};
}

function createMockAgent(overrides: Partial<AgentHarness> = {}): AgentHarness {
	return {
		validate: vi.fn().mockResolvedValue(undefined),
		run: vi.fn().mockResolvedValue({output: '', exitCode: 0}),
		...overrides,
	};
}

function createConfig(workDir: string, overrides: Partial<DevPulseConfig> = {}): DevPulseConfig {
	return {
		agentCmd: 'mock-agent',
		maxIterations: 1,
		workDir,
		noPush: true,
		noSleep: true,
		...overrides,
	};
}

function writeTaskFile(
	tmpDir: string,
	issueNumber: number,
	seq: number,
	slug: string,
	dependsOn: string[] = [],
) {
	const dir = path.join(tmpDir, 'tasks', String(issueNumber));
	fs.mkdirSync(dir, {recursive: true});
	const seqStr = String(seq).padStart(3, '0');
	const id = `${issueNumber}-${seqStr}`;
	const depsStr = dependsOn.map((d) => `"${d}"`).join(', ');
	fs.writeFileSync(
		path.join(dir, `${seqStr}-${slug}.md`),
		`---
id: "${id}"
issue: ${issueNumber}
title: "Task ${slug}"
depends_on: [${depsStr}]
---

## Description
Test task.
`,
	);
	return id;
}

// We need to mock GitManager since tests don't have a real git repo
// Shared mock functions so tests can override behavior
const mockRemoteFileExists = vi.fn().mockResolvedValue(true);
const mockRemotePathHasFiles = vi.fn().mockResolvedValue(true);

vi.mock('../src/git.js', () => {
	class MockGitManager {
		fetch = vi.fn().mockResolvedValue(undefined);
		checkoutMain = vi.fn().mockResolvedValue(undefined);
		checkout = vi.fn().mockResolvedValue(undefined);
		getCurrentBranch = vi.fn().mockResolvedValue('main');
		commitAll = vi.fn().mockResolvedValue(false);
		push = vi.fn().mockResolvedValue(undefined);
		forcePush = vi.fn().mockResolvedValue(undefined);
		hasChanges = vi.fn().mockResolvedValue(false);
		localBranchExists = vi.fn().mockResolvedValue(false);
		deleteLocalBranch = vi.fn().mockResolvedValue(undefined);
		getDefaultBranch = vi.fn().mockResolvedValue('main');
		verifyBranch = vi.fn().mockResolvedValue(undefined);
		remoteFileExists = mockRemoteFileExists;
		remotePathHasFiles = mockRemotePathHasFiles;
	}
	return {GitManager: MockGitManager};
});

describe('Orchestrator', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whitesmith-orch-'));
		// Reset shared git mocks to defaults
		mockRemoteFileExists.mockReset().mockResolvedValue(true);
		mockRemotePathHasFiles.mockReset().mockResolvedValue(true);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, {recursive: true, force: true});
		vi.restoreAllMocks();
	});

	describe('idle when nothing to do', () => {
		it('goes idle when no issues exist', async () => {
			const issues = createMockIssueProvider();
			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Agent should not be called
			expect(agent.run).not.toHaveBeenCalled();
		});
	});

	describe('reconcile', () => {
		it('closes an issue when all tasks are done on issue branch', async () => {
			const issue = makeIssue({number: 42, title: 'Feature X'});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
				// issue/42 branch exists and has no task files (all completed)
				remoteBranchExists: vi.fn().mockResolvedValue(true),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			// Override remotePathHasFiles to return false (no task files = all done)
			mockRemotePathHasFiles.mockResolvedValue(false);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.addLabel).toHaveBeenCalledWith(42, LABELS.COMPLETED);
			expect(issues.removeLabel).toHaveBeenCalledWith(42, LABELS.TASKS_ACCEPTED);
			expect(issues.closeIssue).toHaveBeenCalledWith(42);
			expect(issues.comment).toHaveBeenCalledWith(42, expect.stringContaining('All tasks'));
		});

		it('creates safety-net PR during reconcile if none exists', async () => {
			const issue = makeIssue({number: 42, title: 'Feature X'});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
				remoteBranchExists: vi.fn().mockResolvedValue(true),
				getPRForBranch: vi.fn().mockResolvedValue(null),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {noPush: false});

			mockRemotePathHasFiles.mockResolvedValue(false);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.createPR).toHaveBeenCalledWith(
				expect.objectContaining({
					head: 'issue/42',
					base: 'main',
					title: expect.stringContaining('#42'),
				}),
			);
			expect(issues.closeIssue).toHaveBeenCalledWith(42);
		});
	});

	describe('investigate', () => {
		it('runs agent and labels issue when investigating', async () => {
			const issue = makeIssue({number: 7, title: 'New feature'});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.noLabels) return [issue];
						return [];
					}),
			});

			// Agent creates task files during its run
			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					writeTaskFile(tmpDir, 7, 1, 'first-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir);
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.addLabel).toHaveBeenCalledWith(7, LABELS.INVESTIGATING);
			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('Issue #7'),
					workDir: tmpDir,
				}),
			);
		});

		it('removes investigating label if agent fails', async () => {
			const issue = makeIssue({number: 3});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.noLabels) return [issue];
						return [];
					}),
			});

			const agent = createMockAgent({
				run: vi.fn().mockResolvedValue({output: 'error', exitCode: 1}),
			});

			const config = createConfig(tmpDir);
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.addLabel).toHaveBeenCalledWith(3, LABELS.INVESTIGATING);
			expect(issues.removeLabel).toHaveBeenCalledWith(3, LABELS.INVESTIGATING);
		});

		it('removes investigating label if agent creates no tasks', async () => {
			const issue = makeIssue({number: 5});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.noLabels) return [issue];
						return [];
					}),
			});

			// Agent succeeds but creates no task files
			const agent = createMockAgent({
				run: vi.fn().mockResolvedValue({output: 'done', exitCode: 0}),
			});

			const config = createConfig(tmpDir);
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.removeLabel).toHaveBeenCalledWith(5, LABELS.INVESTIGATING);
		});
	});

	describe('implement', () => {
		it('runs agent to implement an available task', async () => {
			const issue = makeIssue({number: 10, title: 'Add logging'});

			writeTaskFile(tmpDir, 10, 1, 'add-logger');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('10-001'),
					workDir: tmpDir,
				}),
			);
		});

		it('skips tasks with unsatisfied dependencies (dep not yet completed on issue branch)', async () => {
			const issue = makeIssue({number: 20});

			writeTaskFile(tmpDir, 20, 1, 'base');
			writeTaskFile(tmpDir, 20, 2, 'dependent', ['20-001']);

			// Issue branch exists but task 20-001 file still present (not completed yet)
			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
				remoteBranchExists: vi.fn().mockImplementation(async (branch: string) => {
					return branch === 'issue/20';
				}),
			});

			// remoteFileExists: both task files exist on the branch (neither completed)
			mockRemoteFileExists.mockResolvedValue(true);

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should implement 20-001 (first task, no deps)
			// 20-002 depends on 20-001 which is not yet completed
			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('20-001'),
				}),
			);
		});

		it('skips completed tasks on issue branch and picks next', async () => {
			const issue = makeIssue({number: 30});
			writeTaskFile(tmpDir, 30, 1, 'task-a');
			writeTaskFile(tmpDir, 30, 2, 'task-b', ['30-001']);

			// Issue branch exists, task-a (001) file deleted (completed), task-b (002) still present
			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
				remoteBranchExists: vi.fn().mockResolvedValue(true),
			});

			// task-a file doesn't exist on issue branch (completed), task-b exists
			mockRemoteFileExists.mockImplementation(async (_ref: string, filePath: string) => {
				return filePath.includes('002');
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should skip 30-001 (completed) and implement 30-002 (dep satisfied)
			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('30-002'),
				}),
			);
		});

		it('picks up task when issue branch exists but task not yet done', async () => {
			const issue = makeIssue({number: 40});
			writeTaskFile(tmpDir, 40, 1, 'stalled');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
				remoteBranchExists: vi.fn().mockResolvedValue(true),
			});

			// Task file still exists on the issue branch (not completed)
			mockRemoteFileExists.mockResolvedValue(true);

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should pick up the task
			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('40-001'),
				}),
			);
		});
	});

	describe('auto-approve', () => {
		it('auto-approves task PR when auto-work is enabled via config and issue is tasks-proposed', async () => {
			const issue = makeIssue({number: 50, title: 'Auto issue', labels: [LABELS.TASKS_PROPOSED]});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.labels?.includes(LABELS.TASKS_PROPOSED)) return [issue];
						return [];
					}),
				getPRForBranch: vi.fn().mockResolvedValue({
					state: 'open',
					url: 'https://github.com/test/repo/pull/55',
					number: 55,
				}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.mergePR).toHaveBeenCalledWith(55);
			expect(issues.removeLabel).toHaveBeenCalledWith(50, LABELS.TASKS_PROPOSED);
			expect(issues.addLabel).toHaveBeenCalledWith(50, LABELS.TASKS_ACCEPTED);
			expect(issues.comment).toHaveBeenCalledWith(50, expect.stringContaining('auto-approved'));
			expect(agent.run).not.toHaveBeenCalled();
		});

		it('auto-approves task PR when issue has auto-work label', async () => {
			const issue = makeIssue({number: 51, title: 'Labeled auto', labels: [LABELS.TASKS_PROPOSED, LABELS.AUTO_WORK]});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.labels?.includes(LABELS.TASKS_PROPOSED)) return [issue];
						return [];
					}),
				getPRForBranch: vi.fn().mockResolvedValue({
					state: 'open',
					url: 'https://github.com/test/repo/pull/56',
					number: 56,
				}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.mergePR).toHaveBeenCalledWith(56);
			expect(issues.removeLabel).toHaveBeenCalledWith(51, LABELS.TASKS_PROPOSED);
			expect(issues.addLabel).toHaveBeenCalledWith(51, LABELS.TASKS_ACCEPTED);
		});

		it('does NOT auto-approve when auto-work is disabled', async () => {
			const issue = makeIssue({number: 52, title: 'No auto', labels: [LABELS.TASKS_PROPOSED]});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.labels?.includes(LABELS.TASKS_PROPOSED)) return [issue];
						if (opts?.noLabels) return [];
						return [];
					}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.mergePR).not.toHaveBeenCalled();
		});

		it('skips auto-approve when no open PR exists for the branch', async () => {
			const issue = makeIssue({number: 53, title: 'No PR', labels: [LABELS.TASKS_PROPOSED]});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.labels?.includes(LABELS.TASKS_PROPOSED)) return [issue];
						if (opts?.noLabels) return [];
						return [];
					}),
				getPRForBranch: vi.fn().mockResolvedValue(null),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.mergePR).not.toHaveBeenCalled();
			// Should not transition labels either
			expect(issues.addLabel).not.toHaveBeenCalled();
		});

		it('prints dry-run message for auto-approve', async () => {
			const issue = makeIssue({number: 54, title: 'Dry run auto', labels: [LABELS.TASKS_PROPOSED]});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.labels?.includes(LABELS.TASKS_PROPOSED)) return [issue];
						return [];
					}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true, dryRun: true});

			const consoleSpy = vi.spyOn(console, 'log');
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Would auto-approve task PR for issue #54'),
			);
			expect(issues.mergePR).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('auto-approve takes priority over implement', async () => {
			const proposedIssue = makeIssue({number: 55, title: 'Proposed', labels: [LABELS.TASKS_PROPOSED]});
			const acceptedIssue = makeIssue({number: 56, title: 'Accepted'});

			writeTaskFile(tmpDir, 56, 1, 'pending');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [acceptedIssue];
						if (opts?.labels?.includes(LABELS.TASKS_PROPOSED)) return [proposedIssue];
						return [];
					}),
				getPRForBranch: vi.fn().mockResolvedValue({
					state: 'open',
					url: 'https://github.com/test/repo/pull/60',
					number: 60,
				}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should auto-approve, not implement
			expect(issues.mergePR).toHaveBeenCalledWith(60);
			expect(agent.run).not.toHaveBeenCalled();
		});
	});

	describe('priority ordering', () => {
		it('reconcile takes priority over implement', async () => {
			const completedIssue = makeIssue({number: 1, title: 'Done'});
			const activeIssue = makeIssue({number: 2, title: 'Active'});

			// Issue 2 has tasks, issue 1 doesn't (= all done)
			writeTaskFile(tmpDir, 2, 1, 'pending');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [completedIssue, activeIssue];
						return [];
					}),
				// issue/1 branch exists with all tasks done, issue/2 branch has tasks remaining
				remoteBranchExists: vi.fn().mockImplementation(async (branch: string) => {
					return branch === 'issue/1';
				}),
			});

			// issue/1 has no task files (all done)
			mockRemotePathHasFiles.mockResolvedValue(false);

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should reconcile (close issue 1) rather than implement
			expect(issues.closeIssue).toHaveBeenCalledWith(1);
			expect(agent.run).not.toHaveBeenCalled();
		});

		it('implement takes priority over investigate', async () => {
			const acceptedIssue = makeIssue({number: 1, title: 'Has tasks'});
			const newIssue = makeIssue({number: 2, title: 'New issue'});

			writeTaskFile(tmpDir, 1, 1, 'pending');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [acceptedIssue];
						if (opts?.noLabels) return [newIssue];
						return [];
					}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir);

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should implement the task, not investigate the new issue
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('1-001'),
				}),
			);
		});
	});

	describe('push mode', () => {
		it('creates PR when noPush is false during investigate', async () => {
			const issue = makeIssue({number: 8});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.noLabels) return [issue];
						return [];
					}),
			});

			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					writeTaskFile(tmpDir, 8, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.createPR).toHaveBeenCalledWith(
				expect.objectContaining({
					head: 'investigate/8',
					base: 'main',
					title: expect.stringContaining('#8'),
				}),
			);
			expect(issues.addLabel).toHaveBeenCalledWith(8, LABELS.TASKS_PROPOSED);
		});

		it('reuses existing PR when branch already has one during investigate', async () => {
			const issue = makeIssue({number: 9});

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [];
						if (opts?.noLabels) return [issue];
						return [];
					}),
				getPRForBranch: vi.fn().mockResolvedValue({
					state: 'open',
					url: 'https://github.com/test/repo/pull/99',
					number: 99,
				}),
			});

			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					writeTaskFile(tmpDir, 9, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should NOT create a new PR
			expect(issues.createPR).not.toHaveBeenCalled();
			// Should still label as proposed
			expect(issues.addLabel).toHaveBeenCalledWith(9, LABELS.TASKS_PROPOSED);
		});

		it('creates PR on issue branch when last task completes (noPush false)', async () => {
			const issue = makeIssue({number: 15, title: 'Feature fifteen'});
			writeTaskFile(tmpDir, 15, 1, 'do-thing');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
			});

			// Agent deletes the task file (simulating completion)
			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					// Delete the task file to simulate agent completing the task
					const taskDir = path.join(tmpDir, 'tasks', '15');
					fs.rmSync(taskDir, {recursive: true, force: true});
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.createPR).toHaveBeenCalledWith(
				expect.objectContaining({
					head: 'issue/15',
					base: 'main',
					title: expect.stringContaining('#15'),
				}),
			);
		});

		it('does not create PR when tasks remain after implementation', async () => {
			const issue = makeIssue({number: 16, title: 'Multi-task'});
			writeTaskFile(tmpDir, 16, 1, 'first');
			writeTaskFile(tmpDir, 16, 2, 'second');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
			});

			// Agent deletes only the first task file
			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					const taskFile = path.join(tmpDir, 'tasks', '16', '001-first.md');
					fs.unlinkSync(taskFile);
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should NOT create PR (task 2 still remaining)
			expect(issues.createPR).not.toHaveBeenCalled();
		});
	});
});
