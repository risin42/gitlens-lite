/**
 * Signal-based state management for the Commit Details webview.
 *
 * State is instance-owned: the root component creates a `CommitDetailsState` via
 * `createCommitDetailsState()` and passes it to actions/events as a parameter.
 * No module-level singletons.
 *
 * State Categories:
 * 1. Persisted (survive hide/show/refresh) — pinned, commitRef
 * 2. Ephemeral UI — navigationStack
 * 3. Domain Data — currentCommit, preferences, enrichment signals
 * 4. Repository context — remote availability and local metadata
 * 5. Resource-owned (NOT in state) — loading and reachability
 * 6. Derived — computed from above (canNavigateBack, isUncommitted, etc.)
 *
 * Signals removed from state (now resource-owned in commitDetails.ts):
 * - loadingCommit → commitResource.loading
 * - reachabilityState → reachabilityResource.status
 * - reachability → reachabilityResource.value
 */
import { computed } from '@lit-labs/signals';
import { signalObject } from 'signal-utils/object';
import type { GitCommitSearchContext } from '@gitlens/git/models/search.js';
import type { Autolink } from '../../../autolinks/models/autolinks.js';
import type { CommitDetails, CommitSignatureShape, Preferences } from '../../commitDetails/protocol.js';
import type { NavigationState } from '../shared/controllers/navigationStack.js';
import type { HostStorage } from '../shared/host/storage.js';
import { createStateGroup } from '../shared/state/signals.js';

/**
 * Creates a new Commit Details state instance with all signals initialized to defaults.
 * Called by the root component; the returned object is passed to actions/events
 * as a parameter.
 *
 * @param storage - Optional host storage for persisting UI state.
 */
export function createCommitDetailsState(storage?: HostStorage) {
	const { signal, persisted, resetAll, startAutoPersist, dispose } = createStateGroup({
		storage: storage,
		version: 1,
	});

	// ── Infrastructure ──

	const loading = signal(false);
	const error = signal<string | undefined>(undefined);

	// ── Persisted UI State ──

	const pinned = persisted('pinned', false);
	/** Persisted commit reference for reload recovery (replaces manual persistState). */
	const commitRef = persisted<{ sha: string; repoPath: string } | undefined>('commitRef', undefined);

	// ── Ephemeral UI State ──

	const navigationStack = signal<NavigationState>({ count: 0, position: 0, canBack: false, canForward: false });

	// ── Domain Data ──

	/** Current commit details — set by actions after resource fetch. */
	const currentCommit = signal<CommitDetails | undefined>(undefined);
	const searchContext = signal<GitCommitSearchContext | undefined>(undefined);
	const preferences = signal<Preferences | undefined>(undefined);

	const capabilities = signalObject({ autolinksEnabled: false });

	// ── Repository context ──

	const hasRemotes = signal(false);

	// ── Enrichment (fire-and-forget, not resources) ──

	const autolinks = signal<Autolink[] | undefined>(undefined);
	const formattedMessage = signal<string | undefined>(undefined);
	const signature = signal<CommitSignatureShape | undefined>(undefined);

	// ── Derived State ──

	const canNavigateBack = computed(() => navigationStack.get().canBack);

	const canNavigateForward = computed(() => navigationStack.get().canForward);

	const isUncommitted = computed(() => {
		const commit = currentCommit.get();
		return commit?.sha === '0000000000000000000000000000000000000000';
	});

	return {
		// Infrastructure
		loading: loading,
		error: error,

		// Persisted UI State
		pinned: pinned,
		commitRef: commitRef,

		// Ephemeral UI State
		navigationStack: navigationStack,

		// Domain Data
		currentCommit: currentCommit,
		searchContext: searchContext,
		preferences: preferences,
		capabilities: capabilities,

		// Repository context
		hasRemotes: hasRemotes,

		// Enrichment
		autolinks: autolinks,
		formattedMessage: formattedMessage,
		signature: signature,

		// Derived State (read-only)
		canNavigateBack: canNavigateBack,
		canNavigateForward: canNavigateForward,
		isUncommitted: isUncommitted,

		// Lifecycle
		resetAll: resetAll,
		startAutoPersist: startAutoPersist,
		dispose: dispose,
	};
}

/** Commit Details state type — the return value of `createCommitDetailsState()`. */
export type CommitDetailsState = ReturnType<typeof createCommitDetailsState>;
