---
id: "23-003"
issue: 23
title: "Auto-approve and merge task PR in the iteration loop when auto-work is enabled"
depends_on: ["23-001", "23-002"]
---

## Description

Modify the orchestrator's iteration loop to automatically merge the task-proposal PR when auto-work is enabled for an issue. This is the core of the alternative auto-work approach: instead of bypassing the task PR, we auto-approve it so tasks land on `main` through the normal merge path.

### Where to add the logic

In `Orchestrator.decideAction()` (or in the `run()` loop itself), add a new priority step between the existing reconcile and implement checks. When an issue is in `tasks-proposed` state and auto-work is enabled:

1. Find the task-proposal PR for the issue (branch `investigate/<issue-number>`)
2. Merge it using `mergePR()`
3. Transition the issue label from `tasks-proposed` to `tasks-accepted`
4. Comment on the issue that the task PR was auto-approved

After this, the next iteration will naturally find the tasks on `main` and pick them up for implementation via the existing `findAvailableTask()` flow.

### Approach options

**Option A — New action type**: Add an `'auto-approve'` action type and handle it in the `run()` switch. This is more explicit but adds a new action type.

**Option B — Inline in decideAction or run**: Before checking for implement actions, check for `tasks-proposed` issues with auto-work enabled and handle them directly. This avoids a new action type but mixes side effects into decision logic.

**Recommended: Option A** — add a new action type `{type: 'auto-approve'; issue: Issue}` to the `Action` union, return it from `decideAction()`, and handle it in `run()`. This keeps the code clean and consistent with the existing pattern.

## Acceptance Criteria

- When auto-work is enabled for an issue (via any detection method from task 001) and the issue has label `whitesmith:tasks-proposed`:
  - The orchestrator finds and merges the corresponding `investigate/<N>` PR
  - The issue label transitions from `tasks-proposed` to `tasks-accepted`
  - A comment is posted on the issue indicating auto-approval
- The existing `investigate()`, `implement()`, `findAvailableTask()`, and `reconcile()` flows remain unchanged
- The `Action` type union in `src/types.ts` includes the new action type
- Dry-run mode prints what would happen without executing
- Tests verify:
  - Auto-approve action is selected for `tasks-proposed` issues when auto-work is enabled
  - Auto-approve action is NOT selected when auto-work is disabled
  - The merge and label transition happen correctly
  - The next iteration picks up tasks normally after auto-approve

## Implementation Notes

- **Files to modify**: `src/types.ts` (Action union), `src/orchestrator.ts` (decideAction + new handler method + run switch)
- In `decideAction()`, add the auto-approve check after reconcile but before implement:
  ```
  Priority 1: Reconcile
  Priority 2: Auto-approve task PRs (NEW)
  Priority 3: Implement
  Priority 4: Investigate
  ```
- The `auto-approve` handler should:
  1. Find the PR for `investigate/<issue.number>` using `getPRForBranch()`
  2. If PR exists and is open, call `mergePR(pr.number)` (note: need PR number, may need to extend `getPRForBranch` return type or use `listPRsByBranchPrefix`)
  3. Wait briefly for merge to propagate (or just let the next iteration's `git fetch` handle it)
  4. Transition labels: remove `tasks-proposed`, add `tasks-accepted`
  5. Comment on the issue
- The `reconcile` command in `cli.ts` already handles `tasks-proposed` → `tasks-accepted` by checking if tasks exist on `main`. After merge, on the next `git fetch` + checkout main, tasks will be on main. The reconcile command could also be enhanced to handle this, but the orchestrator approach is cleaner.
- After merging, do `git fetch` + `git checkoutMain()` to get the merged tasks before continuing. Or simply return from the iteration and let the next iteration's fetch pick them up.
- Look at `getPRForBranch()` — it currently returns `{state, url}` but not `number`. You may need to extend it to also return the PR number, or use `listPRsByBranchPrefix('investigate/')` which already returns `number`.
