import type {Issue} from '../types.js';

/**
 * Interface for issue sources.
 * Implementations can back this with GitHub Issues, GitLab, Jira, etc.
 */
export interface IssueProvider {
	/**
	 * List open issues, optionally filtered by labels
	 */
	listIssues(options?: {labels?: string[]; noLabels?: string[]}): Promise<Issue[]>;

	/**
	 * Get a single issue by number
	 */
	getIssue(number: number): Promise<Issue>;

	/**
	 * Add a label to an issue
	 */
	addLabel(number: number, label: string): Promise<void>;

	/**
	 * Remove a label from an issue
	 */
	removeLabel(number: number, label: string): Promise<void>;

	/**
	 * Post a comment on an issue
	 */
	comment(number: number, body: string): Promise<void>;

	/**
	 * Close an issue
	 */
	closeIssue(number: number): Promise<void>;

	/**
	 * Create a pull request and return its URL
	 */
	createPR(options: {head: string; base: string; title: string; body: string}): Promise<string>;

	/**
	 * Check if a remote branch exists
	 */
	remoteBranchExists(branch: string): Promise<boolean>;

	/**
	 * Check if there's an open or merged PR for a given head branch
	 */
	getPRForBranch(
		branch: string,
	): Promise<{state: 'open' | 'merged' | 'closed'; url: string; number: number} | null>;

	/**
	 * Merge a pull request by number
	 */
	mergePR(number: number): Promise<void>;

	/**
	 * Ensure required labels exist in the repo (create if missing)
	 */
	ensureLabels(labels: string[]): Promise<void>;

	/**
	 * List PRs whose head branch matches a prefix
	 */
	listPRsByBranchPrefix(
		prefix: string,
	): Promise<Array<{branch: string; number: number; title: string; state: string; url: string}>>;

	/**
	 * List comments on an issue
	 */
	listComments(number: number): Promise<Array<{author: string; body: string}>>;

	/**
	 * Get PR details by number (branch, state, body, etc.)
	 */
	getPR(number: number): Promise<{
		branch: string;
		number: number;
		title: string;
		state: string;
		url: string;
		body: string;
	} | null>;
}
