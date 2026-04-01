import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * Runs agent commands and captures their output
 */
export class AgentRunner {
	private logFile?: string;
	private isTTY: boolean;

	constructor(logFile?: string) {
		this.logFile = logFile;
		this.isTTY = process.stdout.isTTY ?? false;
	}

	/**
	 * Run an agent command with the given prompt
	 * Handles output streaming and logging
	 */
	async runAgent(prompt: string, command: string): Promise<{ output: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];

			// Parse command to get program and args
			// The command format is like: "claude --dangerously-skip-permissions -p"
			// or a path to a script like: "/path/to/mock-agent.sh"
			const parts = this.parseCommand(command);
			const program = parts[0];
			const args = [...parts.slice(1), prompt];

			const child = spawn(program, args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
			});

			// Handle stdout
			child.stdout.on('data', (data: Buffer) => {
				chunks.push(data);

				// Stream to terminal if TTY
				if (this.isTTY) {
					process.stdout.write(data);
				}

				// Append to log file if specified
				if (this.logFile) {
					fs.appendFileSync(this.logFile, data);
				}
			});

			// Handle stderr (merge with stdout for our purposes)
			child.stderr.on('data', (data: Buffer) => {
				chunks.push(data);

				// Stream to terminal if TTY
				if (this.isTTY) {
					process.stderr.write(data);
				}

				// Append to log file if specified
				if (this.logFile) {
					fs.appendFileSync(this.logFile, data);
				}
			});

			child.on('error', (error) => {
				reject(new Error(`Failed to spawn agent command: ${error.message}`));
			});

			child.on('close', (code) => {
				const output = Buffer.concat(chunks).toString('utf-8');
				resolve({ output, exitCode: code ?? 0 });
			});
		});
	}

	/**
	 * Parse a command string into program and arguments
	 * Handles quoted arguments and paths with spaces
	 */
	private parseCommand(command: string): string[] {
		const parts: string[] = [];
		let current = '';
		let inQuote = false;
		let quoteChar = '';

		for (const char of command) {
			if ((char === '"' || char === "'") && !inQuote) {
				inQuote = true;
				quoteChar = char;
			} else if (char === quoteChar && inQuote) {
				inQuote = false;
				quoteChar = '';
			} else if (char === ' ' && !inQuote) {
				if (current) {
					parts.push(current);
					current = '';
				}
			} else {
				current += char;
			}
		}

		if (current) {
			parts.push(current);
		}

		return parts;
	}

	/**
	 * Initialize the log file with a header
	 */
	initLogFile(workDir: string): void {
		if (this.logFile) {
			const header = `=== Ralph Agent Log - ${new Date().toISOString()} ===\nWorking directory: ${workDir}\n\n`;
			fs.appendFileSync(this.logFile, header);
		}
	}
}
