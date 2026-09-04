import type { CancellationToken, Command } from 'vscode';
import { MarkdownString, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';
import type { GitBranch } from '@gitlens/git/models/branch.js';
import { GitCommit } from '@gitlens/git/models/commit.js';
import type { GitRevisionReference } from '@gitlens/git/models/reference.js';
import { makeHierarchical } from '@gitlens/utils/array.js';
import { joinPaths, normalizePath } from '@gitlens/utils/path.js';
import { getSettledValue, pauseOnCancelOrTimeout } from '@gitlens/utils/promise.js';
import { sortCompare } from '@gitlens/utils/string.js';
import type { DiffWithPreviousCommandArgs } from '../../commands/diffWithPrevious.js';
import type { Colors } from '../../constants.colors.js';
import { CommitFormatter } from '../../git/formatters/commitFormatter.js';
import {
	getCommitAuthorAvatarUri,
	getCommitGitUri,
	getCommitsForFiles,
	isCommitSigned,
} from '../../git/utils/-webview/commit.utils.js';
import { toAbortSignal } from '../../system/-webview/cancellation.js';
import { createCommand } from '../../system/-webview/command.js';
import { configuration } from '../../system/-webview/configuration.js';
import type { FileHistoryView } from '../fileHistoryView.js';
import type { ViewsWithCommits } from '../viewBase.js';
import { disposeChildren } from '../viewBase.js';
import type { ViewNode } from './abstract/viewNode.js';
import { ContextValues, getViewNodeId } from './abstract/viewNode.js';
import { ViewRefNode } from './abstract/viewRefNode.js';
import { CommitFileNode } from './commitFileNode.js';
import type { FileNode } from './folderNode.js';
import { FolderNode } from './folderNode.js';

export class CommitNode extends ViewRefNode<'commit', ViewsWithCommits | FileHistoryView, GitRevisionReference> {
	constructor(
		view: ViewsWithCommits | FileHistoryView,
		parent: ViewNode,
		public readonly commit: GitCommit,
		protected readonly unpublished?: boolean,
		public readonly branch?: GitBranch,
		protected readonly getBranchAndTagTips?: (sha: string, options?: { compact?: boolean }) => string | undefined,
		protected readonly _options: { allowFilteredFiles?: boolean; expand?: boolean } = {},
	) {
		super('commit', getCommitGitUri(commit), view, parent);

		this.updateContext({ commit: commit });
		this._uniqueId = getViewNodeId(this.type, this.context);
	}

	override dispose(): void {
		super.dispose();
		this.children = undefined;
	}

	override get id(): string {
		return this._uniqueId;
	}

	override toClipboard(): string {
		return `${this.commit.shortSha}: ${this.commit.summary}`;
	}

	get isTip(): boolean {
		return (this.branch?.current && this.branch.sha === this.commit.ref) ?? false;
	}

	get ref(): GitRevisionReference {
		return this.commit;
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
			const commit = this.commit;

			let children: ViewNode[] = [];
			const commits = await getCommitsForFiles(commit, {
				allowFilteredFiles: this._options.allowFilteredFiles,
				include: { stats: true },
			});
			for (const c of commits) {
				children.push(new CommitFileNode(this.view, this, c.file!, c));
			}

			if (this.view.config.files.layout !== 'list') {
				const hierarchy = makeHierarchical(
					children as FileNode[],
					n => n.uri.relativePath.split('/'),
					(...parts: string[]) => normalizePath(joinPaths(...parts)),
					this.view.config.files.compact,
				);

				const root = new FolderNode(this.view, this, hierarchy, this.repoPath, '', undefined);
				children = root.getChildren() as FileNode[];
			} else {
				(children as FileNode[]).sort((a, b) => sortCompare(a.label!, b.label!));
			}

			this.children = children;
		}

		return this.children;
	}

	async getTreeItem(): Promise<TreeItem> {
		const label = CommitFormatter.fromTemplate(this.view.config.formats.commits.label, this.commit, {
			dateFormat: configuration.get('defaultDateFormat'),
			getBranchAndTagTips: (sha: string) => this.getBranchAndTagTips?.(sha, { compact: true }),
			messageTruncateAtNewLine: true,
		});

		const item = new TreeItem(
			label,
			this._options.expand ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
		);
		item.id = this.id;
		item.contextValue = `${ContextValues.Commit}${this.branch?.current ? '+current' : ''}${
			this.isTip ? '+HEAD' : ''
		}${this.unpublished ? '+unpublished' : ''}`;

		item.description = CommitFormatter.fromTemplate(this.view.config.formats.commits.description, this.commit, {
			dateFormat: configuration.get('defaultDateFormat'),
			getBranchAndTagTips: (sha: string) => this.getBranchAndTagTips?.(sha, { compact: true }),
			messageTruncateAtNewLine: true,
		});

		item.iconPath = this.unpublished
			? new ThemeIcon('arrow-up', new ThemeColor('gitlens-lite.unpublishedCommitIconColor' satisfies Colors))
			: this.view.config.avatars
				? await getCommitAuthorAvatarUri(this.commit, {
						defaultStyle: configuration.get('defaultGravatarsStyle'),
					})
				: undefined;
		// item.tooltip = this.tooltip;

		return item;
	}

	override getCommand(): Command | undefined {
		return createCommand<[undefined, DiffWithPreviousCommandArgs]>(
			'gitlens.diffWithPrevious:views',
			'Open Changes with Previous Revision',
			undefined,
			{
				commit: this.commit,
				uri: this.uri,
				range: null,
				showOptions: { preserveFocus: true, preview: true },
			},
		);
	}

	override refresh(reset?: boolean): void {
		void super.refresh?.(reset);

		this.children = undefined;
		if (reset) {
			this.deleteState();
		}
	}

	override async resolveTreeItem(item: TreeItem, token: CancellationToken): Promise<TreeItem> {
		item.tooltip ??= await this.getTooltip(token);
		return item;
	}

	private async getTooltip(cancellation: CancellationToken) {
		const template = this.getTooltipTemplate();

		const showSignature =
			configuration.get('signing.showSignatureBadges') &&
			!this.commit.isUncommitted &&
			CommitFormatter.has(template, 'signature');

		const [remotesResult, _, signatureResult] = await Promise.allSettled([
			this.view.container.git
				.getRepositoryService(this.commit.repoPath)
				.remotes.getBestRemotesWithProviders(toAbortSignal(cancellation)),
			GitCommit.ensureFullDetails(this.commit, {
				allowFilteredFiles: this._options.allowFilteredFiles,
				include: { stats: true },
			}),
			showSignature
				? pauseOnCancelOrTimeout(
						isCommitSigned(this.commit.repoPath, this.commit.sha),
						toAbortSignal(cancellation),
					)
				: undefined,
		]);

		if (cancellation.isCancellationRequested) return undefined;

		const remotes = getSettledValue(remotesResult, []);
		const signature = getSettledValue(signatureResult);

		const tooltip = await CommitFormatter.fromTemplateAsync(
			template,
			this.commit,
			{ source: 'view:hover' },
			{
				dateFormat: configuration.get('defaultDateFormat'),
				getBranchAndTagTips: this.getBranchAndTagTips,
				messageAutolinks: true,
				messageIndent: 4,
				outputFormat: 'markdown',
				remotes: remotes,
				unpublished: this.unpublished,
				signed: signature?.value === true,
			},
		);

		const markdown = new MarkdownString(tooltip, true);
		markdown.supportHtml = true;
		markdown.isTrusted = true;

		return markdown;
	}

	protected getTooltipTemplate(): string {
		return this.view.config.formats.commits.tooltip;
	}
}
