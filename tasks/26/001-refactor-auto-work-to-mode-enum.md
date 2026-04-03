---
id: "26-001"
issue: 26
title: "Refactor autoWork from boolean to mode enum (never/always/triggered/ai)"
depends_on: []
---

## Description

Replace the boolean `autoWork` field in `DevPulseConfig` with a string union `autoWorkMode` supporting four modes: `"never"`, `"always"`, `"triggered"`, and `"ai"`. Update the CLI option from `--auto-work` (boolean flag) to `--auto-work <mode>` (string argument with default `"triggered"`). Add an optional `--auto-work-model <model>` option for the `ai` mode. Refactor `isAutoWorkEnabled()` in `src/auto-work.ts` to implement the new mode logic.

## Acceptance Criteria

- `DevPulseConfig.autoWork` (boolean) is replaced with `autoWorkMode: "never" | "always" | "triggered" | "ai"` and an optional `autoWorkModel?: string` field
- CLI `--auto-work <mode>` accepts `never`, `always`, `triggered`, `ai` with default `triggered`
- CLI `--auto-work-model <model>` is added (optional, falls back to main `--model`)
- `isAutoWorkEnabled()` is made **async** (returns `Promise<boolean>`) to prepare for the AI call in task 002
- `isAutoWorkEnabled()` behavior per mode:
  - `never`: always returns `false`
  - `always`: always returns `true`
  - `triggered`: returns `true` if the issue has the `whitesmith:auto-work` label OR the issue body contains `whitesmith:auto-work` (current trigger behavior)
  - `ai`: returns `true` if triggered conditions are met (does NOT yet call AI — that is task 002)
- All callers of `isAutoWorkEnabled()` (in `src/orchestrator.ts` `decideAction()`) are updated to `await` the async function
- All existing tests in `test/auto-work.test.ts` are updated to use the new mode enum and `await` the async function
- All references to `config.autoWork` in `src/orchestrator.ts` and anywhere else are updated
- The old `--auto-work` boolean flag no longer exists

## Implementation Notes

### Files to modify
- `src/types.ts`: Change `autoWork: boolean` to `autoWorkMode: 'never' | 'always' | 'triggered' | 'ai'`, add `autoWorkModel?: string`
- `src/auto-work.ts`: Refactor `isAutoWorkEnabled()` to switch on mode and make it **async** (returns `Promise<boolean>`). This prepares for task 002 which will add the actual AI call. For `ai` mode in this task, just fall through to `triggered` logic.
- `src/cli.ts`: Replace `.option('--auto-work', ...)` with `.option('--auto-work <mode>', 'Auto-work mode (never|always|triggered|ai)', 'triggered')` and add `.option('--auto-work-model <model>', 'Model for AI auto-work decisions')`. Update config construction.
- `src/orchestrator.ts`: Update `decideAction()` to `await` the now-async `isAutoWorkEnabled()`. Update `run()` log output to show the auto-work mode instead of boolean.
- `test/auto-work.test.ts`: Update `makeConfig` default and all test cases to use mode strings. Update tests to await the now-async function.

### Backward compatibility
The `triggered` default preserves the old behavior where label/body triggers enable auto-work. The old `--auto-work` boolean flag (which mapped to global enable) is replaced — users who passed `--auto-work` should now pass `--auto-work always`.
