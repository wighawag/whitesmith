import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RalphState } from './types.js';

const STATE_FILE_NAME = '.ralph-epic-state';

/**
 * Manages the state file that tracks the current epic being worked on.
 * Uses JSON format for safety instead of bash source files.
 */
export class StateManager {
	private stateFilePath: string;

	constructor(workDir: string) {
		this.stateFilePath = path.join(workDir, STATE_FILE_NAME);
	}

	/**
	 * Save the current epic state to the state file
	 */
	saveState(state: RalphState): void {
		const content = JSON.stringify(state, null, 2);
		fs.writeFileSync(this.stateFilePath, content, 'utf-8');
		console.log(`State saved: epic=${state.epicId} branch=${state.branchName}`);
	}

	/**
	 * Load the current epic state from the state file
	 * Returns undefined if no state file exists or it's invalid
	 */
	loadState(): RalphState | undefined {
		if (!fs.existsSync(this.stateFilePath)) {
			return undefined;
		}

		try {
			const content = fs.readFileSync(this.stateFilePath, 'utf-8');

			// Try JSON format first (new format)
			try {
				const state = JSON.parse(content) as RalphState;
				if (state.epicId && state.branchName) {
					console.log(`State loaded: epic=${state.epicId} branch=${state.branchName}`);
					return state;
				}
			} catch {
				// Not JSON, try parsing as bash format for backward compatibility
				const lines = content.split('\n');
				const state: Partial<RalphState> = {};

				for (const line of lines) {
					const match = line.match(/^SAVED_(\w+)="([^"]*)"/);
					if (match) {
						const [, key, value] = match;
						switch (key) {
							case 'EPIC_ID':
								state.epicId = value;
								break;
							case 'EPIC_NAME':
								state.epicName = value;
								break;
							case 'DEPENDS_ON':
								if (value) state.dependsOn = value;
								break;
							case 'BRANCH_NAME':
								state.branchName = value;
								break;
						}
					}
				}

				if (state.epicId && state.branchName && state.epicName) {
					console.log(`State loaded (bash format): epic=${state.epicId} branch=${state.branchName}`);
					return state as RalphState;
				}
			}
		} catch (error) {
			console.error('Failed to load state:', error);
		}

		return undefined;
	}

	/**
	 * Clear the state file (typically after completing an epic)
	 */
	clearState(): void {
		if (fs.existsSync(this.stateFilePath)) {
			fs.unlinkSync(this.stateFilePath);
		}
		console.log('State cleared');
	}

	/**
	 * Check if a state file exists
	 */
	hasState(): boolean {
		return fs.existsSync(this.stateFilePath);
	}

	/**
	 * Get the epic ID from the state file without loading full state
	 * Used to exclude in-progress epics from the "completed" list
	 */
	getInProgressEpicId(): string | undefined {
		if (!fs.existsSync(this.stateFilePath)) {
			return undefined;
		}

		try {
			const content = fs.readFileSync(this.stateFilePath, 'utf-8');

			// Try JSON format first
			try {
				const state = JSON.parse(content) as RalphState;
				return state.epicId;
			} catch {
				// Try bash format
				const match = content.match(/SAVED_EPIC_ID="([^"]*)"/);
				return match?.[1];
			}
		} catch {
			return undefined;
		}
	}

	/**
	 * Get the path to the state file (for exclusion from git commits)
	 */
	getStateFileName(): string {
		return STATE_FILE_NAME;
	}
}
