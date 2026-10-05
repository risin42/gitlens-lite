import type { Uri } from 'vscode';
import { Disposable, MarkdownString, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, window } from 'vscode';
import { GitBranch } from '@gitlens/git/models/branch.js';
import { GitCommit } from '@gitlens/git/models/commit.js';
import type { GitLog } from '@gitlens/git/models/log.js';
import type { GitBranchReference } from '@gitlens/git/models/reference.js';
import type { GitUser } from '@gitlens/git/models/user.js';
import { GitWorktree } from '@gitlens/git/models/worktree.js';
import { getLastFetchedUpdateInterval } from '@gitlens/git/utils/fetch.utils.js';
import { getHighlanderProviders } from '@gitlens/git/utils/remote.utils.js';
import { formatIndicators, formatTrackingTooltip } from '@gitlens/git/utils/tooltip.utils.js';
import { fromNow } from '@gitlens/utils/date.js';
import { gate } from '@gitlens/utils/decorators/gate.js';
import { debug, trace } from '@gitlens/utils/decorators/log.js';
import { memoize } from '@gitlens/utils/decorators/memoize.js';
import { disposableInterval } from '@gitlens/utils/disposable.js';
import { weakEvent } from '@gitlens/utils/event.js';
import { map } from '@gitlens/utils/iterable.js';
import { getSettledValue, pauseOnCancelOrTimeout } from '@gitlens/utils/promise.js';
import { pad } from '@gitlens/utils/string.js';
import type { IconPath } from '../../@types/vscode.iconpath.d.js';
import type { ViewShowBranchComparison } from '../../config.js';
import type { Colors } from '../../constants.colors.js';
import { GlyphChars } from '../../constants.js';
import type { Container } from '../../container.js';
import type { GitRepositoryService } from '../../git/gitRepositoryService.js';
import type { GitUri } from '../../git/gitUri.js';
import { unknownGitUri } from '../../git/gitUri.js';
import type { GlRepository, RepositoryChangeEvent } from '../../git/models/repository.js';
import {
	getBranchAheadRange,
	getBranchMergeTargetName,
	getBranchRemote,
	setBranchDisposition,
} from '../../git/utils/-webview/branch.utils.js';
import { getBranchIconPath, getRemoteIconPath, getWorktreeBranchIconPath } from '../../git/utils/-webview/icons.js';
import type { View, ViewsWithBranches } from '../viewBase.js';
import { disposeChildren } from '../viewBase.js';
import { createViewDecorationUri } from '../viewDecorationProvider.js';
import { SubscribeableViewNode } from './abstract/subscribeableViewNode.js';
import type { PageableViewNode, ViewNode } from './abstract/viewNode.js';
import { ContextValues, getViewNodeId } from './abstract/viewNode.js';
import { ViewRefNode } from './abstract/viewRefNode.js';
import { BranchTrackingStatusNode } from './branchTrackingStatusNode.js';
import { CommitNode } from './commitNode.js';
import { LoadMoreNode, MessageNode } from './common.js';
import { CompareBranchNode } from './compareBranchNode.js';
import { PausedOperationStatusNode } from './pausedOperationStatusNode.js';
import { StashNode } from './stashNode.js';
import { insertDateMarkers } from './utils/-webview/node.utils.js';

type Options = {
	expand: boolean;
	limitCommits: boolean;
	showAsCommits: boolean;
	showComparison: false | ViewShowBranchComparison;
	showStatusDecorationOnly: boolean;
	showMergeCommits?: boolean;
	showStashes: boolean;
	showStatus: boolean;
	showTracking: boolean;
	authors?: GitUser[];
};

