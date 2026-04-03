import {select, input, confirm, password} from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AuthMode = 'auth-json' | 'models-json';

export interface ProviderEntry {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKeyEnvVar: string;
	models: {id: string}[];
	compat?: Record<string, boolean>;
	builtin: boolean;
}

/**
 * Serializable CI configuration.
 * Can be saved to JSON with --export-config and loaded with --config.
 * When --include-secrets is used, the `secrets` field maps env var names to
 * their actual API key values. These are set via `gh secret set` on install.
 */
export interface CIConfigFile {
	providers: ProviderEntry[];
	defaultProvider: string;
	defaultModel: string;
	/** API key values keyed by env var name. Only present with --include-secrets. */
	secrets?: Record<string, string>;
}

interface CIConfig {
	authMode: AuthMode;
	providers: ProviderEntry[];
	defaultProvider: string;
	defaultModel: string;
	/** When true, install whitesmith from source (pnpm i + pnpm link --global) instead of npm. */
	dev: boolean;
	/** When true, generate the review workflow. */
	reviewWorkflow: boolean;
	/** When true, the review step is enabled in the main loop (whitesmith PRs are already reviewed inline). */
	reviewStepEnabled: boolean;
}

/**
 * Context passed by GitHubProvider so github-ci doesn't need raw execSync.
 */
export interface GitHubCIContext {
	workDir: string;
	repo: string | undefined;
	ghAvailable: boolean;
	setSecret(name: string, value: string): Promise<void>;
}

// ─── Interactive Setup ───────────────────────────────────────────────────────

async function promptProviders(): Promise<ProviderEntry[]> {
	const providers: ProviderEntry[] = [];

	let addMore = true;
	while (addMore) {
		const providerType = await select({
			message: providers.length === 0 ? 'Add a provider:' : 'Add another provider:',
			choices: [
				{name: 'Anthropic (built-in provider, needs API key)', value: 'anthropic'},
				{name: 'OpenAI (built-in provider, needs API key)', value: 'openai'},
				{name: 'Custom provider', value: 'custom'},
			],
		});

		if (providerType === 'anthropic' || providerType === 'openai') {
			const provider = await promptBuiltinProvider(providerType);
			providers.push(provider);
		} else {
			const provider = await promptCustomProvider();
			providers.push(provider);
		}

		addMore = await confirm({message: 'Add another provider?', default: false});
	}

	return providers;
}

async function promptBuiltinProvider(type: 'anthropic' | 'openai'): Promise<ProviderEntry> {
	const defaultEnvVar = type === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
	const defaultModel = type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';

	const apiKeyEnvVar = await input({
		message: 'GitHub secret name for the API key:',
		default: defaultEnvVar,
	});

	const customUrl = await input({
		message: 'Custom base URL (leave empty for default):',
	});

	// Collect models
	const models: {id: string}[] = [];
	let addModel = true;
	while (addModel) {
		const modelId = await input({
			message: models.length === 0 ? 'Model ID:' : 'Another model ID:',
			default: models.length === 0 ? defaultModel : undefined,
		});
		models.push({id: modelId});
		addModel = await confirm({message: 'Add another model?', default: false});
	}

	return {
		name: type,
		baseUrl: customUrl || undefined,
		apiKeyEnvVar,
		models,
		builtin: true,
	};
}

async function promptCustomProvider(): Promise<ProviderEntry> {
	const name = await input({message: 'Provider name:'});

	const baseUrl = await input({message: 'Base URL:'});

	const api = await select({
		message: 'API type:',
		choices: [
			{name: 'Anthropic Messages API', value: 'anthropic-messages'},
			{name: 'OpenAI Completions API', value: 'openai-completions'},
		],
	});

	const apiKeyEnvVar = await input({
		message: 'GitHub secret name for the API key:',
	});

	const needsCompat = api === 'openai-completions';
	let compat: Record<string, boolean> | undefined;
	if (needsCompat) {
		const supportsDeveloperRole = await confirm({
			message: 'Does this provider support the developer role?',
			default: true,
		});
		const supportsReasoningEffort = await confirm({
			message: 'Does this provider support reasoning effort?',
			default: true,
		});
		if (!supportsDeveloperRole || !supportsReasoningEffort) {
			compat = {supportsDeveloperRole, supportsReasoningEffort};
		}
	}

	const models: {id: string}[] = [];
	let addModel = true;
	while (addModel) {
		const modelId = await input({
			message: models.length === 0 ? 'Model ID:' : 'Another model ID:',
		});
		models.push({id: modelId});
		addModel = await confirm({message: 'Add another model?', default: false});
	}

	return {
		name,
		baseUrl,
		api,
		apiKeyEnvVar,
		models,
		builtin: false,
		compat,
	};
}

