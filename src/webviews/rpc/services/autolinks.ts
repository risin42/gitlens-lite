/**
 * Autolinks service — shared commit autolink operations for webviews.
 *
 * Parses autolinks locally and returns serialized links and linkified commit messages.
 *
 * Message formatting produces linkified markdown. Callers that need a headline
 * splitter token (e.g., Commit Details) pass it via `headlineSplitterToken`
 * so it's inserted into the plain-text message *before* linkification.
 * This is critical because post-processing linkified output with plain-text
 * assumptions (e.g., splitting on first `\n`) produces broken markup.
 */

import type { GitCommit } from '@gitlens/git/models/commit.js';
import type { GitRemote } from '@gitlens/git/models/remote.js';
import { map } from '@gitlens/utils/iterable.js';
import { encodeHtmlWeak } from '@gitlens/utils/string.js';
import type { Autolink } from '../../../autolinks/models/autolinks.js';
import { serializeAutolink } from '../../../autolinks/utils/-webview/autolinks.utils.js';
import type { Container } from '../../../container.js';
import { CommitFormatter } from '../../../git/formatters/commitFormatter.js';

// ============================================================
// Result Types
// ============================================================

/** Result of basic autolink parsing. */
export interface CommitAutolinksResult {
	autolinks: Autolink[];
	formattedMessage: string;
}

// ============================================================
// Service
// ============================================================

export class AutolinksService {
	constructor(private readonly container: Container) {}

	private async getCommit(repoPath: string, sha: string, isStash?: boolean): Promise<GitCommit | undefined> {
		const svc = this.container.git.getRepositoryService(repoPath);
		if (isStash) {
			const stash = await svc.stash?.getStash();
			const commit = stash?.stashes.get(sha);
			if (commit != null) return commit;
		}
		return svc.commits.getCommit(sha);
	}

	/**
	 * Get basic autolinks parsed from a commit message.
	 * Resolves remote for URL patterns; does NOT call enrichment APIs.
	 * Returns parsed autolinks and the commit message linkified as markdown.
	 *
	 * @param headlineSplitterToken — If provided, inserted at the first newline in the
	 *   plain-text message *before* linkification so callers can split headline from body.
	 */
	async getCommitAutolinks(
		repoPath: string,
		sha: string,
		headlineSplitterToken?: string,
		isStash?: boolean,
		signal?: AbortSignal,
	): Promise<CommitAutolinksResult | undefined> {
		signal?.throwIfAborted();
		const commit = await this.getCommit(repoPath, sha, isStash);
		signal?.throwIfAborted();
		if (commit == null) return undefined;

		const remote = await this.container.git
			.getRepositoryService(commit.repoPath)
			.remotes.getBestRemoteWithProvider();
		signal?.throwIfAborted();

		const autolinks =
			commit.message != null ? await this.container.autolinks.getAutolinks(commit.message, remote) : undefined;
		signal?.throwIfAborted();

		return {
			autolinks: autolinks != null ? [...map(autolinks.values(), serializeAutolink)] : [],
			formattedMessage: linkifyMessage(this.container, commit, remote, headlineSplitterToken),
		};
	}

	/**
	 * Get basic autolinks parsed from multiple commits' messages in a single pass.
	 * Fetches each commit's message server-side, aggregates them, and parses autolinks once.
	 * Does NOT produce a formatted/linkified message — returns only the parsed autolinks.
	 */
	async getAutolinksForCommits(repoPath: string, shas: string[], signal?: AbortSignal): Promise<Autolink[]> {
		signal?.throwIfAborted();
		const svc = this.container.git.getRepositoryService(repoPath);
		const commits = await Promise.all(shas.map(sha => svc.commits.getCommit(sha)));
		signal?.throwIfAborted();
		const messages = commits.map(c => c?.message).filter(m => m != null);
		return this.parseAutolinksFromMessages(repoPath, messages);
	}

	/**
	 * Get basic autolinks for a comparison range (`fromSha..toSha`). Enumerates every commit in
	 * the range via `getLog` so autolinks reflect the full range (matches the diff/files), not
	 * just the user's explicit selection — which can be a subset of the range when commits are
	 * picked individually with cmd/ctrl-click rather than as a contiguous range.
	 */
	async getAutolinksForCompareRange(
		repoPath: string,
		fromSha: string,
		toSha: string,
		signal?: AbortSignal,
	): Promise<Autolink[]> {
		signal?.throwIfAborted();
		const messages = await this.getCompareRangeMessages(repoPath, fromSha, toSha);
		signal?.throwIfAborted();
		return this.parseAutolinksFromMessages(repoPath, messages);
	}

	private async getCompareRangeMessages(repoPath: string, fromSha: string, toSha: string): Promise<string[]> {
		const log = await this.container.git.getRepositoryService(repoPath).commits.getLog(`${fromSha}..${toSha}`);
		if (log == null) return [];

		const messages: string[] = [];
		for (const commit of log.commits.values()) {
			if (commit.message != null) {
				messages.push(commit.message);
			}
		}
		return messages;
	}

	private async parseAutolinksFromMessages(repoPath: string, messages: string[]): Promise<Autolink[]> {
		if (!messages.length) return [];

		const remote = await this.container.git.getRepositoryService(repoPath).remotes.getBestRemoteWithProvider();
		const autolinks = await this.container.autolinks.getAutolinks(messages.join('\n'), remote);
		return [...map(autolinks.values(), serializeAutolink)];
	}
}

// ============================================================
// Helpers
// ============================================================

/**
 * Linkify a commit message with autolink patterns as markdown.
 * If `headlineSplitterToken` is provided, it replaces the first newline in the
 * plain-text message before linkification so the token survives markdown processing.
 */
function linkifyMessage(
	container: Container,
	commit: GitCommit,
	remote: GitRemote | undefined,
	headlineSplitterToken?: string,
): string {
	let message = CommitFormatter.fromTemplate(`\${message}`, commit);
	// Encode HTML entities for safety before markdown linkification — prevents raw HTML
	// in commit messages from being rendered (e.g. <script>, <span onclick>).
	// The marked library won't double-encode existing entities.
	message = encodeHtmlWeak(message);
	if (headlineSplitterToken != null) {
		const index = message.indexOf('\n');
		if (index !== -1) {
			message = `${message.substring(0, index)}${headlineSplitterToken}${message.substring(index + 1)}`;
		}
	}
	return container.autolinks.linkify(message, 'markdown', remote != null ? [remote] : undefined);
}
