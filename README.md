# whitesmith

AI-powered issue-to-PR pipeline. Whitesmith monitors your GitHub issues, breaks them into tasks, and implements them as pull requests — all autonomously.

## How It Works

Whitesmith runs a loop with four phases:

1. **Investigate** — Picks up unlabeled GitHub issues, explores the codebase, and breaks each issue into concrete implementation tasks (stored as markdown files in `tasks/<issue>/`). Opens a PR on `investigate/<issue-number>` for human review.

2. **Auto-approve** *(optional)* — If [auto-work mode](#auto-work-mode) is enabled for an issue, the task-proposal PR is automatically merged (with an optional AI review first).

3. **Implement** — Once a task PR is merged (tasks accepted), picks up available tasks respecting dependency order, implements the changes on the `issue/<issue-number>` branch, deletes the task file, and opens a PR when all tasks are complete.

4. **Reconcile** — When all tasks for an issue are completed and merged, closes the original issue.

### Issue Lifecycle

Issues move through labels automatically:

```
(new issue, no labels)
  → whitesmith:investigating    — agent is generating tasks
  → whitesmith:tasks-proposed   — task PR opened for review
  → whitesmith:tasks-accepted   — task PR merged (or auto-approved), implementation begins
  → whitesmith:completed        — all tasks done, issue closed
```

### Labels

| Label | Description |
|---|---|
| `whitesmith:investigating` | Agent is generating tasks for this issue |
| `whitesmith:tasks-proposed` | A PR with generated tasks has been opened for review |
| `whitesmith:tasks-accepted` | Task PR has been merged — implementation in progress |
| `whitesmith:completed` | All tasks have been implemented and merged |
| `whitesmith:auto-work` | Enables [auto-work mode](#auto-work-mode) for this issue |

### Branch Naming Convention

Whitesmith uses specific branch naming conventions:

| Branch | Purpose |
|---|---|
| `investigate/<issue-number>` | Task proposal PRs — contains generated task files |
| `issue/<issue-number>` | Implementation PRs — contains the actual code changes |

### Review System

After creating task-proposal PRs or implementation PRs, whitesmith automatically runs an AI review. Reviews produce a verdict:

- **APPROVE** — The PR looks good
- **REQUEST_CHANGES** — The review found issues that need attention

The review is posted as a comment on the PR. Disable automatic reviews with the `--no-review` flag on the `run` command.

### Auto-Work Mode

Auto-work mode enables fully autonomous operation — task-proposal PRs are automatically merged without waiting for human review.

Auto-work is enabled for an issue when **any** of these conditions are met:

1. The `--auto-work` CLI flag is passed to `whitesmith run`
2. The issue has the `whitesmith:auto-work` label
3. The issue body contains the string `whitesmith:auto-work`

When auto-work is enabled and the review system is active, whitesmith runs an AI review before merging. If the review returns REQUEST_CHANGES, the auto-merge is skipped and a comment is posted asking for manual review.

## Installation

```bash
npm install -g whitesmith
```

You also need [pi](https://github.com/nicholasgasior/pi-coding-agent) (the default agent harness):

```bash
npm install -g @mariozechner/pi-coding-agent
```

## Setup

### 1. Configure AI Provider

Whitesmith uses `pi` as its agent harness. You can configure authentication in two ways:

#### Option A: `auth.json` (OAuth / API key)

Create `~/.pi/agent/auth.json`:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  }
}
```

#### Option B: `models.json` (provider configuration)

Create `~/.pi/agent/models.json` to configure providers with custom base URLs, API types, and models:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    },
    "my-custom-provider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "MY_API_KEY",
      "models": [{ "id": "my-model" }]
    }
  }
}
```

For built-in providers (`anthropic`, `openai`), the `apiKey` field references an environment variable name that contains the actual key. For custom providers, you also specify `baseUrl`, `api` type (`anthropic-messages` or `openai-completions`), and available `models`.

This is the default auth mode used by `install-ci` for CI/CD setups.

### 2. GitHub Authentication

Whitesmith uses the `gh` CLI. Make sure you're authenticated:

```bash
gh auth login
```

## Usage

### `whitesmith run` — Run the Main Loop

```bash
whitesmith run . --provider anthropic --model claude-opus-4-6
```

Runs the full investigate → auto-approve → implement → reconcile loop.

#### Options

| Option | Description | Default |
|---|---|---|
| `--provider <name>` | AI provider (e.g. `anthropic`, `openai`) | *required* |
| `--model <id>` | AI model ID (e.g. `claude-opus-4-6`) | *required* |
| `--agent-cmd <cmd>` | Agent harness command | `pi` |
| `--max-iterations <n>` | Max loop iterations | `10` |
| `--repo <owner/repo>` | GitHub repo (auto-detected if omitted) | — |
| `--log-file <path>` | Log agent output to file | — |
| `--no-push` | Skip pushing branches and PR creation | `false` |
| `--no-sleep` | Skip sleep between iterations | `false` |
| `--dry-run` | Print what would be done without executing it | `false` |
| `--auto-work` | Enable [auto-work mode](#auto-work-mode) (auto-approve task PRs) | `false` |
| `--no-review` | Disable the automatic [review step](#review-system) after PRs are created | `false` |

### `whitesmith status` — Check Status

```bash
whitesmith status .
```

Shows all issues grouped by their whitesmith label and any pending tasks.

#### Options

| Option | Description | Default |
|---|---|---|
| `--repo <owner/repo>` | GitHub repo | auto-detected |

### `whitesmith reconcile` — Reconcile Issues

```bash
whitesmith reconcile .
```

Checks for completed issues (all tasks merged) and closes them. Also handles the `tasks-proposed` → `tasks-accepted` transition when a task PR has been merged. No AI needed.

#### Options

| Option | Description | Default |
|---|---|---|
| `--repo <owner/repo>` | GitHub repo | auto-detected |

### `whitesmith comment` — Handle Comments

```bash
whitesmith comment . --number 42 --body "Please add tests" --provider anthropic --model claude-opus-4-6
```

Handles a comment on an issue or PR. Whitesmith auto-detects whether the target is a PR or an issue and handles each appropriately:

- **PR comments**: Checks out the PR branch, lets the agent make changes, commits and pushes any modifications, and optionally posts a response.
- **Issue comments**: The agent analyzes the issue and related context (task PRs, implementation PRs, pending tasks) and generates a response. If related PRs exist with open branches, the agent can check them out and make changes.

#### Options

| Option | Description | Default |
|---|---|---|
| `--number <n>` | Issue or PR number | *required* |
| `--body <text>` | Comment body text | — |
| `--body-file <path>` | Read comment body from a file (alternative to `--body`) | — |
| `--provider <name>` | AI provider | *required* |
| `--model <id>` | AI model ID | *required* |
| `--agent-cmd <cmd>` | Agent harness command | `pi` |
| `--repo <owner/repo>` | GitHub repo | auto-detected |
| `--log-file <path>` | Log agent output to file | — |
| `--post` | Post the response as a GitHub comment (otherwise prints to stdout) | `false` |

Either `--body` or `--body-file` must be provided.

### `whitesmith review` — Review PRs and Tasks

```bash
whitesmith review . --number 42 --provider anthropic --model claude-opus-4-6
```

Reviews a PR, task proposal, or completed task implementation. Produces a verdict: **APPROVE** or **REQUEST_CHANGES**.

#### Review Types

| Type | Description |
|---|---|
| `pr` | Review a generic PR (examine the diff, check for bugs, quality) |
| `issue-tasks` | Review a task proposal — check that tasks are detailed and precise enough |
| `issue-tasks-completed` | Review completed tasks — verify implementation follows the plan, check for bugs |

If `--type` is omitted, the review type is auto-detected based on the target:

- PR on `investigate/<N>` branch → `issue-tasks`
- PR on `issue/<N>` branch → `issue-tasks-completed`
- Other PR → `pr`
- Issue with `whitesmith:tasks-accepted` label → `issue-tasks-completed`
- Issue with `whitesmith:tasks-proposed` label → `issue-tasks`

#### Options

| Option | Description | Default |
|---|---|---|
| `--number <n>` | PR or issue number to review | *required* |
| `--type <type>` | Review type: `pr`, `issue-tasks`, `issue-tasks-completed` | auto-detected |
| `--provider <name>` | AI provider | *required* |
| `--model <id>` | AI model ID | *required* |
| `--agent-cmd <cmd>` | Agent harness command | `pi` |
| `--repo <owner/repo>` | GitHub repo | auto-detected |
| `--log-file <path>` | Log agent output to file | — |
| `--post` | Post the review as a GitHub comment (otherwise prints to stdout) | `false` |

### `whitesmith install-ci` — Set Up GitHub Actions

```bash
whitesmith install-ci .
```

Interactive setup wizard that generates GitHub Actions workflows, a shared composite action, and configures GitHub secrets. This is the recommended way to set up whitesmith for CI/CD.

#### What Gets Generated

| File | Description |
|---|---|
| `.github/actions/setup-whitesmith/action.yml` | Composite action: Node.js setup, git config, install whitesmith + pi, configure auth |
| `.github/workflows/whitesmith.yml` | Main loop — runs on a schedule (every 15 min) and manual dispatch |
| `.github/workflows/whitesmith-comment.yml` | Responds to issue/PR comments (triggered by `/whitesmith` or comments on managed branches) |
| `.github/workflows/whitesmith-reconcile.yml` | Reconciles on PR merge to `main` |
| `.github/workflows/whitesmith-review.yml` | *(optional)* Reviews PRs on open/synchronize |

#### Auth Modes

- **`models-json`** *(default)* — Each provider's API key is stored as a separate GitHub secret. The setup wizard generates a `models.json` configuration inline in the composite action.
- **`auth-json`** (`--auth-json` flag) — Uses a single `PI_AUTH_JSON` GitHub secret containing the full `auth.json` file. Also requires a `GH_PAT` secret for OAuth token refresh.

#### Interactive Usage

```bash
whitesmith install-ci .
```

The wizard prompts you to:
1. Add providers (Anthropic, OpenAI, or custom)
2. Configure models for each provider
3. Select default provider and model
4. Enter API keys (set as GitHub secrets automatically)

#### Non-Interactive Usage

Export a configuration file:

```bash
whitesmith install-ci . --export-config config.json --include-secrets
```

Re-use the configuration later:

```bash
whitesmith install-ci . --config config.json
```

#### Options

| Option | Description | Default |
|---|---|---|
| `--auth-json` | Use `auth.json` mode instead of `models.json` | `false` |
| `--repo <owner/repo>` | GitHub repo | auto-detected |
| `--fake` | Write workflows to `.fake/` instead of `.github/` (for testing) | `false` |
| `--config <path>` | Load provider config from a JSON file (skip interactive prompts) | — |
| `--export-config <path>` | Write the provider config as JSON to a file (instead of generating workflows) | — |
| `--include-secrets` | With `--export-config`, prompt for API keys and include them in the JSON output | `false` |
| `--no-secrets` | Skip setting GitHub secrets (useful when reconfiguring workflows only) | `false` |
| `--dev` | Build whitesmith from source (pnpm) instead of npm install | `false` |
| `--review-workflow` | Generate the optional PR review workflow | `false` |
| `--no-review-step` | Disable the review step in the main loop (the review workflow will cover all PRs) | `false` |

## GitHub Actions

### Quick Setup

The easiest way to set up GitHub Actions is with the `install-ci` command:

```bash
whitesmith install-ci .
```

This generates all necessary workflows, the shared setup action, and configures your GitHub secrets interactively. See [`whitesmith install-ci`](#whitesmith-install-ci--set-up-github-actions) for details.

### Architecture

The generated CI setup consists of:

1. **Composite action** (`.github/actions/setup-whitesmith/action.yml`) — Shared setup logic used by all workflows: installs Node.js, configures git, installs whitesmith + pi, sets up AI provider authentication. Supports npm caching for faster CI runs.

2. **Main workflow** (`whitesmith.yml`) — Runs the `whitesmith run` loop on a schedule (every 15 minutes) and via manual dispatch. Uses concurrency groups to prevent overlapping runs.

3. **Comment workflow** (`whitesmith-comment.yml`) — Triggered by `issue_comment` events. Runs when:
   - The comment body contains `/whitesmith` (slash command trigger)
   - The comment is on a PR whose branch matches `investigate/*` or `task/*` (whitesmith-managed branches)

   The workflow reacts to the comment with 👀, runs the agent, then reacts with 👍 on success or 👎 on failure.

4. **Reconcile workflow** (`whitesmith-reconcile.yml`) — Triggered when a PR is merged to `main`. Runs `whitesmith reconcile` to transition issue labels and close completed issues.

5. **Review workflow** (`whitesmith-review.yml`, optional) — Triggered on PR open/synchronize. Runs an AI review and posts the result as a comment. When the review step is enabled in the main loop, this workflow skips whitesmith-managed branches (already reviewed inline). Pass `--review-workflow` to `install-ci` to generate this workflow.

### Required Repository Settings

Enable in your repository settings:

**Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**

### Secrets

Secrets are set automatically by `install-ci`, or can be added manually:

**models-json mode** (default):
- One secret per provider API key (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)

**auth-json mode** (`--auth-json`):
- `PI_AUTH_JSON` — Contents of `~/.pi/agent/auth.json`
- `GH_PAT` — GitHub personal access token with repo scope (for OAuth token refresh)

### `/whitesmith` Slash Command

In the comment workflow, any comment containing `/whitesmith` triggers the agent. This works on both issues and PRs. Comments on whitesmith-managed PR branches (`investigate/*` or `task/*`) also trigger automatically without needing the slash command.

## Task File Format

Tasks are stored as markdown files with YAML frontmatter in `tasks/<issue-number>/`:

```markdown
---
id: "42-001"
issue: 42
title: "Add input validation"
depends_on: []
---

## Description
Add validation for user input...

## Acceptance Criteria
- Input is validated before processing
- Error messages are clear

## Implementation Notes
Modify `src/handler.ts`...
```

- **id**: `<issue>-<seq>` format (e.g. `42-001`)
- **depends_on**: List of task IDs that must be completed first
- Tasks are deleted when implemented (marking them as complete)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Watch mode
pnpm dev

# Run tests
pnpm test

# Format
pnpm format
```

## License

MIT
