/**
 * Shared types that cross the RPC boundary.
 *
 * These are serializable data shapes used by multiple service interfaces.
 * Keep this file to pure type definitions — no runtime code.
 */

import type { GitTrackingUpstream } from '@gitlens/git/models/branch.js';
import type { GitDiffFileStats } from '@gitlens/git/models/diff.js';
import type { GitFileChangeShape, GitFileChangeStats } from '@gitlens/git/models/fileChange.js';
import type { GitPausedOperationStatus } from '@gitlens/git/models/pausedOperationStatus.js';
import type { RepositoryChange } from '@gitlens/git/models/repository.js';

// Re-export for webview-side consumers (avoids deep `../../../../git/` imports)
export type { RepositoryChange } from '@gitlens/git/models/repository.js';

// ============================================================
// File Show Options
// ============================================================

/**
 * Portable file-show options that cross the RPC boundary.
 * Mirrors the subset of VS Code's `TextDocumentShowOptions` used by webviews.
 */
export interface FileShowOptions {
	readonly viewColumn?: number;
	readonly preserveFocus?: boolean;
	readonly preview?: boolean;
}

/**
 * Arguments for opening a file set in VS Code's native multi-diff editor.
 *
 * `rhs === ''` means the right side is the working tree. The host forces multi-diff
 * regardless of the `views.openChangesInMultiDiffEditor` setting.
 *
 * `wip: true` forces per-file HEAD↔index↔working semantics regardless of `lhs`/`rhs`.
 * Use when the user is acting on their working tree directly (e.g. WIP details panel,
 * compare-mode scoped to the WIP pseudo-commit). Default (false/undefined) means the
 * standard `lhs → rhs` per-file diff; with `rhs === ''` the right side resolves to
 * the working tree (S&C-style cumulative diff against `lhs`).
 */
export interface OpenMultipleChangesArgs {
	readonly files: readonly GitFileChangeShape[];
	readonly repoPath: string;
	readonly lhs: string;
	readonly rhs: string;
	readonly wip?: boolean;
	readonly title?: string;
}

// ============================================================
// Serialized Types
// ============================================================

/**
 * Serialized repository info for RPC.
 */
export interface SerializedRepository {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly uri: string;
	readonly closed: boolean;
	readonly starred: boolean;
}

/**
 * Repository change event data.
 *
 * `changes` contains numeric values matching the `RepositoryChange` const enum.
 * Use the `repositoryChange` constants below for comparisons in webview code
 * (which can't import the enum from `repository.ts` without pulling in `vscode`).
 */
export interface RepositoryChangeEventData {
	readonly repoPath: string;
	readonly repoUri: string;
	readonly changes: RepositoryChange[];
}

/**
 * Commit selected event data (from EventBus).
 */
export interface CommitSelectedEventData {
	readonly repoPath: string;
	readonly sha: string;
	readonly interaction: 'active' | 'passive';
	readonly preserveFocus?: boolean;
}

/**
 * Aggregate repositories state for webviews.
 */
export interface RepositoriesState {
	readonly count: number;
	readonly openCount: number;
	readonly hasUnsafe: boolean;
	readonly trusted: boolean;
}

// ============================================================
// Commit Signature DTO
// ============================================================

/**
 * Serialized commit signature for RPC.
 * Used by repository service and commit details views.
 */
export interface CommitSignatureShape {
	status: 'good' | 'bad' | 'unknown' | 'expired' | 'revoked' | 'error';
	format?: 'gpg' | 'ssh' | 'x509' | 'openpgp';
	signer?: string;
	keyId?: string;
	fingerprint?: string;
	trustLevel?: 'ultimate' | 'full' | 'marginal' | 'never' | 'unknown';
	errorMessage?: string;
}

/**
 * Provider-resolved avatars for a commit, as serialized URI strings. Fetched off the critical path —
 * the core commit payload carries a synchronous cached-or-gravatar avatar, and this upgrades it.
 * `committer` is only set when the committer differs from the author.
 */
export interface CommitAvatarsShape {
	author?: string;
	committer?: string;
}

// ============================================================
// Git Model DTOs (serialized shapes for base RPC methods)
// ============================================================

/**
 * Serialized identity — Date becomes a timestamp over RPC.
 */
export interface SerializedGitIdentity {
	readonly name: string;
	readonly email: string | undefined;
	readonly date: number;
}

/**
 * Serialized commit for base RPC methods.
 *
 * View-specific services (e.g. CommitDetailsGitService) override the
 * base method with their own return type; this DTO types the default
 * implementation so the base class is not `unknown`.
 */
export interface SerializedGitCommit {
	readonly sha: string;
	readonly shortSha: string;
	readonly repoPath: string;
	readonly author: SerializedGitIdentity;
	readonly committer: SerializedGitIdentity;
	readonly parents: string[];
	readonly message: string | undefined;
	readonly summary: string;
	readonly stashNumber: string | undefined;
	readonly stashOnRef: string | undefined;
	readonly refType: 'revision' | 'stash';
}

/**
 * Serialized branch for base RPC methods.
 */
