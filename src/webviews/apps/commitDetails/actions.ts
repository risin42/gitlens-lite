/**
 * Actions for the Commit Details webview.
 *
 * Actions are methods that:
 * 1. Update local state (via signals)
 * 2. Make RPC calls to the backend
 *
 * Patterns used:
 * - Resources: commit and reachability resources handle asynchronous data
 *   fetch/cancel/staleness (replaces CancellableRequest + manual loading)
 * - Auto-persistence: persisted signals are auto-saved via `startAutoPersist()`
 *   (replaces manual `persistState()` / `getHostApi().setState()`)
 * - State bridging: after resource fetch, actions writes results to state signals
 *   so derived signals (isUncommitted) and events can read them
 *
 * The CommitDetailsActions class requires resolved sub-services, state, and
 * resources in the constructor (resolve-once pattern), which enables:
 * - Easier unit testing (mock services, state, and resources can be injected)
 * - Clear lifecycle management (no module-level state)
 * - Single await per sub-service at startup, then direct calls
 */
import type { Remote } from '@eamodio/supertalk';
import type { GitFileChangeShape } from '@gitlens/git/models/fileChange.js';
import type { RemoteResourceType } from '@gitlens/git/models/remoteResource.js';
import type { GitCommitReachability } from '@gitlens/git/providers/commits.js';
import { isUncommitted } from '@gitlens/git/utils/revision.utils.js';
import { Logger } from '@gitlens/utils/logger.js';
import { LruMap } from '@gitlens/utils/lruMap.js';
import { getSettledValue } from '@gitlens/utils/promise.js';
import type { Autolink } from '../../../autolinks/models/autolinks.js';
import type { ViewFilesLayout } from '../../../config.js';
import type { GlExtensionCommands } from '../../../constants.commands.js';
import type { CommitDetailsServices, InitialContext } from '../../commitDetails/commitDetailsService.js';
import type { CommitDetails, CommitSignatureShape, FileShowOptions } from '../../commitDetails/protocol.js';
import { defaultViewFilesConfig, messageHeadlineSplitterToken } from '../../commitDetails/protocol.js';
import { applyReachableFromOtherWorktrees, withCachedEnrichment } from '../shared/actions/commitEnrichment.js';
import type { OpenMultipleChangesArgs } from '../shared/actions/file.js';
import * as fileActions from '../shared/actions/file.js';
import {
	enrichmentGuard,
	fireAndForget,
	fireRpc,
	guardedEnrich,
	isConnectionClosedError,
	noop,
	noopUnlessReal,
	notifyService,
	optimisticFireAndForget,
} from '../shared/actions/rpc.js';
import { NavigationStack } from '../shared/controllers/navigationStack.js';
import type { Resource } from '../shared/state/resource.js';
import type { CommitDetailsState } from './state.js';

// ============================================================
// Resolved Services Type (resolve-once pattern)
// ============================================================

/**
 * Helper type: resolves a sub-service from Remote<CommitDetailsServices>.
 * After `const git = await services.git`, the type is `ResolvedSubService<'git'>`.
 */
type ResolvedSubService<K extends keyof CommitDetailsServices> = Awaited<Remote<CommitDetailsServices>[K]>;

/**
 * Resolved sub-services passed to CommitDetailsActions.
 * Each sub-service is resolved once at startup via `await services.inspect`, etc.
 */
export interface ResolvedServices {
	readonly inspect: ResolvedSubService<'inspect'>;
	readonly repositories: ResolvedSubService<'repositories'>;
	readonly repository: ResolvedSubService<'repository'>;
	readonly commands: ResolvedSubService<'commands'>;
	readonly config: ResolvedSubService<'config'>;
	readonly storage: ResolvedSubService<'storage'>;
	readonly autolinks: ResolvedSubService<'autolinks'>;
	readonly files: ResolvedSubService<'files'>;
}

/**
 * Resources bag for Commit Details — created in commitDetails.ts, passed to actions.
 */
export interface CommitDetailsResources {
	readonly commit: Resource<CommitDetails | undefined, [string, string]>;
	readonly reachability: Resource<GitCommitReachability | undefined>;
}

interface FetchCommitOptions {
	force?: boolean;
}

/** Per-SHA aggregate of resolved enrichment values:
 *  `hasPullRequest` / `hasSignature` are sentinels because `undefined` is a valid resolved
 *  value (commit not signed, no PR), distinguishing "not fetched yet" from "fetched and got nothing". */
