---
id: "43-002"
issue: 43
title: "Comment on issue instead of creating PR when investigation is ambiguous"
depends_on: ["43-001"]
---

## Description

Update the `investigate()` method in `src/orchestrator.ts` to handle the ambiguity path: when the agent signals ambiguity (via `.whitesmith-ambiguity.md`), comment on the issue with clarification questions instead of creating a PR with task files.

### Current flow
```
investigate() → agent generates tasks → push branch → create PR → label tasks-proposed
```

### New flow
```
investigate() → agent signals ambiguity? 
  YES → comment on issue with questions → label needs-clarification → return (no PR)
  NO  → existing flow (push branch → create PR → label tasks-proposed)
```

### Changes needed

1. **New label** — Add `NEEDS_CLARIFICATION: 'whitesmith:needs-clarification'` to `LABELS` in `src/types.ts`.

2. **Update `investigate()` in `src/orchestrator.ts`** — After the agent runs:
   - Check for ambiguity using the helper from task 43-001.
   - If ambiguous:
     - Remove the `investigating` label.
     - Add the `needs-clarification` label.
     - Post a comment on the issue with the agent's clarification questions, wrapped in a standard template that includes instructions on how to respond (see comment template below).
     - Do NOT create a branch, push, or create a PR.
     - Return early.
   - If not ambiguous:
     - Continue with the existing flow (verify tasks, push, create PR, etc.)

3. **Comment template** — The comment posted on the issue should follow this format:
   ```markdown
   🤔 I've analyzed this issue and need clarification before generating implementation tasks:

   <agent's clarification questions from .whitesmith-ambiguity.md>

   ---

   **How to respond:**
   1. **Edit this issue** (preferred) — update the description with the missing details
   2. **Reply to this comment** — but please include full context in your reply. **I don't read comment history**, only the latest reply.

   I'll automatically re-analyze when the issue is updated.
   ```

4. **Update `decideAction()` and `decideActionForIssue()`** — Issues with the `needs-clarification` label should be treated as "waiting" (idle), not picked up for investigation.

5. **Update `ensureLabels()`** call — The new label should be included in the labels created at startup.

### Files to modify

- `src/types.ts` — Add `NEEDS_CLARIFICATION` to `LABELS`.
- `src/orchestrator.ts` — Modify `investigate()`, `decideAction()`, `decideActionForIssue()`.

## Acceptance Criteria

- When the agent signals ambiguity, a comment is posted on the issue with the clarification questions
- The comment includes clear instructions about editing the issue vs. replying
- The comment explicitly warns that comment history is not read
- No PR is created when investigation is ambiguous
- No branch is pushed when investigation is ambiguous
- The `needs-clarification` label is applied to the issue
- The `investigating` label is removed
- Issues with `needs-clarification` label are skipped during `decideAction()` (treated as idle/waiting)
- The `needs-clarification` label is included in `ensureLabels()`
- Existing investigate flow (non-ambiguous) is unchanged
- Unit tests cover: ambiguous investigation path (comment posted, no PR, correct labels), non-ambiguous path still works, `decideAction` skips needs-clarification issues

## Implementation Notes

- The comment template should be a function in `src/prompts.ts` (or a helper in `orchestrator.ts`) for testability.
- In `decideAction()`, filter out issues with `needs-clarification` in the `noLabels` filter for finding new issues. Also handle it explicitly in `decideActionForIssue()`.
- Make sure the agent's clarification text is properly sanitized/trimmed before including in the comment.
- When ambiguous, the orchestrator should still return to the `main` branch (clean up).
