---
id: "13-001"
issue: 13
title: "Add --dry-run flag to the run command"
depends_on: []
---

## Description

Add a `--dry-run` flag to the `whitesmith run` command. When set, the orchestrator should **skip** `agent.validate()` and `ensureLabels()` (since the former is unnecessary when no agent will run and would fail for users without it installed, and the latter is a write operation that creates missing labels via the GitHub API), then fetch/checkout main, call `decideAction()`, print a human-readable summary of what it *would* do, and exit immediately with code 0. No agent runs, no git branch operations, no GitHub API mutations (labels, PRs, comments, closes) should occur.

## Acceptance Criteria

- `whitesmith run . --provider anthropic --model claude-opus-4-6 --dry-run` prints the decided action and exits with code 0.
- The printed output clearly identifies the action type and relevant details:
  - `reconcile` → prints "Would reconcile issue #N: <title>"
  - `investigate` → prints "Would investigate issue #N: <title>"
  - `implement` → prints "Would implement task <id>: <title> (issue #N)"
  - `idle` → prints "Nothing to do. All issues are either in-progress or completed."
- No agent is spawned, no branches are created or checked out (beyond the initial fetch/checkout-main), no labels are changed, no PRs are opened, no comments are posted.
- The `--dry-run` flag defaults to `false` when omitted (existing behavior unchanged).
- The flag is visible in `whitesmith run --help`.

## Implementation Notes

### 1. `src/types.ts`
Add `dryRun: boolean` to the `DevPulseConfig` interface.

### 2. `src/cli.ts`
- Add `.option('--dry-run', 'Print what would be done without executing it')` to the `run` command (after the existing options).
- Set `dryRun: opts.dryRun ?? false` in the config object passed to `Orchestrator`.

### 3. `src/orchestrator.ts`

**Skip side-effectful startup in dry-run mode.** Before the agent validation and label creation (around lines 45-50), add a guard:

```ts
// Skip agent validation and label creation in dry-run mode
if (!this.config.dryRun) {
    await this.agent.validate();
    console.log('Agent validated successfully.');
    console.log('');

    await this.issues.ensureLabels(Object.values(LABELS));
}
```

This ensures `--dry-run` doesn't fail if the agent isn't installed, and doesn't create labels as a side effect.

**Print action summary and exit early.** In the `run()` method, after calling `this.decideAction()` and the `console.log(`Action: ${action.type}`)` line, add:

```ts
if (this.config.dryRun) {
    switch (action.type) {
        case 'reconcile':
            console.log(`Would reconcile issue #${action.issue.number}: ${action.issue.title}`);
            break;
        case 'investigate':
            console.log(`Would investigate issue #${action.issue.number}: ${action.issue.title}`);
            break;
        case 'implement':
            console.log(`Would implement task ${action.task.id}: ${action.task.title} (issue #${action.issue.number})`);
            break;
        case 'idle':
            console.log('Nothing to do. All issues are either in-progress or completed.');
            break;
    }
    return;
}
```

This early return exits the loop (and the `run()` method) after the first `decideAction()` call, before any side effects.

### 4. Testing
- Verify `whitesmith run --help` shows the `--dry-run` option.
- If there are existing tests for the CLI or orchestrator, add a test that confirms `--dry-run` calls `decideAction()` but does not call `investigate()`, `implement()`, or `reconcile()`.
