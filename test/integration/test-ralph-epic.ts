#!/usr/bin/env tsx
/**
 * test-ralph-epic.ts - Test script for ralph-epic TypeScript implementation
 * Creates a temporary git repo and runs the script with the mock agent
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.resolve(import.meta.dirname, '../..');
const MOCK_AGENT = path.join(SCRIPT_DIR, 'test/mocks/mock-agent.ts');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-test-'));

console.log('=== Test Setup ===');
console.log(`Script directory: ${SCRIPT_DIR}`);
console.log(`Test directory: ${TEST_DIR}`);
console.log(`Mock agent: ${MOCK_AGENT}`);
console.log('');

// Verify mock agent exists
if (!fs.existsSync(MOCK_AGENT)) {
	console.error(`ERROR: Mock agent not found at ${MOCK_AGENT}`);
	process.exit(1);
}

// Create test git repository
console.log('=== Creating Test Repository ===');
process.chdir(TEST_DIR);

execSync('git init', { stdio: 'inherit' });
execSync('git config user.email "test@example.com"', { stdio: 'inherit' });
execSync('git config user.name "Test User"', { stdio: 'inherit' });

// Create initial files
fs.mkdirSync('src', { recursive: true });
fs.writeFileSync('README.md', '# Test Project\n');
fs.writeFileSync('src/index.ts', 'export const app = () => {};\n');

execSync('git add .', { stdio: 'inherit' });
execSync('git commit -m "Initial commit"', { stdio: 'inherit' });
execSync('git branch -M main', { stdio: 'inherit' });

console.log('Repository initialized with main branch');
console.log('');

// Run ralph-epic with mock agent using tsx to run the TypeScript source
console.log('=== Running ralph-epic with Mock Agent ===');
console.log('');

const result = spawnSync(
	'npx',
	[
		'tsx',
		path.join(SCRIPT_DIR, 'src/index.ts'),
		'--agent-cmd',
		`npx tsx ${MOCK_AGENT}`,
		'--max-iterations',
		'10',
		'--no-push',
		'--no-sleep',
		TEST_DIR,
	],
	{
		stdio: 'inherit',
		cwd: TEST_DIR,
		env: { ...process.env },
	}
);

if (result.error) {
	console.error('Error running ralph-epic:', result.error);
	process.exit(1);
}

// Show results
console.log('');
console.log('=== Test Results ===');
console.log('');
console.log('Branches created:');
execSync('git branch -a', { stdio: 'inherit' });

console.log('');
console.log('Commit log (all branches):');
execSync('git log --oneline --all --graph --decorate', { stdio: 'inherit' });

console.log('');
console.log('Files created:');
try {
	const files = execSync('find src -type f -name "*.ts" 2>/dev/null | sort', {
		encoding: 'utf-8',
	});
	console.log(files || '(none)');
} catch {
	console.log('(none)');
}

console.log('');
console.log('==========================================');
console.log('Test completed successfully!');
console.log('==========================================');
console.log('');
console.log(`Test directory: ${TEST_DIR}`);
console.log(`To explore: cd ${TEST_DIR} && git log --all --oneline`);
console.log(`To clean up: rm -rf ${TEST_DIR}`);
