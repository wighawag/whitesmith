#!/usr/bin/env node

import {Command} from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {DevPulseConfig} from './types.js';
import {LABELS} from './types.js';
import {Orchestrator} from './orchestrator.js';
import {GitHubProvider} from './providers/github.js';
import {PiHarness} from './harnesses/pi.js';
import {TaskManager} from './task-manager.js';
import {handlePRComment, handleIssueComment, isPullRequest} from './comment.js';
import {performReview, detectReviewTarget} from './review.js';
import type {AuthMode} from './providers/github-ci.js';
import pkg from '../package.json' with {type: 'json'};

const DEFAULT_AGENT_CMD = 'pi';
const DEFAULT_MAX_ITERATIONS = 10;

function createOrchestrator(config: DevPulseConfig): Orchestrator {
	const issues = new GitHubProvider(config.workDir, config.repo);
	const agent = new PiHarness({
		cmd: config.agentCmd,
		provider: config.provider,
		model: config.model,
	});
	return new Orchestrator(config, issues, agent);
}

const packageName = pkg.name;
const binName = typeof pkg.bin === 'string' ? pkg.bin : Object.keys(pkg.bin)[0];

export function buildCli(): Command {
	const program = new Command();

	program.name(binName).description('AI-powered issue-to-PR pipeline').version('0.0.0');

	// --- run ---
	program
		.command('run')
		.description('Run the main whitesmith loop: investigate issues, implement tasks')
		.argument('[work_dir]', 'Working directory', '.')
		.option('--agent-cmd <cmd>', 'Agent harness command', DEFAULT_AGENT_CMD)
		.requiredOption('--provider <name>', 'AI provider (e.g. anthropic, openai)')
		.requiredOption('--model <id>', 'AI model ID (e.g. claude-opus-4-6)')
		.option('--max-iterations <n>', 'Max iterations', String(DEFAULT_MAX_ITERATIONS))
		.option('--repo <owner/repo>', 'GitHub repo (auto-detected if omitted)')
		.option('--log-file <path>', 'Log agent output to file')
		.option('--no-push', 'Skip pushing and PR creation')
		.option('--no-sleep', 'Skip sleep between iterations')
		.option('--dry-run', 'Print what would be done without executing it')
		.option('--auto-work', 'Enable auto-work mode (auto-approve task PRs)')
		.option('--no-review', 'Disable review step after PRs are created')
		.action(async (workDir: string, opts) => {
			const config: DevPulseConfig = {
				agentCmd: opts.agentCmd,
				provider: opts.provider,
				model: opts.model,
				maxIterations: parseInt(opts.maxIterations, 10),
				workDir: path.resolve(workDir),
				noPush: opts.push === false,
				noSleep: opts.sleep === false,
				dryRun: opts.dryRun ?? false,
				autoWork: opts.autoWork ?? false,
				review: opts.review !== false,
				logFile: opts.logFile,
				repo: opts.repo,
			};

			if (!fs.existsSync(config.workDir)) {
				console.error(`ERROR: Directory '${config.workDir}' does not exist`);
				process.exit(1);
			}

			process.chdir(config.workDir);
			const orchestrator = createOrchestrator(config);

			try {
				await orchestrator.run();
			} catch (error) {
				console.error('ERROR:', error instanceof Error ? error.message : error);
				process.exit(1);
			}
		});

	// --- status ---
	program
		.command('status')
		.description('Show current status of issues and tasks')
		.argument('[work_dir]', 'Working directory', '.')
		.option('--repo <owner/repo>', 'GitHub repo')
		.action(async (workDir: string, opts) => {
			const resolvedDir = path.resolve(workDir);
			const issues = new GitHubProvider(resolvedDir, opts.repo);
			const taskMgr = new TaskManager(resolvedDir);

			console.log('=== whitesmith status ===\n');

			// Show issues by state
			for (const [name, label] of Object.entries(LABELS)) {
				const list = await issues.listIssues({labels: [label]});
				if (list.length > 0) {
					console.log(`${name} (${label}):`);
					for (const issue of list) {
						console.log(`  #${issue.number} - ${issue.title}`);
					}
					console.log('');
				}
			}

			// Show new issues (no whitesmith labels)
			const allLabels = Object.values(LABELS);
			const newIssues = await issues.listIssues({noLabels: allLabels});
			if (newIssues.length > 0) {
				console.log('NEW (no label):');
				for (const issue of newIssues) {
					console.log(`  #${issue.number} - ${issue.title}`);
				}
				console.log('');
			}

			// Show pending tasks
			const allTasks = taskMgr.listAllTasks();
			if (allTasks.length > 0) {
				console.log('PENDING TASKS:');
				for (const task of allTasks) {
					const deps = task.dependsOn.length > 0 ? ` (depends: ${task.dependsOn.join(', ')})` : '';
					console.log(`  ${task.id} - ${task.title}${deps}`);
				}
				console.log('');
			}
		});

	// --- comment ---
	program
		.command('comment')
		.description('Handle a comment on an issue or PR (auto-detects which)')
		.argument('[work_dir]', 'Working directory', '.')
		.requiredOption('--number <n>', 'Issue or PR number')
		.option('--body <text>', 'Comment body text (or use --body-file)')
		.option('--body-file <path>', 'Read comment body from file instead of --body')
		.option('--agent-cmd <cmd>', 'Agent harness command', DEFAULT_AGENT_CMD)
		.requiredOption('--provider <name>', 'AI provider (e.g. anthropic, openai)')
		.requiredOption('--model <id>', 'AI model ID (e.g. claude-opus-4-6)')
		.option('--repo <owner/repo>', 'GitHub repo (auto-detected if omitted)')
		.option('--log-file <path>', 'Log agent output to file')
		.option(
			'--post',
			'Post the response as a GitHub comment (issue-only, otherwise prints to stdout)',
		)
		.action(async (workDir: string, opts) => {
			const resolvedDir = path.resolve(workDir);
			if (!fs.existsSync(resolvedDir)) {
				console.error(`ERROR: Directory '${resolvedDir}' does not exist`);
				process.exit(1);
			}

			// Read body from file if --body-file is provided, otherwise use --body
			let commentBody: string;
			if (opts.bodyFile) {
				const bodyFilePath = path.resolve(opts.bodyFile);
				if (!fs.existsSync(bodyFilePath)) {
					console.error(`ERROR: Body file '${bodyFilePath}' does not exist`);
					process.exit(1);
				}
				commentBody = fs.readFileSync(bodyFilePath, 'utf-8');
			} else if (opts.body) {
				commentBody = opts.body;
			} else {
				console.error('ERROR: Either --body or --body-file is required');
				process.exit(1);
			}

			process.chdir(resolvedDir);

			const issues = new GitHubProvider(resolvedDir, opts.repo);
			const agent = new PiHarness({
				cmd: opts.agentCmd,
				provider: opts.provider,
				model: opts.model,
			});

			await agent.validate();

			const number = parseInt(opts.number, 10);
			const commentConfig = {
				number,
				commentBody,
				workDir: resolvedDir,
				repo: opts.repo,
				logFile: opts.logFile,
				post: opts.post === true,
			};

			try {
				const isPR = await isPullRequest(issues, number);
				if (isPR) {
					console.log(`Detected PR #${number}`);
					await handlePRComment(commentConfig, issues, agent);
				} else {
					console.log(`Detected issue #${number}`);
					await handleIssueComment(commentConfig, issues, agent);
				}
			} catch (error) {
				console.error('ERROR:', error instanceof Error ? error.message : error);
				process.exit(1);
			}
		});

	// --- reconcile ---
	program
		.command('reconcile')
		.description('Check for completed issues and close them (no AI needed)')
		.argument('[work_dir]', 'Working directory', '.')
		.option('--repo <owner/repo>', 'GitHub repo')
		.action(async (workDir: string, opts) => {
			const resolvedDir = path.resolve(workDir);
			const issues = new GitHubProvider(resolvedDir, opts.repo);
			const taskMgr = new TaskManager(resolvedDir);

			console.log('=== whitesmith reconcile ===\n');

			// Also handle tasks-proposed → tasks-accepted transition
			// When a PR is merged, the tasks land on main, so if we see tasks on disk
			// for an issue labeled tasks-proposed, it means the PR was merged
			const proposedIssues = await issues.listIssues({labels: [LABELS.TASKS_PROPOSED]});
			for (const issue of proposedIssues) {
				if (taskMgr.hasRemainingTasks(issue.number)) {
					// Tasks exist on main = PR was merged
					console.log(`Issue #${issue.number}: tasks PR merged, marking as accepted`);
					await issues.removeLabel(issue.number, LABELS.TASKS_PROPOSED);
					await issues.addLabel(issue.number, LABELS.TASKS_ACCEPTED);
				}
			}

			// Check accepted issues for completion
			const acceptedIssues = await issues.listIssues({labels: [LABELS.TASKS_ACCEPTED]});
			for (const issue of acceptedIssues) {
				if (!taskMgr.hasRemainingTasks(issue.number)) {
					console.log(`Issue #${issue.number}: all tasks done, closing`);
					await issues.addLabel(issue.number, LABELS.COMPLETED);
					await issues.removeLabel(issue.number, LABELS.TASKS_ACCEPTED);
					await issues.comment(
						issue.number,
						'✅ All tasks for this issue have been implemented and merged. Closing.',
					);
					await issues.closeIssue(issue.number);
				}
			}

			console.log('Reconcile complete.');
		});

	// --- review ---
	program
		.command('review')
		.description('Review a PR, task proposal, or completed tasks')
		.argument('[work_dir]', 'Working directory', '.')
		.requiredOption('--number <n>', 'PR or issue number to review')
		.option(
			'--type <type>',
			'Review type: pr, issue-tasks, issue-tasks-completed (auto-detected if omitted)',
		)
		.option('--agent-cmd <cmd>', 'Agent harness command', DEFAULT_AGENT_CMD)
		.requiredOption('--provider <name>', 'AI provider (e.g. anthropic, openai)')
		.requiredOption('--model <id>', 'AI model ID (e.g. claude-opus-4-6)')
		.option('--repo <owner/repo>', 'GitHub repo (auto-detected if omitted)')
		.option('--log-file <path>', 'Log agent output to file')
		.option('--post', 'Post the review as a GitHub comment (otherwise prints to stdout)')
		.action(async (workDir: string, opts) => {
			const resolvedDir = path.resolve(workDir);
			if (!fs.existsSync(resolvedDir)) {
				console.error(`ERROR: Directory '${resolvedDir}' does not exist`);
				process.exit(1);
			}

			process.chdir(resolvedDir);

			const issues = new GitHubProvider(resolvedDir, opts.repo);
			const agent = new PiHarness({
				cmd: opts.agentCmd,
				provider: opts.provider,
				model: opts.model,
			});

			await agent.validate();

			const number = parseInt(opts.number, 10);

			try {
				let target;
				if (opts.type) {
					// Explicit type provided
					switch (opts.type) {
						case 'pr':
							target = {type: 'pr' as const, number};
							break;
						case 'issue-tasks':
							target = {type: 'issue-tasks' as const, issueNumber: number};
							break;
						case 'issue-tasks-completed':
							target = {type: 'issue-tasks-completed' as const, issueNumber: number};
							break;
						default:
							console.error(
								`ERROR: Unknown review type '${opts.type}'. Use: pr, issue-tasks, issue-tasks-completed`,
							);
							process.exit(1);
					}
				} else {
					// Auto-detect
					target = await detectReviewTarget(number, issues);
					console.log(`Auto-detected review type: ${target.type}`);
				}

				const result = await performReview(
					target,
					{
						workDir: resolvedDir,
						repo: opts.repo,
						logFile: opts.logFile,
						post: opts.post === true,
					},
					issues,
					agent,
				);

				console.log(`\nVerdict: ${result.verdict}`);
			} catch (error) {
				console.error('ERROR:', error instanceof Error ? error.message : error);
				process.exit(1);
			}
		});

	// --- install-ci ---
	program
		.command('install-ci')
		.description('Set up GitHub Actions workflows for whitesmith CI')
		.argument('[work_dir]', 'Working directory (target repository)', '.')
		.option(
			'--auth-json',
			'Use pi auth.json instead of models.json (requires PI_AUTH_JSON and GH_PAT secrets)',
		)
		.option('--repo <owner/repo>', 'GitHub repo (auto-detected if omitted)')
		.option('--fake', 'Write workflows to .fake/ instead of .github/ (for testing/comparison)')
		.option('--config <path>', 'Load provider config from a JSON file (skip interactive prompts)')
		.option(
			'--export-config <path>',
			'Write the provider config as JSON to a file instead of generating workflows',
		)
		.option(
			'--include-secrets',
			'With --export-config, prompt for API keys and include them in the JSON output',
		)
		.option('--no-secrets', 'Skip setting GitHub secrets (useful when reconfiguring workflows only)')
		.option('--dev', 'Build whitesmith from source (pnpm i + link --global) instead of npm install')
		.option('--review-workflow', 'Generate a GitHub Actions workflow for PR reviews')
		.option(
			'--no-review-step',
			'Indicate the review step is disabled in the main loop (review workflow will cover all PRs)',
		)
		.action(async (workDir: string, opts) => {
			const resolvedDir = path.resolve(workDir);
			if (!fs.existsSync(resolvedDir)) {
				console.error(`ERROR: Directory '${resolvedDir}' does not exist`);
				process.exit(1);
			}

			const authMode: AuthMode = opts.authJson ? 'auth-json' : 'models-json';

			try {
				const provider = new GitHubProvider(resolvedDir, opts.repo);
				await provider.installCI({
					authMode,
					fake: opts.fake ?? false,
					configFile: opts.config,
					exportConfig: opts.exportConfig,
					includeSecrets: opts.includeSecrets ?? false,
					dev: opts.dev,
					reviewWorkflow: opts.reviewWorkflow ?? false,
					reviewStepEnabled: opts.reviewStep !== false,
					skipSecrets: opts.secrets === false,
				});
			} catch (error) {
				console.error('ERROR:', error instanceof Error ? error.message : error);
				process.exit(1);
			}
		});

	return program;
}

export async function main(args: string[] = process.argv): Promise<void> {
	const program = buildCli();
	await program.parseAsync(args);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
