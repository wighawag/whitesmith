---
id: "30-001"
issue: 30
title: "Add createIssue method to IssueProvider interface and GitHub implementation"
depends_on: []
---

## Description

Add the ability to create new GitHub issues programmatically via the `IssueProvider` interface and its `GitHubProvider` implementation. This is a prerequisite for the investigate phase to be able to create sub-issues when it determines an issue is too large.

The new method should support:
- Setting a title and body
- Applying labels
- Referencing a parent issue (via body text, since GitHub sub-issues API may not be universally available)

## Acceptance Criteria

- `IssueProvider` interface in `src/providers/issue-provider.ts` has a new `createIssue` method with the signature:
  ```typescript
  createIssue(options: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }>;
  ```
- `GitHubProvider` in `src/providers/github.ts` implements `createIssue` using the `gh` CLI (`gh issue create`).
- The implementation correctly handles the title, body, and optional labels.
- A unit test or integration note confirms the method works (e.g., a test in `test/` that mocks `gh` or verifies the command construction).

## Implementation Notes

- In `src/providers/issue-provider.ts`, add the `createIssue` method to the `IssueProvider` interface.
- In `src/providers/github.ts`, implement it using `gh issue create --title "..." --body-file - --label "..."`. Use stdin for the body to avoid shell escaping issues (similar pattern to `comment()` and `createPR()`).
- Return the issue number and URL from the `gh` CLI output (use `--json number,url` or parse the URL from stdout).
- Keep it simple — no sub-issue API usage yet. Parent issue references will be handled in the prompt/body text by the caller.
