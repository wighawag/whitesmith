---
id: "43-005"
issue: 43
title: "Update install-ci to generate workflows with new triggers and labels"
depends_on: ["43-003", "43-004"]
---

## Description

Update the `install-ci` command's workflow generators in `src/providers/github-ci.ts` to include the new triggers and logic for ambiguous investigations.

### Changes to generated workflows

1. **`generateIssueWorkflow()`** — Update to trigger on both `opened` and `edited` events. Add a condition for the `edited` event to only run when the issue has the `whitesmith:needs-clarification` label:

   ```yaml
   on:
     issues:
       types: [opened, edited]
   
   jobs:
     run:
       if: >-
         github.event.action == 'opened' ||
         (github.event.action == 'edited' && 
          contains(join(github.event.issue.labels.*.name, ','), 'whitesmith:needs-clarification'))
   ```

2. **`generateCommentWorkflow()`** — Update the `check` job to also trigger for comments on issues with `needs-clarification` label. Add a new path in the check step:

   ```bash
   # Check if this is a comment on a needs-clarification issue (not a PR, not a bot)
   if [ -z "${{ github.event.issue.pull_request.url }}" ]; then
     # It's an issue comment
     LABELS=$(gh issue view ${{ github.event.issue.number }} \
       --repo ${{ github.repository }} --json labels -q '.labels[].name')
     if echo "$LABELS" | grep -q 'whitesmith:needs-clarification'; then
       # Check it's not a bot comment
       if [[ "${{ github.event.comment.user.type }}" != "Bot" ]]; then
         echo "should_run=true" >> "$GITHUB_OUTPUT"
         echo "run_mode=reinvestigate" >> "$GITHUB_OUTPUT"
         exit 0
       fi
     fi
   fi
   ```

   Add a new output `run_mode` to distinguish between regular comment handling and re-investigation. In the `run` job, use `run_mode` to decide whether to run `whitesmith comment` or `whitesmith run --issue`.

3. **New labels in setup action** — The `ensureLabels` call already handles this at runtime, but document the new labels in any generated README or comments.

### Files to modify

- `src/providers/github-ci.ts` — Update `generateIssueWorkflow()`, `generateCommentWorkflow()`.

## Acceptance Criteria

- `install-ci` generates an issue workflow that triggers on both `opened` and `edited`
- The `edited` trigger is filtered to only run for issues with `needs-clarification` label
- `install-ci` generates a comment workflow that detects needs-clarification issues
- The comment workflow routes needs-clarification issue comments to `whitesmith run --issue` instead of `whitesmith comment`
- Bot comments are filtered out in the re-investigation path
- Existing workflow generation behavior is preserved for non-ambiguity flows
- The generated workflows pass YAML linting

## Implementation Notes

- The `generateIssueWorkflow()` and `generateCommentWorkflow()` functions use template strings. Be careful with escaping `${{ }}` expressions — they need to use `\${{ }}` in the template literals.
- The comment workflow's `check` job already has a complex conditional. Add the new branch cleanly — the needs-clarification check should come before the existing `/whitesmith` trigger check.
- For the re-investigation path in the comment workflow, save the comment body to a file and pass it via `--comment-body-file` to `whitesmith run` (from task 43-003).
- Test by running `install-ci --fake` and comparing the generated files.