async function promptDefaults(
	providers: ProviderEntry[],
): Promise<{provider: string; model: string}> {
	let provider: string;
	let model: string;

	if (providers.length === 1) {
		provider = providers[0].name;
	} else {
		provider = await select({
			message: 'Default provider:',
			choices: providers.map((p) => ({name: p.name, value: p.name})),
		});
	}

	const selected = providers.find((p) => p.name === provider)!;
	if (selected.models.length === 1) {
		model = selected.models[0].id;
	} else {
		model = await select({
			message: 'Default model:',
			choices: selected.models.map((m) => ({name: m.id, value: m.id})),
		});
	}

	return {provider, model};
}

/**
 * Set API key secrets on GitHub. If `knownSecrets` contains a value for an
 * env var, it is used directly; otherwise the user is prompted interactively.
 * Returns the list of secret names that were successfully set.
 */
async function setOrPromptSecrets(
	ctx: GitHubCIContext,
	providers: ProviderEntry[],
	knownSecrets?: Record<string, string>,
): Promise<string[]> {
	const setSecrets: string[] = [];
	const seen = new Set<string>();

	for (const p of providers) {
		if (seen.has(p.apiKeyEnvVar)) continue;
		seen.add(p.apiKeyEnvVar);

		let apiKey = knownSecrets?.[p.apiKeyEnvVar];
		if (!apiKey) {
			apiKey = await password({
				message: `Enter API key for ${p.name} (secret: ${p.apiKeyEnvVar}):`,
			});
		}

		if (!apiKey) {
			console.log(`  ⚠ Skipped ${p.apiKeyEnvVar} (empty)`);
			continue;
		}

		try {
			await ctx.setSecret(p.apiKeyEnvVar, apiKey);
			console.log(`  ✅ Secret ${p.apiKeyEnvVar} set on ${ctx.repo}`);
			setSecrets.push(p.apiKeyEnvVar);
		} catch (error: any) {
			const msg = error.stderr?.toString() || error.message || 'unknown error';
			console.error(`  ❌ Failed to set ${p.apiKeyEnvVar}: ${msg}`);
		}
	}

	return setSecrets;
}

// ─── models.json generation ──────────────────────────────────────────────────

function buildModelsJson(providers: ProviderEntry[]): object {
	const providersObj: Record<string, any> = {};

	for (const p of providers) {
		if (p.builtin) {
			// Built-in providers: apiKey references the env var name (pi resolves it at runtime)
			const entry: any = {apiKey: p.apiKeyEnvVar};
			if (p.baseUrl) entry.baseUrl = p.baseUrl;
			providersObj[p.name] = entry;
		} else {
			const entry: any = {
				baseUrl: p.baseUrl,
				api: p.api,
				apiKey: p.apiKeyEnvVar,
				models: p.models,
			};
			if (p.compat) entry.compat = p.compat;
			providersObj[p.name] = entry;
		}
	}

	return {providers: providersObj};
}

// ─── Workflow Templates ──────────────────────────────────────────────────────

function indent(text: string, spaces: number): string {
	const pad = ' '.repeat(spaces);
	return text
		.split('\n')
		.map((line) => (line.trim() === '' ? '' : pad + line))
		.join('\n');
}

/**
 * Top-level env block shared by whitesmith.yml and whitesmith-comment.yml.
 * Includes defaults, GH_TOKEN, and API key secrets.
 */
