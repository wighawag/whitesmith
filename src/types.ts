/**
 * A GitHub issue (or equivalent) created by a human.
 * Represents a problem, feature request, or improvement.
 */
export interface Issue {
	/** Issue number (e.g. 42) */
	number: number;
	/** Issue title */
	title: string;
	/** Issue body/description (markdown) */
	body: string;
	/** Current labels on the issue */
	labels: string[];
	/** Issue URL */
	url: string;
}

/**
 * A task generated from an issue.
 * Each task represents a single PR's worth of work.
 */
export interface Task {
	/** Unique task ID: "<issue>-<seq>" e.g. "42-001" */
	id: string;
	/** Parent issue number */
	issue: number;
	/** Human-readable title */
	title: string;
	/** Task IDs this depends on (must be completed first) */
	dependsOn: string[];
	/** Full markdown content of the task file (including frontmatter) */
	content: string;
	/** File path relative to repo root */
	filePath: string;
}

/**
 * Parsed frontmatter from a task file
 */
export interface TaskFrontmatter {
	id: string;
	issue: number;
	title: string;
	depends_on?: string[];
}

/**
 * Labels used by whitesmith to track issue state
 */
export const LABELS = {
	/** Agent is generating tasks for this issue */
	INVESTIGATING: 'whitesmith:investigating',
	/** A PR with generated tasks has been opened */
	TASKS_PROPOSED: 'whitesmith:tasks-proposed',
	/** Task PR has been merged — tasks are on main */
	TASKS_ACCEPTED: 'whitesmith:tasks-accepted',
	/** All tasks for this issue have been completed */
	COMPLETED: 'whitesmith:completed',
	/** Auto-work mode: auto-approve task PRs */
	AUTO_WORK: 'whitesmith:auto-work',
	/** Issue needs clarification before tasks can be generated */
	NEEDS_CLARIFICATION: 'whitesmith:needs-clarification',
	/** Issue needs human review after repeated ambiguity cycles */
	NEEDS_HUMAN_REVIEW: 'whitesmith:needs-human-review',
} as const;

/**
 * Configuration for whitesmith
 */
export interface DevPulseConfig {
	/** Command to run the agent harness */
	agentCmd: string;
	/** AI provider name (e.g. 'anthropic', 'openai') */
	provider: string;
	/** AI model ID (e.g. 'claude-opus-4-6') */
	model: string;
	/** Maximum iterations per run */
	maxIterations: number;
	/** Working directory (the repo) */
	workDir: string;
	/** Skip pushing branches and creating PRs */
	noPush: boolean;
	/** Skip sleep between iterations (for testing) */
	noSleep: boolean;
	/** Print what would be done without executing it */
	dryRun: boolean;
	/** Enable auto-work mode (auto-approve task PRs) */
	autoWork: boolean;
	/** Enable review step after PRs are created (on by default) */
	review: boolean;
	/** Log file path */
	logFile?: string;
	/** GitHub repo in "owner/repo" format (auto-detected if not set) */
	repo?: string;
	/** Target a single issue number (single-issue run mode) */
	issueNumber?: number;
	/** Maximum ambiguity cycles before escalating to human review (default: 3) */
	maxAmbiguityCycles?: number;
}

/**
 * Result of the investigate phase.
 * Either tasks were generated, or the agent signaled ambiguity.
 */
export type InvestigateResult =
	| { outcome: 'tasks'; taskCount: number }
	| { outcome: 'ambiguous'; clarificationComment: string };

/**
 * What the orchestrator should do next
 */
export type Action =
	| {type: 'reconcile'; issue: Issue}
	| {type: 'auto-approve'; issue: Issue}
	| {type: 'investigate'; issue: Issue}
	| {type: 'implement'; task: Task; issue: Issue}
	| {type: 'idle'};
