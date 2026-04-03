---
id: "30-005"
issue: 30
title: "Add tests for issue decomposition and sub-issue dependency features"
depends_on: ["30-002", "30-003", "30-004"]
---

## Description

Add comprehensive tests for the new issue decomposition functionality, including:
1. Scope assessment logic (detecting when issues are too large).
2. Decomposition file parsing.
3. Sub-issue dependency parsing and resolution.
4. Orchestrator behavior for decomposed issues.
5. Reconciliation of decomposed parent issues.

## Acceptance Criteria

- Tests for `parseIssueDependencies()` utility function covering:
  - "Depends on #123" format
  - "Blocked by #456" format
  - Multiple dependencies in one body
  - No dependencies (empty result)
  - Edge cases (self-reference, non-existent format)
- Tests for decomposition JSON parsing:
  - Valid decomposition file is correctly parsed.
  - Invalid JSON or missing fields produce clear errors.
  - Dependency index resolution (0-based indices → issue numbers).
- Tests for orchestrator `decideAction()`:
  - Decomposed issues are skipped for investigation.
  - Issues with unresolved dependencies are skipped.
  - Issues with resolved dependencies proceed normally.
- Tests for reconciliation of decomposed issues:
  - Parent is closed when all sub-issues are closed.
  - Parent is NOT closed when some sub-issues are still open.
- All existing tests continue to pass (no regressions).

## Implementation Notes

### Files to create/modify

- **`test/decomposition.test.ts`** (new): Unit tests for decomposition JSON parsing, dependency parsing, and related utility functions.
- **`test/orchestrator.test.ts`** (new or existing): Tests for orchestrator behavior with decomposed issues. These may require mocking `IssueProvider` and `AgentHarness`.

### Testing approach

- Use `vitest` (already configured in the project via `vitest.config.ts`).
- Mock the `IssueProvider` interface for tests that involve GitHub API calls.
- Mock the `AgentHarness` for tests that involve running the agent.
- Use temporary directories for tests that involve file system operations (task files, decomposition JSON).

### Key test scenarios

1. **Decomposition file parsing**:
   - Create a `.whitesmith-decomposition.json` with valid content, verify it's parsed correctly.
   - Test with missing fields, empty arrays, invalid JSON.

2. **Dependency parsing**:
   - `parseIssueDependencies("Depends on #10")` → `[10]`
   - `parseIssueDependencies("Depends on #10\nBlocked by #20")` → `[10, 20]`
   - `parseIssueDependencies("No dependencies here")` → `[]`

3. **Orchestrator decision logic**:
   - Mock an issue with `whitesmith:decomposed` label → verify it's not picked for investigation.
   - Mock an issue with "Depends on #5" in body, where #5 is open → verify it's skipped.
   - Mock an issue with "Depends on #5" in body, where #5 is closed → verify it proceeds.

4. **Reconciliation**:
   - Mock a decomposed parent with sub-issues #10 and #11, both closed → verify parent is closed.
   - Mock a decomposed parent with sub-issues #10 (closed) and #11 (open) → verify parent is NOT closed.
