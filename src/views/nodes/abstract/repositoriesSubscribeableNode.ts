import { Disposable } from 'vscode';
import { trace } from '@gitlens/utils/decorators/log.js';
import { weakEvent } from '@gitlens/utils/event.js';
import type { RepositoriesChangeEvent } from '../../../git/gitProviderService.js';
import { unknownGitUri } from '../../../git/gitUri.js';
import type { View } from '../../viewBase.js';
import { SubscribeableViewNode } from './subscribeableViewNode.js';
import type { ViewNode } from './viewNode.js';

export abstract class RepositoriesSubscribeableNode<
	TView extends View = View,
	TChild extends ViewNode = ViewNode,
> extends SubscribeableViewNode<'repositories', TView, TChild> {
	constructor(view: TView) {
		super('repositories', unknownGitUri, view);
	}

	override async getSplattedChild(): Promise<TChild | undefined> {
		if (this.children == null) {
			await this.getChildren();
		}

		return this.children?.length === 1 ? this.children[0] : undefined;
	}

	protected override etag(): number {
		return this.view.container.git.etag;
	}

	@trace()
	protected subscribe(): Disposable | Promise<Disposable> {
		return Disposable.from(
			weakEvent(this.view.container.git.onDidChangeRepositories, this.onRepositoriesChanged, this),
			weakEvent(this.view.onDidChangeRepositoryFilter, this.onViewRepositoryFilterChanged, this),
		);
	}

	private onRepositoriesChanged(_e: RepositoriesChangeEvent) {
		void this.triggerChange(true);
	}

	private onViewRepositoryFilterChanged() {
		void this.triggerChange(true);
	}
}
