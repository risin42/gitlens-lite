import './commitDetails.scss';
import type { Remote, Subscription } from '@eamodio/supertalk';
import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { GitCommitReachability } from '@gitlens/git/providers/commits.js';
import type { StashApplyCommandArgs } from '../../../commands/stashApply.js';
import type { ViewFilesLayout } from '../../../config.js';
import type { CommitDetailsServices } from '../../commitDetails/commitDetailsService.js';
import type { CopyCommitPatchEventDetail, OpenMultipleChangesArgs } from '../shared/actions/file.js';
import { SignalWatcherWebviewApp } from '../shared/appBase.js';
import { getHost } from '../shared/host/context.js';
import { RpcController } from '../shared/rpc/rpcController.js';
import type { ResourceStatus } from '../shared/state/resource.js';
import { createResource } from '../shared/state/resource.js';
import type { CommitDetailsActions, CommitDetailsResources } from './actions.js';
import { createActions } from './actions.js';
import type { FileChangeListItemDetail } from './components/gl-details-base.js';
import { setupSubscriptions } from './events.js';
import type { CommitDetailsState } from './state.js';
import { createCommitDetailsState } from './state.js';
import '../shared/components/gl-error-banner.js';
import './components/gl-details-commit-panel.js';

export const uncommittedSha = '0000000000000000000000000000000000000000';

/**
 * Commit Details App - signal-based state management with RPC.
 *
 * This component uses:
 * - SignalWatcher to automatically re-render when signals change
 * - RpcController for RPC lifecycle management
 * - Instance-owned state created via createCommitDetailsState()
 * - HostContext for portable persistence and RPC endpoint creation
 * - Resources for async data lifecycle (commit and reachability)
 */
@customElement('gl-commit-details-app')
export class GlCommitDetailsApp extends SignalWatcherWebviewApp {
	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	// ── Host abstraction ──
	private _host = getHost();

	/**
	 * Instance-owned state — created here with persistence support, passed to actions/events.
	 */
	private _state: CommitDetailsState = createCommitDetailsState(this._host.storage);

	/**
	 * RPC controller — manages connection lifecycle via Lit's ReactiveController pattern.
	 */
	protected override readonly _rpc = new RpcController<CommitDetailsServices>(this, {
		rpcOptions: { endpoint: () => this._host.createEndpoint() },
		onReady: services => this._onRpcReady(services),
		onError: error => this._state.error.set(error.message),
	});

	/**
	 * Actions instance for handling user interactions.
	 */
	private _actions?: CommitDetailsActions;

	/**
	 * Resources for async data lifecycle — created in _onRpcReady.
	 */
	private _resources?: CommitDetailsResources;

	/**
	 * RPC event subscription — released at disconnect (before the actions its subscriber captured
	 * are disposed) and recreated per ready against the new session's actions.
	 */
	private _eventsSubscription?: Subscription;

	/**
	 * Stop auto-persistence — returned by startAutoPersist().
	 */
	private _stopAutoPersist?: () => void;

	override connectedCallback(): void {
		super.connectedCallback?.();

		this.consumeContext();
	}

	override disconnectedCallback(): void {
		// Unsubscribe BEFORE the actions/state below are disposed: the retained handle would
		// otherwise re-issue its subscriber — which closes over those disposed objects — on the
		// next handshake, ahead of `_onRpcReady`'s replacement. A fresh subscription is created
		// per ready anyway, so nothing is lost by releasing this one here.
		this._eventsSubscription?.unsubscribe();
		this._eventsSubscription = undefined;

		// Stop auto-persistence
		this._stopAutoPersist?.();
		this._stopAutoPersist = undefined;

		// Dispose all resources
		this._resources?.commit.dispose();
		this._resources?.reachability.dispose();
		this._resources = undefined;

		// Clear actions reference
		this._actions = undefined;

		// Reset state
		this._state.resetAll();

		// GlWebviewApp cleans up focus and theme listeners
		// Lit framework: calls RpcController.hostDisconnected() → ends the RPC session (the connection lives on)
		super.disconnectedCallback?.();
	}

