import {select, input, confirm, password} from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AuthMode = 'auth-json' | 'models-json';

interface ProviderEntry {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKeyEnvVar: string;
	models: {id: string}[];
	compat?: Record<string, boolean>;
	builtin: boolean;
}

interface CIConfig {
	authMode: AuthMode;
	providers: ProviderEntry[];
	defaultProvider: string;
	defaultModel: string;
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
 * Prompt for API key values and set them as GitHub secrets.
 * Returns the list of secrets that were set.
 */
async function promptAndSetSecrets(
	ctx: GitHubCIContext,
	providers: ProviderEntry[],
): Promise<string[]> {
	const setSecrets: string[] = [];
	const seen = new Set<string>();

	for (const p of providers) {
		if (seen.has(p.apiKeyEnvVar)) continue;
		seen.add(p.apiKeyEnvVar);

		const apiKey = await password({
			message: `Enter API key for ${p.name} (secret: ${p.apiKeyEnvVar}):`,
		});

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

function generateModelsJsonStep(config: CIConfig): string {
	const modelsJson = buildModelsJson(config.providers);
	const modelsJsonStr = JSON.stringify(modelsJson, null, 2);

	return `\
      - name: Configure pi models
        run: |
          mkdir -p ~/.pi/agent
          cat > ~/.pi/agent/models.json << 'MODELS_EOF'
${indent(modelsJsonStr, 10)}
          MODELS_EOF`;
}

function generateAuthJsonSteps(): string {
	return `\
      - name: Configure pi auth
        env:
          PI_AUTH_JSON: \${{ secrets.PI_AUTH_JSON }}
        run: |
          if [ -z "$PI_AUTH_JSON" ]; then
            echo "ERROR: PI_AUTH_JSON secret is not configured."
            echo "Set it to the contents of ~/.pi/agent/auth.json"
            exit 1
          fi
          mkdir -p ~/.pi/agent
          echo "$PI_AUTH_JSON" > ~/.pi/agent/auth.json
          chmod 600 ~/.pi/agent/auth.json

      # Workaround for https://github.com/badlogic/pi-mono/issues/2743
      - name: Refresh OAuth token
        env:
          GH_PAT: \${{ secrets.GH_PAT }}
        run: node .github/scripts/refresh-oauth-token.mjs`;
}

function generateAuthSteps(config: CIConfig): string {
	if (config.authMode === 'auth-json') {
		return generateAuthJsonSteps();
	}
	return generateModelsJsonStep(config);
}

function generateRunEnvBlock(config: CIConfig): string {
	const envs: Record<string, string> = {
		GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
	};

	if (config.authMode === 'models-json') {
		for (const p of config.providers) {
			envs[p.apiKeyEnvVar] = `\${{ secrets.${p.apiKeyEnvVar} }}`;
		}
	}

	return Object.entries(envs)
		.map(([k, v]) => `          ${k}: ${v}`)
		.join('\n');
}

function generateMainWorkflow(config: CIConfig): string {
	const authSteps = generateAuthSteps(config);
	const envBlock = generateRunEnvBlock(config);

	return `\
# NOTE: This workflow requires the repo setting:
#   Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
# Without this, PR creation will fail with a permissions error.
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
        description: 'AI provider (overrides default)'
        required: false
        type: string
      model:
        description: 'AI model (overrides default)'
        required: false
        type: string

env:
  WHITESMITH_PROVIDER: ${config.defaultProvider}
  WHITESMITH_MODEL: ${config.defaultModel}

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
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Configure git
        run: |
          git config user.name "whitesmith[bot]"
          git config user.email "whitesmith[bot]@users.noreply.github.com"

      - name: Get npm global prefix
        id: npm-prefix
        run: echo "dir=$(npm prefix -g)" >> "$GITHUB_OUTPUT"

      - name: Cache global npm packages
        id: npm-cache
        uses: actions/cache@v4
        with:
          path: \${{ steps.npm-prefix.outputs.dir }}
          key: npm-global-\${{ runner.os }}-pi-v1

      - name: Install whitesmith and pi
        if: steps.npm-cache.outputs.cache-hit != 'true'
        run: |
          npm install -g whitesmith
          npm install -g @mariozechner/pi-coding-agent

${authSteps}

      - name: Run whitesmith
        env:
${envBlock}
        run: |
          PROVIDER="\${{ inputs.provider || env.WHITESMITH_PROVIDER }}"
          MODEL="\${{ inputs.model || env.WHITESMITH_MODEL }}"
          whitesmith run . \\
            --agent-cmd "pi" \\
            --provider "$PROVIDER" \\
            --model "$MODEL" \\
            --max-iterations \${{ inputs.max_iterations || '3' }}
`;
}

function generateCommentWorkflow(config: CIConfig): string {
	const authSteps = generateAuthSteps(config);
	const envBlock = generateRunEnvBlock(config);

	return `\
# NOTE: This workflow requires the repo setting:
#   Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
name: whitesmith-comment

on:
  issue_comment:
    types: [created]

env:
  WHITESMITH_PROVIDER: ${config.defaultProvider}
  WHITESMITH_MODEL: ${config.defaultModel}

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
      - name: Check if should run
        id: check
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          COMMENT_BODY: \${{ github.event.comment.body }}
        run: |
          # Always run if comment contains /whitesmith
          if echo "$COMMENT_BODY" | grep -q '/whitesmith'; then
            echo "should_run=true" >> "$GITHUB_OUTPUT"
            echo "Triggered by /whitesmith keyword"
            exit 0
          fi

          # For PR comments, auto-trigger if the PR is on a whitesmith branch
          if [ -n "\${{ github.event.issue.pull_request.url }}" ]; then
            BRANCH=$(gh pr view \${{ github.event.issue.number }} \\
              --repo \${{ github.repository }} \\
              --json headRefName -q .headRefName)
            echo "PR branch: $BRANCH"
            if echo "$BRANCH" | grep -qE '^(investigate|task)/'; then
              echo "should_run=true" >> "$GITHUB_OUTPUT"
              echo "Triggered by comment on whitesmith PR branch"
              exit 0
            fi
          fi

          echo "should_run=false" >> "$GITHUB_OUTPUT"
          echo "Skipping: not a /whitesmith command and not a whitesmith PR"

  run:
    needs: check
    runs-on: ubuntu-latest
    if: needs.check.outputs.should_run == 'true'
    steps:
      - name: React with eyes to acknowledge
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api repos/\${{ github.repository }}/issues/comments/\${{ github.event.comment.id }}/reactions \\
            -f content=eyes

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Configure git
        run: |
          git config user.name "whitesmith[bot]"
          git config user.email "whitesmith[bot]@users.noreply.github.com"

      - name: Get npm global prefix
        id: npm-prefix
        run: echo "dir=$(npm prefix -g)" >> "$GITHUB_OUTPUT"

      - name: Cache global npm packages
        id: npm-cache
        uses: actions/cache@v4
        with:
          path: \${{ steps.npm-prefix.outputs.dir }}
          key: npm-global-\${{ runner.os }}-pi-v1

      - name: Install whitesmith and pi
        if: steps.npm-cache.outputs.cache-hit != 'true'
        run: |
          npm install -g whitesmith
          npm install -g @mariozechner/pi-coding-agent

${authSteps}

      - name: Save comment body to file
        env:
          COMMENT_BODY: \${{ github.event.comment.body }}
        run: |
          printf '%s' "$COMMENT_BODY" > .whitesmith-comment-body.txt

      - name: Run whitesmith comment
        env:
${envBlock}
        run: |
          whitesmith comment . \\
            --number "\${{ github.event.issue.number }}" \\
            --body-file .whitesmith-comment-body.txt \\
            --provider "$WHITESMITH_PROVIDER" \\
            --model "$WHITESMITH_MODEL" \\
            --post

      - name: React with checkmark on success
        if: success()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api repos/\${{ github.repository }}/issues/comments/\${{ github.event.comment.id }}/reactions \\
            -f content="+1"

      - name: React with X and comment on failure
        if: failure()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api repos/\${{ github.repository }}/issues/comments/\${{ github.event.comment.id }}/reactions \\
            -f content="-1"
          gh issue comment \${{ github.event.issue.number }} \\
            --repo \${{ github.repository }} \\
            --body "❌ Agent run failed for [this comment](\${{ github.event.comment.html_url }}). Check the [workflow run](\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}) for details."
`;
}

function generateReconcileWorkflow(): string {
	return `\
name: whitesmith-reconcile

on:
  pull_request:
    types: [closed]
    branches: [main]

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

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Get npm global prefix
        id: npm-prefix
        run: echo "dir=$(npm prefix -g)" >> "$GITHUB_OUTPUT"

      - name: Cache global npm packages
        id: npm-cache
        uses: actions/cache@v4
        with:
          path: \${{ steps.npm-prefix.outputs.dir }}
          key: npm-global-\${{ runner.os }}-whitesmith-v1

      - name: Install whitesmith
        if: steps.npm-cache.outputs.cache-hit != 'true'
        run: npm install -g whitesmith

      - name: Reconcile
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: whitesmith reconcile .
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
}

export async function installGitHubCI(
	ctx: GitHubCIContext,
	options: InstallCIOptions,
): Promise<void> {
	const {authMode} = options;

	console.log('=== whitesmith install-ci (GitHub) ===\n');
	console.log(`Auth mode: ${authMode}\n`);

	let repo = ctx.repo;

	if (!repo && authMode === 'models-json' && ctx.ghAvailable) {
		repo = await input({
			message: 'GitHub repository (owner/repo) — needed to set secrets:',
		});
		ctx.repo = repo;
	}

	let providers: ProviderEntry[] = [];
	let defaultProvider: string;
	let defaultModel: string;

	if (authMode === 'models-json') {
		// Configure providers interactively
		providers = await promptProviders();

		// Pick defaults
		const defaults = await promptDefaults(providers);
		defaultProvider = defaults.provider;
		defaultModel = defaults.model;
	} else {
		// auth.json mode — still need provider/model for whitesmith commands
		defaultProvider = await input({
			message: 'Default AI provider:',
			default: 'anthropic',
		});
		defaultModel = await input({
			message: 'Default AI model:',
			default: 'claude-sonnet-4-20250514',
		});
	}

	const config: CIConfig = {
		authMode,
		providers,
		defaultProvider,
		defaultModel,
	};

	// ── Set GitHub secrets via gh CLI ─────────────────────────────────────

	const fake = options.fake ?? false;

	if (!fake && authMode === 'models-json' && repo) {
		if (!ctx.ghAvailable) {
			console.log('\n⚠ GitHub CLI (gh) is not available or not authenticated.');
			console.log('  You will need to set the following secrets manually.\n');
		} else {
			console.log('\n🔑 Setting API key secrets on GitHub...\n');
			const setSecrets = await promptAndSetSecrets(ctx, providers);

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
	const githubDir = path.join(ctx.workDir, outputBase);
	const workflowsDir = path.join(githubDir, 'workflows');
	fs.mkdirSync(workflowsDir, {recursive: true});

	const files: {path: string; content: string}[] = [
		{
			path: path.join(workflowsDir, 'whitesmith.yml'),
			content: generateMainWorkflow(config),
		},
		{
			path: path.join(workflowsDir, 'whitesmith-comment.yml'),
			content: generateCommentWorkflow(config),
		},
		{
			path: path.join(workflowsDir, 'whitesmith-reconcile.yml'),
			content: generateReconcileWorkflow(),
		},
	];

	if (authMode === 'auth-json') {
		const scriptsDir = path.join(githubDir, 'scripts');
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
