---
id: "30-004"
issue: 30
title: "Update review, comment handling, and status command for decomposed issues"
depends_on: ["30-002"]
---

## Description

Update the supporting systems (review, comment handling, status command, and reconciliation) to be aware of the new `whitesmith:decomposed` state and sub-issue relationships. This ensures the full pipeline handles decomposed issues correctly, not just the investigate phase.

### Status command

The `status` CLI command should:
- Show decomposed issues under a `DECOMPOSED` section.
- For decomposed issues, list their sub-issues (parsed from the issue body or comments).

### Comment handling

When a user comments on a decomposed issue (e.g., `/whitesmith` trigger), the agent should:
- Understand that this issue has been decomposed into sub-issues.
- Include context about the sub-issues in the prompt.
- Be able to answer questions about the decomposition, the overall progress, etc.

### Reconciliation

The `reconcile` command and the reconciliation step in the orchestrator should:
- Check decomposed issues: if all sub-issues are closed/completed, close the parent issue too.
- Add the `whitesmith:completed` label and close the parent issue with a summary comment.

### Review

No changes needed for the review system itself — decomposed issues don't produce PRs, so there's nothing to review at the parent level. Sub-issues go through the normal review flow. This is noted here for completeness.

## Acceptance Criteria

- The `status` command shows issues labeled `whitesmith:decomposed` in a dedicated section.
- The `reconcile` command checks decomposed issues and closes the parent if all sub-issues are completed.
- The `reconcile` command in the orchestrator loop (`decideAction()` Priority 1) also checks decomposed issues for completion.
- Comment handling on decomposed issues includes sub-issue context in the agent prompt.
- The `DECOMPOSED` label is included in `ensureLabels()` calls (already covered by `Object.values(LABELS)` if added to `LABELS` in task 30-002).

## Implementation Notes

### Files to modify

- **`src/cli.ts`** — `status` command action:
  - Add a section that lists issues with the `whitesmith:decomposed` label.
  - For each decomposed issue, optionally show sub-issue references found in comments or body.

- **`src/cli.ts`** — `reconcile` command action:
  - After handling `tasks-proposed` and `tasks-accepted` issues, add a new loop for `whitesmith:decomposed` issues.
  - For each decomposed issue, parse the sub-issue numbers from the parent issue body/comments (look for the comment posted during decomposition listing created sub-issues).
  - Check if all referenced sub-issues are closed.
  - If all closed, add `whitesmith:completed`, remove `whitesmith:decomposed`, comment, and close.

- **`src/orchestrator.ts`** — `decideAction()`:
  - Add a reconciliation check for decomposed issues (similar to Priority 1 for tasks-accepted).
  - Create a `reconcileDecomposed(issue)` method that checks if all sub-issues are closed and if so, closes the parent.

- **`src/comment.ts`** — `gatherContextForIssue()`:
  - When the issue has the `whitesmith:decomposed` label, gather sub-issue information.
  - Parse sub-issue numbers from the issue body/comments.
  - Include them in the `WhitesmithContext` (may need to extend the context interface with a `subIssues` field).

### Parsing sub-issue references

The decomposition step (task 30-002) posts a comment on the parent issue listing the created sub-issues. Parse this comment to find sub-issue numbers. The format should be something like:
```
📋 This issue has been decomposed into sub-issues:
- #31: Sub-issue title 1
- #32: Sub-issue title 2
```

Use a regex like `/#(\d+)/g` on the decomposition comment to extract sub-issue numbers.

### Checking sub-issue completion

Use `issues.getIssue()` for each sub-issue number and check if the issue's state is closed (the `gh` CLI returns state info). Alternatively, check for the `whitesmith:completed` label. Since issues can be closed manually, checking the closed state is more robust.

Note: The `getIssue()` method currently only returns open issues' data. You may need to ensure it works for closed issues too, or add an `isIssueClosed()` method to the provider.
