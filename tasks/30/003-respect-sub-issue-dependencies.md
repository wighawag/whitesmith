---
id: "30-003"
issue: 30
title: "Respect sub-issue dependency ordering in the orchestrator"
depends_on: ["30-002"]
---

## Description

When a large issue is decomposed into sub-issues, some sub-issues may depend on others (e.g., sub-issue B depends on sub-issue A being merged first). The orchestrator needs to respect these dependency relationships when deciding which issues to investigate and implement.

Currently, `decideAction()` picks issues in a simple order (oldest first for investigation, first available task for implementation). This task adds inter-issue dependency awareness so that:

1. A sub-issue that depends on another sub-issue is NOT investigated or implemented until the dependency sub-issue has been completed (closed with `whitesmith:completed` label, or its implementation PR merged).
2. The dependency information is parsed from the sub-issue body text (e.g., "Depends on #X" lines added during decomposition in task 30-002).

### Dependency detection

Sub-issues created by the decomposition step (task 30-002) include "Depends on #X" lines in their body. The orchestrator should parse these to build a dependency graph. A sub-issue is "ready" when all issues it depends on are closed.

### Changes to decideAction()

- When considering issues for investigation (Priority 4: new issues), check if the issue body contains "Depends on #X" references. If any referenced issue is still open, skip this issue.
- When considering issues for implementation (Priority 3: tasks-accepted issues), similarly check if the parent issue has unresolved dependencies.

## Acceptance Criteria

- A utility function (e.g., `parseIssueDependencies(body: string): number[]`) extracts issue numbers from "Depends on #X" patterns in an issue body.
- `decideAction()` skips issues whose dependencies are not yet closed when selecting issues for investigation.
- `decideAction()` skips issues whose dependencies are not yet closed when selecting tasks for implementation.
- Circular dependencies are handled gracefully (e.g., logged as a warning and the issue is skipped).
- Issues with no dependency markers behave exactly as before (no regression).
- The dependency check is efficient — it should batch-fetch issue states rather than making N+1 API calls where possible.

## Implementation Notes

### Files to modify

- **`src/orchestrator.ts`**:
  - Add a helper method `parseIssueDependencies(body: string): number[]` that extracts issue numbers from patterns like `Depends on #123`, `Blocked by #456`, or `depends_on: [#123, #456]`.
  - In `decideAction()`, Priority 4 (investigate new issues): filter out issues whose dependencies are not closed.
  - In `decideAction()`, Priority 3 (implement tasks): filter out issues whose dependencies are not closed. You can check this by calling `issues.getIssue()` for each dependency number and checking if it's closed or has the `whitesmith:completed` label.

- **`src/providers/issue-provider.ts`**: Consider adding an `isIssueClosed(number: number): Promise<boolean>` method, or use the existing `getIssue()` and check labels. Alternatively, add `listIssues` support for closed issues. The simplest approach is to use the `gh` CLI to check issue state.

- **`src/providers/github.ts`**: If adding a new method, implement it using `gh issue view <number> --json state`.

### Dependency parsing

Use a regex like `/(?:depends on|blocked by)\s+#(\d+)/gi` to extract issue numbers from the body text. This should match the format used by the decomposition step in task 30-002.

### Performance considerations

- Cache issue state lookups within a single `decideAction()` call to avoid redundant API requests.
- Consider fetching all referenced issues in one batch if the `gh` CLI supports it, or at minimum avoid re-fetching the same issue multiple times across the loop iterations.

### Edge cases

- An issue depends on an issue that doesn't exist → treat as unsatisfied (skip the issue, log a warning).
- An issue depends on itself → skip with a warning (circular dependency).
- An issue has no "Depends on" markers → no dependency check, process normally.
- A dependency issue is closed but NOT completed by whitesmith → still treat as satisfied (any closure counts).