	/**
	 * Called by RpcController when RPC connection is established.
	 * Resolves all sub-services once (resolve-once pattern), creates resources,
	 * then passes them to actions and subscriptions for direct method calls.
	 */
	private async _onRpcReady(services: Remote<CommitDetailsServices>): Promise<void> {
		const s = this._state;

		// Resolve all sub-services in parallel (one await per sub-service)
		const [inspect, repository, repositories, commands, config, storage, autolinks, files] = await Promise.all([
			services.inspect,
			services.repository,
			services.repositories,
			services.commands,
			services.config,
			services.storage,
			services.autolinks,
			services.files,
		]);

		// Create resources — fetchers read current state signals via closure
		const resources: CommitDetailsResources = {
			commit: createResource((signal, repoPath: string, sha: string) => inspect.getCommit(repoPath, sha, signal)),
			reachability: createResource<GitCommitReachability | undefined>(async _signal => {
				const commit = s.currentCommit.get();
				if (commit == null) return undefined;
				return repository.getCommitReachability(commit.repoPath, commit.sha, _signal);
			}),
		};
		this._resources = resources;

		const resolvedServices = {
			inspect: inspect,
			repositories: repositories,
			repository: repository,
			commands: commands,
			config: config,
			storage: storage,
			autolinks: autolinks,
			files: files,
		};

		// Create actions instance with resolved sub-services and resources
		this._actions = createActions(s, resolvedServices, resources);

		// Start auto-persistence before any state changes from host
		this._stopAutoPersist = s.startAutoPersist();

		// Set up DOM event listeners (needs actions to be initialized)
		this.setupDomListeners();

		// Set up event subscriptions FIRST (so we don't miss events during fetch) — synchronous:
		// `subscribe()` buffers the wire subscribe until the connection's handshake completes.
		// Recreated per ready (not `??=`): the subscriber closes over this session's actions, and a
		// reconnect recreates those — a kept first-session subscription would replay events into
		// disposed objects. Unsubscribing also cancels the old subscription's own resubscription.
		this._eventsSubscription?.unsubscribe();
		this._eventsSubscription = setupSubscriptions(this._rpc.connection!, s, this._actions);
		// Wait for the subscriptions to land before the initial fetch below, preserving the
		// subscribe-before-fetch guarantee (`ready` settles once, so reconnects don't re-wait).
		await this._eventsSubscription.ready;

		// Fetch initial state via individual parallel calls (replaces legacy getState())
		await this._actions.fetchInitialState();

		// Update document properties based on initial state
		this.updateDocumentProperties();
	}

