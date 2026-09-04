import { Uri, workspace } from 'vscode';
import { isWeb } from '@env/platform.js';
import { base64, fromBase64 } from '@gitlens/utils/base64.js';
import { getAvatarUri } from '../../avatars.js';
import type { Container } from '../../container.js';
import { getExistingEntryKeys } from '../../git/utils/allowedSignersFile.js';
import type { AllowedSignersResultsChangedEvent, AllowedSignersServices } from '../rpc/allowedSignersService.js';
import { AllowedSignersService, expandHome } from '../rpc/allowedSignersService.js';
import type { EventVisibilityBuffer, SubscriptionTracker } from '../rpc/eventVisibilityBuffer.js';
import { createSharedServices } from '../rpc/services/common.js';
import { proxyServices } from '../rpc/services/proxy.js';
import type { WebviewHost, WebviewProvider, WebviewShowingArgs } from '../webviewProvider.js';
import type { WebviewShowOptions } from '../webviewsController.js';
import type { CandidateSigner, LoadingProgress, State } from './protocol.js';
import type { AllowedSignersWebviewShowingArgs } from './registration.js';

/**
 * How many recent commits to scan for SSH signatures when discovering signers. The scan is a cheap SHA enumeration
 * plus a single `cat-file --batch` (no per-commit `git` and no file-stat log), so a few thousand commits costs well
 * under a second; this window comfortably covers a repo's active signers without scanning all of history.
 */
const signedCommitScanLimit = 2000;

const defaultAllowedSignersPath = '~/.ssh/allowed_signers';

export class AllowedSignersWebviewProvider implements WebviewProvider<State, State, AllowedSignersWebviewShowingArgs> {
	private _repoPath: string | undefined;
	private _preselectFingerprint: string | undefined;
	private _disposed = false;
	private _loadStarted = false;
	// Latest discovery results, cached so re-showing the panel restores them. Hiding the editor tab tears down the
	// webview (retainContextWhenHidden is false); showing it again re-runs `includeBootstrap`, which would otherwise
	// return the loading shell while `loadSigners` early-returns on `_loadStarted` — leaving the panel stuck loading.
	private _results:
		| {
				signers: CandidateSigner[];
				error?: string;
		  }
		| undefined;

	/** Created with (and cached by) `getRpcServices` so the discovery flow can fire its events. */
	private _service: AllowedSignersService | undefined;

	constructor(
		private readonly container: Container,
		private readonly host: WebviewHost<'gitlens.allowedSigners'>,
	) {}

	dispose(): void {
		this._disposed = true;
	}

	onShowing(
		_loading: boolean,
		_options?: WebviewShowOptions,
		...args: WebviewShowingArgs<AllowedSignersWebviewShowingArgs, State>
	): boolean {
		let nextRepoPath: string | undefined;
		let nextPreselectFingerprint: string | undefined;

		const arg = args[0];
		if (typeof arg === 'string') {
			nextRepoPath = arg;
			// Opened from a commit's "Add to allowed signers…" action — pre-check that commit's signer (by fingerprint).
			nextPreselectFingerprint = typeof args[1] === 'string' ? args[1] : undefined;
		} else if (arg != null && 'state' in arg) {
			// Restored panel (deserialized on a fresh launch): recover the repository and selection intent from state.
			nextRepoPath = arg.state?.repoPath ?? undefined;
			nextPreselectFingerprint = arg.state?.preselectFingerprint ?? undefined;
		}
		// A no-arg show (e.g. from the Command Palette) is a generic open: both stay undefined so discovery re-derives
		// the best repository with no pre-selection.

		// This panel is single-instance, so the provider is reused across shows. Drop cached discovery whenever the
		// show context changes, so a re-open never surfaces the previous repo's signers or a stale pre-check. The
		// service's seed cache must drop with it — the webview's subscribe-then-query would otherwise apply the
		// previous repo's signers before discovery corrects the UI.
		if (nextRepoPath !== this._repoPath || nextPreselectFingerprint !== this._preselectFingerprint) {
			this._results = undefined;
			this._loadStarted = false;
			this._service?.clearResults();
		}
		this._repoPath = nextRepoPath;
		this._preselectFingerprint = nextPreselectFingerprint;

		return true;
	}