function generateTopLevelEnv(config: CIConfig): string {
	const lines: string[] = [
		`  WHITESMITH_PROVIDER: ${config.defaultProvider}`,
		`  WHITESMITH_MODEL: ${config.defaultModel}`,
		`  GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
	];

	if (config.authMode === 'models-json') {
		const seen = new Set<string>();
		for (const p of config.providers) {
			if (seen.has(p.apiKeyEnvVar)) continue;
			seen.add(p.apiKeyEnvVar);
			lines.push(`  ${p.apiKeyEnvVar}: \${{ secrets.${p.apiKeyEnvVar} }}`);
		}
	}

	return lines.join('\n');
}

/**
 * Composite action: node setup, git config, npm cache, install, auth config.
 * This is written to .github/actions/setup-whitesmith/action.yml so workflows
 * can just do `uses: ./.github/actions/setup-whitesmith`.
 */
function generateSetupAction(config: CIConfig): string {
	let authStep: string;

	if (config.authMode === 'auth-json') {
		authStep = `\
    - name: Configure pi auth
      shell: bash
      run: |
        if [ -z "$PI_AUTH_JSON" ]; then
          echo "ERROR: PI_AUTH_JSON secret is not set" >&2; exit 1
        fi
        mkdir -p ~/.pi/agent
        echo "$PI_AUTH_JSON" > ~/.pi/agent/auth.json
        chmod 600 ~/.pi/agent/auth.json

    # Workaround for https://github.com/badlogic/pi-mono/issues/2743
    - name: Refresh OAuth token
      shell: bash
      run: node .github/scripts/refresh-oauth-token.mjs`;
	} else {
		const modelsJson = buildModelsJson(config.providers);
		const modelsJsonStr = JSON.stringify(modelsJson, null, 2);

		authStep = `\
    - name: Configure pi models
      shell: bash
      run: |
        mkdir -p ~/.pi/agent
        cat > ~/.pi/agent/models.json << 'MODELS_EOF'
${indent(modelsJsonStr, 8)}
        MODELS_EOF`;
	}

	let installSteps: string;

	if (config.dev) {
		// Dev mode: build whitesmith from source using pnpm.
		// We add pnpm's global bin to $GITHUB_PATH so that `whitesmith` and `pi`
		// are available in all subsequent steps (persists across composite action
		// steps and the calling workflow).
		// We always rebuild (even on cache hit) because source changes per commit.
		installSteps = `\
    - name: Setup pnpm
      uses: pnpm/action-setup@v4

    - name: Add pnpm global bin to PATH
      shell: bash
      run: |
        pnpm setup
        echo "$HOME/.local/share/pnpm" >> "$GITHUB_PATH"

    - name: Install dependencies and build whitesmith
      shell: bash
      run: |
        pnpm install
        pnpm run build
        pnpm link --global

    - name: Install pi
      shell: bash
      run: pnpm add -g @mariozechner/pi-coding-agent`;
	} else {
		installSteps = `\
    - name: Get npm global prefix
      id: npm-prefix
      shell: bash
      run: echo "dir=$(npm prefix -g)" >> "$GITHUB_OUTPUT"

    - name: Cache npm packages
      id: npm-cache
      uses: actions/cache@v4
      with:
        path: \${{ steps.npm-prefix.outputs.dir }}
        key: whitesmith-\${{ runner.os }}-v1

    - name: Install whitesmith and pi
      if: steps.npm-cache.outputs.cache-hit != 'true'
      shell: bash
      run: npm install -g whitesmith @mariozechner/pi-coding-agent`;
	}

	return `\
name: Setup whitesmith
description: Install Node.js, whitesmith, pi, and configure AI provider auth

runs:
  using: composite
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '22'

    - name: Configure git
      shell: bash
      run: |
        git config user.name "whitesmith[bot]"
        git config user.email "whitesmith[bot]@users.noreply.github.com"

${installSteps}

${authStep}
`;
}

function generateMainWorkflow(config: CIConfig): string {
	const envBlock = generateTopLevelEnv(config);

	return `\
# Requires: Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
name: whitesmith

on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:
    inputs:
      max_iterations:
        description: 'Maximum iterations'
        default: '3'
      provider:
        description: 'AI provider (overrides WHITESMITH_PROVIDER)'
      model:
        description: 'AI model (overrides WHITESMITH_MODEL)'

env:
${envBlock}

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

      - uses: ./.github/actions/setup-whitesmith

      - run: |
          whitesmith run . \\
            --provider "\${{ inputs.provider || env.WHITESMITH_PROVIDER }}" \\
            --model "\${{ inputs.model || env.WHITESMITH_MODEL }}" \\
            --max-iterations \${{ inputs.max_iterations || '3' }}
`;
}

function generateCommentWorkflow(config: CIConfig): string {
	const envBlock = generateTopLevelEnv(config);

	return `\
# Requires: Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
name: whitesmith-comment

on:
  issue_comment:
    types: [created]

env:
${envBlock}

concurrency:
  group: whitesmith-comment-\${{ github.event.issue.number }}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    outputs:
      should_run: \${{ steps.check.outputs.should_run }}
    steps:
      - id: check
        env:
          COMMENT_BODY: \${{ github.event.comment.body }}
        run: |
          if echo "$COMMENT_BODY" | grep -q '/whitesmith'; then
            echo "should_run=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ -n "\${{ github.event.issue.pull_request.url }}" ]; then
            BRANCH=$(gh pr view \${{ github.event.issue.number }} \\
              --repo \${{ github.repository }} --json headRefName -q .headRefName)
            if echo "$BRANCH" | grep -qE '^(investigate|task)/'; then
              echo "should_run=true" >> "$GITHUB_OUTPUT"
              exit 0
            fi
          fi
          echo "should_run=false" >> "$GITHUB_OUTPUT"

  run:
    needs: check
    if: needs.check.outputs.should_run == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh api repos/\${{ github.repository }}/issues/comments/\${{ github.event.comment.id }}/reactions \\
            -f content=eyes

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: ./.github/actions/setup-whitesmith

      - env:
          COMMENT_BODY: \${{ github.event.comment.body }}
        run: |
          printf '%s' "$COMMENT_BODY" > .whitesmith-comment-body.txt
          whitesmith comment . \\
            --number "\${{ github.event.issue.number }}" \\
            --body-file .whitesmith-comment-body.txt \\
            --provider "$WHITESMITH_PROVIDER" \\
            --model "$WHITESMITH_MODEL" \\
            --post

      - if: success()
        run: |
          gh api repos/\${{ github.repository }}/issues/comments/\${{ github.event.comment.id }}/reactions \\
            -f content="+1"

      - if: failure()
        run: |
          gh api repos/\${{ github.repository }}/issues/comments/\${{ github.event.comment.id }}/reactions \\
            -f content="-1"
          gh issue comment \${{ github.event.issue.number }} --repo \${{ github.repository }} \\
            --body "❌ Agent run failed. See [workflow run](\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }})."
`;
}

function generateReviewWorkflow(config: CIConfig): string {
	const envBlock = generateTopLevelEnv(config);

	// When the review step is enabled in the main loop, whitesmith PRs are
	// already reviewed inline. The workflow should only review non-whitesmith PRs.
	// When the review step is disabled, the workflow reviews ALL PRs.
	const skipWhitesmithCheck = config.reviewStepEnabled
		? `\
  check:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    outputs:
      should_run: \${{ steps.check.outputs.should_run }}
    steps:
      - id: check
        run: |
          BRANCH="\${{ github.event.pull_request.head.ref }}"
          if echo "$BRANCH" | grep -qE '^(investigate|issue)/'; then
            echo "Skipping review for whitesmith-managed branch: $BRANCH"
            echo "should_run=false" >> "$GITHUB_OUTPUT"
          else
            echo "should_run=true" >> "$GITHUB_OUTPUT"
          fi

  review:
    needs: check
    if: >-
      (github.event_name == 'workflow_dispatch') ||
      (needs.check.outputs.should_run == 'true')`
		: `\
  review:`;

	return `\
name: whitesmith-review

on:
  pull_request:
    types: [opened, synchronize]
  workflow_dispatch:
    inputs:
      number:
        description: 'PR or issue number to review'
        required: true
      type:
        description: 'Review type (auto-detected if empty): pr, issue-tasks, issue-tasks-completed'
      provider:
        description: 'AI provider (overrides WHITESMITH_PROVIDER)'
      model:
        description: 'AI model (overrides WHITESMITH_MODEL)'

env:
${envBlock}

concurrency:
  group: whitesmith-review-\${{ github.event.pull_request.number || inputs.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
${skipWhitesmithCheck}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: ./.github/actions/setup-whitesmith

      - if: github.event_name == 'pull_request'
        run: |
          whitesmith review . \\
            --number "\${{ github.event.pull_request.number }}" \\
            --provider "\${{ env.WHITESMITH_PROVIDER }}" \\
            --model "\${{ env.WHITESMITH_MODEL }}" \\
            --post

      - if: github.event_name == 'workflow_dispatch'
        run: |
          TYPE_FLAG=""
          if [ -n "\${{ inputs.type }}" ]; then
            TYPE_FLAG="--type \${{ inputs.type }}"
          fi
          whitesmith review . \\
            --number "\${{ inputs.number }}" \\
            \$TYPE_FLAG \\
            --provider "\${{ inputs.provider || env.WHITESMITH_PROVIDER }}" \\
            --model "\${{ inputs.model || env.WHITESMITH_MODEL }}" \\
            --post
`;
}

function generateIssueWorkflow(config: CIConfig): string {
	const envBlock = generateTopLevelEnv(config);

	return `\
name: whitesmith-issue

on:
  issues:
    types: [opened]

env:
${envBlock}

concurrency:
  group: whitesmith-issue-\${{ github.event.issue.number }}
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

      - uses: ./.github/actions/setup-whitesmith

      - run: |
          whitesmith run . \\
            --issue "\${{ github.event.issue.number }}" \\
            --provider "$WHITESMITH_PROVIDER" \\
            --model "$WHITESMITH_MODEL" \\
            --max-iterations 10
`;
}

function generateReconcileWorkflow(): string {
	return `\
name: whitesmith-reconcile

on:
  pull_request:
    types: [closed]
    branches: [main]

env:
  GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}

permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
  reconcile:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: ./.github/actions/setup-whitesmith

      - run: whitesmith reconcile .
`;
}

// ─── Refresh OAuth Script (auth-json mode only) ─────────────────────────────

const REFRESH_OAUTH_SCRIPT = `\
#!/usr/bin/env node
/**
 * Refresh OAuth tokens in pi's auth.json before pi runs.
 *
 * Workaround for https://github.com/badlogic/pi-mono/issues/2743
 * pi-ai sends JSON to Anthropic's OAuth token endpoint, which now requires
 * application/x-www-form-urlencoded. We refresh the token ourselves.
 *
 * After refreshing, updates the PI_AUTH_JSON GitHub secret so the next run
 * has the latest rotated refresh token (requires GH_PAT with repo scope).
 *
 * Remove this script once the upstream fix is released.
 */
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const authPath = join(process.env.HOME, ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf-8"));
const cred = auth.anthropic;

if (!cred || cred.type !== "oauth") {
  console.log("No OAuth credentials for anthropic, skipping refresh");
  process.exit(0);
}

if (Date.now() < cred.expires) {
  console.log("Token still valid until", new Date(cred.expires).toISOString());
  process.exit(0);
}

console.log(
  "Token expired at",
  new Date(cred.expires).toISOString(),
  "- refreshing..."
);

const response = await fetch(ANTHROPIC_TOKEN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ANTHROPIC_CLIENT_ID,
    refresh_token: cred.refresh,
  }).toString(),
  signal: AbortSignal.timeout(30_000),
});

const data = await response.json();

if (!response.ok) {
  console.error("Refresh failed:", response.status, JSON.stringify(data));
  process.exit(1);
}

auth.anthropic = {
  type: "oauth",
  refresh: data.refresh_token,
  access: data.access_token,
  expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
};

writeFileSync(authPath, JSON.stringify(auth, null, 2));
chmodSync(authPath, 0o600);
console.log(
  "Token refreshed, new expiry:",
  new Date(auth.anthropic.expires).toISOString()
);

// Update the GitHub secret so the next run has the latest refresh token
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_PAT;
if (repo && token) {
  try {
    execSync(\`gh secret set PI_AUTH_JSON --repo "\${repo}"\`, {
      input: JSON.stringify(auth),
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log("PI_AUTH_JSON secret updated");
  } catch (err) {
    console.warn("Failed to update secret (non-fatal):", err.stderr?.toString() || err.message);
  }
} else {
  console.log("Skipping secret update (no GH_PAT or GITHUB_REPOSITORY)");
}
`;

// ─── Main Entry Point ────────────────────────────────────────────────────────

export interface InstallCIOptions {
	authMode: AuthMode;
	fake?: boolean;
	/** Path to a JSON config file — skips interactive prompts. */
	configFile?: string;
	/** Write the provider config as JSON to this file path instead of generating workflows. */
	exportConfig?: string;
	/** When used with --export-config, prompt for API keys and include them in the output. */
	includeSecrets?: boolean;
	/** Build whitesmith from source (pnpm i + link --global) instead of installing from npm. Auto-detected when inside the whitesmith repo. */
	dev?: boolean;
	/** Generate the review workflow for PR reviews. Off by default. */
	reviewWorkflow?: boolean;
	/** Whether the review step is enabled in the main loop (affects review workflow filtering). */
	reviewStepEnabled?: boolean;
	/** Skip setting GitHub secrets (useful when reconfiguring workflows only). */
	skipSecrets?: boolean;
}

/**
 * Load config from a JSON file, skipping interactive prompts.
 */
function loadConfigFile(filePath: string): CIConfigFile {
	const raw = fs.readFileSync(filePath, 'utf-8');
	const data = JSON.parse(raw) as CIConfigFile;

	if (!data.providers || !Array.isArray(data.providers) || data.providers.length === 0) {
		throw new Error(`Config file must contain a non-empty "providers" array`);
	}
	if (!data.defaultProvider) {
		throw new Error(`Config file must contain "defaultProvider"`);
	}
	if (!data.defaultModel) {
		throw new Error(`Config file must contain "defaultModel"`);
	}

	return data;
}

export async function installGitHubCI(
	ctx: GitHubCIContext,
	options: InstallCIOptions,
): Promise<void> {
	const {authMode} = options;
	const fake = options.fake ?? false;
	const exportConfig = options.exportConfig ?? undefined;

	console.log('=== whitesmith install-ci (GitHub) ===\n');
	console.log(`Auth mode: ${authMode}\n`);

	let repo = ctx.repo;

	if (!exportConfig && !fake && !repo && authMode === 'models-json' && ctx.ghAvailable) {
		repo = await input({
			message: 'GitHub repository (owner/repo) — needed to set secrets:',
		});
		ctx.repo = repo;
	}

	let providers: ProviderEntry[];
	let defaultProvider: string;
	let defaultModel: string;
	let loadedSecrets: Record<string, string> | undefined;

	if (options.configFile) {
		// Load from file — no prompts
		const loaded = loadConfigFile(options.configFile);
		providers = loaded.providers;
		defaultProvider = loaded.defaultProvider;
		defaultModel = loaded.defaultModel;
		loadedSecrets = loaded.secrets;
	} else if (authMode === 'models-json') {
		// Interactive prompts
		providers = await promptProviders();
		const defaults = await promptDefaults(providers);
		defaultProvider = defaults.provider;
		defaultModel = defaults.model;
	} else {
		// auth.json mode — still need provider/model for whitesmith commands
		providers = [];
		defaultProvider = await input({
			message: 'Default AI provider:',
			default: 'anthropic',
		});
		defaultModel = await input({
			message: 'Default AI model:',
			default: 'claude-sonnet-4-20250514',
		});
	}

	// ── Export config mode — write JSON to stdout and exit ───────────────

	if (exportConfig) {
		const configFile: CIConfigFile = {providers, defaultProvider, defaultModel};
		if (options.includeSecrets && providers.length > 0) {
			const secrets: Record<string, string> = {};
			const seen = new Set<string>();
			for (const p of providers) {
				if (seen.has(p.apiKeyEnvVar)) continue;
				seen.add(p.apiKeyEnvVar);
				const key = await password({
					message: `Enter API key for ${p.name} (${p.apiKeyEnvVar}):`,
				});
				if (key) secrets[p.apiKeyEnvVar] = key;
			}
			if (Object.keys(secrets).length > 0) {
				configFile.secrets = secrets;
			}
		}
		const json = JSON.stringify(configFile, null, 2) + '\n';
		fs.writeFileSync(exportConfig, json, 'utf-8');
		console.log(`\n✅ Config written to ${exportConfig}`);
		return;
	}

	// Auto-detect dev mode: check if we're inside the whitesmith repo itself
	let dev = options.dev ?? false;
	if (!dev) {
		try {
			const pkgPath = path.join(ctx.workDir, 'package.json');
			if (fs.existsSync(pkgPath)) {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
				if (pkg.name === 'whitesmith') {
					dev = true;
					console.log('📦 Detected whitesmith repo — using dev mode (build from source)\n');
				}
			}
		} catch {
			// Ignore — not in whitesmith repo
		}
	}

	const reviewWorkflow = options.reviewWorkflow ?? false;
	const reviewStepEnabled = options.reviewStepEnabled ?? true;

	const config: CIConfig = {
		authMode,
		providers,
		defaultProvider,
		defaultModel,
		dev,
		reviewWorkflow,
		reviewStepEnabled,
	};

	// ── Set GitHub secrets via gh CLI ─────────────────────────────────────

	const skipSecrets = options.skipSecrets ?? false;

	if (skipSecrets) {
		console.log('\n🔑 Skipping secret setup (--no-secrets)');
	} else if (!fake && authMode === 'models-json' && repo) {
		if (!ctx.ghAvailable) {
			console.log('\n⚠ GitHub CLI (gh) is not available or not authenticated.');
			console.log('  You will need to set the following secrets manually.\n');
		} else {
			// If config file included secrets, set them directly without prompting
			const configSecrets = options.configFile ? loadedSecrets : undefined;
			console.log('\n🔑 Setting API key secrets on GitHub...\n');
			const setSecrets = await setOrPromptSecrets(ctx, providers, configSecrets);

			const allEnvVars = [...new Set(providers.map((p) => p.apiKeyEnvVar))];
			const missing = allEnvVars.filter((v) => !setSecrets.includes(v));
			if (missing.length > 0) {
				console.log(`\n⚠ The following secrets were not set and must be added manually:`);
				for (const m of missing) {
					console.log(`   - ${m}`);
				}
			}
		}
	} else if (fake) {
		console.log('\n🔑 Skipping secret setup (--fake mode)');
	}

	// ── Generate and write workflow files ─────────────────────────────────

	const outputBase = fake ? '.fake' : '.github';
	const baseDir = path.join(ctx.workDir, outputBase);
	const workflowsDir = path.join(baseDir, 'workflows');
	const actionsDir = path.join(baseDir, 'actions', 'setup-whitesmith');
	fs.mkdirSync(workflowsDir, {recursive: true});
	fs.mkdirSync(actionsDir, {recursive: true});

	const files: {path: string; content: string}[] = [
		{
			path: path.join(actionsDir, 'action.yml'),
			content: generateSetupAction(config),
		},
		{
			path: path.join(workflowsDir, 'whitesmith.yml'),
			content: generateMainWorkflow(config),
		},
		{
			path: path.join(workflowsDir, 'whitesmith-comment.yml'),
			content: generateCommentWorkflow(config),
		},
		{
			path: path.join(workflowsDir, 'whitesmith-issue.yml'),
			content: generateIssueWorkflow(config),
		},
		{
			path: path.join(workflowsDir, 'whitesmith-reconcile.yml'),
			content: generateReconcileWorkflow(),
		},
	];

	if (config.reviewWorkflow) {
		files.push({
			path: path.join(workflowsDir, 'whitesmith-review.yml'),
			content: generateReviewWorkflow(config),
		});
	}

	if (authMode === 'auth-json') {
		const scriptsDir = path.join(baseDir, 'scripts');
		fs.mkdirSync(scriptsDir, {recursive: true});
		files.push({
			path: path.join(scriptsDir, 'refresh-oauth-token.mjs'),
			content: REFRESH_OAUTH_SCRIPT,
		});
	}

	for (const file of files) {
		fs.writeFileSync(file.path, file.content, 'utf-8');
	}

	// ── Summary ──────────────────────────────────────────────────────────

	console.log('\n✅ GitHub Actions workflows installed!\n');
	console.log('Files created:');
	for (const file of files) {
		console.log(`  ${path.relative(ctx.workDir, file.path)}`);
	}

	console.log('\n📋 Required setup:\n');
	console.log('1. Enable in repo settings:');
	console.log(
		'   Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"\n',
	);

	if (authMode === 'auth-json') {
		console.log('2. Add GitHub secrets:');
		console.log('   - PI_AUTH_JSON: contents of ~/.pi/agent/auth.json');
		console.log(
			'   - GH_PAT: GitHub personal access token with repo scope (for OAuth token refresh)\n',
		);
	} else if (!ctx.ghAvailable || !repo) {
		console.log('2. Add GitHub secrets for your API keys:');
		const seen = new Set<string>();
		for (const p of providers) {
			if (!seen.has(p.apiKeyEnvVar)) {
				console.log(`   - ${p.apiKeyEnvVar}: API key for ${p.name}`);
				seen.add(p.apiKeyEnvVar);
			}
		}
		console.log('');
	}

	console.log(`Default provider: ${defaultProvider}`);
	console.log(`Default model: ${defaultModel}`);
	console.log('');
	console.log('You can customize these by editing the generated workflow files.');
}
