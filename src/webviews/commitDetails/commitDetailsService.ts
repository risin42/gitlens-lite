/**
 * RPC Service interface for the Commit Details webview.
 *
 * This interface extends SharedWebviewServices with view-specific
 * sub-services for inspect operations and drafts.
 *
 * Architecture:
 * - Backend is stateless - it only provides data and forwards events
 * - Webview owns all state (current commit, pinned, navigation, etc.)
 * - Webview subscribes to events and fetches data via RPC
 *
 * Sub-services are nested objects. On the webview side, resolve each
 * sub-service once (e.g., `const inspect = await services.inspect`) then
 * call methods with a single await.
 *
 * Service Layout:
 * - SharedWebviewServices: repositories, repository, config, storage,
 *   autolinks, commands, and files
 * - inspect: view-specific commit queries, navigation, and commit actions
 */
import type { GitCommitSearchContext } from '@gitlens/git/models/search.js';
import type { AutolinksService } from '../rpc/services/autolinks.js';
import type { CommandsService } from '../rpc/services/commands.js';
import type { ConfigService } from '../rpc/services/config.js';
import type { FilesService } from '../rpc/services/files.js';
import type { RepositoriesService } from '../rpc/services/repositories.js';
import type { RepositoryService } from '../rpc/services/repository.js';
import type { StorageService } from '../rpc/services/storage.js';
import type { Unsubscribe } from '../rpc/services/types.js';
import type { WebviewViewService } from '../rpc/webviewViewService.js';
import type { CommitDetails } from './protocol.js';

// ============================================================
// Event Types (used by subscription callbacks)
// ============================================================

/**
 * Commit selection event - a commit was selected elsewhere.
 * Named "Selection" (not "Selected") to avoid conflict with eventBus.CommitSelectedEvent.
 */
export interface CommitSelectionEvent {
	repoPath: string;
	sha: string;
	/** Optional search context if commit was found via search */
	searchContext?: GitCommitSearchContext;
	/** Whether this is a passive selection (e.g., from line tracker) */
	passive?: boolean;
}

// ============================================================
// Initial Context Types
// ============================================================

/**
 * Minimal context for webview initialization.
 * Contains only what's needed to know what data to fetch.
 */
export interface InitialContext {
	/** Whether the view is pinned */
	pinned: boolean;
	/** Initial commit info */
	initialCommit?: { repoPath: string; sha: string };
}

// ============================================================
// View-Specific Sub-Service: Inspect
// ============================================================

/**
 * Inspect service for Commit Details — the single view-specific sub-service
 * that owns local commit queries, navigation, and commit actions.
 *
 * This keeps local commit actions and navigation in one
 * cohesive interface. Generic Git operations live on the `repository` service,
 * while file operations live on the `files` service.
 */
export interface CommitInspectService {
	// ── Events ──

	/**
	 * Fired when a commit is selected elsewhere (editor line, tree views, etc.).
	 * View-specific: includes search context and passive flag.
	 */
	onCommitSelected(callback: (event: CommitSelectionEvent) => void): Unsubscribe;

	// ── Initialization ──

	/**
	 * Get initial context for webview initialization.
	 * Returns minimal info needed to determine what data to fetch.
	 */
	getInitialContext(): Promise<InitialContext>;

	// ── Commit Queries ──

	/**
	 * Get core commit details (fast path — no autolinks, no enriched data).
	 * Returns commit identity, files, and stats immediately.
	 * @param signal - Optional AbortSignal for cooperative cancellation
	 */
	getCommit(repoPath: string, sha: string, signal?: AbortSignal): Promise<CommitDetails | undefined>;

	/**
	 * Pin or unpin the current view.
	 * When pinned, the view won't follow line tracker changes.
	 */
	setPin(pin: boolean): Promise<void>;

	// ── Commit Actions ──

	/**
	 * Execute a commit action (open the local action menu or copy SHA).
	 */
	executeCommitAction(repoPath: string, sha: string, action: 'more' | 'scm' | 'sha', alt?: boolean): Promise<void>;

	/** Copy the commit diff to the system clipboard. */
	copyCommitPatchToClipboard(repoPath: string, to: string, from?: string): Promise<void>;

	/**
	 * Open commit picker to select a different commit.
	 */
	pickCommit(): Promise<void>;

	/**
	 * Open commit search dialog.
	 */
	searchCommit(): Promise<void>;
}

// ============================================================
// Combined Services Interface
// ============================================================

/**
 * RPC service interface for Commit Details webview.
 *
 * Extends SharedWebviewServices with one view-specific sub-service:
 * - `inspect`: commit/WIP queries, navigation, and commit actions
 *
 */
export interface CommitDetailsServices {
	readonly webview: WebviewViewService;
	readonly repositories: RepositoriesService;
	readonly repository: RepositoryService;
	readonly config: ConfigService;
	readonly storage: StorageService;
	readonly autolinks: AutolinksService;
	readonly commands: CommandsService;
	readonly files: FilesService;
	readonly inspect: CommitInspectService;
}
