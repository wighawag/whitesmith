---
id: "50-001"
issue: 50
title: "Add custom prompt loading with Handlebars template rendering"
depends_on: []
---

## Description

Currently, all prompts in whitesmith are hardcoded in `src/prompts.ts` and `src/comment.ts`. Users have no way to customize the prompts used during investigation, implementation, review, or comment handling. This task adds the ability for users to provide their own prompt templates in a `.whitesmith/prompts/` directory at the repository root, with Handlebars-style variable substitution.

### What to build

1. **A prompt template loader** that looks for user-provided prompt files in `.whitesmith/prompts/` directory
2. **A simple Handlebars-compatible template renderer** that substitutes `{{variableName}}` placeholders with actual values
3. **Integration with all existing prompt builders** so they check for a custom template first, falling back to the hardcoded default if none is found

### Prompt template file convention

Users place `.md` files in `.whitesmith/prompts/` at the repository root. Each file corresponds to a prompt type:

| File | Replaces | Available Variables |
|---|---|---|
| `investigate.md` | `buildInvestigatePrompt()` | `issueNumber`, `issueTitle`, `issueBody`, `issueUrl`, `issueTasksDir` |
| `implement.md` | `buildImplementPrompt()` | `issueNumber`, `issueTitle`, `issueUrl`, `taskId`, `taskTitle`, `taskContent`, `taskFilePath`, `taskIssue` |
| `review-task-proposal.md` | `buildReviewTaskProposalPrompt()` | `issueNumber`, `issueTitle`, `issueBody`, `issueUrl`, `taskList`, `taskPRUrl`, `responseFile` |
| `review-implementation-pr.md` | `buildReviewImplementationPRPrompt()` | `prNumber`, `prTitle`, `prBody`, `prBranch`, `prUrl`, `parentIssueSection`, `responseFile` |
| `review-task-completion.md` | `buildReviewTaskCompletionPrompt()` | `issueNumber`, `issueTitle`, `issueBody`, `issueUrl`, `implPRUrl`, `implBranch`, `responseFile` |
| `clarification-comment.md` | `buildClarificationComment()` | `clarificationText` |
| `escalation-comment.md` | `buildEscalationComment()` | (none) |
| `pr-comment.md` | `buildPRCommentPrompt()` in comment.ts | `prTitle`, `prUrl`, `prNumber`, `prBody`, `prBranch`, `commentBody`, `whitesmithContext`, `responseFile` |
| `issue-comment.md` | `buildIssueCommentPrompt()` in comment.ts | `issueTitle`, `issueUrl`, `issueNumber`, `issueBody`, `commentBody`, `responseFile`, `whitesmithContext`, `workOnPRInstructions` |

Variables use Handlebars syntax: `{{variableName}}`. If a variable is undefined, it renders as an empty string.

### How it works

