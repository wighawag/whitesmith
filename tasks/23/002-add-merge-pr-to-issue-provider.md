---
id: "23-002"
issue: 23
title: "Add mergePR method to IssueProvider interface and GitHubProvider"
depends_on: []
---

## Description

Two changes are needed:

1. **Extend `getPRForBranch()` to return the PR number** — currently it returns `{state, url}` but not `number`. The auto-approve flow needs the PR number to call `mergePR()`. Add `number` to the return type and include it in the `gh` JSON query.

2. **Add a `mergePR` method** to the `IssueProvider` interface and implement it in `GitHubProvider`. This method is needed so the orchestrator can auto-merge task-proposal PRs when auto-work is enabled.

## Acceptance Criteria

- `getPRForBranch()` in `IssueProvider` interface and `GitHubProvider` returns `{state, url, number}` instead of `{state, url}`
  - The `gh` query in `GitHubProvider.getPRForBranch()` includes `number` in the `--json` fields
  - All existing callers of `getPRForBranch()` continue to work (they just ignore the new field)
- `IssueProvider` interface in `src/providers/issue-provider.ts` has a `mergePR(number: number): Promise<void>` method
- `GitHubProvider` in `src/providers/github.ts` implements `mergePR` using `gh pr merge <number> --merge`
- The method waits for the merge to complete (the `gh` CLI does this synchronously)
- Unit/integration tests verify the method calls the right `gh` command

## Implementation Notes

- **Files to modify**: `src/providers/issue-provider.ts`, `src/providers/github.ts`
- For `getPRForBranch()`: change the `--json` flag from `state,url` to `state,url,number` and update the return type and parse logic
- Use the existing `gh()` helper method pattern in `GitHubProvider` for `mergePR`
- The `gh pr merge` command: `gh pr merge <number> --merge --delete-branch`
- Using `--delete-branch` cleans up the `investigate/<N>` branch after merge
- No `--admin` flag — keep it simple. Auto-work won't work on repos with required reviews unless the bot account has bypass permissions (known limitation)
- No separate `approvePR` step — just merge directly
