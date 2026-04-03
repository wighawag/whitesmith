import {describe, it, expect, vi} from 'vitest';
import {
	buildReviewTaskProposalPrompt,
	buildReviewImplementationPRPrompt,
	buildReviewTaskCompletionPrompt,
} from '../src/prompts.js';
import {detectReviewTarget, parseReviewVerdict} from '../src/review.js';
import type {IssueProvider} from '../src/providers/issue-provider.js';
import type {Issue} from '../src/types.js';

// --- Prompt tests ---

describe('buildReviewTaskProposalPrompt', () => {
	const baseArgs = {
		issueNumber: 42,
		issueTitle: 'Add user authentication',
		issueBody: 'We need login/logout.',
		issueUrl: 'https://github.com/org/repo/issues/42',
		tasks: [
			{
				id: '42-001',
				title: 'Setup auth middleware',
				content: '## Description\nAdd middleware.',
				filePath: 'tasks/42/001-setup-auth.md',
			},
		],
		responseFile: '.whitesmith-review.md',
	};

	it('includes issue number and title', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('Issue #42');
		expect(prompt).toContain('Add user authentication');
	});

	it('includes issue body', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('We need login/logout.');
	});

	it('includes task details', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('42-001');
		expect(prompt).toContain('Setup auth middleware');
		expect(prompt).toContain('tasks/42/001-setup-auth.md');
		expect(prompt).toContain('Add middleware.');
	});

	it('includes review criteria', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('Coverage');
		expect(prompt).toContain('Clarity');
		expect(prompt).toContain('Acceptance Criteria');
	});

	it('includes VERDICT instruction', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('VERDICT: APPROVE');
		expect(prompt).toContain('VERDICT: REQUEST_CHANGES');
	});

	it('includes response file path', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('.whitesmith-review.md');
	});

	it('instructs not to modify files other than response', () => {
		const prompt = buildReviewTaskProposalPrompt(baseArgs);
		expect(prompt).toContain('Do NOT modify any files other than');
	});

	it('includes task PR URL when provided', () => {
		const prompt = buildReviewTaskProposalPrompt({
			...baseArgs,
			taskPRUrl: 'https://github.com/org/repo/pull/5',
		});
		expect(prompt).toContain('https://github.com/org/repo/pull/5');
	});

	it('shows placeholder when no tasks found', () => {
		const prompt = buildReviewTaskProposalPrompt({...baseArgs, tasks: []});
		expect(prompt).toContain('No task files found');
	});
});

describe('buildReviewImplementationPRPrompt', () => {
	const baseArgs = {
		prNumber: 10,
		prTitle: 'feat(#42): Add auth',
		prBody: 'Implements authentication.',
		prBranch: 'issue/42',
		prUrl: 'https://github.com/org/repo/pull/10',
		responseFile: '.whitesmith-review.md',
	};

	it('includes PR number and title', () => {
		const prompt = buildReviewImplementationPRPrompt(baseArgs);
		expect(prompt).toContain('Pull Request #10');
		expect(prompt).toContain('feat(#42): Add auth');
	});

	it('includes PR body and branch', () => {
		const prompt = buildReviewImplementationPRPrompt(baseArgs);
		expect(prompt).toContain('Implements authentication.');
		expect(prompt).toContain('issue/42');
	});

	it('includes code review criteria', () => {
		const prompt = buildReviewImplementationPRPrompt(baseArgs);
		expect(prompt).toContain('Correctness');
		expect(prompt).toContain('Edge Cases');
		expect(prompt).toContain('Security');
		expect(prompt).toContain('Performance');
		expect(prompt).toContain('Tests');
	});

	it('includes diff instruction', () => {
		const prompt = buildReviewImplementationPRPrompt(baseArgs);
		expect(prompt).toContain('git diff main...HEAD');
	});

	it('includes parent issue when provided', () => {
		const prompt = buildReviewImplementationPRPrompt({
			...baseArgs,
			parentIssue: {
				number: 42,
				title: 'Add auth',
				body: 'Need login.',
				url: 'https://github.com/org/repo/issues/42',
			},
		});
		expect(prompt).toContain('Parent Issue');
		expect(prompt).toContain('#42');
		expect(prompt).toContain('Need login.');
	});

	it('does not include parent issue section when absent', () => {
		const prompt = buildReviewImplementationPRPrompt(baseArgs);
		expect(prompt).not.toContain('Parent Issue');
	});
});

describe('buildReviewTaskCompletionPrompt', () => {
	const baseArgs = {
		issueNumber: 42,
		issueTitle: 'Add user authentication',
		issueBody: 'We need login/logout.',
		issueUrl: 'https://github.com/org/repo/issues/42',
		implBranch: 'issue/42',
		responseFile: '.whitesmith-review.md',
	};

	it('includes issue number and title', () => {
		const prompt = buildReviewTaskCompletionPrompt(baseArgs);
		expect(prompt).toContain('Issue #42');
		expect(prompt).toContain('Add user authentication');
	});

	it('includes completion review criteria', () => {
		const prompt = buildReviewTaskCompletionPrompt(baseArgs);
		expect(prompt).toContain('Task Adherence');
		expect(prompt).toContain('Completeness');
		expect(prompt).toContain('Bugs');
		expect(prompt).toContain('Regressions');
	});

	it('includes git log instruction', () => {
		const prompt = buildReviewTaskCompletionPrompt(baseArgs);
		expect(prompt).toContain('git log main..HEAD');
	});

	it('includes git show for original tasks', () => {
		const prompt = buildReviewTaskCompletionPrompt(baseArgs);
		expect(prompt).toContain('git show main:tasks/42/');
	});

	it('includes implementation PR URL when provided', () => {
		const prompt = buildReviewTaskCompletionPrompt({
			...baseArgs,
			implPRUrl: 'https://github.com/org/repo/pull/11',
		});
		expect(prompt).toContain('https://github.com/org/repo/pull/11');
	});
});

