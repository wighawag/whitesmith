import {exec, execSync} from 'node:child_process';
import {promisify} from 'node:util';
import type {IssueProvider} from './issue-provider.js';
import type {Issue} from '../types.js';
import {installGitHubCI, type InstallCIOptions, type AuthMode} from './github-ci.js';

const execAsync = promisify(exec);

/**
 * GitHub Issues provider using the `gh` CLI.
 */
export class GitHubProvider implements IssueProvider {
	private workDir: string;
	private repo?: string;

	constructor(workDir: string, repo?: string) {
		this.workDir = workDir;
		this.repo = repo;
	}

	private repoFlag(): string {
		return this.repo ? ` --repo ${this.repo}` : '';
	}

	private async gh(args: string): Promise<string> {
		try {
			const {stdout} = await execAsync(`gh ${args}${this.repoFlag()}`, {
				cwd: this.workDir,
				maxBuffer: 10 * 1024 * 1024,
			});
			return stdout.trim();
		} catch (error) {
			const e = error as {stdout?: string; stderr?: string; message?: string};
			// Some gh commands return exit code 1 for "not found" results
			if (e.stdout !== undefined) {
				return e.stdout.trim();
			}
			throw new Error(`gh ${args} failed: ${e.stderr || e.message}`);
		}
	}

	async listIssues(options?: {labels?: string[]; noLabels?: string[]}): Promise<Issue[]> {
		let cmd = 'issue list --state open --json number,title,body,labels,url --limit 100';

		if (options?.labels && options.labels.length > 0) {
			cmd += ` --label "${options.labels.join(',')}"`;
		}

		const raw = await this.gh(cmd);
		if (!raw || raw === '[]') return [];

		const issues: Array<{
			number: number;
			title: string;
			body: string;
			labels: Array<{name: string}>;
			url: string;
		}> = JSON.parse(raw);

		let result: Issue[] = issues.map((i) => ({
			number: i.number,
			title: i.title,
			body: i.body || '',
			labels: i.labels.map((l) => l.name),
			url: i.url,
		}));

		// Client-side filter for "no labels" (gh CLI doesn't support negation)
		if (options?.noLabels && options.noLabels.length > 0) {
			result = result.filter((issue) => !issue.labels.some((l) => options.noLabels!.includes(l)));
		}

		return result;
	}

	async getIssue(number: number): Promise<Issue> {
		const raw = await this.gh(`issue view ${number} --json number,title,body,labels,url`);
		const i = JSON.parse(raw) as {
			number: number;
			title: string;
			body: string;
			labels: Array<{name: string}>;
			url: string;
		};
		return {
			number: i.number,
			title: i.title,
			body: i.body || '',
			labels: i.labels.map((l) => l.name),
			url: i.url,
		};
	}

	async addLabel(number: number, label: string): Promise<void> {
		await this.gh(`issue edit ${number} --add-label "${label}"`);
	}

	async removeLabel(number: number, label: string): Promise<void> {
		try {
			await this.gh(`issue edit ${number} --remove-label "${label}"`);
		} catch {
			// Ignore if label wasn't present
		}
	}

	async comment(number: number, body: string): Promise<void> {
		// Use stdin to avoid shell escaping issues
		await new Promise<void>((resolve, reject) => {
			const child = exec(
				`gh issue comment ${number} --body-file -${this.repoFlag()}`,
				{cwd: this.workDir},
				(err) => (err ? reject(err) : resolve()),
			);
			child.stdin!.write(body);
			child.stdin!.end();
		});
	}

	async closeIssue(number: number): Promise<void> {
		await this.gh(`issue close ${number}`);
	}

