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
- Concurrency is set per-issue (`whitesmith-issue-<number>`) with `cancel-in-progress: false` to prevent duplicate runs.
- The workflow uses the existing `.github/actions/setup-whitesmith` composite action.
- The `install-ci` command (`src/providers/github-ci.ts`) is updated to generate this new workflow file.
- The workflow includes the same env vars and permissions as the existing `whitesmith.yml`.

## Implementation Notes

- Create `.github/workflows/whitesmith-issue.yml` with the new trigger.
- Update `src/providers/github-ci.ts`:
  - Add a `generateIssueWorkflow(config: CIConfig)` function.
  - Add it to the files array in `installGitHubCI()`.
- The workflow should pass `--auto-work` if configured (or the orchestrator can detect it from issue labels).
- Use `--max-iterations` with a reasonable default (e.g., 10) since a single issue may need investigate + auto-approve + multiple implement steps.
- The concurrency group should use the issue number to allow parallel processing of different issues.