export class BranchNode
	extends ViewRefNode<'branch', ViewsWithBranches, GitBranchReference>
	implements PageableViewNode
{
	limit: number | undefined;

	private readonly options: Options;

	constructor(
		uri: GitUri,
		view: ViewsWithBranches,
		public override parent: ViewNode,
		public readonly repo: GlRepository,
		public readonly branch: GitBranch,
		// Specifies that the node is shown as a root
		public readonly root: boolean,
		options?: Partial<Options>,
	) {
		super('branch', uri, view, parent);

		this.updateContext({ repository: repo, branch: branch, root: root });
		this._uniqueId = getViewNodeId(this.type, this.context);
		this.limit = this.view.getNodeLastKnownLimit(this);

		this.options = {
			expand: false,
			limitCommits: false,
			showAsCommits: false,
			showComparison: false,
			showStashes: false,
			// Only show status decorations when the node is displayed as a root
			showStatusDecorationOnly: this.root,
			// Don't show merge/rebase status info the node is displayed as a root
			showStatus: true, //!this.root,
			// Don't show tracking info the node is displayed as a root
			showTracking: !this.root,
			...options,
		};
	}

	override dispose(): void {
		super.dispose();
		this.children = undefined;
	}

	override get id(): string {
		return this._uniqueId;
	}

	override toClipboard(): string {
		return this.branch.name;
	}

	private get avoidCompacting(): boolean {
		return (
			this.root ||
			this.current ||
			this.worktree?.opened ||
			this.branch.detached ||
			this.branch.disposition != null
		);
	}

	compacted: boolean = false;

	get current(): boolean {
		return this.branch.current;
	}

	get ref(): GitBranchReference {
		return this.branch;
	}

	get treeHierarchy(): string[] {
		return this.avoidCompacting ? [this.branch.name] : this.branch.nameWithoutRemote.split('/');
	}

	@memoize()
	get worktree(): GitWorktree | undefined {
		const worktree = this.context.worktreesByBranch?.get(this.branch.id);
		return worktree?.isDefault ? undefined : worktree;
	}

	private _children: ViewNode[] | undefined;
	protected get children(): ViewNode[] | undefined {
		return this._children;
	}
	protected set children(value: ViewNode[] | undefined) {
		if (this._children === value) return;

		disposeChildren(this._children, value);
		this._children = value;
	}

	async getChildren(): Promise<ViewNode[]> {
		if (this.children == null) {
			const branch = this.branch;

			let comparison: CompareBranchNode | undefined;
			let loadComparisonDefaultCompareWith = false;
			if (this.options.showComparison !== false && this.view.type !== 'remotes') {
				comparison = new CompareBranchNode(
					this.uri,
					this.view,
					this,
					branch,
					this.options.showComparison,
					this.splatted,
				);
				loadComparisonDefaultCompareWith = comparison.compareWith == null;
			}

			const svc = this.view.container.git.getRepositoryService(this.uri.repoPath!);
			const [
				logResult,
				getBranchAndTagTipsResult,
				pausedOpStatusResult,
				unpublishedCommitsResult,
				baseResult,
				targetResult,
			] = await Promise.allSettled([
				this.getLog(svc),
				svc.getBranchesAndTagsTipsLookup(branch.name),
				this.options.showStatus && branch.current ? svc.pausedOps?.getPausedOperationStatus?.() : undefined,
				!branch.remote
					? getBranchAheadRange(svc, branch).then(range =>
							range
								? svc.commits.getLogShas(range, { limit: 0, merges: this.options.showMergeCommits })
								: undefined,
						)
					: undefined,
				loadComparisonDefaultCompareWith ? svc.branches.getBaseBranchName?.(this.branch.name) : undefined,
				loadComparisonDefaultCompareWith
					? getBranchMergeTargetName(this.view.container, this.branch, {
							timeout: 100,
						})
					: undefined,
			]);
			const log = getSettledValue(logResult);
			if (log == null) return [new MessageNode(this.view, this, 'No commits could be found.')];

			const children = [];

			const pausedOpsStatus = getSettledValue(pausedOpStatusResult);
			const unpublishedCommits = new Set(getSettledValue(unpublishedCommitsResult));

			if (pausedOpsStatus != null) {
				children.push(new PausedOperationStatusNode(this.view, this, branch, pausedOpsStatus, this.root));
			} else if (this.options.showTracking) {
				const status = {
					ref: branch.ref,
					repoPath: branch.repoPath,
					upstream: branch.upstream,
				};

				if (status.upstream != null) {
					if (this.root && status.upstream.missing) {
						children.push(
							new BranchTrackingStatusNode(this.view, this, branch, status, 'missing', this.root),
						);
					} else if (this.root && !status.upstream.state.behind && !status.upstream.state.ahead) {
						children.push(new BranchTrackingStatusNode(this.view, this, branch, status, 'same', this.root));
					} else {
						if (status.upstream.state.behind) {
							children.push(
								new BranchTrackingStatusNode(this.view, this, branch, status, 'behind', this.root),
							);
						}

						if (status.upstream.state.ahead) {
							children.push(
								new BranchTrackingStatusNode(this.view, this, branch, status, 'ahead', this.root, {
									unpublishedCommits: unpublishedCommits,
								}),
							);
						}
					}
				} else if (!branch.detached) {
					children.push(new BranchTrackingStatusNode(this.view, this, branch, status, 'none', this.root));
				}
			}

			if (comparison != null) {
				children.push(comparison);

				if (loadComparisonDefaultCompareWith) {
					const baseBranchName = getSettledValue(baseResult);
					const targetMaybeResult = getSettledValue(targetResult);

					let baseOrTargetBranchName: string | undefined;
					if (targetMaybeResult?.paused) {
						baseOrTargetBranchName = baseBranchName;
					} else {
						baseOrTargetBranchName = targetMaybeResult?.value ?? baseBranchName;
					}

					if (baseOrTargetBranchName != null) {
						void comparison.setDefaultCompareWith({
							ref: baseOrTargetBranchName,
							label: baseOrTargetBranchName,
							notation: '...',
							type: 'branch',
							checkedFiles: [],
						});
					}

					if (targetMaybeResult?.paused) {
						void targetMaybeResult.value.then(target => {
							if (target == null) return;

							void comparison.setDefaultCompareWith({
								ref: target,
								label: target,
								notation: '...',
								type: 'branch',
								checkedFiles: [],
							});
						});
					}
				}
			}

			if (children.length !== 0) {
				if (this.view.type === 'commits') {
					children.push(new CommitsCurrentBranchNode(this.view, this, this.branch));
				} else {
					children.push(new MessageNode(this.view, this, '', GlyphChars.Dash.repeat(2), ''));
				}
			}

			const getBranchAndTagTips = getSettledValue(getBranchAndTagTipsResult);

			children.push(
				...insertDateMarkers(
					map(log.commits.values(), c =>
						GitCommit.isStash(c)
							? new StashNode(this.view, this, c, { icon: true })
							: new CommitNode(
									this.view,
									this,
									c,
									unpublishedCommits?.has(c.ref),
									branch,
									getBranchAndTagTips,
								),
					),
					this,
				),
			);

			if (log.hasMore) {
				children.push(
					new LoadMoreNode(this.view, this, children.at(-1)!, {
						getCount: () =>
							this.view.container.git
								.getRepositoryService(branch.repoPath)
								.commits.getCommitCount(branch.name),
					}),
				);
			}

			this.children = children;
		}

		return this.children;
	}

	async getTreeItem(): Promise<TreeItem> {
		let hasWorkingChanges: boolean | undefined;
		if (this.worktree != null) {
			const result = await pauseOnCancelOrTimeout(this.getWorktreeHasWorkingChanges(), undefined, 1);
			if (!result.paused) {
				hasWorkingChanges = result.value;
			} else {
				queueMicrotask(() => {
					void result.value.then(() => {
						this.view.triggerNodeChange(this);
					});
				});
			}
		}

		const parts = await getBranchNodeParts(this.view.container, this.branch, this.current, {
			avatars: this.view.config.avatars,
			hasWorkingChanges: hasWorkingChanges,
			showAsCommits: this.options.showAsCommits,
			showingLocalAndRemoteBranches: this.view.type === 'branches' && this.view.config.showRemoteBranches,
			showStatusDecorationOnly: this.options.showStatusDecorationOnly,
			useBaseNameOnly: !(this.view.config.branches?.layout !== 'tree' || this.compacted || this.avoidCompacting),
			worktree: this.worktree,
			worktreesByBranch: this.context.worktreesByBranch,
		});

		// TODO@axosoft-ramint Temporary workaround, remove when our git commands work on closed repos.
		if (!this.repo.opened) {
			parts.contextValue += '+closed';
		}

		const item = new TreeItem(
			parts.label,
			this.options.expand ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
		);
		item.id = this.id;
		item.contextValue = parts.contextValue;
		item.description = parts.description;
		item.iconPath = parts.iconPath;
		item.resourceUri = parts.resourceUri;
		item.tooltip = parts.tooltip;

		return item;
	}

	@debug()
	async star(): Promise<void> {
		await setBranchDisposition(this.view.container, this.branch, 'starred');
		void this.view.refresh(true);
	}

	@debug()
	async unstar(): Promise<void> {
		await setBranchDisposition(this.view.container, this.branch, undefined);
		void this.view.refresh(true);
	}

	override refresh(reset?: boolean): void {
		void super.refresh?.(reset);

		this.children = undefined;
		if (reset) {
			this._log = undefined;
			this._worktreeHasWorkingChanges = undefined;
			this.deleteState();
		}
	}

	/** `null` remembers a failed check (e.g. a deleted worktree folder) until the next reset, rather than re-running it on every redraw */
	private _worktreeHasWorkingChanges: boolean | null | undefined;
	private async getWorktreeHasWorkingChanges(): Promise<boolean | undefined> {
		if (this._worktreeHasWorkingChanges === undefined && this.worktree != null) {
			this._worktreeHasWorkingChanges = await GitWorktree.hasWorkingChanges(this.worktree).catch(() => null);
		}
		return this._worktreeHasWorkingChanges ?? undefined;
	}

	private _log: GitLog | undefined;
	private async getLog(svc: GitRepositoryService): Promise<GitLog | undefined> {
		if (this._log == null) {
			let limit =
				this.limit ??
				(this.root && !this.options.limitCommits
					? this.view.config.pageItemLimit
					: this.view.config.defaultItemLimit);
			// Try to show more commits if they are unpublished
			const ahead = this.branch.upstream?.state.ahead ?? 0;
			if (limit !== 0 && ahead > limit) {
				limit = Math.min(ahead + 1, limit * 2);
			}

			this._log = await svc.commits.getLog(this.ref.ref, {
				limit: limit,
				authors: this.options?.authors,
				merges: this.options?.showMergeCommits,
				stashes: this.options?.showStashes,
			});
		}

		return this._log;
	}

	get hasMore(): boolean {
		return this._log?.hasMore ?? true;
	}

	@gate()
	async loadMore(limit?: number | { until?: any }): Promise<void> {
		let log = await window.withProgress({ location: { viewId: this.view.id } }, () =>
			this.getLog(this.view.container.git.getRepositoryService(this.uri.repoPath!)),
		);
		if (!log?.hasMore) return;

		log = await log.more?.(limit ?? this.view.config.pageItemLimit);
		if (this._log === log) return;

		this._log = log;
		this.limit = log?.count;

		this.children = undefined;
		void this.triggerChange(false);
	}
}