	getRpcServices(buffer?: EventVisibilityBuffer, tracker?: SubscriptionTracker): AllowedSignersServices {
		const shared = createSharedServices(this.container, this.host, buffer, tracker);

		this._service ??= new AllowedSignersService(this.container, () => this._repoPath, buffer, tracker);

		return proxyServices({
			...shared,

			allowedSigners: this._service,
		} satisfies AllowedSignersServices);
	}

	includeBootstrap(): Promise<State> {
		return this.getInitialState();
	}

	onReady(): void {
		// Discover signers asynchronously after the loading shell is shown, streaming progress to the webview.
		void this.loadSigners();
	}

	/** A soft-reconnected iframe re-booted from the ORIGINAL bootstrap, and discovery won't re-run
	 *  (the `_loadStarted` guard) — re-push the cached results or the panel sits on its loading
	 *  shell. If discovery is still in flight, its completion fires on the new session normally. */
	onReconnect(): void {
		if (!this._disposed && this._results != null) {
			this._service?.fireResultsChanged(this._results);
		}
	}

	/**
	 * Resolves the repository path to operate on. Uses the explicit/restored path when set; otherwise picks the best
	 * repository, waiting for repository discovery to finish first — on a fresh launch the panel can be restored before
	 * GitLens has discovered any repositories, which would otherwise leave it stuck on the empty state.
	 */
	private async resolveRepoPath(): Promise<string | undefined> {
		if (this._repoPath != null) return this._repoPath;

		let repo = this.container.git.getBestRepositoryOrFirst();
		if (repo == null) {
			await this.container.git.isDiscoveringRepositories;
			if (this._disposed) return undefined;

			repo = this.container.git.getBestRepositoryOrFirst();
		}
		return repo?.path;
	}

	private async getInitialState(): Promise<State> {
		const repoPath = await this.resolveRepoPath();
		this._repoPath = repoPath;

		let repoName: string | undefined;
		let targetPath = defaultAllowedSignersPath;
		let currentAllowedSignersFile: string | undefined;
		if (repoPath != null) {
			// The repository may not be discovered yet on restore, but a service bound to its path still works.
			repoName = this.container.git.getRepository(repoPath)?.name ?? basename(repoPath);
			const signing = await this.container.git.getRepositoryService(repoPath).config.getSigningConfig?.();
			currentAllowedSignersFile = signing?.allowedSignersFile || undefined;
			targetPath = currentAllowedSignersFile || defaultAllowedSignersPath;
		}

		// When the panel is re-shown after being hidden, discovery has already run (and won't run again); restore its
		// cached results so the panel doesn't return to the loading shell and get stuck there.
		const results = this._results;
		const loading = repoPath != null && results == null;

		return {
			...this.host.baseWebviewState,
			webroot: this.host.getWebRoot(),
			repoPath: repoPath,
			repoName: repoName,
			// With a repo and no results yet, paint the loading page immediately; discovery happens in onReady.
			loading: loading,
			progress: loading ? { message: 'Analyzing commit signatures…' } : undefined,
			signers: results?.signers ?? [],
			error: results?.error,
			targetPath: targetPath,
			currentAllowedSignersFile: currentAllowedSignersFile,
			setConfigScope: 'global',
			hasNodeHost: !isWeb,
			preselectFingerprint: this._preselectFingerprint,
		};
	}

