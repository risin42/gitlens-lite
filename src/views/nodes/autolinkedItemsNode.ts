import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import type { GitLog } from '@gitlens/git/models/log.js';
import { GitUri } from '../../git/gitUri.js';
import type { ViewsWithCommits } from '../viewBase.js';
import { CacheableChildrenViewNode } from './abstract/cacheableChildrenViewNode.js';
import type { PageableViewNode, ViewNode } from './abstract/viewNode.js';
import { ContextValues, getViewNodeId } from './abstract/viewNode.js';
import { AutolinkedItemNode } from './autolinkedItemNode.js';
import { LoadMoreNode, MessageNode } from './common.js';

export class AutolinkedItemsNode extends CacheableChildrenViewNode<'autolinks', ViewsWithCommits> {
	constructor(
		view: ViewsWithCommits,
		protected override readonly parent: PageableViewNode,
		public readonly repoPath: string,
		public readonly log: GitLog,
		private expand: boolean,
	) {
		super('autolinks', GitUri.fromRepoPath(repoPath), view, parent);

		this._uniqueId = getViewNodeId(this.type, this.context);
	}

	override get id(): string {
		return this._uniqueId;
	}

	async getChildren(): Promise<ViewNode[]> {
		if (this.children == null) {
			const commits = [...this.log.commits.values()];

			let children: ViewNode[] | undefined;
			if (commits.length) {
				const remote = await this.view.container.git
					.getRepositoryService(this.repoPath)
					.remotes.getBestRemoteWithProvider();
				const combineMessages = commits.map(c => c.message).join('\n');

				const autolinks = await this.view.container.autolinks.getAutolinks(combineMessages, remote);
				children = Array.from(
					autolinks.values(),
					autolink => new AutolinkedItemNode(this.view, this, this.repoPath, autolink, undefined),
				);
			}

			if (!children?.length) {
				children = [new MessageNode(this.view, this, 'No autolinked issues or pull requests could be found.')];
			}

			if (this.log.hasMore) {
				children.push(
					new LoadMoreNode(this.view, this.parent, children.at(-1)!, {
						context: { expandAutolinks: true },
						message: 'Load more commits to search for autolinks',
					}),
				);
			}

			this.children = children;
		}
		return this.children;
	}

	getTreeItem(): TreeItem {
		const item = new TreeItem(
			'Autolinked Issues and Pull Requests',
			this.expand ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
		);
		item.id = this.id;
		item.contextValue = ContextValues.AutolinkedItems;

		return item;
	}
}