export async function getBranchNodeParts(
	container: Container,
	branch: GitBranch,
	current: boolean,
	options?: {
		avatars?: boolean;
		hasWorkingChanges?: boolean;
		showAsCommits?: boolean;
		showingLocalAndRemoteBranches?: boolean;
		showStatusDecorationOnly?: boolean;
		useBaseNameOnly: boolean;
		worktree?: GitWorktree;
		worktreesByBranch?: Map<string, GitWorktree>;
	},
): Promise<{
	label: string;
	description: string | undefined;
	tooltip: MarkdownString;
	contextValue: string;
	iconPath: IconPath;
	resourceUri: Uri | undefined;
}> {
	const status = branch.status;

	const suffixes = [];
	if (current) {
		if (branch.rebasing) {
			suffixes.push('rebasing');
		}
		suffixes.push('current branch');
	}
	if (options?.worktree) {
		if (options.worktree.opened && !current) {
			suffixes.push('in an opened worktree');
		} else {
			suffixes.push('in a worktree');
		}
	}

	let tooltip: string | MarkdownString = `$(git-branch) \`${branch.nameWithoutRemote}\`${formatIndicators(suffixes)}`;

	let contextValue: string = ContextValues.Branch;
	let checkedout = false;
	if (current) {
		contextValue += '+current';
		checkedout = true;
	}
	if (branch.remote) {
		contextValue += '+remote';
	}
	if (branch.starred) {
		contextValue += '+starred';
	}
	if (branch.upstream != null && !branch.upstream.missing) {
		contextValue += '+tracking';
	}
	if (options?.showAsCommits) {
		contextValue += '+commits';
	}
	if (options?.worktree != null) {
		contextValue += '+worktree';
		checkedout = true;

		if (options.worktree.opened) {
			contextValue += '+opened';
		}
	} else if (options?.worktreesByBranch?.get(branch.id)?.isDefault) {
		checkedout = true;
	}
	if (checkedout) {
		contextValue += '+checkedout';
	}

	let iconColor: ThemeColor | undefined;
	let description;
	if (!branch.remote) {
		if (branch.upstream != null) {
			let arrows = GlyphChars.Dash;

			const remote = await getBranchRemote(container, branch);
			if (!branch.upstream.missing) {
				if (remote != null) {
					let left;
					let right;
					for (const { type } of remote.urls) {
						if (type === 'fetch') {
							left = true;

							if (right) break;
						} else if (type === 'push') {
							right = true;

							if (left) break;
						}
					}

					if (left && right) {
						arrows = GlyphChars.ArrowsRightLeft;
					} else if (right) {
						arrows = GlyphChars.ArrowRight;
					} else if (left) {
						arrows = GlyphChars.ArrowLeft;
					}
				}
			} else {
				arrows = GlyphChars.Warning;
			}

			description = options?.showAsCommits
				? `${GitBranch.getTrackingStatus(branch, {
						suffix: pad(GlyphChars.Dot, 1, 1),
					})}${branch.nameWithoutRemote}${branch.rebasing ? ' (Rebasing)' : ''}${pad(arrows, 2, 2)}${
						branch.upstream.name
					}`
				: `${GitBranch.getTrackingStatus(branch, { suffix: `${GlyphChars.Space} ` })}${arrows}${GlyphChars.Space} ${
						branch.upstream.name
					}`;

			tooltip += `\n\n${formatTrackingTooltip(
				branch.upstream.name,
				branch.upstream.missing,
				branch.upstream.state,
				remote?.provider?.name,
			)}`;

			switch (status) {
				case 'ahead':
					contextValue += '+ahead';
					iconColor = new ThemeColor('gitlens-lite.decorations.branchAheadForegroundColor' satisfies Colors);
					break;
				case 'behind':
					contextValue += '+behind';
					iconColor = new ThemeColor('gitlens-lite.decorations.branchBehindForegroundColor' satisfies Colors);
					break;
				case 'diverged':
					contextValue += '+ahead+behind';
					iconColor = new ThemeColor(
						'gitlens-lite.decorations.branchDivergedForegroundColor' satisfies Colors,
					);
					break;
				case 'upToDate':
					iconColor = new ThemeColor(
						'gitlens-lite.decorations.branchUpToDateForegroundColor' satisfies Colors,
					);
					break;
			}
		} else {
			const providers = getHighlanderProviders(
				await container.git.getRepositoryService(branch.repoPath).remotes.getRemotesWithProviders(),
			);
			const providerName = providers?.length ? providers[0].name : undefined;

			tooltip += `\n\nLocal branch, hasn't been published to ${providerName ?? 'a remote'}`;
		}
	}

	if (branch.date != null) {
		description = `${description ? `${description}${pad(GlyphChars.Dot, 2, 2)}` : ''}${GitBranch.formatDateWithStyle(branch, container.BranchDateFormatting)}`;

		tooltip += `\n\nLast commit ${GitBranch.formatDateFromNow(branch)} (${GitBranch.formatDate(
			branch,
			container.BranchDateFormatting.dateFormat,
		)})`;
	}

	tooltip = new MarkdownString(tooltip, true);
	tooltip.supportHtml = true;
	tooltip.isTrusted = true;

	if (branch.starred) {
		tooltip.appendMarkdown('\\\n$(star-full) Favorited');
	}

	let label;
	if (options?.showAsCommits) {
		label = 'Commits';
	} else {
		const branchName = branch.nameWithoutRemote;
		label = `${!options?.useBaseNameOnly ? branchName : branch.basename}${branch.rebasing ? ' (Rebasing)' : ''}`;
	}

	let localUnpublished = false;
	if (status === 'local') {
		// If there are any remotes then say this is unpublished, otherwise local
		const remotes = await container.git.getRepositoryService(branch.repoPath).remotes.getRemotes();
		if (remotes.length) {
			localUnpublished = true;
		}
	}

	let iconPath: IconPath;
	if (options?.showAsCommits) {
		iconPath = new ThemeIcon('git-commit', iconColor);
	} else if (options?.worktree != null) {
		iconPath = getWorktreeBranchIconPath(container, branch, options?.hasWorkingChanges);
	} else if (branch.remote && options?.showingLocalAndRemoteBranches) {
		const remote = await getBranchRemote(container, branch);
		iconPath = getRemoteIconPath(container, remote, { avatars: options?.avatars });
	} else {
		iconPath = getBranchIconPath(container, branch);
	}

	return {
		label: label,
		description: description,
		tooltip: tooltip,
		contextValue: contextValue,
		iconPath: iconPath,
		resourceUri: createViewDecorationUri('branch', {
			status: localUnpublished ? 'unpublished' : status,
			current: current,
			worktree: options?.worktree != null ? { opened: options.worktree.opened } : undefined,
			disposition: branch.disposition,
			showStatusOnly: options?.showStatusDecorationOnly,
		}),
	};
}

