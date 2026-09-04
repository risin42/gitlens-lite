import { Uri as VscodeUri, workspace } from 'vscode';
import type { CachedGitTypes } from '@gitlens/git/cache.js';
import type { GitServiceConfig, GitServiceContext } from '@gitlens/git/context.js';
import type { RepositoryChange } from '@gitlens/git/models/repository.js';
import { mixinDisposable } from '@gitlens/utils/disposable.js';
import type { Uri } from '@gitlens/utils/uri.js';
import { getRepositoryKey } from '@gitlens/utils/uri.js';
import type { Container } from '../container.js';
import { configuration } from '../system/-webview/configuration.js';
import { buildRemoteProviderConfigs } from './remotes/remoteProviderConfigs.js';
import { sortRemotes } from './utils/-webview/remote.utils.js';

/**
 * Creates a {@link GitServiceContext} — config, hooks, workspace resolution,
 * and remote configuration.
 *
 * All hooks fire directly to the extension event bus.
 * Providers pass the context through unchanged (no augmentation needed).
 */
export function createGitProviderContext(container: Container): GitServiceContext {
	const config: GitServiceConfig = {
		get commits() {
			return {
				includeFileDetails: (repoPath: string) => !container.gitHealth.shouldDelayFileDetails(repoPath),
				ordering: configuration.get('advanced.commitOrdering'),
				similarityThreshold: configuration.get('advanced.similarityThreshold'),
				maxItems: configuration.get('advanced.maxListItems'),
			};
		},
		get fileHistory() {
			return {
				showAllBranches: configuration.get('advanced.fileHistoryShowAllBranches'),
				showMergeCommits: configuration.get('advanced.fileHistoryShowMergeCommits'),
				followRenames: configuration.get('advanced.fileHistoryFollowsRenames'),
			};
		},
		get search() {
			return {
				maxItems: configuration.get('advanced.maxSearchItems'),
			};
		},
		get graph() {
			return {
				writeCommitGraph: configuration.get('gitOptimizations.enabled'),
			};
		},
		get maintenance() {
			return {
				enabled: configuration.get('gitOptimizations.enabled'),
			};
		},
		get push() {
			return {
				useForceWithLease: configuration.getCore('git.useForcePushWithLease') ?? true,
				useForceIfIncludes: configuration.getCore('git.useForcePushIfIncludes') ?? true,
			};
		},
		get signing() {
			return {
				enabled: configuration.getCore('git.enableCommitSigning'),
			};
		},
	};

	return {
		config: config,

		hooks: {
			cache: {
				onReset: (repoPath: string, ...types: CachedGitTypes[]) =>
					container.events.fire('git:cache:reset', {
						repoPath: getRepositoryKey(repoPath),
						types: types.length ? types : undefined,
					}),
			},
			repository: {
				onChanged: (repoPath: string, changes: RepositoryChange[]) =>
					container.events.fire('git:repo:change', {
						repoPath: getRepositoryKey(repoPath),
						changes: changes,
					}),
			},
			operations: {
				onRebaseCapableOperation: (repoPath, command, phase) => {
					if (phase === 'started') {
						container.operationOrigins.markStarted(repoPath, command);
					} else {
						void container.operationOrigins.onOperationEnded(repoPath);
					}
				},
			},
		},

		fs: {
			readDirectory: async (uri: Uri) => workspace.fs.readDirectory(uri),
			readFile: async (uri: Uri) => workspace.fs.readFile(uri),
			stat: async (uri: Uri) => {
				try {
					return await workspace.fs.stat(uri);
				} catch {
					return undefined;
				}
			},
		},

		remotes: {
			getCustomProviders: (repoPath: string) => {
				const repo = container.git.getRepository(repoPath);
				const configuredRemotes = configuration.get('remotes', repo?.folder?.uri ?? null);
				return Promise.resolve(buildRemoteProviderConfigs(configuredRemotes));
			},

			getRepositoryInfo: () => Promise.resolve(undefined),

			sort: (remotes, cancellation) => sortRemotes(container, remotes, cancellation),
		},

		workspace: {
			// workspace.onDidGrantWorkspaceTrust is one-way (untrusted → trusted), but the
			// event is generic boolean for future-proofing
			onDidChangeTrust: (listener, thisArgs, disposables) => {
				const d = mixinDisposable(
					workspace.onDidGrantWorkspaceTrust(() => {
						listener.call(thisArgs, true);
					}),
				);
				if (disposables) {
					disposables.push(d);
				}
				return d;
			},

			getFolder: (repoPath: string) => {
				const folder = workspace.getWorkspaceFolder(VscodeUri.file(repoPath));
				if (folder == null) return undefined;
				return { path: folder.uri.fsPath };
			},

			get isTrusted() {
				return workspace.isTrusted;
			},
		},
	};
}
