---
id: "35-004"
issue: 35
title: "Remove cron trigger from main workflow and update documentation"
depends_on: ["35-002", "35-003"]
---

## Description

Now that all whitesmith actions are triggered by events (issue opened, PR merged, comments), the cron-based `schedule` trigger in `whitesmith.yml` is no longer needed. Remove it and update the workflow to only support `workflow_dispatch` (manual trigger) as a fallback/catch-up mechanism.

Also update `README.md` and any other documentation to reflect the new event-driven architecture.

## Acceptance Criteria

- The `schedule` / `cron` trigger is removed from `.github/workflows/whitesmith.yml`.
- `workflow_dispatch` remains as a manual trigger for catch-up or debugging.
- The `workflow_dispatch` for `whitesmith.yml` accepts an optional `--issue` parameter to target a specific issue, in addition to the existing global scan mode.
- `README.md` is updated to describe the event-driven workflow:
  - Issue created → investigate immediately
  - Task PR merged → implement immediately
  - Implementation PR merged → reconcile immediately
  - Comment on issue/PR → respond immediately (existing)
  - Manual `workflow_dispatch` as fallback
- The `install-ci` command (`src/providers/github-ci.ts`) no longer generates the cron schedule in `generateMainWorkflow()`.
- The concurrency group on `whitesmith.yml` is updated: instead of a global `whitesmith-loop` group, use per-issue concurrency when `--issue` is specified via `workflow_dispatch`. Use the following expression pattern:
  ```yaml
  concurrency:
    group: ${{ inputs.issue && format('whitesmith-issue-{0}', inputs.issue) || 'whitesmith-global' }}
    cancel-in-progress: false
  ```

## Implementation Notes

- Modify `.github/workflows/whitesmith.yml`:
  - Remove the `schedule` block.
  - Add an optional `issue` input to `workflow_dispatch`.
  - Update the `run` step to pass `--issue` when the input is provided.
  - Consider keeping the global scan mode (no `--issue`) as the default for `workflow_dispatch` to handle any missed events.
  - Update the concurrency group to use a conditional expression:
    ```yaml
    concurrency:
      group: ${{ inputs.issue && format('whitesmith-issue-{0}', inputs.issue) || 'whitesmith-global' }}
      cancel-in-progress: false
    ```
- Update `src/providers/github-ci.ts`: remove the `schedule` block from `generateMainWorkflow()`, add the `issue` input, update the concurrency group expression.
- Update `README.md` to document the new trigger architecture.
- **Note on `install-ci` tests**: There are no dedicated tests for `install-ci` in the test directory. Manual verification is sufficient for this task. Optionally, consider adding basic snapshot or smoke tests for the generated workflow content in a follow-up.