export interface SerializedGitBranch {
	readonly repoPath: string;
	readonly id: string;
	readonly name: string;
	readonly refName: string;
	readonly remote: boolean;
	readonly current: boolean;
	readonly date: number | undefined;
	readonly sha: string | undefined;
	readonly upstream: GitTrackingUpstream | undefined;
	readonly detached: boolean;
	readonly rebasing: boolean;
	readonly worktree: { readonly path: string; readonly isDefault: boolean } | false | undefined;
}

/**
 * Serialized file change — extends `GitFileChangeShape` with extra
 * data properties available on `GitFileChange` instances.
 */
export interface SerializedGitFileChange extends GitFileChangeShape {
	readonly previousSha?: string;
	readonly stats?: GitFileChangeStats;
}

// ============================================================
// Conflict Details Types
// ============================================================

/** One commit that changed a conflicted file on one side (merge-base → side ref). */
export interface ConflictDetailsCommit {
	readonly sha: string;
	readonly shortSha: string;
	readonly message: string;
	readonly author: string;
	readonly authorEmail?: string;
	readonly avatarUrl?: string;
	/** Committer identity (avatar overlay + hover) — set only when the committer differs from the author. */
	readonly committerAvatarUrl?: string;
	readonly committerName?: string;
	readonly committerEmail?: string;
	/** Committer date as epoch ms — set only when the committer differs from the author. */
	readonly committerDate?: number;
	/** Author date as epoch ms (webview renders via `new Date(date)`). */
	readonly date: number;
}

/** One side (current/incoming) of a conflict: its ref, how to render it, and the commits behind it. */
export interface ConflictDetailsSide {
	readonly ref: string;
	/** Whether the side resolves to a branch (render a branch pill) or a bare commit (sha pill). */
	readonly refKind: 'branch' | 'commit';
	/** Branch name (when `refKind === 'branch'`) or commit sha (when `'commit'`) for the pill. */
	readonly refName: string;
	readonly commits: readonly ConflictDetailsCommit[];
}

/** Per-side history + stage affordances for a conflicted file in the WIP conflict details sheet. */
export interface ConflictDetails {
	readonly path: string;
	readonly status: string;
	/** False when no merge-base is available — per-side commit history can't be computed. */
	readonly hasMergeBase: boolean;
	readonly canStageCurrent: boolean;
	readonly canStageIncoming: boolean;
	readonly current: ConflictDetailsSide;
	readonly incoming: ConflictDetailsSide;
}

// ============================================================
// Working Tree / WIP Types
// ============================================================

/**
 * Lightweight WIP summary — diff stats, conflicts, and paused operation status.
 * Used by Home overview for per-branch WIP display.
 */
export interface WipSummary {
	readonly workingTreeState?: GitDiffFileStats;
	readonly hasConflicts?: boolean;
	readonly conflictsCount?: number;
	readonly pausedOpStatus?: GitPausedOperationStatus;
}

/**
 * Full working tree status — file list + summary.
 * Used by Commit Details for WIP file display and other synthetic commits.
 */
export interface WipStatus {
	readonly branch: string;
	readonly files: SerializedGitFileChange[];
	readonly summary: Omit<WipSummary, 'pausedOpStatus'>;
}

/**
 * WIP file change — extends `GitFileChangeShape` with the unresolved conflict-marker count
 * (when the file is conflicted and the count is known).
 */
export interface WipFileChange extends GitFileChangeShape {
	conflictMarkers?: number;
}

/**
 * WIP change — branch + repository + changed files.
 * Used by Commit Details for WIP display, and by DraftsService for patch creation.
 */
export interface WipChange {
	branchName: string;
	repository: { name: string; path: string; uri: string };
	files: WipFileChange[];
	hasConflicts?: boolean;
	pausedOpStatus?: GitPausedOperationStatus;
	/** A continue/skip is still running. `<op> --continue` blocks for as long as git's commit-message tab
	 *  stays open, so only the host knows when it ends — the bar can't time it. */
	pausedOpContinuing?: boolean;
}

// ============================================================
// Service Host Types
// ============================================================

/**
 * Minimal host interface for RPC services.
 *
 * Services only need a subset of `WebviewHost` — this avoids `WebviewHost<any>`
 * leaking through the RPC service layer.
 */
export interface RpcServiceHost {
	readonly id: string;
	readonly instanceId: string;
}

// ============================================================
// RPC Result Types
// ============================================================

/**
 * Discriminated result type for RPC operations where error semantics matter.
 *
 * Use this instead of throwing when the webview needs to distinguish error
 * reasons. Supertalk only propagates error `message` across the boundary,
 * losing the `.is()` type guard pattern. Result types preserve discriminators.
 *
 * @example
 * ```typescript
 * const result = await service.run();
 * if ('error' in result) {
 *   showError(result.error.message);
 * }
 * ```
 */
export type RpcResult<T, TReason extends string = string> =
	| { value: T; error?: never }
	| { error: { message: string; reason?: TReason }; value?: never };

// ============================================================
// Event Subscription Types
// ============================================================

/**
 * Unsubscribe function returned by event subscriptions.
 */
export type Unsubscribe = (() => void) | Promise<() => void>;

/**
 * Event subscription function signature.
 * Returns an unsubscribe function.
 */
export type RpcEventSubscription<T> = (handler: (data: T) => void) => Unsubscribe;
