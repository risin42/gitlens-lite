import type { TextDocumentShowOptions } from 'vscode';
import { Disposable, env, EventEmitter, window } from 'vscode';
import type { GitCommit } from '@gitlens/git/models/commit.js';
import type { GitFileChange } from '@gitlens/git/models/fileChange.js';
import type { GitRevisionReference } from '@gitlens/git/models/reference.js';
import { createReference } from '@gitlens/git/utils/reference.utils.js';
import { isUncommitted } from '@gitlens/git/utils/revision.utils.js';
import { Logger } from '@gitlens/utils/logger.js';
import type { CopyMessageToClipboardCommandArgs } from '../../commands/copyMessageToClipboard.js';
import type { CopyShaToClipboardCommandArgs } from '../../commands/copyShaToClipboard.js';
import type { Container } from '../../container.js';
import type { CommitSelectedEvent } from '../../eventBus.js';
import { executeGitCommand } from '../../git/actions.js';
import { showDetailsQuickPick } from '../../git/actions/commit.js';
import { getCommitAndFileByPath } from '../../git/utils/-webview/commit.utils.js';
import { getReferenceFromRevision } from '../../git/utils/-webview/reference.utils.js';
import { executeCommand, executeCoreCommand, registerWebviewCommand } from '../../system/-webview/command.js';
import { getWebviewCommand } from '../../system/decorators/command.js';
import type { LinesChangeEvent } from '../../trackers/lineTracker.js';
import type { EventRegistration, EventVisibilityBuffer, SubscriptionTracker } from '../rpc/eventVisibilityBuffer.js';
import { bufferEventHandler, trackRpcRegistration } from '../rpc/eventVisibilityBuffer.js';
import { AutolinksService } from '../rpc/services/autolinks.js';
import { CommandsService } from '../rpc/services/commands.js';
import { ConfigService } from '../rpc/services/config.js';
import { FilesService } from '../rpc/services/files.js';
import { proxyServices } from '../rpc/services/proxy.js';
import { RepositoriesService } from '../rpc/services/repositories.js';
import { RepositoryService } from '../rpc/services/repository.js';
import { StorageService } from '../rpc/services/storage.js';
import { WebviewViewService } from '../rpc/webviewViewService.js';
import type { WebviewHost, WebviewProvider, WebviewShowingArgs } from '../webviewProvider.js';
import type { WebviewShowOptions } from '../webviewsController.js';
import { isSerializedState } from '../webviewsController.js';
import type { CommitDetailsServices, CommitSelectionEvent } from './commitDetailsService.js';
import type { ComparisonContext } from './commitDetailsWebview.utils.js';
import {
	getCoreCommitDetails,
	getFileCommitFromContext,
	isDetailsFileContext,
	isDetailsFolderContext,
	isDetailsItemContext,
	resolveMultiFileContext,
} from './commitDetailsWebview.utils.js';
import { DetailsFileCommands, getDetailsFileCommands, getDetailsFileMultiCommands } from './detailsFileCommands.js';
import {
	DetailsFolderCommands,
	getDetailsFolderCommands,
	sharedDetailsFolderCommandRoutes,
} from './detailsFolderCommands.js';
import type { DetailsItemContext, ExecuteFileActionParams, State } from './protocol.js';
import type { CommitDetailsWebviewShowingArgs } from './registration.js';

// Commands that open or modify editor content and need the line tracker suspended
const lineTrackerCommands = new Set([
	'gitlens.views.openChanges:',
	'gitlens.views.openChangesWithWorking:',
	'gitlens.openChangesWithWorktreeFile:',
	'gitlens.views.openPreviousChangesWithWorking:',
	'gitlens.views.openFile:',
	'gitlens.openWorktreeFile:',
	'gitlens.views.openFileRevision:',
	'gitlens.externalDiff:',
	'gitlens.views.highlightChanges:',
	'gitlens.views.highlightRevisionChanges:',
]);

