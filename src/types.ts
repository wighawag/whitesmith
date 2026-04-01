/**
 * Status values for epics and tasks
 */
export type Status = 'pending' | 'in-progress' | 'done';

/**
 * Represents an epic (high-level grouping of tasks)
 */
export interface Epic {
	id: string;
	name: string;
	dependsOn?: string;
	status: Status;
}

/**
 * Represents a task within an epic
 */
export interface Task {
	id: string;
	epicId: string;
	name: string;
	status: Status;
	acceptanceCriteria?: string[];
}

/**
 * Configuration options for the ralph-epic CLI
 */
export interface RalphConfig {
	/** Command to run the agent (default: "claude --dangerously-skip-permissions -p") */
	agentCmd: string;
	/** Maximum number of iterations (default: 50) */
	maxIterations: number;
	/** Branch prefix for epic branches (default: "ralph") */
	branchPrefix: string;
	/** Path to log file (optional) */
	logFile?: string;
	/** Skip pushing branches and creating PRs */
	noPush: boolean;
	/** Skip sleep between iterations (for testing) */
	noSleep: boolean;
	/** Working directory */
	workDir: string;
}

/**
 * State saved between iterations to resume work
 */
export interface RalphState {
	epicId: string;
	epicName: string;
	dependsOn?: string;
	branchName: string;
}

/**
 * Signals used to communicate between agent and orchestrator
 */
export const SIGNALS = {
	/** All epics are complete */
	RALPH_COMPLETE: 'RALPH_COMPLETE',
	/** Current epic is complete */
	EPIC_COMPLETE: 'EPIC_COMPLETE',
	/** PR description markers */
	PR_DESCRIPTION_START: 'PR_DESCRIPTION_START',
	PR_DESCRIPTION_END: 'PR_DESCRIPTION_END',
} as const;

/**
 * Result of parsing agent discovery output
 */
export interface DiscoveryResult {
	epicId: string;
	epicName: string;
	dependsOn?: string;
	isComplete: boolean;
}

/**
 * Result of parsing agent work output
 */
export interface WorkResult {
	output: string;
	isEpicComplete: boolean;
	isAllComplete: boolean;
	prDescription?: string;
}
