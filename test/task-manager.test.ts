import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskManager } from '../src/task-manager.js';

describe('TaskManager', () => {
	let tmpDir: string;
	let mgr: TaskManager;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-pulse-test-'));
		mgr = new TaskManager(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeTaskFile(issueNumber: number, seq: number, slug: string, extra: string = '') {
		const dir = path.join(tmpDir, 'tasks', String(issueNumber));
		fs.mkdirSync(dir, { recursive: true });
		const seqStr = String(seq).padStart(3, '0');
		const id = `${issueNumber}-${seqStr}`;
		const content = `---
id: "${id}"
issue: ${issueNumber}
title: "Task ${seq} for issue ${issueNumber}"
depends_on: [${extra}]
---

## Description
Test task.
`;
		fs.writeFileSync(path.join(dir, `${seqStr}-task-${seq}.md`), content);
		return id;
	}

	it('lists tasks for an issue', () => {
		writeTaskFile(42, 1, 'first');
		writeTaskFile(42, 2, 'second');

		const tasks = mgr.listTasks(42);
		expect(tasks).toHaveLength(2);
		expect(tasks[0].id).toBe('42-001');
		expect(tasks[1].id).toBe('42-002');
	});

	it('returns empty for non-existent issue', () => {
		expect(mgr.listTasks(999)).toHaveLength(0);
	});

	it('lists all tasks across issues', () => {
		writeTaskFile(1, 1, 'a');
		writeTaskFile(2, 1, 'b');
		writeTaskFile(2, 2, 'c');

		const all = mgr.listAllTasks();
		expect(all).toHaveLength(3);
	});

	it('checks remaining tasks', () => {
		writeTaskFile(42, 1, 'a');
		expect(mgr.hasRemainingTasks(42)).toBe(true);
		expect(mgr.hasRemainingTasks(99)).toBe(false);
	});

	it('writes a task file', () => {
		const relPath = mgr.writeTask(
			10,
			1,
			'setup-database',
			{ id: '10-001', issue: 10, title: 'Setup database' },
			'## Description\nCreate the database schema.'
		);

		expect(relPath).toBe('tasks/10/001-setup-database.md');

		const tasks = mgr.listTasks(10);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe('Setup database');
	});

	it('deletes a task file', () => {
		writeTaskFile(42, 1, 'a');
		const tasks = mgr.listTasks(42);
		expect(tasks).toHaveLength(1);

		mgr.deleteTask(tasks[0].filePath);
		expect(mgr.listTasks(42)).toHaveLength(0);

		// Directory should be cleaned up
		expect(fs.existsSync(path.join(tmpDir, 'tasks', '42'))).toBe(false);
	});

	it('checks dependency satisfaction', () => {
		writeTaskFile(42, 1, 'first');
		writeTaskFile(42, 2, 'second', '"42-001"');

		const tasks = mgr.listTasks(42);
		const task1 = tasks.find((t) => t.id === '42-001')!;
		const task2 = tasks.find((t) => t.id === '42-002')!;

		// Task 1 has no deps — satisfied
		expect(mgr.areDependenciesSatisfied(task1)).toBe(true);

		// Task 2 depends on task 1 which still exists — not satisfied
		expect(mgr.areDependenciesSatisfied(task2)).toBe(false);

		// Delete task 1 — now task 2's deps are satisfied
		mgr.deleteTask(task1.filePath);
		expect(mgr.areDependenciesSatisfied(task2)).toBe(true);
	});

	it('gets issue numbers with tasks', () => {
		writeTaskFile(5, 1, 'a');
		writeTaskFile(12, 1, 'b');
		writeTaskFile(3, 1, 'c');

		const issues = mgr.getIssuesWithTasks();
		expect(issues).toEqual([3, 5, 12]);
	});
});
