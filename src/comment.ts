import * as fs from 'node:fs';
import * as path from 'node:path';
import type {AgentHarness} from './harnesses/agent-harness.js';
import type {IssueProvider} from './providers/issue-provider.js';
import {GitManager} from './git.js';
import {TaskManager} from './task-manager.js';
import {LABELS} from './types.js';

export interface CommentConfig {
	/** Issue or PR number */
	number: number;
	/** The comment body text */
	commentBody: string;
	/** Working directory (the repo) */
	workDir: string;
	/** GitHub repo in "owner/repo" format (auto-detected if not set) */
	repo?: string;
	/** Log file path */
	logFile?: string;
	/** Whether to post the response as a GitHub comment (issue-only) */
	post: boolean;
}

/** A related PR with its metadata */
interface RelatedPR {
	branch: string;
	number: number;
	title: string;
	state: string;
	url: string;
}

/** Whitesmith context gathered for prompts */
interface WhitesmithContext {
	/** The issue this comment relates to (for PR comments, the parent issue) */
	parentIssue?: {number: number; title: string; body: string; url: string; labels: string[]};
	/** Task proposal PR (investigate/<N>) */
	taskPR?: RelatedPR;
	/** Implementation PRs (task/<N>-*) */
	implementationPRs: RelatedPR[];
	/** Task files on the current branch (if tasks-accepted) */
	tasks: Array<{id: string; title: string; filePath: string}>;
	/** Whitesmith state label, if any */
	stateLabel?: string;
	/** The issue/PR number (used to tell the agent how to fetch comments) */
	number: number;
}

/**
 * Handle a comment on a PR.
 */
export async function handlePRComment(
	config: CommentConfig,
	issues: IssueProvider,
	agent: AgentHarness,
): Promise<void> {
	const git = new GitManager(config.workDir);

	// Get PR details
	const pr = await issues.getPR(config.number);
	if (!pr) {
		throw new Error(`Could not find PR #${config.number}`);
	}

	console.log(`PR #${config.number}: ${pr.title}`);
	console.log(`Branch: ${pr.branch}`);

	// Clean up temp files before checkout to avoid conflicts
	git.cleanupTempFiles();

	// Checkout PR branch
	await git.fetch();
	await git.checkout(pr.branch);

	// Gather whitesmith context based on branch naming
	const context = await gatherContextForPR(pr.branch, config.workDir, issues, config.number);

	const prompt = buildPRCommentPrompt({
		title: pr.title,
		url: pr.url,
		number: config.number,
		body: pr.body,
		branch: pr.branch,
		commentBody: config.commentBody,
		context,
	});

	const {exitCode} = await agent.run({
		prompt,
		workDir: config.workDir,
		logFile: config.logFile,
	});

	if (exitCode !== 0) {
		throw new Error(`Agent failed with exit code ${exitCode}`);
	}

	// Commit and push any changes
	const committed = await git.commitAll(`fix(#${config.number}): address review comment`);
	if (committed) {
		await git.push(pr.branch);
		console.log(`Changes pushed to ${pr.branch}`);
	} else {
		console.log('No changes to commit.');
	}
}

/**
 * Handle a comment on an issue (not a PR).
 */
export async function handleIssueComment(
	config: CommentConfig,
	issues: IssueProvider,
	agent: AgentHarness,
): Promise<void> {
	const git = new GitManager(config.workDir);
	const issue = await issues.getIssue(config.number);
	console.log(`Issue #${config.number}: ${issue.title}`);

	// Fetch so the agent can checkout related PR branches if needed
	await git.fetch();

	// Gather whitesmith context for this issue
	const context = await gatherContextForIssue(config.number, config.workDir, issues);

	const responseFile = '.whitesmith-response.md';
	const prompt = buildIssueCommentPrompt({
		title: issue.title,
		url: issue.url,
		number: config.number,
		body: issue.body,
		commentBody: config.commentBody,
		responseFile,
		context,
	});

	const {exitCode} = await agent.run({
		prompt,
		workDir: config.workDir,
		logFile: config.logFile,
	});

	if (exitCode !== 0) {
		throw new Error(`Agent failed with exit code ${exitCode}`);
	}

	// Read the response file
	const responsePath = path.join(config.workDir, responseFile);

	if (!fs.existsSync(responsePath)) {
		console.error('Agent did not produce a response file.');
		process.exitCode = 1;
		return;
	}

	const response = fs.readFileSync(responsePath, 'utf-8');

	// Clean up the response file
	try {
		fs.unlinkSync(responsePath);
	} catch {
		// ignore
	}

	if (config.post) {
		await issues.comment(config.number, response);
		console.log(`Response posted as comment on issue #${config.number}`);
	} else {
		// Print to stdout
		process.stdout.write(response);
	}
}

/**
 * Detect whether a given number is a PR or an issue.
 */
