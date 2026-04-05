---
id: "43-003"
issue: 43
title: "Re-investigate on issue edit when needs-clarification"
depends_on: ["43-002"]
---

## Description

Add orchestrator logic to re-investigate an issue when the user provides clarification by editing the issue body. **Only issue edits trigger re-investigation — comment-based re-investigation is not supported.**

> **Note:** Workflow trigger changes (adding `issues.edited` to the GitHub Actions workflow) are handled in **task 005** via `install-ci` / `generateIssueWorkflow()`. Do **NOT** modify any files under `.github/workflows/` in this task.

### 1. Orchestrator changes

**`decideActionForIssue()`** — Update the behavior for `needs-clarification` from `idle` (set in 43-002) to `investigate`. When an issue has the `needs-clarification` label, return `{type: 'investigate', issue}` so the full investigation flow runs again. **Update the test from 43-002 that asserted idle behavior to now assert investigate behavior.**

**`investigate()`** — At the start, if the issue has the `needs-clarification` label, remove it before proceeding. This ensures the issue goes through the full investigation flow again with the updated issue body. The label removal should happen after the `investigating` label is added (existing behavior), so the sequence is:
1. Add `investigating` label (existing)
2. Check and remove `needs-clarification` label if present (new)
3. Proceed with agent run

### 2. No changes to CLI, prompt, or comment workflow

Since re-investigation is triggered only by issue edits:
- No `--comment-body` or `--comment-body-file` CLI flags are needed
- No changes to `DevPulseConfig` for comment body
- No changes to `buildInvestigatePrompt()` signature — the updated issue body is already available via the standard issue fetch
- No changes to the comment workflow (`.github/workflows/whitesmith-comment.yml`)

### Files to modify

- `src/orchestrator.ts` — Update `decideActionForIssue()` to return `investigate` for `needs-clarification` issues. Update `investigate()` to remove `needs-clarification` label at the start.
- `test/orchestrator.test.ts` — Update the test from 43-002 for `needs-clarification` idle behavior to now assert `investigate` behavior. Add tests for label removal during re-investigation.

## Acceptance Criteria

- `decideActionForIssue()` returns `{type: 'investigate', issue}` for `needs-clarification` issues
- The `needs-clarification` label is removed at the start of `investigate()` when present
- The re-investigation uses the updated issue body (no special context passing needed — standard issue fetch gets the latest body)
- The re-investigation follows the same ambiguity detection flow (can result in another clarification comment or proceed to create a PR with tasks)
- Unit tests cover:
  - `decideActionForIssue` returns `investigate` for `needs-clarification` issues
  - `investigate()` removes the `needs-clarification` label when present
  - Normal investigate flow (no `needs-clarification` label) is unchanged
- **No files under `.github/workflows/` are modified** (workflow changes are in task 005)

## Implementation Notes

- Since the `whitesmith run --issue N` command fetches the issue fresh, the updated description is automatically available without any special passing.
- The workflow concurrency group `whitesmith-issue-${{ github.event.issue.number }}` already handles preventing concurrent runs for the same issue — the `edited` trigger (added in task 005) reuses the same group.
