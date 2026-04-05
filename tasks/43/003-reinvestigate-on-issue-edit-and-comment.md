---
id: "43-003"
issue: 43
title: "Re-investigate on issue edit or user comment when needs-clarification"
depends_on: ["43-002"]
---

## Description

Add workflow triggers and orchestrator logic to re-investigate an issue when the user provides clarification, either by editing the issue body or by replying with a comment.

### 1. GitHub Actions workflow changes

**`whitesmith-issue.yml`** — Currently triggers only on `issues.opened`. Add `issues.edited` as a trigger:

```yaml
on:
  issues:
    types: [opened, edited]
```

Add a condition to the job: on `edited` events, only run if the issue has the `whitesmith:needs-clarification` label (to avoid re-investigating every issue edit).

**`whitesmith-comment.yml`** — Currently triggers on `issue_comment.created`. Update the `check` job to also trigger re-investigation when:
- The comment is on an issue (not a PR)
- The issue has the `whitesmith:needs-clarification` label
- The comment is from a non-bot user (not from `whitesmith[bot]` or any `[bot]` user)

When these conditions are met, instead of running `whitesmith comment`, run `whitesmith run --issue <N>` to re-investigate.

### 2. Orchestrator changes

**`decideActionForIssue()`** — When an issue has the `needs-clarification` label, treat it as ready for re-investigation (return `investigate` action) instead of idle. The label should be removed at the start of `investigate()` so the normal investigation flow proceeds.

**`investigate()`** — At the start, if the issue has the `needs-clarification` label, remove it before proceeding. This ensures the issue goes through the full investigation flow again.

### 3. Context for re-investigation

When re-investigating after a comment reply, the orchestrator should pass the latest comment context to the agent. Update `buildInvestigatePrompt()` to optionally accept a `latestComment` parameter:

```typescript
export function buildInvestigatePrompt(
  issue: Issue, 
  issueTasksDir: string,
  options?: { latestComment?: string }
): string
```

When `latestComment` is provided, include it in the prompt so the agent can consider the user's reply.

For the workflow, the latest comment body should be passed through to the orchestrator. Add an optional `--comment-body` flag to `whitesmith run` CLI that pipes through to the investigate prompt.

### Files to modify

- `.github/workflows/whitesmith-issue.yml` — Add `edited` trigger with label filter.
- `.github/workflows/whitesmith-comment.yml` — Add re-investigation path for needs-clarification issues.
- `src/orchestrator.ts` — Update `decideActionForIssue()` to handle `needs-clarification` label. Update `investigate()` to remove the label.
- `src/prompts.ts` — Add optional `latestComment` to `buildInvestigatePrompt()`.
- `src/cli.ts` — Add `--comment-body` option to the `run` command.
- `src/types.ts` — Add optional `commentBody` field to `DevPulseConfig`.

## Acceptance Criteria

- Issue edit triggers re-investigation when issue has `needs-clarification` label
- Issue edit does NOT trigger re-investigation for issues without `needs-clarification` label
- User comment on a `needs-clarification` issue triggers re-investigation
- Bot comments are ignored (do not trigger re-investigation)
- Comments on PRs do not trigger re-investigation through this path
- The `needs-clarification` label is removed when re-investigation starts
- When a comment triggered re-investigation, the comment body is included in the agent prompt
- When an edit triggered re-investigation, only the updated issue body is used (no comment context needed)
- The re-investigation follows the same ambiguity detection flow (can still result in another clarification comment)
- Unit tests cover: `decideActionForIssue` returns `investigate` for `needs-clarification` issues, `investigate()` removes the label
- Workflow files have correct trigger conditions and filtering

## Implementation Notes

- For the issue edit workflow, use GitHub Actions' `if` condition with `contains(github.event.issue.labels.*.name, 'whitesmith:needs-clarification')` to filter.
- For the comment workflow, the check job already runs — add an additional condition branch that detects needs-clarification issues and routes to `whitesmith run` instead of `whitesmith comment`.
- The `--comment-body` flag for `whitesmith run` should accept a file path (like `--body-file` in the comment command) to avoid shell escaping issues with long comments.
- Only the latest comment is passed — no comment history scanning, keeping the context window bounded.
- The `latestComment` in the prompt should be clearly labeled so the agent knows it's a user's reply to a clarification request.
