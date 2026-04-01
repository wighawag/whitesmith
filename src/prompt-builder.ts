import type { TaskProvider } from './providers/task-provider.js';
import type { Epic } from './types.js';
import { SIGNALS } from './types.js';

/**
 * Builds prompts for the agent in different modes
 */
export class PromptBuilder {
	/**
	 * Build the discovery prompt to find the next epic to work on
	 */
	buildDiscoveryPrompt(completedEpics: string[], provider: TaskProvider): string {
		let completedList = '';

		if (completedEpics.length > 0) {
			completedList = `IMPORTANT: The following epic IDs already have branches and should be considered COMPLETE (skip them):
${completedEpics.map((id) => `  - ${id}`).join('\n')}

`;
		}

		const providerInstructions = provider.getDiscoveryInstructions();

		return `You are an autonomous coding agent. Your ONLY task right now is to identify the next epic to work on.

${completedList}INSTRUCTIONS:
${providerInstructions}
2. Find the first epic that:
   - Does NOT have an existing branch (see list above if any)
   - Is not complete (has incomplete tasks)
   - Has all its dependencies (other epics) completed
3. Output ONLY the following three lines (nothing else):
   EPIC_ID: <id>
   EPIC_NAME: <name>
   DEPENDS_ON: <dependency_epic_id or empty if none>

4. If ALL epics are complete (including those with existing branches), output only:
   ${SIGNALS.RALPH_COMPLETE}

DO NOT:
- Make any code changes
- Commit anything
- Do any implementation work
- Work on any epic that already has a branch

This is ONLY a discovery phase to determine which epic to work on next.`;
	}

	/**
	 * Build the work prompt for implementing tasks in an epic
	 */
	buildWorkPrompt(epic: Epic, branchName: string, provider: TaskProvider): string {
		const providerInstructions = provider.getWorkInstructions(epic);

		return `You are an autonomous coding agent working on epic: ${epic.id} (${epic.name})

CURRENT BRANCH: ${branchName}
You are already on the correct branch. All commits will go to this branch.

MANDATORY: After completing ANY task, you MUST commit your changes.
Uncommitted work = incomplete work.

WORKFLOW:
${providerInstructions}

IMPORTANT:
- One task per iteration
- You MUST commit after completing the task
- Do NOT switch branches - stay on ${branchName}
- Always update status: epic and task to 'in-progress' when starting, 'done' when complete

FINAL CHECK: Did you commit? If not, do it now:
git add . ':!.ralph-epic-state' && git commit -m 'feat(${epic.id}): <description>'`;
	}

	/**
	 * Parse discovery output to extract epic information
	 */
	parseDiscoveryOutput(output: string): {
		isComplete: boolean;
		epicId?: string;
		epicName?: string;
		dependsOn?: string;
	} {
		// Check for all complete signal
		if (output.includes(SIGNALS.RALPH_COMPLETE)) {
			return { isComplete: true };
		}

		// Extract epic info using patterns that match the bash script
		const epicIdMatch = output.match(/^\s*EPIC_ID:\s*(.+)$/m);
		const epicNameMatch = output.match(/^\s*EPIC_NAME:\s*(.+)$/m);
		// DEPENDS_ON should only match epic ID patterns (e.g., EPIC-001) or empty
		const dependsOnMatch = output.match(/^\s*DEPENDS_ON:\s*([A-Z]+-\d+)?/m);

		const epicId = epicIdMatch?.[1]?.trim();
		const epicName = epicNameMatch?.[1]?.trim();
		// Only use dependsOn if it matches an epic ID pattern
		const dependsOn = dependsOnMatch?.[1]?.trim() || undefined;

		return {
			isComplete: false,
			epicId,
			epicName,
			dependsOn,
		};
	}

	/**
	 * Parse work output for completion signals and PR description
	 */
	parseWorkOutput(output: string): {
		isEpicComplete: boolean;
		isAllComplete: boolean;
		prDescription?: string;
	} {
		const isEpicComplete = output.includes(SIGNALS.EPIC_COMPLETE);
		const isAllComplete = output.includes(SIGNALS.RALPH_COMPLETE);

		// Extract PR description between markers
		let prDescription: string | undefined;
		const prMatch = output.match(/PR_DESCRIPTION_START\n([\s\S]*?)\nPR_DESCRIPTION_END/);
		if (prMatch) {
			prDescription = prMatch[1].trim();
		}

		return {
			isEpicComplete,
			isAllComplete,
			prDescription,
		};
	}
}