/**
 * Backend provider for Commit Details webview.
 *
 * Architecture: The webview is the source of truth for ALL domain state
 * (commit details, WIP data, etc.). The backend:
 * - Tracks "showing context" (what was requested when opened) so it can
 *   tell the webview what to load on initialization
 * - Provides data via RPC methods (all accept params from webview)
 * - Forwards events to the webview
 * - Controls line tracker based on pinned state
 * - Maintains navigation history for back/forward
 *
 * The backend does NOT cache domain data (commit objects, WIP details, etc.).
 */
export class CommitDetailsWebviewProvider implements WebviewProvider<State, State, CommitDetailsWebviewShowingArgs> {
	private readonly _disposable: Disposable;
	private _focused = false;

	/** Controls line tracker - set via setPin() RPC */
	private _pinned = false;

	// --- Showing context ---
	// These track what was requested when the webview was shown,
	// so getInitialContext() can tell the webview what to load.
	// This is NOT cached domain data - just the request parameters.
	private _showingCommitRef: { repoPath: string; sha: string; refType?: GitRevisionReference['refType'] } | undefined;

	// View-specific event emitters — support multiple subscribers
	private readonly _onCommitSelected = new EventEmitter<CommitSelectionEvent>();
	private readonly _commitSelectedRegistrations = new Set<EventRegistration>();

	constructor(
		private readonly container: Container,
		private readonly host: WebviewHost<'gitlens.views.commitDetails'>,
	) {
		this._disposable = Disposable.from();
	}

	dispose(): void {
		this._disposable.dispose();
		this._lineTrackerDisposable?.dispose();
		this._selectionTrackerDisposable?.dispose();
		this._onCommitSelected.dispose();
	}

	private _skipNextRefreshOnVisibilityChange = false;

	onShowing(
		loading: boolean,
		options?: WebviewShowOptions,
		...args: WebviewShowingArgs<CommitDetailsWebviewShowingArgs, State>
	): boolean {
		const [arg] = args;
		return this.onShowingCommit(arg as Partial<CommitSelectedEvent['data']> | undefined, loading, options);
	}

	onShowingCommit(
		arg: Partial<CommitSelectedEvent['data']> | undefined,
		loading: boolean,
		options?: WebviewShowOptions,
	): boolean {
		let data: Partial<CommitSelectedEvent['data']> | undefined;

		if (isSerializedState<State>(arg)) {
			const { commit: selected } = arg.state;
			if (selected?.repoPath != null && selected?.sha != null) {
				if (selected.stashNumber != null) {
					data = {
						commit: createReference(selected.sha, selected.repoPath, {
							refType: 'stash',
							name: selected.message,
							number: selected.stashNumber,
						}),
					};
				} else {
					data = {
						commit: createReference(selected.sha, selected.repoPath, {
							refType: 'revision',
							message: selected.message,
						}),
					};
				}
			}
		} else if (arg != null && typeof arg === 'object') {
			data = arg;
		}

		// Capture showing context for getInitialContext()
		if (data?.commit != null) {
			const ref = getReferenceFromRevision(data.commit);
			this._showingCommitRef = { repoPath: ref.repoPath, sha: ref.ref, refType: ref.refType };
		} else {
			// No explicit commit - try to resolve from event cache / line tracker
			this._showingCommitRef = this.resolveCurrentCommitRef();
		}

		if (data?.preserveVisibility && !this.host.visible) return false;
		if (options?.preserveVisibility && !this.host.visible) return false;

		// If the webview is already live (reused panel), fire commit selection event
		// so it navigates to the new commit. When loading=true, the webview will call
		// fetchInitialState() which reads _showingCommitRef.
		// Note: For event-bus-driven selections (graph clicks), onCommitSelected() fires
		// the event before show() is called, so this is a no-op (same commit).
		if (!loading && this._showingCommitRef != null) {
			this._onCommitSelected.fire({
				repoPath: this._showingCommitRef.repoPath,
				sha: this._showingCommitRef.sha,
				passive: false,
			});
		}

		this._skipNextRefreshOnVisibilityChange = true;
		return true;
	}

