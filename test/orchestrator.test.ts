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
		review: false,
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

const mockPerformReview = vi
	.fn()
	.mockResolvedValue({response: 'Review looks good.', verdict: 'approve'});

vi.mock('../src/review.js', () => ({
	performReview: (...args: unknown[]) => mockPerformReview(...args),
}));

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
		mockPerformReview
			.mockReset()
			.mockResolvedValue({response: 'Review looks good.', verdict: 'approve'});
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
			const issue = makeIssue({
				number: 51,
				title: 'Labeled auto',
				labels: [LABELS.TASKS_PROPOSED, LABELS.AUTO_WORK],
			});

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
			const proposedIssue = makeIssue({
				number: 55,
				title: 'Proposed',
				labels: [LABELS.TASKS_PROPOSED],
			});
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

	describe('review step', () => {
		it('triggers task proposal review after investigate when review is enabled', async () => {
			const issue = makeIssue({number: 70, title: 'Review me'});

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
					writeTaskFile(tmpDir, 70, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false, review: true});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// PR should be created
			expect(issues.createPR).toHaveBeenCalled();
			// Review should be triggered
			expect(mockPerformReview).toHaveBeenCalledWith(
				{type: 'issue-tasks', issueNumber: 70},
				expect.objectContaining({workDir: tmpDir, post: true}),
				issues,
				agent,
			);
		});

		it('does not trigger review after investigate when review is disabled', async () => {
			const issue = makeIssue({number: 71, title: 'No review'});

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
					writeTaskFile(tmpDir, 71, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false, review: false});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.createPR).toHaveBeenCalled();
			expect(mockPerformReview).not.toHaveBeenCalled();
		});

		it('does not trigger review after investigate in noPush mode', async () => {
			const issue = makeIssue({number: 72, title: 'No push'});

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
					writeTaskFile(tmpDir, 72, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: true, review: true});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// No PR, no review
			expect(issues.createPR).not.toHaveBeenCalled();
			expect(mockPerformReview).not.toHaveBeenCalled();
		});

		it('triggers implementation review after last task completes when review is enabled', async () => {
			const issue = makeIssue({number: 73, title: 'Impl review'});
			writeTaskFile(tmpDir, 73, 1, 'only-task');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
			});

			// Agent deletes the task file (completes it)
			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					const taskDir = path.join(tmpDir, 'tasks', '73');
					fs.rmSync(taskDir, {recursive: true, force: true});
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false, review: true});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// PR should be created
			expect(issues.createPR).toHaveBeenCalled();
			// Review should be triggered for completion
			expect(mockPerformReview).toHaveBeenCalledWith(
				{type: 'issue-tasks-completed', issueNumber: 73},
				expect.objectContaining({workDir: tmpDir, post: true}),
				issues,
				agent,
			);
		});

		it('does not trigger implementation review when tasks remain', async () => {
			const issue = makeIssue({number: 74, title: 'Multi-task'});
			writeTaskFile(tmpDir, 74, 1, 'first');
			writeTaskFile(tmpDir, 74, 2, 'second');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
			});

			// Agent deletes only the first task
			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					const taskFile = path.join(tmpDir, 'tasks', '74', '001-first.md');
					fs.unlinkSync(taskFile);
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false, review: true});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// No PR, no review (tasks remain)
			expect(issues.createPR).not.toHaveBeenCalled();
			expect(mockPerformReview).not.toHaveBeenCalled();
		});

		it('continues gracefully when review fails', async () => {
			const issue = makeIssue({number: 75, title: 'Review fails'});

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
					writeTaskFile(tmpDir, 75, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			mockPerformReview.mockRejectedValue(new Error('Agent crashed'));

			const config = createConfig(tmpDir, {noPush: false, review: true});
			const orch = new Orchestrator(config, issues, agent);

			// Should not throw
			await expect(orch.run()).resolves.toBeUndefined();

			// PR was still created before review failed
			expect(issues.createPR).toHaveBeenCalled();
		});

		it('skips investigate review when auto-work is enabled (auto-approve will review)', async () => {
			const issue = makeIssue({number: 76, title: 'Auto-work skip review'});

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
					writeTaskFile(tmpDir, 76, 1, 'the-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {noPush: false, review: true, autoWork: true});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// PR should be created
			expect(issues.createPR).toHaveBeenCalled();
			// Review should NOT be triggered during investigate (auto-approve handles it)
			expect(mockPerformReview).not.toHaveBeenCalled();
		});

		it('auto-approve runs review and merges when review approves', async () => {
			const issue = makeIssue({number: 80, title: 'Approved', labels: [LABELS.TASKS_PROPOSED]});

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
					url: 'https://github.com/test/repo/pull/81',
					number: 81,
				}),
			});

			mockPerformReview.mockResolvedValue({
				response: 'VERDICT: APPROVE\n\nLooks good!',
				verdict: 'approve',
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true, review: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Review should have been called
			expect(mockPerformReview).toHaveBeenCalled();
			// PR should be merged (review approved)
			expect(issues.mergePR).toHaveBeenCalledWith(81);
			// Labels should transition
			expect(issues.removeLabel).toHaveBeenCalledWith(80, LABELS.TASKS_PROPOSED);
			expect(issues.addLabel).toHaveBeenCalledWith(80, LABELS.TASKS_ACCEPTED);
		});

		it('auto-approve skips merge when review requests changes', async () => {
			const issue = makeIssue({number: 82, title: 'Rejected', labels: [LABELS.TASKS_PROPOSED]});

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
					url: 'https://github.com/test/repo/pull/83',
					number: 83,
				}),
			});

			mockPerformReview.mockResolvedValue({
				response: 'VERDICT: REQUEST_CHANGES\n\nTasks are too vague.',
				verdict: 'request_changes',
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true, review: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Review should have been called
			expect(mockPerformReview).toHaveBeenCalled();
			// PR should NOT be merged
			expect(issues.mergePR).not.toHaveBeenCalled();
			// Should post a comment explaining the skip
			expect(issues.comment).toHaveBeenCalledWith(82, expect.stringContaining('requested changes'));
			// Should remove tasks-proposed to prevent retry loop
			expect(issues.removeLabel).toHaveBeenCalledWith(82, LABELS.TASKS_PROPOSED);
			// Should NOT add tasks-accepted
			expect(issues.addLabel).not.toHaveBeenCalledWith(82, LABELS.TASKS_ACCEPTED);
		});

		it('auto-approve proceeds with merge when review verdict is unknown', async () => {
			const issue = makeIssue({
				number: 84,
				title: 'Unknown verdict',
				labels: [LABELS.TASKS_PROPOSED],
			});

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
					url: 'https://github.com/test/repo/pull/85',
					number: 85,
				}),
			});

			mockPerformReview.mockResolvedValue({
				response: 'Some review without a clear verdict.',
				verdict: 'unknown',
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true, review: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Review ran but verdict unknown — proceed with merge
			expect(mockPerformReview).toHaveBeenCalled();
			expect(issues.mergePR).toHaveBeenCalledWith(85);
			expect(issues.addLabel).toHaveBeenCalledWith(84, LABELS.TASKS_ACCEPTED);
		});

		it('auto-approve proceeds with merge when review throws', async () => {
			const issue = makeIssue({number: 86, title: 'Review error', labels: [LABELS.TASKS_PROPOSED]});

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
					url: 'https://github.com/test/repo/pull/87',
					number: 87,
				}),
			});

			mockPerformReview.mockRejectedValue(new Error('Agent crashed'));

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true, review: true});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Review failed but merge should still proceed (fail-open)
			expect(issues.mergePR).toHaveBeenCalledWith(87);
		});

		it('auto-approve without review merges immediately', async () => {
			const issue = makeIssue({number: 88, title: 'No review', labels: [LABELS.TASKS_PROPOSED]});

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
					url: 'https://github.com/test/repo/pull/89',
					number: 89,
				}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {autoWork: true, review: false});

			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// No review, direct merge
			expect(mockPerformReview).not.toHaveBeenCalled();
			expect(issues.mergePR).toHaveBeenCalledWith(89);
		});
	});

	describe('single-issue mode (runForIssue)', () => {
		it('investigates when issue has no whitesmith labels', async () => {
			const issue = makeIssue({number: 42, title: 'New feature', labels: []});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					writeTaskFile(tmpDir, 42, 1, 'first-task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should fetch the specific issue
			expect(issues.getIssue).toHaveBeenCalledWith(42);
			// Should NOT do a global scan
			expect(issues.listIssues).not.toHaveBeenCalled();
			// Should investigate
			expect(issues.addLabel).toHaveBeenCalledWith(42, LABELS.INVESTIGATING);
			expect(agent.run).toHaveBeenCalledTimes(1);
		});

		it('implements tasks when issue has tasks-accepted label', async () => {
			const issue = makeIssue({number: 42, title: 'Feature', labels: [LABELS.TASKS_ACCEPTED]});
			writeTaskFile(tmpDir, 42, 1, 'do-thing');

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.getIssue).toHaveBeenCalledWith(42);
			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('42-001'),
				}),
			);
		});

		it('reconciles when issue has tasks-accepted and all tasks done on branch', async () => {
			const issue = makeIssue({number: 42, title: 'Done', labels: [LABELS.TASKS_ACCEPTED]});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
				remoteBranchExists: vi.fn().mockResolvedValue(true),
			});

			// No task files on the issue branch = all done
			mockRemotePathHasFiles.mockResolvedValue(false);

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(issues.addLabel).toHaveBeenCalledWith(42, LABELS.COMPLETED);
			expect(issues.removeLabel).toHaveBeenCalledWith(42, LABELS.TASKS_ACCEPTED);
			expect(issues.closeIssue).toHaveBeenCalledWith(42);
		});

		it('clears stale investigating label and re-investigates', async () => {
			const issue = makeIssue({number: 42, title: 'Stale', labels: [LABELS.INVESTIGATING]});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					writeTaskFile(tmpDir, 42, 1, 'task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should clear the stale investigating label
			expect(issues.removeLabel).toHaveBeenCalledWith(42, LABELS.INVESTIGATING);
			// Should re-investigate
			expect(issues.addLabel).toHaveBeenCalledWith(42, LABELS.INVESTIGATING);
			expect(agent.run).toHaveBeenCalledTimes(1);
		});

		it('transitions tasks-proposed to tasks-accepted when tasks exist on main', async () => {
			const issue = makeIssue({number: 42, title: 'Merged PR', labels: [LABELS.TASKS_PROPOSED]});
			// Tasks exist on main (PR was merged)
			writeTaskFile(tmpDir, 42, 1, 'task-a');

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should transition labels inline
			expect(issues.removeLabel).toHaveBeenCalledWith(42, LABELS.TASKS_PROPOSED);
			expect(issues.addLabel).toHaveBeenCalledWith(42, LABELS.TASKS_ACCEPTED);
			// Should proceed to implement the task
			expect(agent.run).toHaveBeenCalledTimes(1);
			expect(agent.run).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('42-001'),
				}),
			);
		});

		it('auto-approves when tasks-proposed and auto-work enabled (no tasks on main)', async () => {
			const issue = makeIssue({number: 42, title: 'Auto', labels: [LABELS.TASKS_PROPOSED]});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
				getPRForBranch: vi.fn().mockResolvedValue({
					state: 'open',
					url: 'https://github.com/test/repo/pull/99',
					number: 99,
				}),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1, autoWork: true});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// No tasks on main, so it should auto-approve (not transition)
			expect(issues.mergePR).toHaveBeenCalledWith(99);
		});

		it('goes idle when issue has tasks-proposed, no auto-work, and no tasks on main', async () => {
			const issue = makeIssue({number: 42, title: 'Waiting', labels: [LABELS.TASKS_PROPOSED]});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should not do anything
			expect(agent.run).not.toHaveBeenCalled();
			expect(issues.mergePR).not.toHaveBeenCalled();
		});

		it('goes idle when issue has completed label', async () => {
			const issue = makeIssue({number: 42, title: 'Done', labels: [LABELS.COMPLETED]});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(agent.run).not.toHaveBeenCalled();
		});

		it('re-fetches issue after each action to get updated labels', async () => {
			// First fetch: no labels (investigate)
			// Second fetch: tasks-proposed + tasks on main (transition to tasks-accepted + implement)
			const issueFetch1 = makeIssue({number: 42, title: 'Pipeline', labels: []});
			const issueFetch2 = makeIssue({number: 42, title: 'Pipeline', labels: [LABELS.TASKS_PROPOSED]});

			const getIssueMock = vi
				.fn()
				.mockResolvedValueOnce(issueFetch1)
				.mockResolvedValueOnce(issueFetch2);

			const issues = createMockIssueProvider({
				getIssue: getIssueMock,
			});

			const agent = createMockAgent({
				run: vi
					.fn()
					.mockImplementationOnce(async () => {
						// Investigate: create task files
						writeTaskFile(tmpDir, 42, 1, 'task-a');
						return {output: 'done', exitCode: 0};
					})
					.mockResolvedValueOnce({output: 'done', exitCode: 0}),
			});

			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 2});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// getIssue should have been called twice (once per iteration)
			expect(getIssueMock).toHaveBeenCalledTimes(2);
			// Agent should be called twice: investigate + implement
			expect(agent.run).toHaveBeenCalledTimes(2);
		});

		it('respects max-iterations limit', async () => {
			// Issue always returns no labels -> investigate each time
			const issue = makeIssue({number: 42, title: 'Looper', labels: []});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent({
				run: vi.fn().mockImplementation(async () => {
					writeTaskFile(tmpDir, 42, 1, 'task');
					return {output: 'done', exitCode: 0};
				}),
			});

			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 3});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should stop after 3 iterations
			expect(agent.run).toHaveBeenCalledTimes(3);
		});

		it('dry-run works with --issue', async () => {
			const issue = makeIssue({number: 42, title: 'Dry run', labels: []});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, dryRun: true});

			const consoleSpy = vi.spyOn(console, 'log');
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Would investigate issue #42'),
			);
			expect(agent.run).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('does not scan other issues when --issue is set', async () => {
			const issue = makeIssue({number: 42, title: 'Solo', labels: [LABELS.COMPLETED]});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
			});

			const agent = createMockAgent();
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 5});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// listIssues should never be called in single-issue mode
			expect(issues.listIssues).not.toHaveBeenCalled();
		});

		it('uses isAutoWorkEnabled to detect auto-work via issue label', async () => {
			const issue = makeIssue({
				number: 42,
				title: 'Label auto',
				labels: [LABELS.TASKS_PROPOSED, LABELS.AUTO_WORK],
			});

			const issues = createMockIssueProvider({
				getIssue: vi.fn().mockResolvedValue(issue),
				getPRForBranch: vi.fn().mockResolvedValue({
					state: 'open',
					url: 'https://github.com/test/repo/pull/99',
					number: 99,
				}),
			});

			const agent = createMockAgent();
			// autoWork is false in config, but issue has the label
			const config = createConfig(tmpDir, {issueNumber: 42, maxIterations: 1});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should auto-approve because issue has AUTO_WORK label
			expect(issues.mergePR).toHaveBeenCalledWith(99);
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

		it('treats implementation as incomplete when agent does not delete task file', async () => {
			const issue = makeIssue({number: 20, title: 'Lazy agent'});
			writeTaskFile(tmpDir, 20, 1, 'do-thing');

			const issues = createMockIssueProvider({
				listIssues: vi
					.fn()
					.mockImplementation(async (opts?: {labels?: string[]; noLabels?: string[]}) => {
						if (opts?.labels?.includes(LABELS.TASKS_ACCEPTED)) return [issue];
						return [];
					}),
			});

			// Agent exits successfully but does NOT delete the task file
			const agent = createMockAgent({
				run: vi.fn().mockResolvedValue({output: 'done', exitCode: 0}),
			});

			const config = createConfig(tmpDir, {noPush: false});
			const orch = new Orchestrator(config, issues, agent);
			await orch.run();

			// Should NOT push or create PR since task was not completed
			expect(issues.createPR).not.toHaveBeenCalled();
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