export async function isPullRequest(issues: IssueProvider, number: number): Promise<boolean> {
	const pr = await issues.getPR(number);
	return pr !== null;
}

// --- Context gathering ---

/**
 * Parse a whitesmith branch name to extract the issue number.
 *
 * - `investigate/<N>` → issue N (task proposal PR)
 * - `task/<N>-<seq>` → issue N (implementation PR)
 */
function parseWhitesmithBranch(branch: string): {type: 'investigate' | 'task'; issueNumber: number; taskId?: string} | null {
	const investigateMatch = branch.match(/^investigate\/(\d+)$/);
	if (investigateMatch) {
		return {type: 'investigate', issueNumber: parseInt(investigateMatch[1], 10)};
	}

	const taskMatch = branch.match(/^task\/(\d+)-(\d+.*)$/);
	if (taskMatch) {
		return {
			type: 'task',
			issueNumber: parseInt(taskMatch[1], 10),
			taskId: `${taskMatch[1]}-${taskMatch[2]}`,
		};
	}

	return null;
}

/**
 * Gather whitesmith context for a PR comment based on its branch name.
 */
async function gatherContextForPR(
	branch: string,
	workDir: string,
	issues: IssueProvider,
	commentNumber: number,
): Promise<WhitesmithContext> {
	const context: WhitesmithContext = {implementationPRs: [], tasks: [], number: commentNumber};

	const parsed = parseWhitesmithBranch(branch);
	if (!parsed) return context;

	// Fetch the parent issue
	try {
		const issue = await issues.getIssue(parsed.issueNumber);
		context.parentIssue = {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			url: issue.url,
			labels: issue.labels,
		};
		context.stateLabel = issue.labels.find((l) => l.startsWith('whitesmith:'));
	} catch {
		// Issue might not exist
	}

	// Find related PRs for this issue
	await gatherRelatedPRs(parsed.issueNumber, issues, context);

	// If tasks are on main, list them
	const taskManager = new TaskManager(workDir);
	context.tasks = taskManager.listTasks(parsed.issueNumber).map((t) => ({
		id: t.id,
		title: t.title,
		filePath: t.filePath,
	}));

	return context;
}

/**
 * Gather whitesmith context for an issue comment.
 */
async function gatherContextForIssue(
	issueNumber: number,
	workDir: string,
	issues: IssueProvider,
): Promise<WhitesmithContext> {
	const context: WhitesmithContext = {implementationPRs: [], tasks: [], number: issueNumber};

	// Get the issue's labels for state
	try {
		const issue = await issues.getIssue(issueNumber);
		context.stateLabel = issue.labels.find((l) => l.startsWith('whitesmith:'));
	} catch {
		// ignore
	}

	// Find related PRs
	await gatherRelatedPRs(issueNumber, issues, context);

	// List tasks on main
	const taskManager = new TaskManager(workDir);
	context.tasks = taskManager.listTasks(issueNumber).map((t) => ({
		id: t.id,
		title: t.title,
		filePath: t.filePath,
	}));

	return context;
}

/**
 * Find task proposal and implementation PRs related to an issue.
 */
async function gatherRelatedPRs(
	issueNumber: number,
	issues: IssueProvider,
	context: WhitesmithContext,
): Promise<void> {
	// Task proposal PR
	const taskPR = await issues.getPRForBranch(`investigate/${issueNumber}`);
	if (taskPR) {
		context.taskPR = {
			branch: `investigate/${issueNumber}`,
			number: 0, // getPRForBranch doesn't return number
			title: '',
			state: taskPR.state,
			url: taskPR.url,
		};
	}

	// Implementation PRs
	const implPRs = await issues.listPRsByBranchPrefix(`task/${issueNumber}-`);
	context.implementationPRs = implPRs;
}

// --- Prompt builders ---