// --- parseReviewVerdict tests ---

describe('parseReviewVerdict', () => {
	it('parses VERDICT: APPROVE', () => {
		expect(parseReviewVerdict('VERDICT: APPROVE\n\nLooks good!')).toBe('approve');
	});

	it('parses VERDICT: APPROVED', () => {
		expect(parseReviewVerdict('VERDICT: APPROVED\n\nAll good.')).toBe('approve');
	});

	it('parses VERDICT: REQUEST_CHANGES', () => {
		expect(parseReviewVerdict('VERDICT: REQUEST_CHANGES\n\nNeeds work.')).toBe('request_changes');
	});

	it('parses verdict with bold markdown', () => {
		expect(parseReviewVerdict('**VERDICT**: APPROVE\n\nNice.')).toBe('approve');
	});

	it('parses verdict case-insensitively', () => {
		expect(parseReviewVerdict('verdict: approve\nGreat!')).toBe('approve');
	});

	it('parses verdict with leading whitespace', () => {
		expect(parseReviewVerdict('  VERDICT: REQUEST_CHANGES\nBad.')).toBe('request_changes');
	});

	it('detects REJECT in verdict value', () => {
		expect(parseReviewVerdict('VERDICT: REJECT\nNo way.')).toBe('request_changes');
	});

	it('falls back to overall assessment approve pattern', () => {
		expect(parseReviewVerdict('Some text\n\nOverall Assessment: Approve\nDone.')).toBe('approve');
	});

	it('falls back to overall assessment request changes pattern', () => {
		expect(parseReviewVerdict('Some text\n\nOverall Assessment: Request Changes\nNope.')).toBe(
			'request_changes',
		);
	});

	it('falls back to ✅ approved emoji pattern', () => {
		expect(parseReviewVerdict('\n✅ Approved\nShip it.')).toBe('approve');
	});

	it('falls back to ❌ request changes emoji pattern', () => {
		expect(parseReviewVerdict('\n❌ Request Changes\nFix it.')).toBe('request_changes');
	});

	it('returns unknown for null response', () => {
		expect(parseReviewVerdict(null)).toBe('unknown');
	});

	it('returns unknown for unrecognized text', () => {
		expect(parseReviewVerdict('This is some random review text without a verdict.')).toBe(
			'unknown',
		);
	});

	it('returns unknown for empty string', () => {
		expect(parseReviewVerdict('')).toBe('unknown');
	});
});

// --- detectReviewTarget tests ---

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

describe('detectReviewTarget', () => {
	it('detects investigate branch as issue-tasks', async () => {
		const issues = createMockIssueProvider({
			getPR: vi.fn().mockResolvedValue({
				branch: 'investigate/42',
				number: 10,
				title: 'tasks(#42)',
				state: 'open',
				url: 'https://github.com/test/repo/pull/10',
				body: '',
			}),
		});

		const target = await detectReviewTarget(10, issues);
		expect(target).toEqual({type: 'issue-tasks', issueNumber: 42});
	});

	it('detects issue branch as issue-tasks-completed', async () => {
		const issues = createMockIssueProvider({
			getPR: vi.fn().mockResolvedValue({
				branch: 'issue/42',
				number: 11,
				title: 'feat(#42)',
				state: 'open',
				url: 'https://github.com/test/repo/pull/11',
				body: '',
			}),
		});

		const target = await detectReviewTarget(11, issues);
		expect(target).toEqual({type: 'issue-tasks-completed', issueNumber: 42});
	});

	it('detects non-whitesmith PR as generic pr review', async () => {
		const issues = createMockIssueProvider({
			getPR: vi.fn().mockResolvedValue({
				branch: 'feature/cool-stuff',
				number: 12,
				title: 'Cool stuff',
				state: 'open',
				url: 'https://github.com/test/repo/pull/12',
				body: '',
			}),
		});

		const target = await detectReviewTarget(12, issues);
		expect(target).toEqual({type: 'pr', number: 12});
	});

	it('detects issue with tasks-accepted label as issue-tasks-completed', async () => {
		const issues = createMockIssueProvider({
			getPR: vi.fn().mockResolvedValue(null), // not a PR
			getIssue: vi
				.fn()
				.mockResolvedValue(makeIssue({number: 42, labels: ['whitesmith:tasks-accepted']})),
		});

		const target = await detectReviewTarget(42, issues);
		expect(target).toEqual({type: 'issue-tasks-completed', issueNumber: 42});
	});

	it('detects issue with tasks-proposed label as issue-tasks', async () => {
		const issues = createMockIssueProvider({
			getPR: vi.fn().mockResolvedValue(null),
			getIssue: vi
				.fn()
				.mockResolvedValue(makeIssue({number: 42, labels: ['whitesmith:tasks-proposed']})),
		});

		const target = await detectReviewTarget(42, issues);
		expect(target).toEqual({type: 'issue-tasks', issueNumber: 42});
	});

	it('defaults to issue-tasks for issue with no whitesmith labels', async () => {
		const issues = createMockIssueProvider({
			getPR: vi.fn().mockResolvedValue(null),
			getIssue: vi.fn().mockResolvedValue(makeIssue({number: 42, labels: []})),
		});

		const target = await detectReviewTarget(42, issues);
		expect(target).toEqual({type: 'issue-tasks', issueNumber: 42});
	});
});
