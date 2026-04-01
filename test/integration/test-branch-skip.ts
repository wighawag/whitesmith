#!/usr/bin/env tsx
/**
 * test-branch-skip.ts - Test that epics with existing branches are skipped
 * This tests the fix for the infinite loop issue where completed epics
 * were being rediscovered because their status updates were on the branch,
 * not on main.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.resolve(import.meta.dirname, '../..');
const MOCK_AGENT = path.join(SCRIPT_DIR, 'test/mocks/mock-agent.ts');

let PASSED = 0;
let FAILED = 0;

console.log('=== Test: Branch Skip Behavior ===');
console.log(`Script directory: ${SCRIPT_DIR}`);
console.log('');

// Verify mock agent exists
if (!fs.existsSync(MOCK_AGENT)) {
	console.error(`ERROR: Mock agent not found at ${MOCK_AGENT}`);
	process.exit(1);
}

/**
 * Run ralph-epic and return the output
 */
function runRalphEpic(testDir: string, agentCmd: string, maxIterations: number = 1): string {
	const result = spawnSync(
		'npx',
		[
			'tsx',
			path.join(SCRIPT_DIR, 'src/index.ts'),
			'--agent-cmd',
			agentCmd,
			'--max-iterations',
			String(maxIterations),
			'--no-push',
			'--no-sleep',
			testDir,
		],
		{
			cwd: testDir,
			env: { ...process.env },
			encoding: 'utf-8',
		}
	);

	return (result.stdout || '') + (result.stderr || '');
}

/**
 * Create a test git repository
 */
function createTestRepo(): string {
	const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-test-'));
	process.chdir(testDir);

	execSync('git init', { stdio: 'pipe' });
	execSync('git config user.email "test@example.com"', { stdio: 'pipe' });
	execSync('git config user.name "Test User"', { stdio: 'pipe' });

	fs.mkdirSync('src', { recursive: true });
	fs.writeFileSync('README.md', '# Test Project\n');
	execSync('git add .', { stdio: 'pipe' });
	execSync('git commit -m "Initial commit"', { stdio: 'pipe' });
	execSync('git branch -M main', { stdio: 'pipe' });

	return testDir;
}

// ============================================
// TEST 1: Epic with branch should be skipped
// ============================================
console.log('=== TEST 1: Epic with existing branch should be skipped ===');
console.log('');

const testDir1 = createTestRepo();

// Simulate that EPIC-001 was completed: create its branch with some work
console.log('Creating completed epic branch for EPIC-001...');
execSync('git checkout -b ralph/epic-EPIC-001-user-authentication', { stdio: 'pipe' });
fs.mkdirSync('src/epic-001', { recursive: true });
fs.writeFileSync('src/epic-001/task-1.ts', '// User Authentication - Task 1\nexport function task1() { return true; }\n');
execSync('git add .', { stdio: 'pipe' });
execSync('git commit -m "feat(EPIC-001): implement task 1"', { stdio: 'pipe' });
execSync('git checkout main', { stdio: 'pipe' });

// Clear any state files
try {
	fs.unlinkSync('.ralph-epic-state');
} catch {}
try {
	fs.unlinkSync('.mock-agent-state');
} catch {}

console.log('');
console.log('Current branches:');
execSync('git branch -a', { stdio: 'inherit' });
console.log('');

// Run the script
console.log('Running ralph-epic with 1 iteration to test discovery...');
console.log('');

const output1 = runRalphEpic(testDir1, `npx tsx ${MOCK_AGENT}`);
console.log(output1);
console.log('');

// Check that EPIC-001 was skipped and EPIC-002 was discovered
if (output1.includes('Discovered epic: EPIC-002') || output1.includes('EPIC_ID: EPIC-002')) {
	console.log('✅ TEST 1 PASSED: EPIC-001 was correctly skipped, EPIC-002 was discovered');
	PASSED++;
} else {
	console.log('❌ TEST 1 FAILED: Expected EPIC-002 to be discovered (skipping EPIC-001)');
	FAILED++;
}

console.log('');

// ============================================
// TEST 2: Verify STATE_FILE epic is excluded from skip list
// ============================================
console.log('=== TEST 2: STATE_FILE epic should NOT be in skip list ===');
console.log('');

const testDir2 = createTestRepo();

// Create branch for EPIC-001 (completed)
execSync('git checkout -b ralph/epic-EPIC-001-user-authentication', { stdio: 'pipe' });
fs.writeFileSync('src/task1.ts', 'task1');
execSync('git add .', { stdio: 'pipe' });
execSync('git commit -m "feat(EPIC-001): complete"', { stdio: 'pipe' });

// Create branch for EPIC-002 (in progress - will be in STATE_FILE)
execSync('git checkout -b ralph/epic-EPIC-002-dashboard-ui', { stdio: 'pipe' });
fs.writeFileSync('src/task2.ts', 'partial');
execSync('git add .', { stdio: 'pipe' });
execSync('git commit -m "feat(EPIC-002): partial work"', { stdio: 'pipe' });

execSync('git checkout main', { stdio: 'pipe' });

// Create partial STATE_FILE
fs.writeFileSync('.ralph-epic-state', `SAVED_EPIC_ID="EPIC-002"\nSAVED_EPIC_NAME="Dashboard UI"\n`);
try {
	fs.unlinkSync('.mock-agent-state');
} catch {}

console.log('Branches:');
execSync('git branch | grep ralph', { stdio: 'inherit' });
console.log('');
console.log('STATE_FILE (partial - will trigger discovery):');
console.log(fs.readFileSync('.ralph-epic-state', 'utf-8'));
console.log('');