	/**
	 * Resolve the current commit ref from the event cache or line tracker.
	 * Used when no explicit commit is provided in onShowingCommit.
	 */
	private resolveCurrentCommitRef():
		| { repoPath: string; sha: string; refType?: GitRevisionReference['refType'] }
		| undefined {
		if (this._pinned) return undefined;

		// Check line tracker first
		if (window.activeTextEditor != null) {
			const { lineTracker } = this.container;
			const line = lineTracker.selections?.[0]?.active;
			if (line != null) {
				const commit = lineTracker.getState(line)?.commit;
				if (commit != null) {
					return { repoPath: commit.repoPath, sha: commit.sha };
				}
			}
		}

		// Check event cache
		const args = this.container.events.getCachedEventArgs('commit:selected');
		if (args?.commit != null) {
			return { repoPath: args.commit.repoPath, sha: args.commit.ref, refType: args.commit.refType };
		}

		return undefined;
	}

	includeBootstrap(_deferrable?: boolean): Promise<State> {
		// Webview fetches all data via RPC — bootstrap only provides metadata
		return Promise.resolve({
			webviewId: this.host.id,
			webviewInstanceId: this.host.instanceId,
			timestamp: Date.now(),
		} as State);
	}

	registerCommands(): Disposable[] {
		const subscriptions: Disposable[] = [
			registerWebviewCommand(`${this.host.id}.refresh`, () => this.host.refresh(true)),
		];

		// Shared file commands. `gitlens.views.copy:` and `gitlens.copyRelativePathToClipboard:` are
		// also wired to folder context — when the menu fires them on a folder row, route to the
		// folder commands instance instead of running the file lookup (which would no-op).
		const fileCommands = new DetailsFileCommands(this.container, this.host.id);
		const folderCommands = new DetailsFolderCommands(this.container);
		for (const { command: cmd, handler } of getDetailsFileCommands()) {
			const suspendsLineTracker = lineTrackerCommands.has(cmd);
			const folderRoute = sharedDetailsFolderCommandRoutes[cmd];
			subscriptions.push(
				registerWebviewCommand(
					getWebviewCommand(cmd, this.host.type),
					async (item?: DetailsItemContext | ExecuteFileActionParams) => {
						if (suspendsLineTracker) {
							this.suspendLineTracker();
						}

						if (folderRoute != null && isDetailsFolderContext(item)) {
							folderCommands[folderRoute](item.webviewItemValue);
							return;
						}

						const [commit, file, comparison] = await this.getFileCommitFromContextOrParams(item);
						if (commit == null) {
							Logger.warn(`${cmd}: unable to resolve the file's commit — command aborted`);
							return;
						}

						return void handler.call(fileCommands, commit, file, this.getShowOptions(item), comparison);
					},
					this,
				),
			);
		}

		// Multi-file commands. When a multi-selection is right-clicked, the row's data-vscode-context
		// carries `webviewItemsValues` (all selected files); resolve each to its commit+file and hand
		// the whole set to the multi handler (one clipboard write, one stage op, etc.).
		for (const { command: cmd, handler } of getDetailsFileMultiCommands()) {
			subscriptions.push(
				registerWebviewCommand(
					getWebviewCommand(cmd, this.host.type),
					async (item?: DetailsItemContext | ExecuteFileActionParams) => {
						const resolved = await resolveMultiFileContext(this.container, item);
						// Mirror resolveMultiFileContext's own count: webviewItemsValues length, falling
						// back to the single anchor row when the multi-selection field is absent.
						const ctx = item as DetailsItemContext | undefined;
						const offered = ctx?.webviewItemsValues?.length ?? (ctx?.webviewItemValue != null ? 1 : 0);
						if (!resolved.length) {
							Logger.warn(`${cmd}: unable to resolve any files from the selection — command aborted`);
							return;
						}

						if (resolved.length < offered) {
							Logger.warn(
								`${cmd}: resolved ${resolved.length} of ${offered} selected files — running on the resolved subset`,
							);
						}

						await handler.call(fileCommands, resolved);
					},
					this,
				),
			);
		}

		// Folder-only commands (Folder History submenu). `gitlens.views.copy:` and
		// `gitlens.copyRelativePathToClipboard:` are intentionally NOT registered here — they share
		// IDs with the file commands above.
		for (const { command: cmd, handler } of getDetailsFolderCommands()) {
			if (cmd in sharedDetailsFolderCommandRoutes) continue;

			subscriptions.push(
				registerWebviewCommand(getWebviewCommand(cmd, this.host.type), (item?: DetailsItemContext) => {
					if (!isDetailsFolderContext(item)) return;

					handler.call(folderCommands, item.webviewItemValue);
				}),
			);
		}

		return subscriptions;
	}

