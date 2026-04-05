import {describe, it, expect} from 'vitest';
import {buildInvestigatePrompt, buildImplementPrompt, buildClarificationComment, buildEscalationComment} from '../src/prompts.js';
import type {Issue, Task} from '../src/types.js';

const sampleIssue: Issue = {
	number: 42,
	title: 'Add user authentication',
	body: 'We need to add login/logout functionality.',
	labels: [],
	url: 'https://github.com/org/repo/issues/42',
};

const sampleTask: Task = {
	id: '42-001',
	issue: 42,
	title: 'Setup auth middleware',
	dependsOn: [],
	content:
		'---\nid: "42-001"\nissue: 42\ntitle: "Setup auth middleware"\n---\n\n## Description\nAdd middleware.',
	filePath: 'tasks/42/001-setup-auth-middleware.md',
};

describe('buildInvestigatePrompt', () => {
	it('includes issue number and title', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('Issue #42');
		expect(prompt).toContain('Add user authentication');
	});

	it('includes issue body', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('We need to add login/logout functionality.');
	});

	it('includes issue URL', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('https://github.com/org/repo/issues/42');
	});

	it('includes the tasks directory path', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('tasks/42');
	});

	it('includes task file format with correct issue number in id', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('"42-<seq>"');
		expect(prompt).toContain('"42-001"');
	});

	it('includes commit instructions without push', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('git commit');
		expect(prompt).toContain('Do NOT push');
	});

	it('includes ambiguity escape hatch instructions', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('.whitesmith-ambiguity.md');
		expect(prompt).toContain('Ambiguity Escape Hatch');
	});

	it('tells the agent NOT to create task files when signaling ambiguity', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('Do NOT create any task files');
	});

	it('tells the agent NOT to commit when signaling ambiguity', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('Do NOT commit anything');
	});

	it('instructs the agent to include questions in the ambiguity file', () => {
		const prompt = buildInvestigatePrompt(sampleIssue, 'tasks/42');
		expect(prompt).toContain('Questions');
		expect(prompt).toContain('Summary');
	});
});

describe('buildClarificationComment', () => {
	it('includes the clarification text', () => {
		const text = '## Summary\nUnclear requirements.\n\n## Questions\n1. What is the scope?';
		const comment = buildClarificationComment(text);
		expect(comment).toContain('What is the scope?');
		expect(comment).toContain('Unclear requirements.');
	});

	it('includes the thinking emoji and header', () => {
		const comment = buildClarificationComment('Some questions');
		expect(comment).toContain('🤔');
		expect(comment).toContain('need clarification');
	});

	it('includes instructions to edit the issue', () => {
		const comment = buildClarificationComment('Some questions');
		expect(comment).toContain('Edit this issue');
		expect(comment).toContain('update the description');
	});

	it('includes re-analyze message', () => {
		const comment = buildClarificationComment('Some questions');
		expect(comment).toContain('automatically re-analyze');
	});

	it('trims whitespace from clarification text', () => {
		const comment = buildClarificationComment('  \n  Some questions  \n  ');
		expect(comment).toContain('Some questions');
		expect(comment).not.toContain('  \n  Some questions');
	});
});

describe('buildEscalationComment', () => {
	it('includes the warning emoji', () => {
		const comment = buildEscalationComment();
		expect(comment).toContain('⚠️');
	});

	it('includes human review needed message', () => {
		const comment = buildEscalationComment();
		expect(comment).toContain('Human review is needed');
	});

	it('includes instructions to remove labels', () => {
		const comment = buildEscalationComment();
		expect(comment).toContain('whitesmith:needs-human-review');
		expect(comment).toContain('whitesmith:needs-clarification');
	});

	it('mentions issue will not be auto-investigated', () => {
		const comment = buildEscalationComment();
		expect(comment).toContain('will not be auto-investigated');
	});
});

describe('buildImplementPrompt', () => {
	it('includes task title and id', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('Setup auth middleware');
		expect(prompt).toContain('42-001');
	});

	it('includes task file path', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('tasks/42/001-setup-auth-middleware.md');
	});

	it('includes issue context', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('Issue #42');
		expect(prompt).toContain('Add user authentication');
	});

	it('includes task content', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('Add middleware.');
	});

	it('instructs to delete the task file', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('Delete the task file');
		expect(prompt).toContain(`MUST delete \`${sampleTask.filePath}\``);
	});

	it('includes commit instructions without push', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('git commit');
		expect(prompt).toContain('Do NOT push');
	});

	it('includes cleanup instructions for empty directory', () => {
		const prompt = buildImplementPrompt(sampleTask, sampleIssue);
		expect(prompt).toContain('tasks/42/');
		expect(prompt).toContain('empty');
	});
});
