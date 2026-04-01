import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskProvider } from './task-provider.js';
import type { Epic, Task, Status } from '../types.js';
import { SIGNALS } from '../types.js';

const execAsync = promisify(exec);

/**
 * Provider implementation for Markplane CLI
 * Uses markplane commands to manage epics and tasks
 */
export class MarkplaneProvider implements TaskProvider {
	private workDir: string;

	constructor(workDir: string) {
		this.workDir = workDir;
	}

	/**
	 * Execute a markplane command and return stdout
	 */
	private async runMarkplane(args: string): Promise<string> {
		try {
			const { stdout } = await execAsync(`markplane ${args}`, {
				cwd: this.workDir,
			});
			return stdout;
		} catch (error) {
			const execError = error as { stderr?: string; message?: string };
			throw new Error(`markplane ${args} failed: ${execError.stderr || execError.message}`);
		}
	}

	async listEpics(): Promise<Epic[]> {
		const output = await this.runMarkplane('epic list');
		return this.parseEpicList(output);
	}

	async getEpicTasks(epicId: string): Promise<Task[]> {
		const output = await this.runMarkplane(`task list --epic ${epicId}`);
		return this.parseTaskList(output, epicId);
	}

	async setEpicStatus(epicId: string, status: Status): Promise<void> {
		await this.runMarkplane(`epic status ${epicId} ${status}`);
	}

	async setTaskStatus(taskId: string, status: Status): Promise<void> {
		await this.runMarkplane(`task status ${taskId} ${status}`);
	}

	async sync(): Promise<void> {
		await this.runMarkplane('sync');
	}

	getDiscoveryInstructions(): string {
		return `1. Use markplane to list all epics and their dependencies`;
	}

	getWorkInstructions(epic: Epic): string {
		return `1. First, mark the epic as 'in-progress' using markplane (if not already):
   markplane epic status ${epic.id} in-progress
2. Find the first incomplete task in this epic using markplane
3. Mark the task as 'in-progress':
   markplane task status <TASK_ID> in-progress
4. Implement it following the specs
5. Check the acceptance criteria
6. If they pass, mark the task as 'done':
   markplane task status <TASK_ID> done
7. Run: markplane sync
8. COMMIT your changes: git add . ':!.ralph-epic-state' && git commit -m 'feat(${epic.id}): <description>'
9. If all tasks IN THIS EPIC are now done:
   - Mark the epic as 'done': markplane epic status ${epic.id} done
   - Run: markplane sync
   - Write: ${SIGNALS.EPIC_COMPLETE}
   - Provide a PR description:
     ${SIGNALS.PR_DESCRIPTION_START}
     <your detailed PR description>
     ${SIGNALS.PR_DESCRIPTION_END}`;
	}

	/**
	 * Parse the output of "markplane epic list"
	 * Expected format varies, but typically includes ID, name, status, dependencies
	 */
	private parseEpicList(output: string): Epic[] {
		const epics: Epic[] = [];
		const lines = output.trim().split('\n');

		for (const line of lines) {
			// Try to parse various formats
			// Format 1: "EPIC-001 | User Authentication | pending | depends: none"
			// Format 2: "EPIC-001: User Authentication [pending]"
			// Format 3: JSON output

			// Try JSON first
			try {
				const parsed = JSON.parse(line);
				if (Array.isArray(parsed)) {
					return parsed.map((e) => ({
						id: e.id,
						name: e.name,
						status: e.status || 'pending',
						dependsOn: e.dependsOn || e.depends_on,
					}));
				}
			} catch {
				// Not JSON, try other formats
			}

			// Try pipe-delimited format
			const pipeMatch = line.match(/^([A-Z]+-\d+)\s*\|\s*([^|]+)\s*\|\s*(pending|in-progress|done)/i);
			if (pipeMatch) {
				const [, id, name, status] = pipeMatch;
				const dependsMatch = line.match(/depends:\s*([A-Z]+-\d+)/i);
				epics.push({
					id: id.trim(),
					name: name.trim(),
					status: status.trim() as Status,
					dependsOn: dependsMatch?.[1],
				});
				continue;
			}

			// Try colon/bracket format
			const colonMatch = line.match(/^([A-Z]+-\d+):\s*([^[]+)\s*\[(pending|in-progress|done)\]/i);
			if (colonMatch) {
				const [, id, name, status] = colonMatch;
				epics.push({
					id: id.trim(),
					name: name.trim(),
					status: status.trim() as Status,
				});
			}
		}

		return epics;
	}

	/**
	 * Parse the output of "markplane task list"
	 */
	private parseTaskList(output: string, epicId: string): Task[] {
		const tasks: Task[] = [];
		const lines = output.trim().split('\n');

		for (const line of lines) {
			// Try JSON first
			try {
				const parsed = JSON.parse(line);
				if (Array.isArray(parsed)) {
					return parsed.map((t) => ({
						id: t.id,
						epicId: t.epicId || t.epic_id || epicId,
						name: t.name,
						status: t.status || 'pending',
						acceptanceCriteria: t.acceptanceCriteria || t.acceptance_criteria,
					}));
				}
			} catch {
				// Not JSON
			}

			// Try pipe-delimited format
			const pipeMatch = line.match(/^([A-Z]+-\d+-\d+)\s*\|\s*([^|]+)\s*\|\s*(pending|in-progress|done)/i);
			if (pipeMatch) {
				const [, id, name, status] = pipeMatch;
				tasks.push({
					id: id.trim(),
					epicId,
					name: name.trim(),
					status: status.trim() as Status,
				});
			}
		}

		return tasks;
	}
}