	private getShowOptions(
		item: DetailsItemContext | ExecuteFileActionParams | undefined,
	): TextDocumentShowOptions | undefined {
		return isDetailsItemContext(item) ? undefined : item?.showOptions;
	}

	onFocusChanged(focused: boolean): void {
		if (this._focused === focused) return;

		this._focused = focused;
		if (focused && this.isLineTrackerSuspended) {
			this.ensureTrackers();
		}
	}

	// Note: Git actions (fetch, push, pull, etc.) are now called directly via RPC with repoPath param

	onRefresh(_force?: boolean | undefined): void {
		// Backend is stateless - webview handles refresh via RPC
		// Just ensure trackers are set up
		this.ensureTrackers();
	}

	onReloaded(): void {
		// Webview will call fetchInitialState() on reload via onRpcReady()
	}

	onVisibilityChanged(visible: boolean): void {
		this.ensureTrackers();
		if (!visible) return;

		const skipRefresh = this._skipNextRefreshOnVisibilityChange;
		if (skipRefresh) {
			this._skipNextRefreshOnVisibilityChange = false;
			return;
		}

		// Notify webview about potential changes that happened while hidden
		if (!this._pinned) {
			// Check if there's a current/new commit to show
			const commitRef = this.resolveCurrentCommitRef();
			if (commitRef != null) {
				this._onCommitSelected.fire({
					repoPath: commitRef.repoPath,
					sha: commitRef.sha,
					passive: true,
				});
			}
		}
	}

	private onCommitSelected(e: CommitSelectedEvent) {
		if (e.data == null) return;

		// Track what's being shown so file/stash actions know which commit to use
		const ref = getReferenceFromRevision(e.data.commit);
		this._showingCommitRef = { repoPath: ref.repoPath, sha: ref.ref, refType: ref.refType };

		// Forward event to webview - let webview decide what to do based on its state
		this._onCommitSelected.fire({
			repoPath: e.data.commit.repoPath,
			sha: e.data.commit.ref,
			searchContext: e.data.searchContext,
			passive: e.data.interaction === 'passive',
		});

		// Show webview if not passive and not pinned
		if (e.data.interaction !== 'passive' && !this._pinned) {
			void this.host.show(false, { preserveFocus: e.data.preserveFocus }, e.data);
		}
	}

	private _lineTrackerDisposable: Disposable | undefined;
	private _selectionTrackerDisposable: Disposable | undefined;
	private ensureTrackers(): void {
		this._selectionTrackerDisposable?.dispose();
		this._selectionTrackerDisposable = undefined;
		this._lineTrackerDisposable?.dispose();
		this._lineTrackerDisposable = undefined;

		if (!this.host.visible) return;

		this._selectionTrackerDisposable = this.container.events.on('commit:selected', this.onCommitSelected, this);

		if (this._pinned) return;

		const { lineTracker } = this.container;
		this._lineTrackerDisposable = lineTracker.subscribe(
			this,
			lineTracker.onDidChangeActiveLines(this.onActiveEditorLinesChanged, this),
		);
	}

	private get isLineTrackerSuspended() {
		return this._lineTrackerDisposable == null;
	}

	private suspendLineTracker() {
		// Defers the suspension of the line tracker, so that the focus change event can be handled first
		setTimeout(() => {
			this._lineTrackerDisposable?.dispose();
			this._lineTrackerDisposable = undefined;
		}, 100);
	}

