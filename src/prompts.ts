import type {Issue, Task} from './types.js';

/**
 * Build the prompt for the "investigate" phase.
 * The agent reads the issue, understands the codebase, and generates task files.
 */
export function buildInvestigatePrompt(issue: Issue, issueTasksDir: string): string {
	return `# Task: Generate implementation tasks for Issue #${issue.number}

## Issue
**Title:** ${issue.title}
**URL:** ${issue.url}

### Description
${issue.body}

## Your Job

You are an AI assistant helping break down a GitHub issue into concrete implementation tasks.
**Important:** The agent implementing these tasks will start with a fresh context — no knowledge of the issue discussion or your investigation. Each task must be **fully self-contained** with enough detail that the implementer can work without guessing.

1. **Read and understand** the issue above.
2. **Explore the codebase thoroughly** to understand the architecture, conventions, and relevant code. Identify the specific files, functions, and patterns that will need to change.
3. **Break the issue down** into 1 or more tasks. Each task should represent a single, reviewable PR's worth of work.
4. **Write task files** to the \`${issueTasksDir}\` directory.

## Task File Format

Each task file should be named \`<seq>-<short-slug>.md\` (e.g., \`001-add-validation.md\`) and contain:

\`\`\`markdown
---
id: "${issue.number}-<seq>"
issue: ${issue.number}
title: "<concise title>"
depends_on: []
---

## Description
<Detailed description of what needs to be done. Include:
- The specific behavior to add/change/fix and WHY
- Which files and functions to modify (use exact paths from your codebase exploration)
- How the change fits into the existing architecture
- Any edge cases or constraints to handle>

## Acceptance Criteria
- <Specific, verifiable criterion — e.g., "calling X with Y returns Z" not "works correctly">
- <Another criterion>

## Implementation Notes
<Concrete guidance for the implementer:
- Exact file paths to create or modify
- Existing patterns or utilities to reuse (with file paths)
- Code snippets or signatures when helpful for clarity
- Any gotchas, non-obvious conventions, or things to avoid>
\`\`\`

## Rules

- Sequence numbers start at 001 and increment.
- The \`id\` field must be \`"${issue.number}-<seq>"\` (e.g., "${issue.number}-001").
- Use \`depends_on\` to list task IDs that must be completed before this task. For example, if task 002 depends on task 001, set \`depends_on: ["${issue.number}-001"]\`.
- Each task should be a meaningful, self-contained unit of work that results in one PR.
- **Be extremely specific.** The implementing agent starts with zero context. Include:
  - Exact file paths discovered during your codebase exploration
  - Function/class names to modify or create
  - Existing patterns to follow (reference specific files as examples)
  - Expected behavior changes with concrete examples
- Acceptance criteria must be **verifiable** — not vague ("works correctly") but testable ("function X returns Y when given Z").
- Consider the existing codebase patterns and conventions.
- Create the \`${issueTasksDir}\` directory if it doesn't exist.

## Ambiguity Escape Hatch

If the issue is **ambiguous, unclear, or needs more information** before you can break it into tasks:

1. **Do NOT create any task files.**
2. **Do NOT commit anything.**
3. Instead, write a file called \`.whitesmith-ambiguity.md\` in the repository root with the following structure:

\`\`\`markdown
## Summary
<Brief summary of what you understood from the issue>

## Questions
1. <Specific question or clarification needed>
2. <Another question>
\`\`\`

The file should contain a brief summary of what was understood, followed by numbered questions that need to be answered before tasks can be generated.

**When to use this escape hatch:** If you find yourself needing to make significant assumptions about the desired behavior, scope, or approach — ask rather than guess. Specifically:
- The issue describes a problem but not the desired solution, and multiple valid approaches exist
- Key details are missing (e.g., which API format, what error behavior, which edge cases matter)
- The issue references context you cannot find in the codebase
- You cannot produce acceptance criteria that are concrete and verifiable without guessing

If the issue is reasonably clear and you can produce detailed, actionable tasks, generate them.

## When Done

After creating all task files, commit your changes:
\`\`\`
git add tasks/
git commit -m "tasks(#${issue.number}): generate implementation tasks"
\`\`\`

Do NOT push. Do NOT create a PR. The orchestrator will handle that.
`;
}

// ─── Review Prompts ──────────────────────────────────────────────────────────

export interface ReviewTaskProposalArgs {
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
	issueUrl: string;
	tasks: Array<{id: string; title: string; content: string; filePath: string}>;
	taskPRUrl?: string;
	responseFile: string;
}

/**
 * Build the prompt for reviewing a task proposal.
 * Ensures proposed tasks are detailed, precise, and properly cover the issue.
 */