interface CommitEnrichmentCacheEntry {
	commit?: CommitDetails;
	autolinks?: Autolink[];
	formattedMessage?: string;
	signature?: CommitSignatureShape | undefined;
	hasSignature?: boolean;
}

const commitEnrichmentCacheLimit = 32;

// ============================================================
// CommitDetailsActions Class
// ============================================================

/**
 * Actions class for the Commit Details webview.
 *
 * This class encapsulates all user actions and RPC calls.
 * It requires resolved sub-services, instance-owned state, and resources
 * to be injected via the constructor.
 */
export class CommitDetailsActions {
	private _navigating = false;

	/** Aborts when a new commit selection arrives — propagates to host-side enrichment RPCs
	 *  via `signal?.throwIfAborted()` so abandoned work stops at the next checkpoint instead
	 *  of running to completion + shipping a dead-letter response over the channel. */
	private _enrichmentController?: AbortController;

	/** SHA-keyed cache of commit shell + chip enrichment. Hydrated synchronously on revisit so
	 *  chips are visible from t≈0ms instead of flashing through cleared state. Same shape as the
	 *  local commit cache. Populated as fetches resolve via the sink in `fetchCommit`. */
	private readonly _commitEnrichmentCache = new LruMap<string, CommitEnrichmentCacheEntry>(
		commitEnrichmentCacheLimit,
	);

	/** Shared back/forward history of visited commits. The
	 *  onChange callback mirrors derived state into the `navigationStack` signal; recording happens
	 *  in {@link fetchCommit}. Survives hide/show because the webview is `retainContextWhenHidden`. */
	private readonly _nav = new NavigationStack<{ sha: string; repoPath: string }>(10, undefined, s =>
		this.state.navigationStack.set(s),
	);

	constructor(
		private readonly state: CommitDetailsState,
		private readonly services: ResolvedServices,
		private readonly resources: CommitDetailsResources,
	) {}

	private resetEnrichment(): AbortSignal {
		this._enrichmentController?.abort();
		const controller = new AbortController();
		this._enrichmentController = controller;
		return controller.signal;
	}

	/**
	 * Cancel all in-flight resource requests.
	 *
	 * Called when the webview becomes hidden (`visibilitychange`) to prevent
	 * hanging promises — VS Code silently drops host→webview `postMessage`
	 * while hidden, so RPC responses would never arrive.
	 *
	 * Safe because:
	 * - Resources handle abort internally via `AbortController`
	 * - Host-side cooperative cancellation fires via `AbortSignal`
	 * - Visibility restore re-fetches via event replays and `visibilitychange`
	 */
	cancelPendingRequests(): void {
		this.resources.commit.cancel();
		this.resources.reachability.cancel();
	}

	// ============================================================
	// Navigation Actions
	// ============================================================

	/** Navigate back to the previously-viewed commit (shared frontend history). */
	async navigateBack(): Promise<void> {
		if (this._navigating || !this.state.canNavigateBack.get()) return;

		const target = this._nav.back();
		if (target == null) return;

		this._navigating = true;
		try {
			this.state.searchContext.set(undefined);
			await this.fetchCommit(target.repoPath, target.sha, { force: true });
		} catch (ex) {
			if (isConnectionClosedError(ex)) {
				Logger.debug('navigate back dropped by deliberate connection teardown');
			} else {
				Logger.error(ex, 'navigate back failed');
			}
		} finally {
			this._navigating = false;
		}
	}

	/** Navigate forward to the next commit in the shared frontend history. */
	async navigateForward(): Promise<void> {
		if (this._navigating || !this.state.canNavigateForward.get()) return;

		const target = this._nav.forward();
		if (target == null) return;

		this._navigating = true;
		try {
			this.state.searchContext.set(undefined);
			await this.fetchCommit(target.repoPath, target.sha, { force: true });
		} catch (ex) {
			if (isConnectionClosedError(ex)) {
				Logger.debug('navigate forward dropped by deliberate connection teardown');
			} else {
				Logger.error(ex, 'navigate forward failed');
			}
		} finally {
			this._navigating = false;
		}
	}

	async refetchCurrentCommit(): Promise<void> {
		const current = this.state.currentCommit.get();
		if (current == null) return;

		await this.fetchCommit(current.repoPath, current.sha, { force: true });
	}