	private onActiveEditorLinesChanged(e: LinesChangeEvent) {
		if (e.pending || e.editor == null || e.suspended) return;

		// Get commit from line tracker
		const line = e.selections?.[0]?.active;
		const commit = line != null ? this.container.lineTracker.getState(line)?.commit : undefined;

		if (commit != null) {
			// Forward commit selection event to webview
			this._onCommitSelected.fire({
				repoPath: commit.repoPath,
				sha: commit.sha,
				passive: true, // Line tracker selections are passive
			});
		}
	}

	private onUpdatePinned(params: { pin: boolean }) {
		if (params.pin === this._pinned) return;

		this._pinned = params.pin;
		this.ensureTrackers();
		// Webview already knows the new pin state - no notification needed
	}

	private async getFileCommitFromContextOrParams(
		item: DetailsItemContext | ExecuteFileActionParams | undefined,
	): Promise<
		| [commit: GitCommit, file: GitFileChange, comparison?: ComparisonContext]
		| [commit?: undefined, file?: undefined, comparison?: undefined]
	> {
		if (item == null) return [];

		if (isDetailsItemContext(item)) {
			if (!isDetailsFileContext(item)) return [];

			return getFileCommitFromContext(this.container, item.webviewItemValue);
		}

		return this.getFileCommitFromParams(item);
	}

	private async getFileCommitFromParams(
		params: ExecuteFileActionParams,
	): Promise<[commit: GitCommit, file: GitFileChange] | [commit?: undefined, file?: undefined]> {
		if (params.repoPath == null) return [];

		const ref = params.ref != null ? { ref: params.ref, stash: params.stash } : undefined;
		return getCommitAndFileByPath(params.repoPath, params.path, ref, params.staged);
	}

	private onShowCommitPicker() {
		// Open commit picker - let it determine best repo
		void executeGitCommand({
			command: 'log',
			state: { reference: 'HEAD', openPickInView: true },
		});
	}

	private onShowCommitSearch() {
		void executeGitCommand({ command: 'search', state: { openPickInView: true } });
	}

	private onExecuteCommitAction(params: {
		repoPath: string;
		sha: string;
		action: 'more' | 'scm' | 'sha';
		alt?: boolean;
	}) {
		switch (params.action) {
			case 'more':
				void this.showCommitActions(params.repoPath, params.sha);
				break;

			case 'scm':
				void executeCoreCommand('workbench.view.scm');
				break;

			case 'sha':
				if (params.alt) {
					// Copy message - need to fetch commit to get message
					void this.container.git
						.getRepositoryService(params.repoPath)
						.commits.getCommit(params.sha)
						.then(commit => {
							if (commit != null) {
								void executeCommand<CopyMessageToClipboardCommandArgs>(
									'gitlens.copyMessageToClipboard',
									{
										message: commit.message,
									},
								);
							}
						});
				} else {
					void executeCommand<CopyShaToClipboardCommandArgs>('gitlens.copyShaToClipboard', {
						sha: params.sha,
					});
				}
				break;
		}
	}

	private async showCommitActions(repoPath: string, sha: string) {
		if (isUncommitted(sha)) return;

		const commit = await this.container.git.getRepositoryService(repoPath).commits.getCommit(sha);
		if (commit == null) return;

		void showDetailsQuickPick(commit);
	}

	private async copyCommitPatchToClipboard(repoPath: string, to: string, from?: string): Promise<void> {
		try {
			const diff = await this.container.git.getRepositoryService(repoPath).diff.getDiff?.(to, from ?? `${to}^`);
			if (!diff?.contents) {
				void window.showWarningMessage('No changes found to copy');
				return;
			}

			await env.clipboard.writeText(diff.contents);
			void window.showInformationMessage('Copied patch to clipboard');
		} catch (ex) {
			Logger.error(ex, 'Failed to copy commit patch to clipboard');
			void window.showErrorMessage(`Unable to copy patch: ${ex instanceof Error ? ex.message : String(ex)}`);
		}
	}

