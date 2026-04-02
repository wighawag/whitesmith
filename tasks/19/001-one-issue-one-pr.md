---
id: 19-001
issue: 19
title: Implement one issue = one PR workflow
depends_on: []
---

## Overview

Refactor the implementation phase to use **one branch per issue** instead of one branch per task. This allows accumulating commits on a single branch and creating one PR when all tasks for an issue are complete.

## Problem

Current flow creates one PR per task:
- Task 1 → branch `task/001` → PR #101 (often useless alone)
- Task 2 → branch `task/002` → PR #102 (often useless alone)
- Task 3 → branch `task/003` → PR #103 (finally useful)

This leads to:
1. **Useless intermediate PRs** - Individual tasks are often meaningless alone
2. **Error recovery issues** - If `autoWork()` crashes mid-way, task files aren't on `main` and normal `implement` flow can't resume
3. **CI overhead** - N tasks = N PR runs instead of 1

## Solution

New flow with accumulated commits:
```
Task 1 → commit abc on branch issue/42
Task 2 → commit def on branch issue/42
Task 3 → commit ghi on branch issue/42
       ↓
    PR #101 (all 3 commits, coherent change)
```

## Implementation

### 1. Update `orchestrator.ts` - `findAvailableTask()`

Change branch naming from `task/${task.id}` to `issue/${issue.number}`:

```typescript
const branch = `issue/${issue.number}`;
```

### 2. Update `orchestrator.ts` - `implement()`

- Use `issue/${issue.number}` branch instead of `task/${task.id}`
- Remove PR creation logic (moved to `reconcile()`)
- Just push the branch after committing

Key changes:
```typescript
const branch = `issue/${issue.number}`;
// ... implement task ...
await this.git.commitAll(`feat(#${issue.number}): ${task.title}`);
await this.git.forcePush(branch);
// No PR creation here
```

### 3. Update `orchestrator.ts` - `reconcile()`

Add PR creation when all tasks are complete:

```typescript
private async reconcile(issue: Issue): Promise<void> {
  const branch = `issue/${issue.number}`;
  
  // Check if PR already exists
  const existingPR = await this.issues.getPRForBranch(branch);
  
  if (!existingPR || existingPR.state !== 'open') {
    await this.issues.createPR({
      head: branch,
      base: 'main',
      title: `feat(#${issue.number}): ${issue.title}`,
      body: `## Implementation of #${issue.number}\n\n${issue.title}\n\nAll tasks have been implemented and tested.\n\n---\n*Implemented by whitesmith*\n\nCloses #${issue.number}`,
    });
  }
  
  await this.issues.addLabel(issue.number, LABELS.COMPLETED);
  await this.issues.removeLabel(issue.number, LABELS.TASKS_ACCEPTED);
}
```

### 4. Update documentation

Update the orchestrator comment to reflect the new branch strategy:
- Investigate: `investigate/<issue-number>` → PR for task review
- Implement: `issue/<issue-number>` → accumulates commits, one PR when all tasks done

## Testing

1. Create a test issue with multiple tasks
2. Run whitesmith in `--no-push` mode
3. Verify:
   - All tasks create commits on `issue/<number>` branch
   - No PRs created during implementation
   - PR created in reconcile phase with all commits
   - PR body summarizes all completed tasks

## Acceptance Criteria

- [ ] Branch naming uses `issue/<number>` format
- [ ] Each task implementation adds one commit to the issue branch
- [ ] No PRs created during `implement()` phase
- [ ] PR created in `reconcile()` phase when all tasks complete
- [ ] PR body summarizes all completed tasks
- [ ] Error recovery works: if agent crashes mid-way, branch persists and can resume
- [ ] Git history shows task progression via commits

## Notes

- Task file structure remains unchanged: `tasks/<issue>/<seq>-<slug>.md`
- The `TaskManager` already supports issue folders, no changes needed there
- This addresses the error recovery gap described in PR #17 comment
