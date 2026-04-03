---
id: "35-003"
issue: 35
title: "Add PR merged workflow trigger for task-proposal and implementation PRs"
depends_on: ["35-001"]
---

## Description

When an `investigate/<N>` PR is merged (task proposal accepted), implementation should start immediately rather than waiting for the next cron tick. Similarly, when an `issue/<N>` PR is merged (implementation complete), the issue should be reconciled immediately.

Update the `generateReconcileWorkflow()` function in `src/providers/github-ci.ts` to generate an enhanced `whitesmith-reconcile.yml` workflow that also kicks off `whitesmith run --issue <N>` when a whitesmith-managed PR is merged. Currently the generated reconcile workflow only runs `whitesmith reconcile .` which handles label transitions but doesn't start implementation.

**Important**: Do NOT create or modify static workflow files under `.github/workflows/` directly. GitHub does not allow workflows to modify workflow files. Only modify the generator functions in `src/providers/github-ci.ts`. The user will run `install-ci` to regenerate workflows after these code changes.

The generated workflow needs to:

1. Detect the type of merged PR from the branch name using a regex pattern:
   - `investigate/<N>`: Extract `<N>` via `echo "$BRANCH" | sed -n 's|^investigate/\([0-9]*\)$|\1|p'`.
   - `issue/<N>`: Extract `<N>` via `echo "$BRANCH" | sed -n 's|^issue/\([0-9]*\)$|\1|p'`.
   - For non-matching branches (regular PRs), run `whitesmith reconcile .` only (existing behavior).
2. For `investigate/<N>` merges:
   - Run `whitesmith reconcile .` **first** to handle the `tasks-proposed` → `tasks-accepted` label transition (the reconcile command detects tasks on `main` and transitions labels).
   - Then run `whitesmith run . --issue <N>` which will see `tasks-accepted` and start implementing.
   - This two-step approach (reconcile then run) is the explicit flow. Alternatively, if Task 001's `runForIssue` handles the `tasks-proposed` state when the investigate PR is already merged (performing the reconcile step inline), then a single `whitesmith run . --issue <N>` call suffices. **Both approaches are valid** — Task 001 specifies that `runForIssue` handles this case inline, so a single `whitesmith run . --issue <N>` call is preferred.
3. For `issue/<N>` merges: Run `whitesmith reconcile .` (existing behavior) to close the issue.
4. Handle the case where auto-work auto-approved and merged the investigate PR — the `pull_request: closed` event fires, but the orchestrator (already running from `whitesmith-issue.yml`) may have already started implementing. Use concurrency groups to prevent double runs.

## Acceptance Criteria

- The `generateReconcileWorkflow()` function in `github-ci.ts` is updated to generate a workflow that, when an `investigate/<N>` PR is merged, runs `whitesmith run . --issue <N>` to start implementation immediately.
- The generated workflow, when an `issue/<N>` PR is merged, runs `whitesmith reconcile .` (existing behavior preserved).
- Concurrency group `whitesmith-issue-<N>` prevents parallel runs for the same issue (same pattern as `whitesmith-issue.yml`).
- For PRs whose branches don't match `investigate/<N>` or `issue/<N>` patterns, use a generic concurrency group (e.g., `whitesmith-reconcile-other`) to avoid interference. The concurrency group expression should be conditional:
  ```yaml
  concurrency:
    group: ${{ (steps.parse.outputs.issue_number && format('whitesmith-issue-{0}', steps.parse.outputs.issue_number)) || 'whitesmith-reconcile-other' }}
    cancel-in-progress: false
  ```
  Note: Since concurrency is at the job level and needs the parsed issue number, this may require splitting into separate jobs or using a workflow-level expression with `github.event.pull_request.head.ref`.
- If the orchestrator from `whitesmith-issue.yml` is already running for this issue (auto-work flow), the merged-PR workflow either waits or is skipped gracefully.
- The `install-ci` command generates the updated reconcile workflow.
- For non-whitesmith PRs (branches not matching `investigate/` or `issue/`), existing reconcile behavior is preserved.

## Implementation Notes

- **Do NOT create or modify any files under `.github/workflows/`**. Only modify `src/providers/github-ci.ts`.
- Update `src/providers/github-ci.ts`: update `generateReconcileWorkflow()` to accept the `CIConfig` parameter.
  - **Breaking change**: The current `generateReconcileWorkflow()` takes no arguments. It now needs to accept `config: CIConfig` to include AI provider env vars via `generateTopLevelEnv(config)`.
  - Update the call site in `installGitHubCI()` to pass the config.
  - The generated reconcile workflow should parse `github.event.pull_request.head.ref` to detect branch type.
  - Use regex to extract the issue number: `echo "$BRANCH" | sed -n 's|^investigate/\([0-9]*\)$|\1|p'` for investigate branches, and similarly for issue branches.
  - For `investigate/<N>` branches: generate a step that runs `whitesmith run . --issue <N> --provider "$WHITESMITH_PROVIDER" --model "$WHITESMITH_MODEL"` (needs AI credentials).
  - For `issue/<N>` branches: generate a step that runs `whitesmith reconcile .` (no AI needed).
  - For non-matching branches: generate a step that runs `whitesmith reconcile .` (existing behavior).
  - Use concurrency group `whitesmith-issue-<N>` (same as issue-opened workflow) so they don't conflict. For non-whitesmith PRs, use a generic group like `whitesmith-reconcile-other`.
  - The generated reconcile workflow now needs AI provider env vars and permissions for the investigate-PR-merged case.
  - Consider splitting into two jobs: one for reconcile (lightweight, no AI) and one for implementation (needs AI setup).
- The generated reconcile workflow's permissions need to be expanded to `contents: write` for the implementation job.
- Ensure the `whitesmith-issue.yml` and reconcile workflow share the same concurrency group pattern per issue number.