	private async loadSigners(): Promise<void> {
		// onReady fires once per controller, but guard against any re-entrancy so we never gather twice in parallel.
		if (this._loadStarted) return;

		this._loadStarted = true;

		const repoPath = this._repoPath;
		if (repoPath == null) return;

		const svc = this.container.git.getRepositoryService(repoPath);

		// Discovered signers — held out here so that, if discovery throws part
		// way, the catch can still report whatever was found (without wiping already-shown signers) and, crucially,
		// clear the loading state so the panel never spins forever.
		const byId = new Map<string, CandidateSigner>();

		try {
			const signing = await svc.config.getSigningConfig?.();
			const targetPath = signing?.allowedSignersFile || defaultAllowedSignersPath;

			let existingContent = '';
			try {
				existingContent = new TextDecoder().decode(
					await workspace.fs.readFile(Uri.file(expandHome(targetPath))),
				);
			} catch {
				// No existing file — nothing is already present.
			}
			const existingKeys = getExistingEntryKeys(existingContent);

			const getSshSigners = svc.commits.getCommitsSshSigners;
			if (getSshSigners != null) {
				this.notifyProgress({ message: 'Analyzing commit signatures…' });

				// Enumerate commit SHAs with a cheap `git log --format=%H` (no file stats), then read those objects in a
				// single `cat-file --batch` — both committer identity and the SSH key come from the batched objects, so
				// no heavy `git log` pass is needed and we can afford to scan far more commits.
				const shas = [...(await svc.commits.getLogShas(undefined, { limit: signedCommitScanLimit }))];
				if (this._disposed) return;

				const signersBySha = await getSshSigners(shas);
				if (this._disposed) return;

				for (const { key, name, email } of signersBySha.values()) {
					if (!email) continue;

					const id = makeId(email, key.keyType, key.keyData);
					const existing = byId.get(id);
					if (existing != null) {
						existing.commitCount++;
						continue;
					}

					byId.set(id, {
						id: id,
						name: name || undefined,
						email: email,
						avatarUrl: getAvatarUri(email).toString(true),
						keyType: key.keyType,
						keyData: key.keyData,
						fingerprint: await computeSshFingerprint(key.keyData),
						commitCount: 1,
						alreadyPresent: existingKeys.has(id),
					});
				}
			}

			if (this._disposed) return;

			this.notifyResults(byId);
		} catch (ex) {
			if (this._disposed) return;

			// Surface a terminal error so the panel leaves the loading state instead of spinning forever,
			// keeping any signers already discovered.
			this.notifyResults(byId, ex instanceof Error ? ex.message : String(ex));
		}
	}

	private notifyProgress(progress: LoadingProgress): void {
		if (this._disposed) return;

		this._service?.fireProgressChanged(progress);
	}

	private notifyResults(byId: Map<string, CandidateSigner>, error?: string): void {
		const signers = sortSigners(byId);
		const event: AllowedSignersResultsChangedEvent = {
			signers: signers,
			error: error,
		};

		// Cache so a later re-show (which rebuilds the bootstrap) restores these instead of the loading shell.
		this._results = event;

		if (this._disposed) return;

		this._service?.fireResultsChanged(event);
	}
}

/** Sorts signers strongest-provenance first, then by signed-commit count, then by email. */
function sortSigners(byId: Map<string, CandidateSigner>): CandidateSigner[] {
	return [...byId.values()].sort((a, b) => b.commitCount - a.commitCount || a.email.localeCompare(b.email));
}

function makeId(email: string, keyType: string, keyData: string): string {
	return `${email.toLowerCase()}\0${keyType}\0${keyData}`;
}

/** Last path segment, used as a repository name fallback when the repo isn't discovered yet. */
function basename(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? path;
}

/**
 * Computes the OpenSSH `SHA256:...` fingerprint of a base64 public-key blob, using the portable Web Crypto API.
 * Returns an empty string if the input isn't decodable — keys are validated upstream, so this is a defensive guard
 * that keeps a single malformed blob from aborting the whole discovery pass.
 */
async function computeSshFingerprint(keyDataBase64: string): Promise<string> {
	try {
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64(keyDataBase64)));
		return `SHA256:${base64(digest).replace(/=+$/, '')}`;
	} catch {
		return '';
	}
}