const emptyDisposable: Disposable = Object.freeze({ dispose: () => {} });

export class CommitsCurrentBranchNode extends SubscribeableViewNode<'commits-current-branch'> {
	private repo: GlRepository | undefined;

	constructor(
		view: View,
		parent: ViewNode,
		readonly branch: GitBranch,
	) {
		super('commits-current-branch', unknownGitUri, view, parent);

		this.repo = view.container.git.getRepository(branch.repoPath);
	}

	getChildren(): ViewNode[] | Promise<ViewNode[]> {
		return [];
	}

	async getTreeItem(): Promise<TreeItem> {
		const lastFetched = (await this.getLastFetched()) ?? 0;
		const context = `${this.branch.name}${
			lastFetched ? ` \u00a0\u2022\u00a0 fetched ${fromNow(new Date(lastFetched))}` : ''
		}`;

		const item = new TreeItem('', TreeItemCollapsibleState.None);
		item.contextValue = ContextValues.CommitsCurrentBranch;
		item.description = `\u2014\u00a0\u00a0 on ${context}`;
		item.tooltip = context;
		return item;
	}

	protected override etag(): number {
		return this.repo?.etag ?? 0;
	}

	private async getLastFetched(): Promise<number | undefined> {
		return this.branch.upstream?.missing || this.branch.detached ? undefined : this.repo?.getLastFetched();
	}

	@trace()
	protected async subscribe(): Promise<Disposable | undefined> {
		const lastFetched = (await this.getLastFetched()) ?? 0;

		const interval = getLastFetchedUpdateInterval(lastFetched);
		if (lastFetched !== 0 && interval > 0) {
			return Disposable.from(
				this.repo != null ? weakEvent(this.repo.onDidChange, this.onRepositoryChanged, this) : emptyDisposable,
				disposableInterval(() => {
					// Skip update if view is not visible to reduce unnecessary work
					if (!this.view.visible) return;

					// Check if the interval should change, and if so, reset it
					if (interval !== getLastFetchedUpdateInterval(lastFetched)) {
						void this.resetSubscription();
						return;
					}

					this.view.triggerNodeChange(this);
				}, interval),
			);
		}

		return undefined;
	}

	@trace()
	private onRepositoryChanged(_e: RepositoryChangeEvent) {
		this.view.triggerNodeChange(this);
	}
}