export function buildReviewTaskProposalPrompt(args: ReviewTaskProposalArgs): string {
	const taskList = args.tasks
		.map((t) => `### Task ${t.id}: ${t.title}\n\n**File:** \`${t.filePath}\`\n\n${t.content}`)
		.join('\n\n---\n\n');

	return `# Review: Task Proposal for Issue #${args.issueNumber}

## Issue
**Title:** ${args.issueTitle}
**URL:** ${args.issueUrl}

### Description
${args.issueBody}
${args.taskPRUrl ? `\n**Task PR:** ${args.taskPRUrl}\n` : ''}
## Proposed Tasks

${taskList || '_No task files found._'}

## Your Job

You are reviewing the proposed task breakdown for the issue above. Your goal is to ensure
the tasks are **detailed enough**, **precise**, and **complete** so that another AI agent
can implement them without ambiguity.

### Review Criteria

1. **Coverage**: Do the tasks fully address the issue? Are there missing aspects?
2. **Clarity**: Is each task description clear and unambiguous? Could an AI agent implement it without asking questions?
3. **Granularity**: Are tasks the right size? Not too large (hard to review) or too small (unnecessary overhead).
4. **Acceptance Criteria**: Does each task have clear, verifiable acceptance criteria?
5. **Dependencies**: Are task dependencies correct? Could any tasks be parallelized?
6. **Implementation Notes**: Are there enough hints about which files/modules to modify?
7. **Consistency**: Do the tasks follow the existing codebase patterns and conventions?

### Instructions

1. **Explore the codebase** to understand the architecture and verify the tasks make sense.
2. **Read each task file** carefully.
3. **Write your review** to \`${args.responseFile}\`.

Your review MUST start with a verdict line as the very first line:

\`\`\`
VERDICT: APPROVE
\`\`\`

or:

\`\`\`
VERDICT: REQUEST_CHANGES
\`\`\`

Followed by:
- An overall assessment explaining your verdict
- Per-task feedback (if any issues found)
- Suggestions for improvement
- Any missing tasks or concerns

Use markdown formatting. Be constructive and specific.

Do NOT modify any files other than \`${args.responseFile}\`.
Do NOT commit, push, or create PRs.
`;
}

export interface ReviewImplementationPRArgs {
	prNumber: number;
	prTitle: string;
	prBody: string;
	prBranch: string;
	prUrl: string;
	parentIssue?: {
		number: number;
		title: string;
		body: string;
		url: string;
	};
	responseFile: string;
}

/**
 * Build the prompt for reviewing an implementation PR.
 * Performs a detailed code review looking for bugs, quality issues, etc.
 */
export function buildReviewImplementationPRPrompt(args: ReviewImplementationPRArgs): string {
	const issueContext = args.parentIssue
		? `\n## Parent Issue\n**#${args.parentIssue.number}:** ${args.parentIssue.title}\n**URL:** ${args.parentIssue.url}\n\n### Issue Description\n${args.parentIssue.body}\n`
		: '';

	return `# Review: Pull Request #${args.prNumber}

## Pull Request
**Title:** ${args.prTitle}
**URL:** ${args.prUrl}
**Branch:** ${args.prBranch}

### PR Description
${args.prBody}
${issueContext}
## Your Job

You are performing a detailed code review of this pull request. You are on the PR branch
(\`${args.prBranch}\`) and have full access to the codebase.

### Review Criteria

1. **Correctness**: Does the code work as intended? Are there any bugs or logic errors?
2. **Edge Cases**: Are edge cases handled? Could inputs cause crashes or unexpected behavior?
3. **Security**: Are there any security concerns (injection, data leaks, etc.)?
4. **Performance**: Are there any performance issues or inefficiencies?
5. **Code Quality**: Is the code clean, readable, and well-structured?
6. **Conventions**: Does it follow the existing codebase patterns and style?
7. **Tests**: Are there adequate tests? Are existing tests still passing?
8. **Error Handling**: Are errors handled gracefully?
9. **Documentation**: Are changes documented where needed?
10. **Completeness**: Does it fully address the issue/task requirements?

### Instructions

1. **Examine the diff** by running \`git diff main...HEAD\` to see all changes.
2. **Explore the codebase** to understand how the changes fit in.
3. **Read the changed files** in full context.
4. **Write your review** to \`${args.responseFile}\`.

Your review MUST start with a verdict line as the very first line:

\`\`\`
VERDICT: APPROVE
\`\`\`

or:

\`\`\`
VERDICT: REQUEST_CHANGES
\`\`\`

Followed by:
- An overall assessment explaining your verdict
- Specific issues found (with file paths and line references)
- Suggestions for improvement
- Any potential bugs or concerns

Use markdown formatting. Be thorough but constructive.

Do NOT modify any files other than \`${args.responseFile}\`.
Do NOT commit, push, or create PRs.
`;
}

export interface ReviewTaskCompletionArgs {
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
	issueUrl: string;
	implPRUrl?: string;
	implBranch: string;
	responseFile: string;
}