	/**
	 * Set up document-level DOM event listeners. Child component interactions use
	 * template @event bindings instead — gl-details-commit-panel renders into a
	 * shadow root, so document-level delegation by selector cannot match its content
	 * (events are retargeted to the host element).
	 */
	private setupDomListeners(): void {
		const actions = this._actions;
		if (actions == null) return;

		const s = this._state;

		// Cancel pending RPC requests on hide (responses would be silently dropped
		// by VS Code); refresh the current commit on visibility restore
		const onVisibilityChange = (): void => {
			if (document.visibilityState !== 'visible') {
				actions.cancelPendingRequests();
				return;
			}

			if (s.loading.get()) return;

			void actions.refetchCurrentCommit();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		this.disposables.push({ dispose: () => document.removeEventListener('visibilitychange', onVisibilityChange) });
	}

	override updated(_changedProperties: Map<PropertyKey, unknown>): void {
		this.updateDocumentProperties();
	}

	private indentPreference = 16;
	private updateDocumentProperties(): void {
		const prefs = this._state.preferences.get();
		const preference = prefs?.indent;
		if (preference === this.indentPreference) return;

		this.indentPreference = preference ?? 16;

		const rootStyle = document.documentElement.style;
		rootStyle.setProperty('--gitlens-tree-indent', `${this.indentPreference}px`);
	}

	// ============================================================
	// Render methods
	// ============================================================

	override render(): unknown {
		// The gl-pick-commit/gl-search-commit bindings below read `this._actions` at event time
		// instead of this capture — the empty state is interactive before the RPC handshake
		// assigns `_actions`, so a render-scoped capture could be stale when clicked
		const actions = this._actions;
		const s = this._state;
		const resources = this._resources;
		const commit = s.currentCommit.get();
		const prefs = s.preferences.get();
		const reach = resources?.reachability.value.get();
		const reachStatus = resources?.reachability.status.get() ?? 'idle';
		const reachState = mapReachabilityStatus(reachStatus);
		const searchCtx = s.searchContext.get();

		return html`
			<div class="commit-detail-panel scrollable">
				<gl-error-banner .error=${s.error}></gl-error-banner>
				<main id="main" tabindex="-1">
					<gl-details-commit-panel
						variant="embedded"
						file-icons
						?multi-selectable=${true}
						.panelActions=${commit != null}
						?show-pin=${commit != null}
						?pinned=${s.pinned.get()}
						.navigation=${s.navigationStack.get()}
						.commit=${commit}
						.loading=${resources?.commit.loading.get() ?? false}
						.files=${commit?.files}
						.preferences=${prefs}
						.showSearchBox=${prefs?.showSearchBox ?? true}
						.searchBoxFilter=${prefs?.searchBoxFilter ?? true}
						.isUncommitted=${s.isUncommitted.get()}
						.filesCollapsable=${false}
						.autolinksEnabled=${s.capabilities.autolinksEnabled}
						.autolinks=${s.autolinks.get()}
						.formattedMessage=${s.formattedMessage.get()}
						.signature=${s.signature.get()}
						.hasRemotes=${s.hasRemotes.get()}
						.searchContext=${searchCtx}
						.reachability=${reach}
						.reachabilityState=${reachState}
						.branchName=${commit?.stashOnRef}
						@gl-pick-commit=${() => this._actions?.pickCommit()}
						@gl-search-commit=${() => this._actions?.searchCommit()}
						@gl-pin=${() => actions?.togglePin()}
						@gl-nav-back=${() => actions?.navigateBack()}
						@gl-nav-forward=${() => actions?.navigateForward()}
						@gl-commit-actions=${(e: CustomEvent<{ action: string; alt: boolean }>) =>
							this.onCommitActions(e)}
						@gl-stash-apply=${(e: CustomEvent<StashApplyCommandArgs>) =>
							actions?.executeCommand('gitlens.stashesApply', e.detail)}
						@load-reachability=${() => void actions?.loadReachability()}
						@refresh-reachability=${() => actions?.refreshReachability()}
						@open-on-remote=${(e: CustomEvent<{ sha: string }>) =>
							actions?.openOnRemote(commit?.repoPath, e.detail.sha)}
						@refresh-commit=${() => void actions?.refetchCurrentCommit()}
						@change-files-layout=${(e: CustomEvent<{ layout: ViewFilesLayout }>) =>
							actions?.changeFilesLayout(e.detail.layout)}
						@file-open-on-remote=${(e: CustomEvent<FileChangeListItemDetail>) =>
							actions?.openFileOnRemote(e.detail)}
						@file-open=${(e: CustomEvent<FileChangeListItemDetail>) =>
							actions?.openFile(e.detail, e.detail.showOptions)}
						@file-compare-working=${(e: CustomEvent<FileChangeListItemDetail>) =>
							actions?.openFileCompareWorking(e.detail, e.detail.showOptions)}
						@file-compare-previous=${(e: CustomEvent<FileChangeListItemDetail>) =>
							actions?.openFileComparePrevious(e.detail, e.detail.showOptions)}
						@file-more-actions=${(e: CustomEvent<FileChangeListItemDetail>) =>
							actions?.executeFileAction(e.detail, e.detail.showOptions)}
						@open-multiple-changes=${(e: CustomEvent<OpenMultipleChangesArgs>) =>
							actions?.openMultipleChanges(e.detail)}
						@copy-commit-patch=${(e: CustomEvent<CopyCommitPatchEventDetail>) =>
							actions?.copyCommitPatchToClipboard(e.detail.repoPath, e.detail.to, e.detail.from)}
						@gl-show-search-box-change=${(e: CustomEvent<boolean>) =>
							actions?.updateShowSearchBox(e.detail)}
						@gl-search-box-filter-change=${(e: CustomEvent<boolean>) =>
							actions?.updateSearchBoxFilter(e.detail)}
					></gl-details-commit-panel>
				</main>
			</div>
		`;
	}

	// ============================================================
	// Event handlers
	// ============================================================

	private onCommitActions(e: CustomEvent<{ action: string; alt: boolean }>): void {
		const commit = this._state.currentCommit.get();
		if (commit == null) return;

		const action = e.detail.action;
		if (action !== 'more' && action !== 'scm' && action !== 'sha') return;

		this._actions?.executeCommitAction(action, e.detail.alt);
	}
}

/** Maps resource status to the component's reachability state. */
function mapReachabilityStatus(status: ResourceStatus): 'idle' | 'loading' | 'loaded' | 'error' {
	return status === 'success' ? 'loaded' : status;
}