	/**
	 * Toggle the pinned state.
	 * Uses optimistic update with rollback on error.
	 * Auto-persisted via `startAutoPersist()` — no manual `persistState()`.
	 */
	togglePin(): void {
		const newPinned = !this.state.pinned.get();
		optimisticFireAndForget(this.state.pinned, newPinned, this.services.inspect.setPin(newPinned), 'toggle pin');
	}

	/**
	 * Open commit picker to select a different commit.
	 */
	pickCommit(): void {
		fireAndForget(this.services.inspect.pickCommit(), 'pick commit');
	}

	/**
	 * Open commit search dialog.
	 */
	searchCommit(): void {
		fireAndForget(this.services.inspect.searchCommit(), 'search commit');
	}

	// ============================================================
	// Preferences Actions
	// ============================================================

	/**
	 * Update a preference value via direct config/workspace storage calls.
	 * Uses optimistic update with rollback on error.
	 */
	updateShowSearchBox(value: boolean): void {
		const currentPrefs = this.state.preferences.get();
		if (currentPrefs == null) {
			fireRpc(
				this.state.error,
				this.services.storage.updateWorkspace('views:commitDetails:showSearchBox', value),
				'update showSearchBox',
			);
			return;
		}

		optimisticFireAndForget(
			this.state.preferences,
			{ ...currentPrefs, showSearchBox: value },
			this.services.storage.updateWorkspace('views:commitDetails:showSearchBox', value),
			'update showSearchBox',
		);
	}

	updateSearchBoxFilter(value: boolean): void {
		const currentPrefs = this.state.preferences.get();
		if (currentPrefs == null) {
			fireRpc(
				this.state.error,
				this.services.storage.updateWorkspace('views:commitDetails:searchBoxFilter', value),
				'update searchBoxFilter',
			);
			return;
		}

		optimisticFireAndForget(
			this.state.preferences,
			{ ...currentPrefs, searchBoxFilter: value },
			this.services.storage.updateWorkspace('views:commitDetails:searchBoxFilter', value),
			'update searchBoxFilter',
		);
	}

	// ============================================================
	// File Actions
	// ============================================================

	/**
	 * Get the current commit's ref + whether it's a stash for file actions. Returns undefined for
	 * uncommitted shas so callers fall through the `ref == null` branches (uncommitted path). The
	 * `stash` flag lets `FilesService` route stash refs through the stash sub-provider (which
	 * has untracked files in its fileset) instead of `commits.getCommit` (which doesn't).
	 */
	private getCurrentRef(): { ref: string; stash?: boolean } | undefined {
		const commit = this.state.currentCommit.get();
		if (commit?.sha == null || isUncommitted(commit.sha)) return undefined;
		return { ref: commit.sha, stash: commit.stashNumber != null };
	}

	openFile(file: GitFileChangeShape, showOptions?: FileShowOptions): void {
		fileActions.openFile(this.services.files, file, showOptions, this.getCurrentRef());
	}

	openFileOnRemote(file: GitFileChangeShape): void {
		fileActions.openFileOnRemote(this.services.files, file, this.getCurrentRef());
	}

	openFileCompareWorking(file: GitFileChangeShape, showOptions?: FileShowOptions): void {
		fileActions.openFileCompareWorking(this.services.files, file, showOptions, this.getCurrentRef());
	}

	openFileComparePrevious(file: GitFileChangeShape, showOptions?: FileShowOptions): void {
		fileActions.openFileComparePrevious(this.services.files, file, showOptions, this.getCurrentRef());
	}

	openFileCompareWipChanges(file: GitFileChangeShape, showOptions?: FileShowOptions): void {
		fileActions.openFileCompareWipChanges(this.services.files, file, showOptions);
	}

	executeFileAction(file: GitFileChangeShape, showOptions?: FileShowOptions): void {
		fileActions.executeFileAction(this.services.files, file, showOptions, this.getCurrentRef());
	}

	openMultipleChanges(args: OpenMultipleChangesArgs): void {
		fileActions.openMultipleChanges(this.services.files, args);
	}

	/**
	 * Copy a commit's (or stash's) full diff to the system clipboard.
	 * `to` is the commit sha, `from` the parent (undefined for a root commit).
	 */
	copyCommitPatchToClipboard(repoPath: string, to: string, from?: string): void {
		fireAndForget(this.services.inspect.copyCommitPatchToClipboard(repoPath, to, from), 'copy commit patch');
	}

