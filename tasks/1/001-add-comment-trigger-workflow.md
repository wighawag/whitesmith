---
id: "1-001"
issue: 1
title: "Add GitHub workflow for acting on @agent comment triggers"
depends_on: []
---

## Description

Create a new GitHub Actions workflow file `.github/workflows/whitesmith-comment.yml` that triggers when a comment containing `@agent` is posted on an issue or pull request. The workflow should:

1. Trigger on `issue_comment` events (which covers both issues and PRs).
2. Only run when the comment body contains `@agent`.
3. React to the comment with a 👀 emoji to acknowledge receipt.
4. Check out the repository code.
5. Set up Node.js, install whitesmith and pi (following the same pattern as `whitesmith.yml`).
6. Configure git and pi auth (same pattern as `whitesmith.yml`).
7. Build a prompt that includes:
   - The issue/PR title, body, and URL.
   - The triggering comment body.
   - If it's a PR, instruct the agent to check out the PR branch, make fixes, commit, and push directly to that branch.
   - If it's a plain issue, instruct the agent to create a new branch, implement changes, commit, push, and create a PR.
8. Run pi with the constructed prompt file.
9. On success, react to the comment with a ✅ emoji; on failure, react with ❌ and post a comment noting the failure.

## Acceptance Criteria

- A new workflow file exists at `.github/workflows/whitesmith-comment.yml`.
- The workflow triggers on `issue_comment` events with `types: [created]`.
- The workflow only runs when the comment body contains `@agent` (use an `if` condition).
- The workflow has appropriate permissions: `contents: write`, `issues: write`, `pull-requests: write`.
- The workflow uses a concurrency group to prevent multiple agent runs from the same issue/PR at the same time (e.g., group by issue number).
- The workflow acknowledges the comment with a reaction.
- For PR comments, the agent checks out the PR branch, applies changes based on the comment, commits, and pushes to the PR branch.
- For issue comments (not on a PR), the agent creates a new branch, implements the requested changes, and opens a PR.
- The workflow follows the same setup patterns as the existing `whitesmith.yml` (Node.js version, pnpm for whitesmith repo, pi install, auth config).
- Provider and model are configurable via `vars.WHITESMITH_PROVIDER` and `vars.WHITESMITH_MODEL` repository variables (same as the main workflow).

## Implementation Notes

- The `issue_comment` event fires for both issue comments and PR comments. Use the GitHub API or `github.event.issue.pull_request` to distinguish between the two.
- For PR comments, you can fetch the PR branch name using `gh pr view $PR_NUMBER --json headRefName -q .headRefName`.
- The prompt should be written to a temporary `.whitesmith-prompt.md` file and passed to pi via `pi --prompt-file`.
- Look at how `whitesmith.yml` handles the pi setup and auth configuration — replicate that pattern exactly.
- Use `gh api` to add reactions to comments: `gh api repos/{owner}/{repo}/issues/comments/{comment_id}/reactions -f content=eyes`.
- The concurrency group should be something like `whitesmith-comment-${{ github.event.issue.number }}` with `cancel-in-progress: false` to queue rather than cancel.
- For the self-repo case (wighawag/whitesmith), build from source with pnpm just like the main workflow does.
