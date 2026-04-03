---
id: "23-001"
issue: 23
title: "Add auto-work detection via config, label, and issue body"
depends_on: []
---

## Description

Add the ability to detect whether auto-work is enabled for a given issue. This involves three detection mechanisms:

1. **Global config option**: Add an `autoWork` boolean field to `DevPulseConfig` (defaults to `false`)
2. **CLI flag**: Add `--auto-work` flag to the `run` command in `cli.ts`
3. **Label-based**: Check if the issue has the `whitesmith:auto-work` label
4. **Issue body detection**: Check if the issue body contains the string `whitesmith:auto-work`

Create a helper function (e.g., `isAutoWorkEnabled(config, issue)`) that returns `true` if any of these conditions are met. This function should live in a place accessible to the orchestrator (could be a method on the `Orchestrator` class or a standalone utility).

## Acceptance Criteria

- `DevPulseConfig` in `src/types.ts` has an `autoWork: boolean` field
- The `run` command in `src/cli.ts` accepts `--auto-work` flag and passes it to config
- A constant `AUTO_WORK` label (`whitesmith:auto-work`) is added to `LABELS` or defined alongside the detection logic
- A function/method `isAutoWorkEnabled(config: DevPulseConfig, issue: Issue): boolean` exists that returns `true` if:
  - `config.autoWork` is `true`, OR
  - `issue.labels` includes `whitesmith:auto-work`, OR
  - `issue.body` contains the string `whitesmith:auto-work`
- Unit tests cover all three detection paths

## Implementation Notes

- **Files to modify**: `src/types.ts`, `src/cli.ts`
- **Files to create or modify**: Add detection logic either in `src/orchestrator.ts` as a private method, or as a standalone helper (e.g., `src/auto-work.ts`)
- The `whitesmith:auto-work` label should be included in `ensureLabels()` call in `Orchestrator.run()` — add it to the labels array
- Keep it simple: the detection function is pure logic, no side effects