	// ============================================================
	// Commit Actions
	// ============================================================

	/**
	 * Execute a commit action (copy SHA or open a local action menu).
	 */
	executeCommitAction(action: 'more' | 'scm' | 'sha', alt?: boolean): void {
		const commit = this.state.currentCommit.get();
		if (!commit) return;

		fireAndForget(
			this.services.inspect.executeCommitAction(commit.repoPath, commit.sha, action, alt),
			`commit action: ${action}`,
		);
	}

	/**
	 * Execute a non-webview GitLens command.
	 */
	executeCommand(command: GlExtensionCommands, ...args: unknown[]): void {
		notifyService(this.services.commands, `command: ${command}`, svc => svc.execute(command, ...args));
	}

	openOnRemote(repoPath: string | undefined, sha: string): void {
		if (!repoPath || isUncommitted(sha)) return;

		notifyService(this.services.commands, 'command: gitlens.openOnRemote', svc =>
			svc.execute('gitlens.openOnRemote', {
				repoPath: repoPath,
				resource: { type: 'commit' satisfies `${RemoteResourceType.Commit}`, sha: sha },
			}),
		);
	}

	changeFilesLayout(layout: ViewFilesLayout): void {
		const prefs = this.state.preferences.get();
		if (!prefs?.files) return;

		const files = { ...prefs.files, layout: layout };
		this.state.preferences.set({ ...prefs, files: files });
		void this.services.config.update('views.commitDetails.files.layout', layout);
	}

	// ============================================================
	// Reachability Actions (via resource)
	// ============================================================

	/**
	 * Load commit reachability data (branches/tags containing the commit).
	 * Resource handles cancel-previous and loading state.
	 */
	async loadReachability(): Promise<void> {
		if (this.resources.reachability.loading.get()) return;

		const commit = this.state.currentCommit.get();
		if (commit == null) return;

		await this.resources.reachability.fetch();
	}

	/**
	 * Clear reachability data without re-fetching (e.g., on repo changes that
	 * invalidate branches/tags).
	 */
	clearReachability(): void {
		this.resources.reachability.cancel();
		this.resources.reachability.mutate(undefined);
	}

	/**
	 * Refresh commit reachability data.
	 */
	refreshReachability(): void {
		this.resources.reachability.mutate(undefined);
		void this.loadReachability();
	}

	// ============================================================
	// Data Fetching Actions
	// ============================================================

	/**
	 * Fetch all initial state for the webview.
	 * Persisted pinned/commitRef are already restored by `createStateGroup` —
	 * no manual `getHostApi().getState()` needed.
	 */
	async fetchInitialState(): Promise<void> {
		this.state.loading.set(true);
		this.state.error.set(undefined);

		// Persisted signals already contain restored values from previous session
		const persistedPinned = this.state.pinned.get();
		const persistedCommitRef = this.state.commitRef.get();

		try {
			// Get initial context (pinned, initial commit info)
			const context: InitialContext = await this.services.inspect.getInitialContext();

			this.state.pinned.set(persistedPinned || context.pinned);

			// Fire config calls as fire-and-forget — each sets its signal on resolve.
			// These don't gate domain data; signals have safe defaults until they arrive.
			void this.fetchPreferences();
			void this.services.config
				.get('views.commitDetails.autolinks.enabled')
				.then(a => (this.state.capabilities.autolinksEnabled = a), noop);
			// Fetch the initial commit — the only thing worth blocking on.
			// Use persisted commitRef as fallback when host has no initial commit.
			const initialCommit = context.initialCommit ?? persistedCommitRef;
			if (initialCommit != null) {
				await this.fetchCommit(initialCommit.repoPath, initialCommit.sha);
			}
		} catch (ex) {
			if (isConnectionClosedError(ex)) {
				Logger.debug('Initial state fetch dropped by deliberate connection teardown');
			} else {
				Logger.error(ex, 'Failed to fetch initial state');
			}
			this.state.error.set(ex instanceof Error ? ex.message : 'Failed to initialize');
		} finally {
			this.state.loading.set(false);
		}
	}

