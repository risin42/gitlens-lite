/** Cached local commit metadata shared by Inspect views. */
import type { CommitDetails } from '../../../commitDetails/protocol.js';
import type { CommitAvatarsShape } from '../../../rpc/services/types.js';

/**
 * Carries the enriched fields — provider avatars and worktree reachability — forward from an already
 * enriched shell for the same sha onto a freshly-fetched core payload. The core payload is deliberately
 * un-enriched (a synchronous cached-or-gravatar avatar, no worktree flag), so without this a revisit
 * would visibly downgrade a commit we'd already enriched while the legs re-run and re-patch it.
 *
 * `knownReachable` wins over the cached value: it's derived from the *current* graph state, whereas the
 * cached flag could predate a worktree moving.
 */
export function withCachedEnrichment(
	commit: CommitDetails,
	cached: CommitDetails | undefined,
	knownReachable?: true,
): CommitDetails {
	// Only merge a shell for the SAME commit: a cancelled fetch leaves the resource holding the PRIOR
	// selection's payload (`cancel()` clears `loading` but not `value`), so without this a stale payload
	// could be grafted with another commit's avatars.
	if (cached != null && (cached.sha !== commit.sha || cached.repoPath !== commit.repoPath)) {
		cached = undefined;
	}

	const reachable = knownReachable ?? cached?.reachableFromOtherWorktrees;
	const authorAvatar = cached?.author.avatar ?? commit.author.avatar;
	const committerAvatar = cached?.committer.avatar ?? commit.committer.avatar;

	if (
		reachable === commit.reachableFromOtherWorktrees &&
		authorAvatar === commit.author.avatar &&
		committerAvatar === commit.committer.avatar
	) {
		return commit;
	}

	return {
		...commit,
		author: { ...commit.author, avatar: authorAvatar },
		committer: { ...commit.committer, avatar: committerAvatar },
		reachableFromOtherWorktrees: reachable,
	};
}

/**
 * Merges resolved avatars into a commit. Returns the SAME object when nothing changed — without a
 * provider avatar the deferred value usually equals the synchronous one, and a needless write re-renders
 * the panel for nothing. Spreading preserves the `files` array identity, so the file tree never rebuilds.
 */
export function applyAvatars(commit: CommitDetails, avatars: CommitAvatarsShape): CommitDetails {
	const author = avatars.author ?? commit.author.avatar;
	const committer = avatars.committer ?? commit.committer.avatar;
	if (author === commit.author.avatar && committer === commit.committer.avatar) return commit;

	return {
		...commit,
		author: { ...commit.author, avatar: author },
		committer: { ...commit.committer, avatar: committer },
	};
}

/**
 * Merges the worktree-reachability flag into a commit. The core payload omits the field, so `undefined`
 * already means `false` — treat them as equal, or the common `false` result patches (and re-renders) on
 * every single selection.
 */
export function applyReachableFromOtherWorktrees(commit: CommitDetails, reachable: boolean): CommitDetails {
	if ((commit.reachableFromOtherWorktrees ?? false) === reachable) return commit;

	return { ...commit, reachableFromOtherWorktrees: reachable };
}
