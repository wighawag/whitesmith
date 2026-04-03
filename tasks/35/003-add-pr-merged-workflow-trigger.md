---
id: "35-003"
issue: 35
title: "Add PR merged workflow trigger for task-proposal and implementation PRs"
depends_on: ["35-001"]
---

## Description

When an `investigate/<N>` PR is merged (task proposal accepted), implementation should start immediately rather than waiting for the next cron tick. Similarly, when an `issue/<N>` PR is merged (implementation complete), the issue should be reconciled immediately.

Extend the existing `whitesmith-reconcile.yml` workflow (which already triggers on `pull_request: [closed]`) to also kick off `whitesmith run --issue <N>` when a whitesmith-managed PR is merged. Currently reconcile only runs `whitesmith reconcile .` which handles label transitions but doesn't start implementation.

The workflow needs to:

1. Detect the type of merged PR from the branch name:
   - `investigate/<N>`: The task proposal was accepted. Run `whitesmith run . --issue <N>` which will detect `tasks-accepted` and start implementing.
   - `issue/<N>`: The implementation was merged. Run `whitesmith reconcile .` (existing behavior) to close the issue.
2. For `investigate/<N>` merges, trigger a full run for the issue so implementation begins immediately.
3. Handle the case where auto-work auto-approved and merged the investigate PR — the `pull_request: closed` event fires, but the orchestrator (already running from `whitesmith-issue.yml`) may have already started implementing. Use concurrency groups to prevent double runs.

## Acceptance Criteria

- When an `investigate/<N>` PR is merged, `whitesmith run . --issue <N>` is triggered to start implementation immediately.
- When an `issue/<N>` PR is merged, `whitesmith reconcile .` runs (existing behavior preserved).
- Concurrency group `whitesmith-issue-<N>` prevents parallel runs for the same issue.
- If the orchestrator from `whitesmith-issue.yml` is already running for this issue (auto-work flow), the merged-PR workflow either waits or is skipped gracefully.
- The `install-ci` command generates the updated reconcile workflow.
- For non-whitesmith PRs (branches not matching `investigate/` or `issue/`), existing reconcile behavior is preserved.

## Implementation Notes

- Modify `.github/workflows/whitesmith-reconcile.yml`:
  - Add a job step that parses `github.event.pull_request.head.ref` to detect branch type.
  - For `investigate/<N>` branches: run `whitesmith run . --issue <N> --provider ... --model ...` (needs AI credentials).
  - For `issue/<N>` branches: run `whitesmith reconcile .` (no AI needed).
  - Use concurrency group `whitesmith-issue-<N>` (same as issue-opened workflow) so they don't conflict.
- Update `src/providers/github-ci.ts`: update `generateReconcileWorkflow()` to include the new logic.
  - The reconcile workflow now needs AI provider env vars and permissions for the investigate-PR-merged case.
  - Consider splitting into two jobs: one for reconcile (lightweight, no AI) and one for implementation (needs AI setup).
- The reconcile workflow's permissions need to be expanded to `contents: write` for the implementation job.
- Ensure the `whitesmith-issue.yml` and reconcile workflow share the same concurrency group pattern per issue number.