	/**
	 * Fetch commit details from the backend.
	 * Resource handles cancel-previous and loading state. After fetch,
	 * the result is written to state signals for derived signals and events.
	 * Autolinks and enriched data are fire-and-forget.
	 */
	async fetchCommit(repoPath: string, sha: string, options?: FetchCommitOptions): Promise<void> {
		const current = this.state.currentCommit.get();
		if (!options?.force && current?.repoPath === repoPath && current?.sha === sha) {
			// Already showing this commit — cancel any in-flight request
			this.resources.commit.cancel();
			return;
		}

		// Record genuinely-new selections into back/forward history. Skips same-commit refetches and
		// navigation itself (navigateBack/Forward drive fetchCommit with `_navigating` set).
		if ((current?.sha !== sha || current?.repoPath !== repoPath) && !this._navigating) {
			this._nav.record({ sha: sha, repoPath: repoPath });
		}

		this.state.error.set(undefined);
		this.resources.reachability.cancel();

		// Abort any prior in-flight enrichment so a slow autolinks / PR / signature lookup from
		// the previous selection can't overwrite the new selection's state. Host-side methods
		// honor the signal via `signal?.throwIfAborted()` so abandoned work stops at the next
		// checkpoint instead of running to completion.
		const enrichSignal = this.resetEnrichment();

		// Hydrate from cache synchronously when we've previously seen this SHA. Skipping the
		// flash-out → flash-in cycle on revisit: chips are visible from t≈0ms instead of after
		// the gating commit.fetch + 30-60ms enrichment fan-out completes. Cache miss falls back
		// to the existing eager-clear so prior-selection chips don't linger over the new commit's
		// metadata once it lands.
		const cacheKey = `${sha}:${repoPath}`;
		const cached = this._commitEnrichmentCache.get(cacheKey);
		if (cached != null) {
			if (cached.commit != null) {
				this.state.currentCommit.set(cached.commit);
				this.state.commitRef.set({ sha: cached.commit.sha, repoPath: cached.commit.repoPath });
			}
			this.state.autolinks.set(cached.autolinks);
			this.state.formattedMessage.set(cached.formattedMessage);
			this.state.signature.set(cached.hasSignature ? cached.signature : undefined);
		} else {
			this.state.autolinks.set(undefined);
			this.state.formattedMessage.set(undefined);
			this.state.signature.set(undefined);
		}

		await this.resources.commit.fetch(repoPath, sha);

		// Write result to state for derived signals and events
		if (this.resources.commit.status.get() === 'success') {
			const fetched = this.resources.commit.value.get();
			// The core payload is un-enriched by design, so carry the already-resolved avatars + worktree
			// reachability forward from the cached shell — otherwise a revisit visibly downgrades them
			// (gravatar avatar, no "(Worktree)" file actions) for as long as the legs take to re-resolve.
			const commit = fetched != null ? withCachedEnrichment(fetched, cached?.commit) : fetched;
			this.state.currentCommit.set(commit);
			this.state.commitRef.set(commit ? { sha: commit.sha, repoPath: commit.repoPath } : undefined);

			if (commit != null) {
				// Cache the freshly-fetched commit shell so future revisits hydrate instantly.
				this._commitEnrichmentCache.update(cacheKey, { commit: commit });

				guardedEnrich(
					this.resources.commit,
					enrichSignal,
					() =>
						this.services.autolinks.getCommitAutolinks(
							repoPath,
							sha,
							messageHeadlineSplitterToken,
							commit.stashNumber != null,
							enrichSignal,
						),
					result => {
						if (result == null) return;

						this._commitEnrichmentCache.update(cacheKey, result);
						this.state.autolinks.set(result.autolinks);
						this.state.formattedMessage.set(result.formattedMessage);
					},
					{ skipIf: () => !this.state.capabilities.autolinksEnabled },
				);

				guardedEnrich(
					this.resources.commit,
					enrichSignal,
					() => this.services.repository.getCommitSignature(repoPath, sha, enrichSignal),
					signature => {
						this._commitEnrichmentCache.update(cacheKey, { signature: signature, hasSignature: true });
						this.state.signature.set(signature);
					},
				);

				guardedEnrich(
					this.resources.commit,
					enrichSignal,
					() => this.services.repository.getReachableFromOtherWorktrees(repoPath, sha, enrichSignal),
					reachable =>
						this.patchCommit(cacheKey, sha, repoPath, c => applyReachableFromOtherWorktrees(c, reachable)),
					{ skipIf: () => commit.stashNumber != null || isUncommitted(sha) },
				);

				// Check if repo has remotes (for "Open on Remote" action) — not enrichment, but
				// shares the generation-guard pattern.
				void this.services.repository.hasRemotes(repoPath).then(
					enrichmentGuard(this.resources.commit, has => {
						if (enrichSignal.aborted) return;

						this.state.hasRemotes.set(has);
					}),
					noopUnlessReal,
				);
			}
		} else if (this.resources.commit.error.get() != null) {
			this.state.error.set(this.resources.commit.error.get());
		}
	}

