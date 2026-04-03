---
id: "23-002"
issue: 23
title: "Add mergePR method to IssueProvider interface and GitHubProvider"
depends_on: []
---

## Description

Add a `mergePR` method to the `IssueProvider` interface and implement it in `GitHubProvider`. This method is needed so the orchestrator can auto-merge task-proposal PRs when auto-work is enabled.

## Acceptance Criteria

- `IssueProvider` interface in `src/providers/issue-provider.ts` has a `mergePR(number: number): Promise<void>` method
- `GitHubProvider` in `src/providers/github.ts` implements `mergePR` using `gh pr merge <number> --merge` (or `--squash`, either is fine — merge commit is simpler for the task flow)
- The method waits for the merge to complete (the `gh` CLI does this synchronously)
- Unit/integration tests verify the method calls the right `gh` command

## Implementation Notes

- **Files to modify**: `src/providers/issue-provider.ts`, `src/providers/github.ts`
- Use the existing `gh()` helper method pattern in `GitHubProvider`
- The `gh pr merge` command: `gh pr merge <number> --merge --delete-branch`
- Using `--delete-branch` cleans up the `investigate/<N>` branch after merge
- Consider whether to use `--admin` flag to bypass branch protection rules — for now, don't include it (keep it simple)