	async createPR(options: {
		head: string;
		base: string;
		title: string;
		body: string;
	}): Promise<string> {
		const url = await new Promise<string>((resolve, reject) => {
			const child = exec(
				`gh pr create --head "${options.head}" --base "${options.base}" --title "${options.title}" --body-file -${this.repoFlag()}`,
				{cwd: this.workDir},
				(err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
			);
			child.stdin!.write(options.body);
			child.stdin!.end();
		});
		return url;
	}

	async remoteBranchExists(branch: string): Promise<boolean> {
		try {
			const {stdout} = await execAsync(`git ls-remote --heads origin ${branch}`, {
				cwd: this.workDir,
			});
			return stdout.trim().length > 0;
		} catch {
			return false;
		}
	}

	async getPRForBranch(
		branch: string,
	): Promise<{state: 'open' | 'merged' | 'closed'; url: string; number: number} | null> {
		try {
			const raw = await this.gh(
				`pr list --head "${branch}" --state all --json state,url,number --limit 1`,
			);
			if (!raw || raw === '[]') return null;
			const prs = JSON.parse(raw) as Array<{state: string; url: string; number: number}>;
			if (prs.length === 0) return null;
			const pr = prs[0];
			const state = pr.state.toLowerCase() as 'open' | 'merged' | 'closed';
			return {state, url: pr.url, number: pr.number};
		} catch {
			return null;
		}
	}

	async mergePR(number: number): Promise<void> {
		await this.gh(`pr merge ${number} --merge --delete-branch`);
	}

	async listPRsByBranchPrefix(
		prefix: string,
	): Promise<Array<{branch: string; number: number; title: string; state: string; url: string}>> {
		try {
			const raw = await this.gh(
				`pr list --state all --json headRefName,number,title,state,url --limit 100`,
			);
			if (!raw || raw === '[]') return [];
			const prs = JSON.parse(raw) as Array<{
				headRefName: string;
				number: number;
				title: string;
				state: string;
				url: string;
			}>;
			return prs
				.filter((pr) => pr.headRefName.startsWith(prefix))
				.map((pr) => ({
					branch: pr.headRefName,
					number: pr.number,
					title: pr.title,
					state: pr.state.toLowerCase(),
					url: pr.url,
				}));
		} catch {
			return [];
		}
	}

	async getPR(number: number): Promise<{
		branch: string;
		number: number;
		title: string;
		state: string;
		url: string;
		body: string;
	} | null> {
		try {
			const raw = await this.gh(`pr view ${number} --json headRefName,number,title,state,url,body`);
			if (!raw) return null;
			const pr = JSON.parse(raw) as {
				headRefName: string;
				number: number;
				title: string;
				state: string;
				url: string;
				body: string;
			};
			return {
				branch: pr.headRefName,
				number: pr.number,
				title: pr.title,
				state: pr.state.toLowerCase(),
				url: pr.url,
				body: pr.body || '',
			};
		} catch {
			return null;
		}
	}

	/**
	 * List comments on an issue.
	 *
	 * Uses `gh issue view --json comments` and parses the JSON in TypeScript.
	 * For issues with many comments this fetches all of them, but for the
	 * ambiguity-cycle feature (≤3 bot comments) this is acceptable.
	 */
	async listComments(number: number): Promise<Array<{author: string; body: string}>> {
		const raw = await this.gh(`issue view ${number} --json comments`);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as {
			comments: Array<{author: {login: string}; body: string}>;
		};
		if (!parsed.comments || !Array.isArray(parsed.comments)) return [];
		return parsed.comments.map((c) => ({
			author: c.author.login,
			body: c.body,
		}));
	}

	async ensureLabels(labels: string[]): Promise<void> {
		for (const label of labels) {
			try {
				await this.gh(
					`label create "${label}" --force --color 7B68EE --description "whitesmith automation"`,
				);
			} catch {
				// Label might already exist
			}
		}
	}

	// ─── CI Installation ────────────────────────────────────────────────

	async installCI(options: InstallCIOptions): Promise<void> {
		const repo = this.repo || this.detectRepo();
		const ghAvailable = this.ghIsAvailable();

		await installGitHubCI(
			{
				workDir: this.workDir,
				repo,
				ghAvailable,
				setSecret: async (name: string, value: string) => {
					const targetRepo = this.repo || repo;
					if (!targetRepo) throw new Error('No repo configured');
					execSync(`gh secret set ${name} --repo "${targetRepo}"`, {
						input: value,
						stdio: ['pipe', 'pipe', 'pipe'],
					});
				},
			},
			options,
		);
	}

	private detectRepo(): string | undefined {
		try {
			const url = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
				cwd: this.workDir,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
				.toString()
				.trim();
			return url || undefined;
		} catch {
			return undefined;
		}
	}

	private ghIsAvailable(): boolean {
		try {
			execSync('gh auth status', {stdio: ['pipe', 'pipe', 'pipe']});
			return true;
		} catch {
			return false;
		}
	}
}