	/**
	 * Applies a late-arriving enrichment onto the commit already in state (and its cache shell), so every
	 * consumer of `CommitDetails` — header, popover, file contexts — upgrades at once. Returning the same
	 * object from `patch` is a no-op: the identical-value case (the common one) must not write, or it
	 * re-renders for nothing. Spreading preserves the `files` array identity, so the file tree never
	 * rebuilds off an avatar patch.
	 */
	private patchCommit(
		cacheKey: string,
		sha: string,
		repoPath: string,
		patch: (commit: CommitDetails) => CommitDetails,
	): void {
		const current = this.state.currentCommit.get();
		// A newer selection already replaced the commit — drop the stale enrichment.
		if (current == null || current.sha !== sha || current.repoPath !== repoPath) return;

		const next = patch(current);
		if (next === current) return;

		this.state.currentCommit.set(next);
		this._commitEnrichmentCache.update(cacheKey, { commit: next });
	}

	/**
	 * Fetch preferences from the backend via individual config calls.
	 */
	async fetchPreferences(): Promise<void> {
		try {
			const [showSearchBoxResult, searchBoxFilterResult, configResult, coreConfigResult] =
				await Promise.allSettled([
					this.services.storage.getWorkspace('views:commitDetails:showSearchBox'),
					this.services.storage.getWorkspace('views:commitDetails:searchBoxFilter'),
					this.services.config.getMany(
						'views.commitDetails.avatars',
						'defaultCurrentUserNameStyle',
						'defaultDateFormat',
						'defaultDateStyle',
						'views.commitDetails.files',
						'signing.showSignatureBadges',
						'views.commitDetails.autolinks.enabled',
						'sortWorkingChangesBy',
					),
					this.services.config.getManyCore(
						'workbench.tree.renderIndentGuides',
						'workbench.tree.indent',
						'git.enableSmartCommit',
						'scm.defaultViewSortKey',
					),
				]);

			const showSearchBox = getSettledValue(showSearchBoxResult);
			const searchBoxFilter = getSettledValue(searchBoxFilterResult);
			const [
				avatars,
				currentUserNameStyle,
				dateFormat,
				dateStyle,
				files,
				showSignatureBadges,
				autolinksEnabled,
				workingChangesSortBy,
			] = getSettledValue(configResult) ?? [];
			const [indentGuides, indent, enableSmartCommit, workingFilesOrderBy] =
				getSettledValue(coreConfigResult) ?? [];
			this.state.preferences.set({
				currentUserNameStyle: currentUserNameStyle ?? 'you',
				avatars: avatars ?? true,
				dateFormat: dateFormat ?? 'MMMM Do, YYYY h:mma',
				dateStyle: dateStyle ?? 'relative',
				files: files ?? this.state.preferences.get()?.files ?? defaultViewFilesConfig,
				indentGuides: indentGuides ?? 'onHover',
				indent: indent,
				workingFilesOrderBy: workingFilesOrderBy ?? 'path',
				workingChangesSortBy: workingChangesSortBy ?? 'stage',
				enableSmartCommit: enableSmartCommit ?? false,
				showSignatureBadges: showSignatureBadges ?? false,
				showSearchBox: showSearchBox ?? true,
				searchBoxFilter: searchBoxFilter ?? true,
			});
			if (autolinksEnabled != null) {
				this.state.capabilities.autolinksEnabled = autolinksEnabled;
			}
		} catch (ex) {
			if (isConnectionClosedError(ex)) {
				Logger.debug('Preferences fetch dropped by deliberate connection teardown');
				return;
			}

			Logger.error(ex, 'Failed to fetch preferences');
		}
	}
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Create a new CommitDetailsActions instance.
 * This is the preferred way to create actions in production code.
 */
export function createActions(
	state: CommitDetailsState,
	services: ResolvedServices,
	resources: CommitDetailsResources,
): CommitDetailsActions {
	return new CommitDetailsActions(state, services, resources);
}
