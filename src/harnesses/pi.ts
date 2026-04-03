import {exec, execSync} from 'node:child_process';
import * as fs from 'node:fs';
import {homedir} from 'node:os';
import * as path from 'node:path';
import type {AgentHarness, AgentHarnessConfig} from './agent-harness.js';

/** Subset of pi JSON event fields we care about */
interface PiEvent {
	type: string;
	toolName?: string;
	args?: any;
	result?: any;
	isError?: boolean;
	assistantMessageEvent?: {type: string; delta?: string};
	reason?: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
}

/**
 * Agent harness for @mariozechner/pi-coding-agent.
 *
 * Runs `pi` with a prompt passed via a temp file, captures output.
 */
export class PiHarness implements AgentHarness {
	private cmd: string;
	private provider: string;
	private model: string;

	constructor(config: AgentHarnessConfig) {
		this.cmd = config.cmd;
		this.provider = config.provider;
		this.model = config.model;
	}

	async validate(): Promise<void> {
		// Check if the command exists
		try {
			execSync(`which ${this.cmd}`, {stdio: 'pipe'});
		} catch {
			throw new Error(
				`Agent command '${this.cmd}' not found. ` +
					`Make sure it is installed and available in PATH. ` +
					`For pi-coding-agent: npm install -g @mariozechner/pi-coding-agent`,
			);
		}

		// Check for auth configuration (auth.json or models.json)
		const homeDir = process.env.HOME || homedir();
		const authJsonPath = path.join(homeDir, '.pi', 'agent', 'auth.json');
		const modelsJsonPath = path.join(homeDir, '.pi', 'agent', 'models.json');
		const hasAuthJson = fs.existsSync(authJsonPath);
		const hasModelsJson = fs.existsSync(modelsJsonPath);

		if (hasModelsJson) {
			try {
				const modelsData = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
				const providers = Object.keys(modelsData.providers || {});
				console.log(`Models config found at ${modelsJsonPath} with providers: ${providers.join(', ')}`);
				if (!modelsData.providers?.[this.provider]) {
					console.warn(
						`WARNING: Provider '${this.provider}' not found in models.json (has: ${providers.join(', ')})`,
					);
				}
			} catch (e: any) {
				console.warn(`WARNING: Could not parse models.json: ${e.message}`);
			}
		} else if (hasAuthJson) {
			try {
				const authData = JSON.parse(fs.readFileSync(authJsonPath, 'utf-8'));
				const providers = Object.keys(authData);
				console.log(`Auth file found at ${authJsonPath} with providers: ${providers.join(', ')}`);
				if (!authData[this.provider]) {
					console.warn(
						`WARNING: Provider '${this.provider}' not found in auth.json (has: ${providers.join(', ')})`,
					);
				}
			} catch (e: any) {
				console.warn(`WARNING: Could not parse auth.json: ${e.message}`);
			}
		} else {
			console.warn(`WARNING: No auth configuration found (checked ${modelsJsonPath} and ${authJsonPath})`);
		}

		// Validate auth by making a minimal API call
		try {
			const result = execSync(
				`${this.cmd} --print --no-tools --no-session --provider ${this.provider} --model ${this.model} "respond with OK"`,
				{stdio: 'pipe', timeout: 30_000},
			);
			const output = result.toString().trim();
			if (!output) {
				throw new Error('Empty response');
			}
			console.log(`Auth check passed (response: ${output.slice(0, 20)})`);
		} catch (error: any) {
			const stderr = error.stderr?.toString() || '';
			const stdout = error.stdout?.toString() || '';
			const details =
				[stderr, stdout].filter(Boolean).join('\n') || error.message || 'unknown error';
			throw new Error(
				`Agent auth validation failed. Ensure valid credentials are configured.\n` +
					`Configure providers via ~/.pi/agent/models.json or ~/.pi/agent/auth.json\n` +
					`models.json exists: ${hasModelsJson}\n` +
					`auth.json exists: ${hasAuthJson}\n` +
					`HOME: ${homeDir}\n` +
					`Details: ${details.slice(0, 800)}`,
			);
		}
	}

	async run(options: {
		prompt: string;
		workDir: string;
		logFile?: string;
	}): Promise<{output: string; exitCode: number}> {
		// Write prompt to a temp file and use @file syntax so pi reads contents
		const promptFile = path.join(options.workDir, '.whitesmith-prompt.md');
		fs.writeFileSync(promptFile, options.prompt, 'utf-8');

		try {
			const result = await this.exec(
				`${this.cmd} --print --mode json --no-session --provider ${this.provider} --model ${this.model} @"${promptFile}"`,
				options.workDir,
				options.logFile,
			);
			return result;
		} finally {
			// Clean up prompt file
			try {
				fs.unlinkSync(promptFile);
			} catch {
				// Ignore
			}
		}
	}

	/** Format a pi JSON event as a human-readable log line (null = skip) */
	private formatEvent(event: PiEvent): string | null {
		switch (event.type) {
			case 'agent_start':
				return '\n🤖 Agent started';
			case 'agent_end':
				return '\n🏁 Agent finished';
			case 'turn_start':
				return '\n--- turn ---';
			case 'message_update': {
				const evt = event.assistantMessageEvent;
				if (evt?.type === 'text_delta' && evt.delta) return evt.delta;
				if (evt?.type === 'thinking_delta' && evt.delta) return evt.delta;
				return null;
			}
			case 'tool_execution_start': {
				const argsStr = JSON.stringify(event.args);
				const truncArgs = argsStr.length > 200 ? argsStr.slice(0, 200) + '…' : argsStr;
				return `\n🔧 ${event.toolName}(${truncArgs})`;
			}
			case 'tool_execution_end': {
				const icon = event.isError ? '❌' : '✅';
				const res = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
				const truncRes = res.length > 500 ? res.slice(0, 500) + '…' : res;
				return `${icon} ${event.toolName} → ${truncRes}`;
			}
			case 'compaction_start':
				return `\n📦 Compaction (${event.reason})`;
			case 'auto_retry_start':
				return `\n🔄 Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`;
			case 'auto_retry_end':
				return event.success ? '🔄 Retry succeeded' : `🔄 Retry failed: ${event.finalError}`;
			default:
				return null;
		}
	}

	private exec(
		cmd: string,
		workDir: string,
		logFile?: string,
	): Promise<{output: string; exitCode: number}> {
		return new Promise((resolve) => {
			const child = exec(cmd, {
				cwd: workDir,
				maxBuffer: 50 * 1024 * 1024,
				timeout: 30 * 60 * 1000, // 30 minute timeout
			});

			// Close stdin immediately so pi doesn't hang waiting for piped input
			child.stdin?.end();

			let output = '';
			let lineBuffer = '';
			const logStream = logFile
				? fs.createWriteStream(path.resolve(workDir, logFile), {flags: 'a'})
				: null;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event: PiEvent = JSON.parse(line);
					const formatted = this.formatEvent(event);
					if (formatted !== null) {
						process.stdout.write(formatted);
					}
				} catch {
					process.stdout.write(line + '\n');
				}
			};

			child.stdout?.on('data', (data: string) => {
				output += data;
				logStream?.write(data);
				lineBuffer += data;
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() ?? '';
				for (const line of lines) processLine(line);
			});

			child.stderr?.on('data', (data: string) => {
				output += data;
				process.stderr.write(data);
				logStream?.write(data);
			});

			child.on('close', (code) => {
				if (lineBuffer.trim()) processLine(lineBuffer);
				logStream?.end();
				resolve({output, exitCode: code ?? 1});
			});
		});
	}
}
