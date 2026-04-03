---
id: "30-002"
issue: 30
title: "Add scope assessment to the investigate phase — detect oversized issues and create sub-issues"
depends_on: ["30-001"]
---

## Description

Modify the investigate phase so that the agent first assesses whether an issue is too large for a single set of tasks (i.e., too large for a single PR). If the issue is too large, instead of generating task files, the agent should output a **decomposition plan** — a set of smaller, independent sub-issues that together cover the original issue. The orchestrator then creates these sub-issues on GitHub and marks the parent issue accordingly.

This is the core feature: the investigate phase gains a two-step decision:
1. **Scope check**: Is this issue small enough for one PR's worth of tasks?
2. **If yes**: Generate task files as today (no change).
3. **If no**: Output a decomposition into sub-issues. The orchestrator creates them on GitHub.

### New label

Add a new label `whitesmith:decomposed` to `LABELS` in `types.ts`. This label is applied to the parent issue after sub-issues are created, signaling that the issue has been broken down and should not be investigated again.

### New prompt

Create a new prompt function `buildInvestigatePrompt` (or modify the existing one) that instructs the agent to:
1. Explore the codebase and understand the issue.
2. Decide if the issue is small enough for a single set of tasks (guideline: if it would require more than ~5-7 task files, or if the tasks span very different subsystems, it's too large).
3. If **small enough**: generate task files as today (write to `tasks/<N>/` directory).
4. If **too large**: write a JSON file (e.g., `.whitesmith-decomposition.json`) describing the sub-issues. Each sub-issue entry should have:
   - `title`: concise title
   - `body`: detailed description (markdown) including a reference back to the parent issue
   - `depends_on`: array of indices (0-based) of other sub-issues in the list that must be completed first

### Orchestrator changes

In `orchestrator.ts`, after the agent runs during the `investigate` phase:
1. Check if a decomposition file exists (`.whitesmith-decomposition.json`).
2. If it does:
   - Parse the sub-issues from the JSON.
   - Create each sub-issue via `issues.createIssue()` (from task 30-001).
   - Add dependency information in the sub-issue body (e.g., "Depends on #X" for issues that have dependencies).
   - Add the `whitesmith:decomposed` label to the parent issue.
   - Comment on the parent issue listing the created sub-issues.
   - Do NOT create a PR or task files.
   - Clean up the decomposition file.
3. If it doesn't exist, proceed as today (task files were generated).

### Decision action flow

Update `decideAction()` so that issues labeled `whitesmith:decomposed` are skipped (they should not be investigated or implemented — their sub-issues are the actionable items).

## Acceptance Criteria

- A new `DECOMPOSED` label (`whitesmith:decomposed`) is added to `LABELS` in `src/types.ts`.
- The investigate prompt instructs the agent to assess scope and either generate tasks OR produce a decomposition plan.
- The decomposition plan format is a JSON file (`.whitesmith-decomposition.json`) with an array of sub-issue objects containing `title`, `body`, and `depends_on` fields.
- When the agent produces a decomposition file, the orchestrator:
  - Creates sub-issues on GitHub using `issues.createIssue()`.
  - Includes dependency references in sub-issue bodies (e.g., "Depends on #X" or "Blocked by #Y").
  - Includes a reference back to the parent issue in each sub-issue body.
  - Labels the parent issue with `whitesmith:decomposed`.
  - Removes the `whitesmith:investigating` label from the parent issue.
  - Comments on the parent issue with a summary of created sub-issues.
  - Does NOT create a PR or branch for the parent issue.
- Issues labeled `whitesmith:decomposed` are excluded from investigation and implementation in `decideAction()`.
- The `.whitesmith-decomposition.json` file is excluded from git commits (added to `.git/info/exclude` pattern, similar to `.whitesmith-*`).
- When the agent determines the issue IS small enough, the existing task-generation flow works unchanged.

## Implementation Notes

### Files to modify

- **`src/types.ts`**: Add `DECOMPOSED: 'whitesmith:decomposed'` to `LABELS`.
- **`src/prompts.ts`**: Modify `buildInvestigatePrompt()` to include scope assessment instructions and the decomposition output format. The prompt should clearly describe both paths (tasks vs. decomposition) and the JSON schema for the decomposition file.
- **`src/orchestrator.ts`**:
  - In `investigate()`: After the agent runs, check for `.whitesmith-decomposition.json`. If present, parse it, create sub-issues, label the parent, and return. If not present, proceed with existing task-file logic.
  - In `decideAction()`: When listing new issues (Priority 4), also exclude issues with the `whitesmith:decomposed` label by adding it to the `allDevPulseLabels` set (it's already included via `Object.values(LABELS)`).
- **`src/git.ts`**: The `.whitesmith-*` pattern in `ensureExcluded()` already covers `.whitesmith-decomposition.json`, so no changes needed here.

### Decomposition JSON schema

```json
{
  "reasoning": "Brief explanation of why this issue is too large",
  "sub_issues": [
    {
      "title": "Sub-issue title",
      "body": "Detailed description...\n\nParent issue: #30",
      "depends_on": []
    },
    {
      "title": "Another sub-issue",
      "body": "Description...\n\nParent issue: #30\nDepends on the first sub-issue being completed.",
      "depends_on": [0]
    }
  ]
}
```

The `depends_on` array contains 0-based indices into the `sub_issues` array. When creating issues on GitHub, the orchestrator resolves these indices to actual issue numbers and adds "Depends on #N" text to the body.

### Prompt design considerations

- The prompt should give the agent clear heuristics for when an issue is "too big": e.g., more than 5-7 tasks, spans multiple unrelated subsystems, or would result in a PR that's hard to review as a unit.
- The prompt should instruct the agent to make sub-issues as independent as possible, minimizing dependencies.
- Each sub-issue should be self-contained: it should have enough context that when investigated independently, the agent can generate tasks for it without needing to read the parent issue.
