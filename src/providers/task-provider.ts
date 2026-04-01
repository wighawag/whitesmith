import type { Epic, Task, Status } from '../types.js';

/**
 * Interface for task providers that can discover and manage epics/tasks
 * from various sources (markplane, GitHub Projects, etc.)
 */
export interface TaskProvider {
	/**
	 * Get all epics from the provider
	 */
	listEpics(): Promise<Epic[]>;

	/**
	 * Get all tasks for a specific epic
	 */
	getEpicTasks(epicId: string): Promise<Task[]>;

	/**
	 * Update the status of an epic
	 */
	setEpicStatus(epicId: string, status: Status): Promise<void>;

	/**
	 * Update the status of a task
	 */
	setTaskStatus(taskId: string, status: Status): Promise<void>;

	/**
	 * Sync changes with the provider backend
	 */
	sync(): Promise<void>;

	/**
	 * Get provider-specific instructions for epic discovery prompts
	 */
	getDiscoveryInstructions(): string;

	/**
	 * Get provider-specific instructions for work prompts
	 */
	getWorkInstructions(epic: Epic): string;
}
