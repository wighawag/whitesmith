---
id: "35-004"
issue: 35
title: "Remove cron trigger from main workflow and update documentation"
depends_on: ["35-002", "35-003"]
---

## Description

Now that all whitesmith actions are triggered by events (issue opened, PR merged, comments), the cron-based `schedule` trigger in `whitesmith.yml` is no longer needed. Update the `generateMainWorkflow()` function in `src/providers/github-ci.ts` to remove the cron schedule and only support `workflow_dispatch` (manual trigger) as a fallback/catch-up mechanism.

Also update `README.md` and any other documentation to reflect the new event-driven architecture.

**Important**: Do NOT create or modify static workflow files under `.github/workflows/` directly. GitHub does not allow workflows to modify workflow files. Only modify the generator functions in `src/providers/github-ci.ts`. The user will run `install-ci` to regenerate workflows after these code changes.

## Acceptance Criteria

- The `generateMainWorkflow()` function in `github-ci.ts` no longer generates the `schedule` / `cron` trigger.
- The generated workflow still includes `workflow_dispatch` as a manual trigger for catch-up or debugging.
- The generated `workflow_dispatch` accepts an optional `issue` parameter to target a specific issue, in addition to the existing global scan mode.
- `README.md` is updated to describe the event-driven workflow:
  - Issue created → investigate immediately
  - Task PR merged → implement immediately
  - Implementation PR merged → reconcile immediately
  - Comment on issue/PR → respond immediately (existing)
  - Manual `workflow_dispatch` as fallback
- The generated concurrency group uses per-issue concurrency when `--issue` is specified via `workflow_dispatch`. Use the following expression pattern:
  ```yaml
  concurrency:
    group: ${{ inputs.issue && format('whitesmith-issue-{0}', inputs.issue) || 'whitesmith-global' }}
    cancel-in-progress: false
  ```

## Implementation Notes

- **Do NOT create or modify any files under `.github/workflows/`**. Only modify `src/providers/github-ci.ts` and `README.md`.
- Update `src/providers/github-ci.ts`:
  - Modify `generateMainWorkflow()` to:
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
- Update `README.md` to document the new trigger architecture.
- **Note on `install-ci` tests**: There are no dedicated tests for `install-ci` in the test directory. Manual verification is sufficient for this task. Optionally, consider adding basic snapshot or smoke tests for the generated workflow content in a follow-up.
