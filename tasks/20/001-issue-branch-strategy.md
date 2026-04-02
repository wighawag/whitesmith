---
id: "20-001"
issue: 20
title: "Switch implement() to use issue/<number> branch and accumulate commits"
depends_on: []
---

## Description

Change the `implement()` method in `orchestrator.ts` to use an `issue/<number>` branch instead of `task/<id>` branch. Each task implementation adds one commit to the shared issue branch. Create the PR in `implement()` when the last task is completed (immediate, not deferred to reconcile). `reconcile()` acts as a safety net for crash recovery.

Also update `findAvailableTask()` to check for task completion using the issue branch instead of per-task branches.

### Changes to `findAvailableTask()`

Currently checks `task/${task.id}` branch + PR existence to determine if a task is already handled. Change to:

- Use `issue/${issue.number}` branch instead of `task/${task.id}`
- Check the issue branch (not per-task branches) to determine if a task was already completed
- A task is "done" if its task file has been deleted from the issue branch (the agent deletes task files on completion)
- If the issue branch exists, checkout and inspect which task files remain to find the next available task
- If no issue branch exists, the first task with satisfied dependencies is available

### Changes to `implement()`

- Branch name: `issue/${issue.number}` instead of `task/${task.id}`
- If the issue branch already exists remotely, check it out and continue from there (accumulate commits)
- If not, create it from `origin/main`
- After agent runs, commit with message `feat(#${issue.number}): ${task.title}`
- Push the branch
- After pushing, check if all tasks for the issue are now complete
- If all tasks are done, create a PR immediately with:
  - `head: issue/${issue.number}`
  - `base: main`
  - `title: feat(#${issue.number}): ${issue.title}`
  - `body`: summary listing all completed tasks
- If tasks remain, just log that more tasks are pending

### Changes to `decideAction()` / `hasRemainingTasks()`

Currently, `decideAction()` triggers reconcile when `hasRemainingTasks(issue.number)` returns `false`. This checks task files on `main` (current working tree). But with the new flow, task files on `main` won't be deleted until the issue PR is merged — so `hasRemainingTasks()` will **always return `true`** for in-progress issues, and reconcile will never trigger.

**Fix**: Update the reconcile check in `decideAction()` to look at the **issue branch** instead of `main`:

- For each `tasks-accepted` issue, check if `issue/<number>` branch exists remotely
- If it does, check whether all task files have been deleted on that branch (using `git show origin/issue/<number>:tasks/<number>/` or similar remote inspection)
- If all task files are deleted on the issue branch → all tasks are complete → trigger reconcile
- If the issue branch doesn't exist or still has task files → tasks remain → continue to implement

This could be implemented by:
1. Adding a new method like `hasRemainingTasksOnBranch(issueNumber: number)` that checks task file existence on the remote issue branch via git commands (e.g., `git ls-tree origin/issue/<number> -- tasks/<number>/`)
2. Or updating `hasRemainingTasks()` to accept an optional branch parameter
3. The key: the check must work **without** checking out the issue branch (we're on `main` during `decideAction()`)

### Changes to `reconcile()`

Currently just closes the issue. Add **safety net** PR creation logic for crash recovery:

- Before closing, check if an `issue/<number>` branch exists with all tasks complete
- If it does and no PR exists for it (e.g. agent crashed after last task push but before PR creation), create a PR
- If a PR already exists, nothing extra to do
- Then add the completed label and close the issue

The key insight: `reconcile()` is a **fallback**, not the primary path. The happy path creates the PR immediately in `implement()` when the last task finishes, so there's no latency waiting for the next reconcile cycle.

## Acceptance Criteria

- Branch naming uses `issue/<number>` format for implementation
- Each task implementation adds one commit to the issue branch
- PR created in `implement()` when the last task is completed (not deferred to reconcile)
- `reconcile()` serves as safety net: creates PR if one doesn't exist but all tasks are done
- PR body summarizes all completed tasks (from commit history or task metadata)
- If agent crashes mid-way, the issue branch persists with previous commits and can resume
- If the issue branch already exists with some tasks done, the next undone task is picked up
- All existing tests updated to reflect new branch naming
- All tests pass

## Implementation Notes

### Files to modify

- `src/orchestrator.ts` — main changes to `findAvailableTask()`, `implement()`, and `reconcile()`
- `test/orchestrator.test.ts` — update all branch references from `task/<id>` to `issue/<number>`, update test expectations for PR creation (moved from implement to reconcile), add test for accumulated commits scenario

### Key considerations

1. **Branch reuse in `implement()`**: When the issue branch already exists remotely, checkout from `origin/issue/<number>` (not `origin/main`) to preserve previous task commits.

2. **Task completion detection in `findAvailableTask()`**: The current approach checks for remote branch + PR per task. The new approach should:
   - For each task, check if it's already been completed on the issue branch (task file deleted)
   - The simplest approach: since `findAvailableTask` runs after `checkoutMain()`, and task files on `main` reflect what's pending, just check if the task file exists on the issue branch by temporarily checking it out, or simply rely on the task files on `main` (which are the source of truth until the issue PR is merged)
   - Actually, the task files on `main` are the canonical list. A task is "in progress" if the issue branch exists. A task is "done" if its file was deleted (committed on the issue branch). Since we're on `main` during `findAvailableTask()`, we can check the issue branch remotely or just track via the task files on `main` + checking the issue branch contents.
   - **Simplest approach**: Keep using task files on `main` as the source of truth for what's pending. When implementing, checkout the issue branch (creating from main or from existing remote). The agent deletes the task file and commits. On the issue branch, completed task files are removed. On `main`, they're still present until the issue PR merges. So `findAvailableTask()` can continue to use `this.tasks.listTasks()` (which reads from the current working tree = main) to find pending tasks. The only check needed is whether a task was already completed on the issue branch — which can be detected by checking if the task file exists on the remote issue branch.

3. **Resumability**: If the agent crashes after task 1 but before task 2:
   - The issue branch has task 1's commit (task file 1 deleted, implementation committed)
   - On `main`, both task files still exist
   - Next run: `findAvailableTask()` finds task 1 as first pending task, but the issue branch already has it done. Need to detect this and skip to task 2.
   - Detection: after checking out the issue branch, check which task files are still present. Those are the remaining tasks. Pick the first one with satisfied deps.

4. **`findAvailableTask()` revised approach**:
   - For each issue with tasks-accepted, get the list of tasks from `main` (current working tree)
   - Check if `issue/<number>` branch exists remotely
   - If it does, we need to know which tasks are already done on that branch. We can check the remote branch for task file existence using `git show origin/issue/<number>:tasks/<number>/<file>` or similar, without actually checking out
   - Alternatively, after checking out the issue branch in `implement()`, re-list tasks and pick the first undone one
   - The cleanest approach: in `findAvailableTask()`, just return the first task with satisfied deps. In `implement()`, after checking out the issue branch, check if the task file still exists. If not, the task was already done — return early (or the orchestrator loop will pick the next task on the next iteration).

5. **Update the orchestrator docstring** to reflect the new flow.
