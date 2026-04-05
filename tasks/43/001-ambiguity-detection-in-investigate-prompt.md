---
id: "43-001"
issue: 43
title: "Add ambiguity detection to the investigate prompt and parse agent output"
depends_on: []
---

## Description

Modify the investigate phase so the agent can signal ambiguity/uncertainty, and add parsing logic to detect it.

Currently, `buildInvestigatePrompt()` in `src/prompts.ts` asks the agent to generate task files. There is no mechanism for the agent to say "I need clarification" instead. This task adds:

1. **Updated investigate prompt** — Tell the agent it can signal ambiguity by writing a special response file (`.whitesmith-ambiguity.md`) instead of creating task files. The response file should contain specific questions/clarifications needed, formatted in markdown.

2. **Ambiguity response parsing** — Add a function to detect whether the agent signaled ambiguity. After the agent runs during `investigate()`, check for the presence of `.whitesmith-ambiguity.md` in the working directory. If it exists, read its contents and return it as the ambiguity signal.

3. **New types** — Add an `InvestigateResult` type to `src/types.ts`:
   ```typescript
   export type InvestigateResult =
     | { outcome: 'tasks'; taskCount: number }
     | { outcome: 'ambiguous'; clarificationComment: string };
   ```

### Files to modify

- `src/prompts.ts` — Update `buildInvestigatePrompt()` to include instructions about the ambiguity escape hatch. The prompt should tell the agent:
  - If the issue is clear, generate task files as before.
  - If the issue is ambiguous, unclear, or needs more information, write a file `.whitesmith-ambiguity.md` containing specific questions and do NOT create any task files. Do NOT commit anything.
  - The ambiguity file should be structured with a brief summary of what was understood, followed by numbered questions.

- `src/types.ts` — Add `InvestigateResult` type.

- `src/orchestrator.ts` — Extract the ambiguity-detection logic from `investigate()` into a helper method (e.g., `checkForAmbiguity()`) that reads `.whitesmith-ambiguity.md` if it exists and cleans it up. The `investigate()` method itself will be updated in task 43-002 to use the new branching logic.

## Acceptance Criteria

- `buildInvestigatePrompt()` includes clear instructions for the agent to signal ambiguity via `.whitesmith-ambiguity.md`
- The prompt tells the agent NOT to create task files and NOT to commit when signaling ambiguity
- An `InvestigateResult` type is defined in `src/types.ts`
- A helper function/method exists to check for `.whitesmith-ambiguity.md`, read its contents, and clean up the file
- `.whitesmith-ambiguity.md` is excluded from git commits (it's already covered by `.whitesmith-*` in `ensureExcluded()` in `git.ts`)
- Unit tests for the ambiguity detection helper (reads file, returns content, cleans up; returns null when no file)
- Unit tests for the updated prompt (contains ambiguity instructions)
- Existing `buildInvestigatePrompt` tests still pass

## Implementation Notes

- The `.whitesmith-*` pattern is already in `git.ts`'s `ensureExcluded()` method, so `.whitesmith-ambiguity.md` will automatically be excluded from git tracking.
- Follow the same pattern as `.whitesmith-response.md` and `.whitesmith-review.md` used in `comment.ts` and `review.ts` — read file, extract content, delete file.
- The prompt update should be additive — the existing task-generation instructions remain, with a new section added for the ambiguity path.
- Add the prompt test to `test/prompts.test.ts`.
