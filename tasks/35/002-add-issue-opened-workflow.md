---
id: "35-002"
issue: 35
title: "Add `issues: opened` workflow trigger for immediate investigation"
depends_on: ["35-001"]
---

## Description

Replace the cron-based trigger for investigation with an event-driven `issues: opened` trigger. When a new issue is created, a GitHub Actions workflow should immediately start the investigation (task generation) for that specific issue, eliminating the up-to-15-minute delay from the current cron schedule.

Create a new workflow file `whitesmith-issue.yml` that triggers on `issues: [opened]` events and runs `whitesmith run . --issue <number>` for the newly created issue. This workflow should also handle auto-work: if auto-work is enabled, the single run will investigate, auto-approve, and start implementing — all in one workflow execution.

## Acceptance Criteria

- A new workflow file `.github/workflows/whitesmith-issue.yml` is created.
- The workflow triggers on `issues: [opened]` events.
- It runs `whitesmith run . --issue ${{ github.event.issue.number }}` with appropriate provider/model/max-iterations args.
- The `--provider` and `--model` flags are passed using `$WHITESMITH_PROVIDER` and `$WHITESMITH_MODEL` env vars (same as the main workflow): `--provider "$WHITESMITH_PROVIDER" --model "$WHITESMITH_MODEL"`.
- Concurrency is set per-issue (`whitesmith-issue-<number>`) with `cancel-in-progress: false` to prevent duplicate runs.
- The workflow uses the existing `.github/actions/setup-whitesmith` composite action.
- The `install-ci` command (`src/providers/github-ci.ts`) is updated to generate this new workflow file via a new `generateIssueWorkflow(config: CIConfig)` function.
- The static `.github/workflows/whitesmith-issue.yml` is committed for **this** repo, AND `github-ci.ts` is updated to generate equivalent workflows for other repos via `install-ci`.
- The workflow includes the same env vars (via `generateTopLevelEnv(config)`) and permissions as the existing `whitesmith.yml`.
- Auto-work does **not** need to be passed as a `--auto-work` CLI flag — the orchestrator's `isAutoWorkEnabled()` function already checks the issue's labels and body at runtime. If a global auto-work toggle is desired in the future, it can be added as a workflow input or env var, but this is not required for this task.

## Implementation Notes

- Create `.github/workflows/whitesmith-issue.yml` with the new trigger (static file for this repo).
- Update `src/providers/github-ci.ts`:
  - Add a `generateIssueWorkflow(config: CIConfig)` function that accepts the `CIConfig` parameter (needed for `generateTopLevelEnv(config)` to include provider env vars and API key secrets).
  - Add it to the files array in `installGitHubCI()` so it is generated for other repos that run `install-ci`.
- Auto-work does **not** need to be passed as a `--auto-work` CLI flag. The orchestrator's `isAutoWorkEnabled()` function already checks the issue's labels and body at runtime. Per-issue control via labels/body text is sufficient.
- Use `--max-iterations` with a reasonable default (e.g., 10) since a single issue may need investigate + auto-approve + multiple implement steps.
- The concurrency group should use the issue number to allow parallel processing of different issues.
- Ensure `--provider` and `--model` are passed using the same `WHITESMITH_PROVIDER` / `WHITESMITH_MODEL` env vars as the main workflow.