/**
 * Build the prompt for reviewing completed tasks.
 * Ensures the tasks were followed properly and checks for bugs or potential issues.
 */
export function buildReviewTaskCompletionPrompt(args: ReviewTaskCompletionArgs): string {
	return `# Review: Task Completion for Issue #${args.issueNumber}

## Issue
**Title:** ${args.issueTitle}
**URL:** ${args.issueUrl}
${args.implPRUrl ? `**Implementation PR:** ${args.implPRUrl}\n` : ''}
### Issue Description
${args.issueBody}

## Your Job

You are reviewing the completed implementation for this issue. All tasks have been
implemented on the \`${args.implBranch}\` branch (you are currently on it).

### Review Criteria

1. **Task Adherence**: Were the original tasks followed? Check the git log for task commits.
2. **Completeness**: Is the issue fully addressed? Are there any missing pieces?
3. **Bugs**: Are there any bugs or logic errors in the implementation?
4. **Edge Cases**: Are edge cases handled properly?
5. **Regressions**: Could any changes break existing functionality?
6. **Code Quality**: Is the code clean, well-structured, and following conventions?
7. **Tests**: Are there adequate tests for the new functionality?
8. **Security**: Any security concerns?
9. **Performance**: Any performance issues?

### Instructions

1. **Examine the full diff** by running \`git diff main...HEAD\` to see all changes.
2. **Check the git log** with \`git log main..HEAD --oneline\` to see all task commits.
3. **Read the original task files** on main with \`git show main:tasks/${args.issueNumber}/\` (if they exist).
4. **Explore the changed code** in full context.
5. **Write your review** to \`${args.responseFile}\`.

Your review MUST start with a verdict line as the very first line:

\`\`\`
VERDICT: APPROVE
\`\`\`

or:

\`\`\`
VERDICT: REQUEST_CHANGES
\`\`\`

Followed by:
- An overall assessment explaining your verdict
- Whether each task was properly completed
- Any bugs, issues, or concerns found
- Suggestions for improvement

Use markdown formatting. Be thorough but constructive.

Do NOT modify any files other than \`${args.responseFile}\`.
Do NOT commit, push, or create PRs.
`;
}

/**
 * Build the escalation comment posted when the ambiguity cycle limit has been reached.
 * Tells the human to review the issue manually.
 */
export function buildEscalationComment(): string {
	return `⚠️ This issue has gone through multiple clarification cycles without reaching a clear task breakdown.

**Human review is needed.** Please:
1. Review the issue description and previous clarification attempts
2. Either update the issue with more detail or break it down manually
3. Remove the \`whitesmith:needs-human-review\` and \`whitesmith:needs-clarification\` labels when ready for the agent to retry

_This issue will not be auto-investigated until the labels are removed._`;
}

/**
 * Build the comment posted on an issue when the agent signals ambiguity.
 * Includes the agent's clarification questions and instructions for the user.
 */
export function buildClarificationComment(clarificationText: string): string {
	return `🤔 I've analyzed this issue and need clarification before generating implementation tasks:

${clarificationText.trim()}

---

**How to respond:**
**Edit this issue** — update the description with the missing details.

I'll automatically re-analyze when the issue description is updated.`;
}

/**
 * Build the prompt for the "implement" phase.
 * The agent implements a specific task and deletes the task file.
 */
export function buildImplementPrompt(task: Task, issue: Issue): string {
	return `# Task: Implement "${task.title}"

## Context

You are implementing a task generated from GitHub Issue #${issue.number}: "${issue.title}"

**Issue URL:** ${issue.url}
**Task ID:** ${task.id}
**Task File:** ${task.filePath}

## Task Details

${task.content}

## Your Job

1. **Read the task** above carefully.
2. **Explore the codebase** to understand the architecture and conventions.
3. **Implement the changes** described in the task.
4. **Verify** your implementation meets the acceptance criteria.
5. **Delete the task file** at \`${task.filePath}\` — this marks the task as complete.
6. **Clean up**: if the task directory \`tasks/${task.issue}/\` is now empty, delete it too.
7. **Commit** all changes (implementation + task file deletion):

\`\`\`
git add -A
git commit -m "feat(#${issue.number}): ${task.title}"
\`\`\`

## Rules

- Follow existing code conventions and patterns.
- Make clean, reviewable changes.
- Do NOT push. Do NOT create a PR. The orchestrator will handle that.
- Do NOT modify other task files.
- You MUST delete \`${task.filePath}\` as part of your commit.
- If the \`tasks/${task.issue}/\` directory is empty after deletion, remove it.
- **Always use tool calls to make changes.** Never just describe what you plan to do — actually do it. If you produce a response with no tool calls, the session ends immediately and your work is lost.
`;
}
