import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { RalphConfig } from './types.js';
import { Orchestrator } from './orchestrator.js';
import { createProvider } from './providers/index.js';

const DEFAULT_AGENT_CMD = 'claude --dangerously-skip-permissions -p';
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_BRANCH_PREFIX = 'ralph';

/**
 * Parse CLI arguments and return configuration
 */
export function parseArgs(args: string[]): RalphConfig {
	const program = new Command();

	program
		.name('ralph-epic')
		.description('Autonomous Coding Agent with Epic-based Branching')
		.argument('[work_dir]', 'Working directory', '.')
		.option('--agent-cmd <cmd>', 'Command to run the agent', DEFAULT_AGENT_CMD)
		.option('--max-iterations <n>', 'Maximum iterations', String(DEFAULT_MAX_ITERATIONS))
		.option('--branch-prefix <prefix>', 'Branch prefix', DEFAULT_BRANCH_PREFIX)
		.option('--log-file <path>', 'Log all agent output to a file')
		.option('--no-push', 'Skip pushing branches and creating PRs')
		.option('--no-sleep', 'Skip sleep between iterations (for testing)');

	program.parse(args);

	const opts = program.opts();
	const workDir = path.resolve(program.args[0] || '.');

	return {
		agentCmd: opts.agentCmd,
		maxIterations: parseInt(opts.maxIterations, 10),
		branchPrefix: opts.branchPrefix,
		logFile: opts.logFile,
		noPush: opts.noPush === true,
		noSleep: opts.noSleep === true,
		workDir,
	};
}

/**
 * Main entry point for the CLI
 */
export async function main(args: string[] = process.argv): Promise<void> {
	const config = parseArgs(args);

	// Validate work directory
	if (!fs.existsSync(config.workDir)) {
		console.error(`ERROR: Directory '${config.workDir}' does not exist`);
		process.exit(1);
	}

	// Change to work directory
	process.chdir(config.workDir);

	// Create provider (currently only markplane is supported)
	const provider = createProvider('markplane', config.workDir);

	// Create and run orchestrator
	const orchestrator = new Orchestrator(config, provider);

	try {
		await orchestrator.run();
	} catch (error) {
		console.error('ERROR:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
