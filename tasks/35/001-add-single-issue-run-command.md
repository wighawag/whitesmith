---
id: "35-001"
issue: 35
title: "Add single-issue `run` mode to orchestrator and CLI"
depends_on: []
---

## Description

Currently `whitesmith run` always scans all issues and picks the next action via `decideAction()`. To support event-driven triggers, the orchestrator needs a mode that targets a **single issue** and performs all applicable actions for it in one invocation (investigate → auto-approve → implement → reconcile), rather than picking one action from the global queue.

Add a `--issue <number>` option to the `run` CLI command. When provided:

1. The orchestrator should only consider that specific issue.
2. It should execute the full pipeline for that issue in sequence within a single run:
   - If the issue has no whitesmith labels → investigate it.
   - If the issue has `tasks-proposed` and the investigate PR is already merged (tasks exist on `main`) → perform the reconcile step inline (transition `tasks-proposed` → `tasks-accepted`), then proceed to implement.
   - If the issue has `tasks-proposed` and auto-work is enabled → auto-approve the task PR.
   - If the issue has `tasks-accepted` and tasks remain → implement the next available task (repeat for all available tasks up to `--max-iterations`).
   - If the issue has `tasks-accepted` and all tasks are done → reconcile (close the issue).
   - If the issue has `whitesmith:investigating` (stale from a crashed previous run) → clear the label, then proceed as if the issue has no labels (re-investigate).
3. The `--max-iterations` flag should still limit total agent invocations.

This is the foundational change that all the event-driven workflows will build on.

### State re-evaluation after each action

After each action completes (e.g., investigate → auto-approve → implement), the `runForIssue` method must **re-fetch the issue** via `this.issues.getIssue(issueNumber)` to get the updated labels before deciding the next action. This is necessary because actions mutate labels via API calls (e.g., `investigate` adds `tasks-proposed`), and the local `Issue` object becomes stale. The loop should:

1. Fetch the issue via `getIssue(issueNumber)`.
2. Inspect its labels to determine the current state.
3. Execute the appropriate action.
4. Repeat from step 1 until `idle` or iteration limit reached.

### Auto-work detection

When `--issue` is provided, auto-work should be detected using the existing `isAutoWorkEnabled(config, issue)` function, which checks the CLI `--auto-work` flag, the issue's `whitesmith:auto-work` label, and the issue body. Do **not** add separate auto-work logic — reuse this function.

## Acceptance Criteria

- `whitesmith run . --issue 42 --provider anthropic --model claude-opus-4-6` targets only issue #42.
- When `--issue` is provided, no other issues are considered (no global scan).
- The orchestrator processes the full pipeline for that issue within the iteration limit.
- After each action, `runForIssue` re-fetches the issue via `getIssue()` to get updated labels before deciding the next action.
- When the issue has a stale `whitesmith:investigating` label, `runForIssue` clears it and re-investigates.
- When the issue has `tasks-proposed` but the investigate PR is already merged (tasks exist on `main`), `runForIssue` transitions `tasks-proposed` → `tasks-accepted` inline and proceeds to implement.
- When `--issue` is NOT provided, behavior is unchanged (backward compatible).
- The `--dry-run` flag works with `--issue`.
- Unit tests cover the single-issue flow: investigate, implement, reconcile paths.
- Unit tests cover edge cases: stale `investigating` label, `tasks-proposed` with merged PR.

## Implementation Notes

- Modify `src/cli.ts`: add `--issue <number>` option to the `run` command.
- Modify `src/types.ts`: add an optional `issueNumber?: number` field to `DevPulseConfig`.
- Modify `src/orchestrator.ts`:
  - Add a new method (e.g., `runForIssue(issueNumber: number)`) that:
    1. Uses `this.issues.getIssue(issueNumber)` (already exists in `IssueProvider`) to fetch the issue.
    2. Inspects the issue's labels to determine its current state.
    3. Executes the appropriate action (investigate, auto-approve, implement, or reconcile).
    4. After each action, **re-fetches the issue** via `getIssue(issueNumber)` to get updated labels, then loops to step 2.
    5. Exits when the issue reaches `idle` state or the iteration limit is reached.
  - Handle the `whitesmith:investigating` label edge case: if the issue already has `investigating` at the start of `runForIssue`, clear it and treat the issue as uninvestigated (re-investigate). This handles crashed previous runs.
  - Handle the `tasks-proposed` + merged PR case: if the issue has `tasks-proposed` but tasks exist on `main` (investigate PR was already merged), perform the label transition `tasks-proposed` → `tasks-accepted` inline (same logic as `reconcile` CLI command in `cli.ts`), then proceed to implement. Use `TaskManager.hasRemainingTasks(issueNumber)` to check if tasks exist on `main`.
  - The existing `run()` method should delegate to `runForIssue()` when `config.issueNumber` is set.
  - In `runForIssue`, after investigate completes, if auto-work is on (check via `isAutoWorkEnabled(config, issue)`), immediately proceed to auto-approve, then implement tasks — all within the same run.
- Add tests in `test/orchestrator.test.ts` for the new single-issue mode, following the existing test patterns (mock providers, `createConfig()` helper with `...overrides` spread, `makeIssue()` helper). The `createConfig()` helper already omits `provider` and `model` since tests mock the agent — new tests should follow the same pattern.