// Create a test mock that shows us what's in the skip list
const testMockPath = path.join(testDir2, 'test-mock.ts');
fs.writeFileSync(
	testMockPath,
	`#!/usr/bin/env tsx
const prompt = process.argv[2] || '';
console.log('=== ANALYZING DISCOVERY PROMPT ===');

// Check what epics are in the skip list
if (prompt.includes('already have branches')) {
    console.log('Skip list found in prompt:');
    const matches = prompt.match(/^\\s*-.*$/gm);
    if (matches) {
        matches.slice(0, 5).forEach(m => console.log(m));
    }
} else {
    console.log('No skip list found');
}

console.log('');

// Verify EPIC-002 is NOT in the skip list (since it's in STATE_FILE)
if (/^\\s*-\\s*EPIC-002/m.test(prompt)) {
    console.log('RESULT: EPIC-002 IS in skip list (BAD)');
    console.log('STATUS: FAIL');
} else {
    console.log('RESULT: EPIC-002 is NOT in skip list (GOOD - STATE_FILE exclusion works)');
    console.log('STATUS: PASS');
}

// Output valid discovery response
console.log('');
console.log('EPIC_ID: EPIC-003');
console.log('EPIC_NAME: API Integration');
console.log('DEPENDS_ON: EPIC-002');
`
);

const output2 = runRalphEpic(testDir2, `npx tsx ${testMockPath}`);
console.log(output2);
console.log('');

if (output2.includes('STATUS: PASS')) {
	console.log('✅ TEST 2 PASSED: STATE_FILE epic correctly excluded from skip list');
	PASSED++;
} else if (output2.includes('STATUS: FAIL')) {
	console.log('❌ TEST 2 FAILED: STATE_FILE epic should NOT be in skip list');
	FAILED++;
} else {
	console.log('⚠️ TEST 2 INCONCLUSIVE: Could not determine result');
	FAILED++;
}

console.log('');

// ============================================
// TEST 3: All epics with branches = COMPLETE signal
// ============================================
console.log('=== TEST 3: All epics with branches should trigger RALPH_COMPLETE ===');
console.log('');

const testDir3 = createTestRepo();

// Create branches for ALL epics
for (const epic of ['EPIC-001', 'EPIC-002', 'EPIC-003']) {
	execSync(`git checkout -b ralph/epic-${epic}-completed`, { stdio: 'pipe' });
	fs.writeFileSync(`src/${epic}.ts`, 'done');
	execSync('git add .', { stdio: 'pipe' });
	execSync(`git commit -m "feat(${epic}): complete"`, { stdio: 'pipe' });
}

execSync('git checkout main', { stdio: 'pipe' });

try {
	fs.unlinkSync('.ralph-epic-state');
} catch {}
try {
	fs.unlinkSync('.mock-agent-state');
} catch {}

console.log('Branches (all epics):');
execSync('git branch | grep ralph', { stdio: 'inherit' });
console.log('');

const output3 = runRalphEpic(testDir3, `npx tsx ${MOCK_AGENT}`);
console.log(output3);
console.log('');

if (output3.includes('ALL EPICS COMPLETED') || output3.includes('RALPH_COMPLETE')) {
	console.log('✅ TEST 3 PASSED: All epics with branches correctly identified as complete');
	PASSED++;
} else {
	console.log('❌ TEST 3 FAILED: Expected RALPH_COMPLETE when all epics have branches');
	FAILED++;
}

console.log('');

// ============================================
// TEST 4: Max iterations reached should not cause syntax error
// ============================================
console.log('=== TEST 4: Max iterations reached should complete without errors ===');
console.log('');

const testDir4 = createTestRepo();
try {
	fs.unlinkSync('.ralph-epic-state');
} catch {}
try {
	fs.unlinkSync('.mock-agent-state');
} catch {}

// Run with exactly 2 iterations
const result4 = spawnSync(
	'npx',
	[
		'tsx',
		path.join(SCRIPT_DIR, 'src/index.ts'),
		'--agent-cmd',
		`npx tsx ${MOCK_AGENT}`,
		'--max-iterations',
		'2',
		'--no-push',
		'--no-sleep',
		testDir4,
	],
	{
		cwd: testDir4,
		env: { ...process.env },
		encoding: 'utf-8',
	}
);

const output4 = (result4.stdout || '') + (result4.stderr || '');
const exitCode4 = result4.status ?? 0;

console.log(output4);
console.log('');
console.log(`Exit code: ${exitCode4}`);
console.log('');

if (output4.includes('syntax error')) {
	console.log('❌ TEST 4 FAILED: Syntax error detected');
	FAILED++;
} else if (exitCode4 !== 0) {
	console.log(`❌ TEST 4 FAILED: Script exited with error code ${exitCode4}`);
	FAILED++;
} else if (output4.includes('Iteration limit reached') || output4.includes('ALL EPICS COMPLETED')) {
	console.log('✅ TEST 4 PASSED: Max iterations reached without errors');
	PASSED++;
} else {
	console.log('⚠️ TEST 4 INCONCLUSIVE: Could not verify behavior');
	FAILED++;
}

console.log('');

// ============================================
// Summary
// ============================================
console.log('==========================================');
console.log(`Test Summary: ${PASSED} passed, ${FAILED} failed`);
console.log('==========================================');
console.log('');
console.log('Test directories:');
console.log(`  - ${testDir1}`);
console.log(`  - ${testDir2}`);
console.log(`  - ${testDir3}`);
console.log(`  - ${testDir4}`);
console.log('');
console.log(`To clean up: rm -rf ${testDir1} ${testDir2} ${testDir3} ${testDir4}`);

if (FAILED > 0) {
	process.exit(1);
}
