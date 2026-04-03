# whitesmith

AI-powered issue-to-PR pipeline. Whitesmith monitors your GitHub issues, breaks them into tasks, and implements them as pull requests — all autonomously.

## How It Works

Whitesmith runs a loop with three phases:

1. **Investigate** — Picks up unlabeled GitHub issues, explores the codebase, and breaks each issue into concrete implementation tasks (stored as markdown files in `tasks/<issue>/`). Opens a PR for human review.

2. **Implement** — Once a task PR is merged (tasks accepted), picks up available tasks respecting dependency order, implements the changes, deletes the task file, and opens a PR.

3. **Reconcile** — When all tasks for an issue are completed and merged, closes the original issue.

### Issue Lifecycle

Issues move through labels automatically:

```
(new issue, no labels)
  → whitesmith:investigating    — agent is generating tasks
  → whitesmith:tasks-proposed   — task PR opened for review
  → whitesmith:tasks-accepted   — task PR merged, implementation begins
  → whitesmith:completed        — all tasks done, issue closed
```

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

Whitesmith uses `pi` as its agent harness. Configure authentication by creating `~/.pi/agent/auth.json`:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  }
}
```

### 2. GitHub Authentication

Whitesmith uses the `gh` CLI. Make sure you're authenticated:

```bash
gh auth login
```

## Usage

### Run the Loop

```bash
whitesmith run . --provider anthropic --model claude-opus-4-6
```

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

### Check Status

```bash
whitesmith status .
```

Shows all issues grouped by their whitesmith label and any pending tasks.

### Reconcile

```bash
whitesmith reconcile .
```

Checks for completed issues (all tasks merged) and closes them. No AI needed.

## GitHub Actions

Whitesmith can run on a schedule via GitHub Actions. Add the workflow file at `.github/workflows/whitesmith.yml`:

```yaml
name: whitesmith

on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:
    inputs:
      max_iterations:
        description: 'Maximum iterations'
        default: '3'
        type: string
      provider:
        description: 'AI provider'
        required: true
        type: string
      model:
        description: 'AI model ID'
        required: true
        type: string

concurrency:
  group: whitesmith-loop
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Configure git
        run: |
          git config user.name "whitesmith[bot]"
          git config user.email "whitesmith[bot]@users.noreply.github.com"

      - name: Install whitesmith & pi
        run: |
          npm install -g whitesmith
          npm install -g @mariozechner/pi-coding-agent

      - name: Configure pi auth
        run: |
          mkdir -p ~/.pi/agent
          echo '${{ secrets.PI_AUTH_JSON }}' > ~/.pi/agent/auth.json
          chmod 600 ~/.pi/agent/auth.json

      - name: Run whitesmith
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          whitesmith run . \
            --agent-cmd "pi" \
            --provider "${{ inputs.provider || vars.WHITESMITH_PROVIDER }}" \
            --model "${{ inputs.model || vars.WHITESMITH_MODEL }}" \
            --max-iterations ${{ inputs.max_iterations || '3' }}
```

### Required Configuration

| Secret/Variable | Description |
|---|---|
| `PI_AUTH_JSON` (secret) | Contents of `~/.pi/agent/auth.json` — AI provider credentials |
| `WHITESMITH_PROVIDER` (variable) | Default AI provider for scheduled runs |
| `WHITESMITH_MODEL` (variable) | Default AI model for scheduled runs |

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