function formatWhitesmithContext(context: WhitesmithContext): string {
	const sections: string[] = [];

	if (context.stateLabel) {
		const stateDescriptions: Record<string, string> = {
			[LABELS.INVESTIGATING]: 'The agent is currently investigating this issue and generating tasks.',
			[LABELS.TASKS_PROPOSED]: 'Tasks have been proposed in a PR and are awaiting review.',
			[LABELS.TASKS_ACCEPTED]: 'Tasks have been accepted and are being implemented.',
			[LABELS.COMPLETED]: 'All tasks for this issue have been completed.',
		};
		const desc = stateDescriptions[context.stateLabel] || context.stateLabel;
		sections.push(`### Whitesmith State\n\n**${context.stateLabel}**: ${desc}`);
	}

	if (context.parentIssue) {
		sections.push(
			`### Parent Issue\n\n` +
			`- **Title:** ${context.parentIssue.title}\n` +
			`- **URL:** ${context.parentIssue.url}\n` +
			`- **Number:** #${context.parentIssue.number}\n` +
			`- **Labels:** ${context.parentIssue.labels.join(', ') || 'none'}\n\n` +
			`#### Issue Description\n\n${context.parentIssue.body}`,
		);
	}

	if (context.taskPR) {
		sections.push(
			`### Task Proposal PR\n\n` +
			`- **Branch:** \`${context.taskPR.branch}\`\n` +
			`- **State:** ${context.taskPR.state}\n` +
			`- **URL:** ${context.taskPR.url}`,
		);
	}

	if (context.implementationPRs.length > 0) {
		const prList = context.implementationPRs
			.map(
				(pr) =>
					`- **#${pr.number}** ${pr.title} — \`${pr.branch}\` (${pr.state}) — ${pr.url}`,
			)
			.join('\n');
		sections.push(`### Implementation PRs\n\n${prList}`);
	}

	if (context.tasks.length > 0) {
		const taskList = context.tasks
			.map((t) => `- **${t.id}**: ${t.title} (\`${t.filePath}\`)`)
			.join('\n');
		sections.push(`### Pending Tasks\n\n${taskList}`);
	}

	sections.push(
		`### Conversation History\n\n` +
		`Previous comments are **not** included here to save context space. ` +
		`If you need to read the conversation history, run:\n\n` +
		`\`\`\`bash\ngh issue view ${context.number} --comments\n\`\`\``,
	);

	if (sections.length === 0) {
		return '';
	}

	return `\n## Whitesmith Context\n\n` +
		`The following is the current whitesmith pipeline state and conversation history related to this issue/PR. ` +
		`Use this context to provide informed responses.\n\n` +
		sections.join('\n\n') + '\n';
}

interface PRCommentPromptArgs {
	title: string;
	url: string;
	number: number;
	body: string;
	branch: string;
	commentBody: string;
	context: WhitesmithContext;
}

function buildPRCommentPrompt(args: PRCommentPromptArgs): string {
	return `# Agent Task from PR Comment

## Pull Request

- **Title:** ${args.title}
- **URL:** ${args.url}
- **PR Number:** #${args.number}
- **Branch:** ${args.branch}

### PR Description

${args.body}
${formatWhitesmithContext(args.context)}
## Triggering Comment

${args.commentBody}

## Instructions

You are working on a pull request. The comment above is a request from a reviewer or contributor.

1. You are already on the PR branch: \`${args.branch}\`
2. Read and understand the comment request.
3. Review the whitesmith context above to understand the pipeline state.
4. Make the requested changes.
5. Commit your changes with a descriptive message.

Do NOT push. Do NOT create a new PR. The caller will handle pushing.
`;
}

interface IssueCommentPromptArgs {
	title: string;
	url: string;
	number: number;
	body: string;
	commentBody: string;
	responseFile: string;
	context: WhitesmithContext;
}

function buildIssueCommentPrompt(args: IssueCommentPromptArgs): string {
	// Build the list of related PR branches the agent can work on
	const relatedBranches: string[] = [];
	if (args.context.taskPR && args.context.taskPR.state === 'open') {
		relatedBranches.push(args.context.taskPR.branch);
	}
	for (const pr of args.context.implementationPRs) {
		if (pr.state === 'open') {
			relatedBranches.push(pr.branch);
		}
	}

	let workOnPRInstructions = '';
	if (relatedBranches.length > 0) {
		const branchList = relatedBranches.map((b) => `  - \`${b}\``).join('\n');
		workOnPRInstructions = `

### Working on related PRs

If the comment asks you to make changes to a related PR (e.g. update the task plan,
fix something in an implementation), you **can and should** do so. The related open PR branches are:

${branchList}

To work on a PR branch:

1. \`git checkout <branch>\` (branches have been fetched already)
2. Make your changes.
3. Commit with a descriptive message.
4. \`git push origin <branch>\`
5. Still write \`${args.responseFile}\` summarizing what you did.

When done, \`git checkout main\` to return to the default branch.`;
	}

	return `# Agent Task from Issue Comment

## Issue

- **Title:** ${args.title}
- **URL:** ${args.url}
- **Issue Number:** #${args.number}

### Issue Description

${args.body}
${formatWhitesmithContext(args.context)}
## Triggering Comment

${args.commentBody}

## Instructions

You are responding to a comment on an issue.

1. Read and understand the issue description and the triggering comment.
2. Review the whitesmith context above to understand what work is already in progress.
3. You have full access to the repository code — read files, explore the codebase as needed.
4. Analyze the request and formulate a helpful response.
5. Write your response in Markdown to the file \`${args.responseFile}\`.

Your response will be posted as a comment on the issue.
Be thorough but concise. Include code snippets, file references, or suggestions as appropriate.
If there are pending PRs or tasks, reference them in your response when relevant.${workOnPRInstructions}
`;
}
