import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../src/prompt-builder.js';
import type { TaskProvider } from '../../src/providers/task-provider.js';
import type { Epic, Status } from '../../src/types.js';

// Mock provider for testing
const mockProvider: TaskProvider = {
	listEpics: async () => [],
	getEpicTasks: async () => [],
	setEpicStatus: async () => {},
	setTaskStatus: async () => {},
	sync: async () => {},
	getDiscoveryInstructions: () => '1. Use markplane to list all epics and their dependencies',
	getWorkInstructions: (epic: Epic) =>
		`1. Work on epic ${epic.id}
2. Mark tasks as done when complete`,
};

describe('PromptBuilder', () => {
	const promptBuilder = new PromptBuilder();

	describe('buildDiscoveryPrompt', () => {
		it('should include provider discovery instructions', () => {
			const prompt = promptBuilder.buildDiscoveryPrompt([], mockProvider);
			expect(prompt).toContain('Use markplane to list all epics');
		});

		it('should include RALPH_COMPLETE signal info', () => {
			const prompt = promptBuilder.buildDiscoveryPrompt([], mockProvider);
			expect(prompt).toContain('RALPH_COMPLETE');
		});

		it('should not include completed epics list when empty', () => {
			const prompt = promptBuilder.buildDiscoveryPrompt([], mockProvider);
			expect(prompt).not.toContain('already have branches');
		});

		it('should include completed epics list when provided', () => {
			const prompt = promptBuilder.buildDiscoveryPrompt(['EPIC-001', 'EPIC-002'], mockProvider);
			expect(prompt).toContain('already have branches');
			expect(prompt).toContain('EPIC-001');
			expect(prompt).toContain('EPIC-002');
		});

		it('should format completed epics as a list', () => {
			const prompt = promptBuilder.buildDiscoveryPrompt(['EPIC-001', 'EPIC-002'], mockProvider);
			expect(prompt).toContain('  - EPIC-001');
			expect(prompt).toContain('  - EPIC-002');
		});
	});

	describe('buildWorkPrompt', () => {
		const epic: Epic = {
			id: 'EPIC-001',
			name: 'User Authentication',
			status: 'in-progress',
		};

		it('should include epic ID and name', () => {
			const prompt = promptBuilder.buildWorkPrompt(epic, 'ralph/epic-EPIC-001-test', mockProvider);
			expect(prompt).toContain('EPIC-001');
			expect(prompt).toContain('User Authentication');
		});

		it('should include branch name', () => {
			const prompt = promptBuilder.buildWorkPrompt(epic, 'ralph/epic-EPIC-001-test', mockProvider);
			expect(prompt).toContain('ralph/epic-EPIC-001-test');
			expect(prompt).toContain('CURRENT BRANCH: ralph/epic-EPIC-001-test');
		});

		it('should include provider work instructions', () => {
			const prompt = promptBuilder.buildWorkPrompt(epic, 'ralph/epic-EPIC-001-test', mockProvider);
			expect(prompt).toContain('Work on epic EPIC-001');
		});

		it('should include commit instructions', () => {
			const prompt = promptBuilder.buildWorkPrompt(epic, 'ralph/epic-EPIC-001-test', mockProvider);
			expect(prompt).toContain('git add');
			expect(prompt).toContain('git commit');
		});

		it('should mention the state file exclusion', () => {
			const prompt = promptBuilder.buildWorkPrompt(epic, 'ralph/epic-EPIC-001-test', mockProvider);
			expect(prompt).toContain('.ralph-epic-state');
		});
	});

	describe('parseDiscoveryOutput', () => {
		it('should detect RALPH_COMPLETE signal', () => {
			const result = promptBuilder.parseDiscoveryOutput('Some output\nRALPH_COMPLETE\nMore output');
			expect(result.isComplete).toBe(true);
		});

		it('should extract epic ID', () => {
			const output = `EPIC_ID: EPIC-001
EPIC_NAME: User Authentication
DEPENDS_ON:`;
			const result = promptBuilder.parseDiscoveryOutput(output);
			expect(result.epicId).toBe('EPIC-001');
		});

		it('should extract epic name', () => {
			const output = `EPIC_ID: EPIC-001
EPIC_NAME: User Authentication
DEPENDS_ON:`;
			const result = promptBuilder.parseDiscoveryOutput(output);
			expect(result.epicName).toBe('User Authentication');
		});

		it('should extract dependsOn', () => {
			const output = `EPIC_ID: EPIC-002
EPIC_NAME: Dashboard
DEPENDS_ON: EPIC-001`;
			const result = promptBuilder.parseDiscoveryOutput(output);
			expect(result.dependsOn).toBe('EPIC-001');
		});

		it('should handle empty dependsOn', () => {
			const output = `EPIC_ID: EPIC-001
EPIC_NAME: First Epic
DEPENDS_ON:`;
			const result = promptBuilder.parseDiscoveryOutput(output);
			expect(result.dependsOn).toBeUndefined();
		});

		it('should ignore non-epic text after DEPENDS_ON', () => {
			const output = `EPIC_ID: EPIC-001
EPIC_NAME: First Epic
DEPENDS_ON: 

--- Mock agent discovery complete ---`;
			const result = promptBuilder.parseDiscoveryOutput(output);
			expect(result.dependsOn).toBeUndefined();
		});

		it('should handle leading whitespace in output', () => {
			const output = `  EPIC_ID: EPIC-001
  EPIC_NAME: Test
  DEPENDS_ON:`;
			const result = promptBuilder.parseDiscoveryOutput(output);
			expect(result.epicId).toBe('EPIC-001');
			expect(result.epicName).toBe('Test');
		});
	});

	describe('parseWorkOutput', () => {
		it('should detect EPIC_COMPLETE signal', () => {
			const result = promptBuilder.parseWorkOutput('Task done!\nEPIC_COMPLETE\nMore output');
			expect(result.isEpicComplete).toBe(true);
		});

		it('should detect RALPH_COMPLETE signal', () => {
			const result = promptBuilder.parseWorkOutput('All done!\nRALPH_COMPLETE');
			expect(result.isAllComplete).toBe(true);
		});

		it('should extract PR description', () => {
			const output = `EPIC_COMPLETE

PR_DESCRIPTION_START
## Summary
This PR implements user authentication.

### Changes
- Added login page
- Added logout functionality
PR_DESCRIPTION_END

Done!`;
			const result = promptBuilder.parseWorkOutput(output);
			expect(result.prDescription).toContain('## Summary');
			expect(result.prDescription).toContain('Added login page');
		});

		it('should return undefined prDescription when not present', () => {
			const result = promptBuilder.parseWorkOutput('EPIC_COMPLETE');
			expect(result.prDescription).toBeUndefined();
		});

		it('should handle output with both signals', () => {
			const result = promptBuilder.parseWorkOutput('EPIC_COMPLETE\nRALPH_COMPLETE');
			expect(result.isEpicComplete).toBe(true);
			expect(result.isAllComplete).toBe(true);
		});
	});
});
