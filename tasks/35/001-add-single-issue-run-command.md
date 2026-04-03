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
   - If the issue has `tasks-proposed` and auto-work is enabled → auto-approve the task PR.
   - If the issue has `tasks-accepted` and tasks remain → implement the next available task (repeat for all available tasks up to `--max-iterations`).
   - If the issue has `tasks-accepted` and all tasks are done → reconcile (close the issue).
3. The `--max-iterations` flag should still limit total agent invocations.

This is the foundational change that all the event-driven workflows will build on.

## Acceptance Criteria

- `whitesmith run . --issue 42 --provider anthropic --model claude-opus-4-6` targets only issue #42.
- When `--issue` is provided, no other issues are considered (no global scan).
- The orchestrator processes the full pipeline for that issue within the iteration limit.
- When `--issue` is NOT provided, behavior is unchanged (backward compatible).
- The `--dry-run` flag works with `--issue`.
- Unit tests cover the single-issue flow: investigate, implement, reconcile paths.

## Implementation Notes

- Modify `src/cli.ts`: add `--issue <number>` option to the `run` command.
- Modify `src/types.ts`: add an optional `issueNumber?: number` field to `DevPulseConfig`.
- Modify `src/orchestrator.ts`:
  - Add a new method (e.g., `runForIssue(issueNumber: number)`) that fetches the issue, determines its current state, and runs the appropriate action(s) in sequence.
  - The existing `run()` method should delegate to `runForIssue()` when `config.issueNumber` is set.
  - In `runForIssue`, after investigate completes, if auto-work is on, immediately proceed to auto-approve, then implement tasks — all within the same run.
- Add tests in `test/orchestrator.test.ts` for the new single-issue mode.