- When a prompt builder function is called, it first checks if a corresponding custom template file exists in `.whitesmith/prompts/`
- If found, it reads the template, substitutes all `{{variableName}}` placeholders with the actual values, and returns the result
- If not found, it falls back to the existing hardcoded prompt (zero behavior change for users who don't provide custom templates)
- The working directory (`workDir`) is used to locate the `.whitesmith/prompts/` directory

## Acceptance Criteria

- A new module `src/prompt-loader.ts` exists that exports:
  - `renderTemplate(template: string, vars: Record<string, string>): string` — replaces `{{varName}}` with values, unknown vars become empty string
  - `loadCustomPrompt(workDir: string, promptName: string, vars: Record<string, string>): string | null` — reads `.whitesmith/prompts/<promptName>.md`, renders it with vars, returns null if file doesn't exist
- All prompt builder functions in `src/prompts.ts` accept an optional `workDir?: string` parameter as their last argument
- When `workDir` is provided, each prompt builder calls `loadCustomPrompt()` first and returns the custom prompt if found
- When `workDir` is not provided or no custom template exists, the existing hardcoded prompt is returned (backward compatible)
- The `buildPRCommentPrompt()` and `buildIssueCommentPrompt()` functions in `src/comment.ts` also check for custom templates
- The callers in `src/orchestrator.ts` and `src/review.ts` pass `workDir` (from `this.config.workDir` or `config.workDir`) to the prompt builder functions
- Unit tests in `test/prompt-loader.test.ts` verify:
  - `renderTemplate` correctly substitutes variables
  - `renderTemplate` replaces unknown variables with empty string
  - `renderTemplate` handles multiple occurrences of the same variable
  - `loadCustomPrompt` returns null when no custom file exists
  - `loadCustomPrompt` returns rendered template when custom file exists
- Existing tests in `test/prompts.test.ts` and `test/review.test.ts` still pass (backward compatibility)
- `.whitesmith/prompts/` directory should be mentioned in a brief section at the end of `README.md`

## Implementation Notes

### Files to create
- `src/prompt-loader.ts` — New module for template loading and rendering

### Files to modify
- `src/prompts.ts` — Add optional `workDir` parameter to all exported prompt builders; call `loadCustomPrompt()` at the start of each
- `src/comment.ts` — Add custom prompt loading to `buildPRCommentPrompt()` and `buildIssueCommentPrompt()` (these are private to the module, but the callers `handlePRComment` and `handleIssueComment` already have `config.workDir`)
- `src/orchestrator.ts` — Pass `this.config.workDir` to `buildInvestigatePrompt()` and `buildImplementPrompt()` calls
- `src/review.ts` — Pass `config.workDir` to review prompt builder calls
- `src/index.ts` — Export `renderTemplate` and `loadCustomPrompt` from `prompt-loader.ts`
- `README.md` — Add a "Custom Prompts" section
- `test/prompt-loader.test.ts` — New test file

### Template rendering approach

Implement a simple Handlebars-style renderer — do NOT add a `handlebars` dependency. The implementation only needs to handle `{{variableName}}` (no helpers, no block expressions, no partials). A simple regex replace is sufficient:

```typescript
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
```

### Custom prompt loading

```typescript
export function loadCustomPrompt(
  workDir: string,
  promptName: string,
  vars: Record<string, string>,
): string | null {
  const promptPath = path.join(workDir, '.whitesmith', 'prompts', `${promptName}.md`);
  if (!fs.existsSync(promptPath)) return null;
  const template = fs.readFileSync(promptPath, 'utf-8');
  return renderTemplate(template, vars);
}
```

### Integration pattern for prompt builders

For each prompt builder in `src/prompts.ts`, add an optional `workDir` parameter and check for a custom prompt at the start. Example for `buildInvestigatePrompt`:

```typescript
export function buildInvestigatePrompt(issue: Issue, issueTasksDir: string, workDir?: string): string {
  if (workDir) {
    const custom = loadCustomPrompt(workDir, 'investigate', {
      issueNumber: String(issue.number),
      issueTitle: issue.title,
      issueBody: issue.body,
      issueUrl: issue.url,
      issueTasksDir,
    });
    if (custom) return custom;
  }
  // ... existing hardcoded prompt ...
}
```

### For comment.ts

Since `buildPRCommentPrompt` and `buildIssueCommentPrompt` are module-private functions, pass `workDir` through from the public `handlePRComment`/`handleIssueComment` functions (which already receive `config.workDir`) into the prompt builder. Add `workDir` to the args interfaces (`PRCommentPromptArgs`, `IssueCommentPromptArgs`).

### Variables for complex prompt sections

For prompts that have complex sections (like `buildReviewTaskProposalPrompt` which has a formatted task list), pre-render those sections into a single string variable. For example, `taskList` would be the pre-formatted markdown of all tasks. This keeps the template variables flat and simple.

Similarly, `parentIssueSection` for `buildReviewImplementationPRPrompt` is the pre-rendered parent issue context block (or empty string if no parent issue).

For `buildIssueCommentPrompt`, `whitesmithContext` is the pre-rendered whitesmith context section, and `workOnPRInstructions` is the pre-rendered section about working on related PRs (or empty string).

### Backward compatibility

- The `workDir` parameter is optional on all prompt builders, so existing callers that don't pass it continue to work
- All existing tests pass without modification since they don't provide `workDir`
- The `.whitesmith/prompts/` directory is entirely opt-in

### gitignore / git exclude

The `.whitesmith/` directory should NOT be excluded from git — it's intended to be committed to the repository so that all team members share the same custom prompts. The existing `.whitesmith-*` exclude pattern in `src/git.ts` only affects temporary files (`.whitesmith-prompt.md`, `.whitesmith-review.md`, etc.) and does not conflict.
