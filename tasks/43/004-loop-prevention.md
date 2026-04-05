---
id: "43-004"
issue: 43
title: "Add loop prevention for repeated ambiguity cycles"
depends_on: ["43-002"]
---

## Description

Add loop prevention to stop the system from endlessly cycling between "needs clarification" and "re-investigate" when the user's responses don't resolve the ambiguity.

### Mechanism

Track the number of ambiguity cycles by counting bot clarification comments on the issue. When the cycle count reaches a threshold (default: 3), the system should:

1. Stop auto-investigating
2. Add a `whitesmith:needs-human-review` label
3. Post a final comment explaining that human intervention is needed
4. Do NOT remove the `needs-clarification` label (so `decideAction` still skips it)

### Counting cycles

Before posting a new clarification comment, count existing bot comments that match the clarification template pattern (e.g., start with "🤔 I've analyzed this issue"). Use the GitHub CLI to fetch comments:

```bash
gh issue view <number> --json comments --jq '.comments[] | select(.author.login == "whitesmith[bot]" or .author.login == "github-actions[bot]") | .body' 
```

Count how many match the clarification pattern. If `count >= MAX_AMBIGUITY_CYCLES - 1` (about to hit the limit), escalate instead of posting another clarification.

### New label

Add `NEEDS_HUMAN_REVIEW: 'whitesmith:needs-human-review'` to `LABELS` in `src/types.ts`.

### Escalation comment template

```markdown
⚠️ This issue has gone through multiple clarification cycles without reaching a clear task breakdown.

**Human review is needed.** Please:
1. Review the issue description and previous clarification attempts
2. Either update the issue with more detail or break it down manually
3. Remove the `whitesmith:needs-human-review` and `whitesmith:needs-clarification` labels when ready for the agent to retry

_This issue will not be auto-investigated until the labels are removed._
```

### Files to modify

- `src/types.ts` — Add `NEEDS_HUMAN_REVIEW` label constant, add `maxAmbiguityCycles` to `DevPulseConfig` (default: 3).
- `src/orchestrator.ts` — Add cycle counting logic before posting clarification comments. Add escalation path.
- `src/providers/issue-provider.ts` — Add a method to list comments on an issue (needed for counting). Something like:
  ```typescript
  listComments(number: number): Promise<Array<{author: string; body: string}>>;
  ```
- `src/providers/github.ts` — Implement `listComments()` using `gh issue view --json comments`.
- `src/cli.ts` — Add `--max-ambiguity-cycles <n>` option to the `run` command (optional, default 3).
- `src/orchestrator.ts` — In `decideAction()` and `decideActionForIssue()`, treat issues with `needs-human-review` label as idle.

## Acceptance Criteria

- After 3 ambiguity cycles (configurable), the system stops auto-investigating
- The `whitesmith:needs-human-review` label is applied to the issue
- A clear escalation comment is posted explaining what happened
- Issues with `needs-human-review` label are skipped by `decideAction()` and `decideActionForIssue()`
- The threshold is configurable via `--max-ambiguity-cycles` CLI option
- Removing both `needs-human-review` and `needs-clarification` labels allows re-investigation
- The `needs-human-review` label is included in `ensureLabels()`
- Unit tests cover: cycle counting, escalation at threshold, skip logic for labeled issues
- The cycle count is based on bot clarification comments, not all comments

## Implementation Notes

- The `listComments` method should be lightweight — only fetch author and body, limit to recent comments.
- The clarification comment pattern matching should be simple — check if the comment body starts with the known prefix ("🤔 I've analyzed this issue").
- The max cycles config should default to 3 but be overridable.
- Consider that the bot username might be `github-actions[bot]` in CI and `whitesmith[bot]` if a GitHub App is used — filter for both.
- The cycle check should happen in `investigate()` BEFORE posting the clarification comment, not after.