	private async onShowFileActions(params: ExecuteFileActionParams) {
		const [commit, file] = await this.getFileCommitFromParams(params);
		if (commit == null) return;

		this.suspendLineTracker();
		void showDetailsQuickPick(commit, file);
	}

	// ============================================================
	// RPC Services (Supertalk)
	// ============================================================

	/**
	 * Returns services to expose via RPC (Supertalk).
	 *
	 * These are thin wrappers around existing functionality, providing a
	 * service-oriented interface for the webview to call.
	 */
	getRpcServices(buffer?: EventVisibilityBuffer, tracker?: SubscriptionTracker): CommitDetailsServices {
		return proxyServices({
			webview: new WebviewViewService(this.host, buffer, tracker),
			repositories: new RepositoriesService(this.container, buffer, tracker),
			repository: new RepositoryService(this.container, buffer, tracker),
			config: new ConfigService(buffer, tracker),
			storage: new StorageService(this.container),
			autolinks: new AutolinksService(this.container),
			commands: new CommandsService(this.container, this.host),
			files: new FilesService(this.container),

			// ============================================================
			// Inspect: view-specific commit/WIP queries, navigation, and actions
			// ============================================================
			inspect: {
				// ── Events ──

				onCommitSelected: (callback: (event: CommitSelectionEvent) => void) => {
					this.ensureTrackers();
					const pendingKey = Symbol('commitSelected');
					const buffered = bufferEventHandler(buffer, pendingKey, callback, 'save-last');
					const session = tracker?.callerSession;
					const tracked = trackRpcRegistration(this._commitSelectedRegistrations, tracker, () => {
						const disposable = this._onCommitSelected.event(buffered);
						return () => {
							buffer?.removePending(pendingKey);
							disposable.dispose();
						};
					});

					// Replay cached selection so webview gets the current commit even if the event fired
					// before subscription was ready — but not to an already-released straggler session.
					if (tracker?.isSessionReleased(session) !== true) {
						const commitRef = this.resolveCurrentCommitRef();
						if (commitRef != null) {
							callback({
								repoPath: commitRef.repoPath,
								sha: commitRef.sha,
								passive: true,
							});
						}
					}

					return tracked;
				},

				// ── Initialization ──

				getInitialContext: () =>
					Promise.resolve({
						pinned: this._pinned,
						initialCommit: this._showingCommitRef,
					}),

				// ── Commit Queries ──

				getCommit: async (repoPath: string, sha: string, signal?: AbortSignal) => {
					signal?.throwIfAborted();
					const svc = this.container.git.getRepositoryService(repoPath);
					let commit: GitCommit | undefined;
					if (this._showingCommitRef?.refType === 'stash') {
						const stash = await svc.stash?.getStash();
						commit = stash?.stashes.get(sha);
					}
					commit ??= await svc.commits.getCommit(sha, signal);
					if (commit == null) return undefined;

					signal?.throwIfAborted();
					// Track what the webview is showing so file actions know which commit to use
					this._showingCommitRef = { repoPath: repoPath, sha: sha, refType: commit.refType };
					const details = await getCoreCommitDetails(commit);
					signal?.throwIfAborted();
					return details;
				},

				setPin: pin => {
					this.onUpdatePinned({ pin: pin });
					return Promise.resolve();
				},

				// ── Commit Actions ──

				executeCommitAction: (repoPath, sha, action, alt?) => {
					this.onExecuteCommitAction({ repoPath: repoPath, sha: sha, action: action, alt: alt });
					return Promise.resolve();
				},

				copyCommitPatchToClipboard: (repoPath, to, from?) =>
					this.copyCommitPatchToClipboard(repoPath, to, from),

				pickCommit: () => {
					this.onShowCommitPicker();
					return Promise.resolve();
				},

				searchCommit: () => {
					this.onShowCommitSearch();
					return Promise.resolve();
				},
			},
		} satisfies CommitDetailsServices);
	}
}
