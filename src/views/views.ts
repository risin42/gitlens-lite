import type { ConfigurationChangeEvent } from 'vscode';
import { Disposable } from 'vscode';
import type { GitContributor } from '@gitlens/git/models/contributor.js';
import type {
	GitBranchReference,
	GitRevisionReference,
	GitStashReference,
	GitTagReference,
} from '@gitlens/git/models/reference.js';
import type { GitRemote } from '@gitlens/git/models/remote.js';
import type { GitWorktree } from '@gitlens/git/models/worktree.js';
import { first } from '@gitlens/utils/iterable.js';
import type { GroupableTreeViewTypes, TreeViewTypes } from '../constants.views.js';
import { localOnlyGroupedViews } from '../constants.views.js';
import type { Container } from '../container.js';
import { executeCommand, executeCoreCommand, registerCommand } from '../system/-webview/command.js';
import { configuration } from '../system/-webview/configuration.js';
import { getContext, setContext } from '../system/-webview/context.js';
import { getViewFocusCommand } from '../system/-webview/vscode/views.js';
import { registerCommitDetailsWebviewView } from '../webviews/commitDetails/registration.js';
import type { WebviewsController } from '../webviews/webviewsController.js';
import { BranchesView } from './branchesView.js';
import { CommitsView } from './commitsView.js';
import { ContributorsView } from './contributorsView.js';
import { FileHistoryView } from './fileHistoryView.js';
import { LineHistoryView } from './lineHistoryView.js';
import type { ViewNode } from './nodes/abstract/viewNode.js';
import { RemotesView } from './remotesView.js';
import { RepositoriesView } from './repositoriesView.js';
import { ScmGroupedView } from './scmGroupedView.js';
import { SearchAndCompareView } from './searchAndCompareView.js';
import { StashesView } from './stashesView.js';
import { TagsView } from './tagsView.js';
import type { RevealOptions, TreeViewByType, ViewsWithRepositoryFolders } from './viewBase.js';
import { ViewCommands } from './viewCommands.js';

const defaultScmGroupedViews = {
	commits: true,
	branches: true,
	remotes: true,
	stashes: true,
	tags: true,
	contributors: true,
	fileHistory: false,
	repositories: false,
	searchAndCompare: false,
} as const;

const allScmGroupedViews = {
	commits: true,
	branches: true,
	remotes: true,
	stashes: true,
	tags: true,
	contributors: true,
	fileHistory: true,
	repositories: true,
	searchAndCompare: true,
} as const;

export class Views implements Disposable {
	private readonly _disposable: Disposable;

	private _lastSelectedScmGroupedView: GroupableTreeViewTypes | undefined;
	get lastSelectedScmGroupedView(): GroupableTreeViewTypes | undefined {
		if (!this._scmGroupedViews?.size) return undefined;

		if (!this._lastSelectedScmGroupedView || !this._scmGroupedViews.has(this._lastSelectedScmGroupedView)) {
			return first(this._scmGroupedViews);
		}

		return this._lastSelectedScmGroupedView;
	}
	set lastSelectedScmGroupedView(type: GroupableTreeViewTypes | undefined) {
		this._lastSelectedScmGroupedView = type;
		void setContext('gitlens:views:scm:grouped:view', type);
		void this.container.storage.storeWorkspace('views:scm:grouped:selected', type).catch();
	}

	private _scmGroupedView: ScmGroupedView | undefined;
	private _scmGroupedViews: Set<GroupableTreeViewTypes> | undefined;
	get scmGroupedViews(): Set<GroupableTreeViewTypes> | undefined {
		return this._scmGroupedViews;
	}

	private _hasVirtualFolders: boolean | undefined;
	constructor(
		private readonly container: Container,
		webviews: WebviewsController,
	) {
		this._disposable = Disposable.from(
			configuration.onDidChange(this.onConfigurationChanged, this),
			container.git.onDidChangeRepositories(this.onRepositoriesChanged, this),
			new ViewCommands(container),
			...this.registerViews(),
			...this.registerWebviewViews(webviews),
			...this.registerCommands(),
		);

		this._lastSelectedScmGroupedView = this.container.storage.getWorkspace(
			'views:scm:grouped:selected',
			configuration.get('views.scm.grouped.default'),
		);
		this.updateScmGroupedViewsRegistration();
	}

	dispose(): void {
		this._scmGroupedView?.dispose();
		this._branchesView?.dispose();
		this._commitsView?.dispose();
		this._contributorsView?.dispose();
		this._fileHistoryView?.dispose();
		this._remotesView?.dispose();
		this._repositoriesView?.dispose();
		this._searchAndCompareView?.dispose();
		this._stashesView?.dispose();
		this._tagsView?.dispose();
		this._disposable.dispose();
	}

	private onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'views.scm.grouped.default')) {
			this.lastSelectedScmGroupedView ??= configuration.get('views.scm.grouped.default');
		}

		if (configuration.changed(e, 'views.scm.grouped.views')) {
			this.updateScmGroupedViewsRegistration();
		}
	}

	private onRepositoriesChanged(): void {
		const hasVirtualFolders = getContext('gitlens:hasVirtualFolders');
		if (this._hasVirtualFolders !== hasVirtualFolders) {
			this._hasVirtualFolders = hasVirtualFolders;
			this.updateScmGroupedViewsRegistration();
		}
	}

	private registerCommands(): Disposable[] {
		return [
			registerCommand('gitlens.views.branches.attach', () => this.toggleScmViewGrouping('branches', true)),
			registerCommand('gitlens.views.scm.grouped.branches.detach', () =>
				this.toggleScmViewGrouping('branches', false),
			),
			registerCommand('gitlens.views.scm.grouped.branches.attach', () =>
				this.toggleScmViewGrouping('branches', true),
			),
			registerCommand('gitlens.views.scm.grouped.branches.visibility.hide', () =>
				this.toggleScmViewVisibility('branches', false),
			),
			registerCommand('gitlens.views.scm.grouped.branches.visibility.show', () =>
				this.toggleScmViewVisibility('branches', true),
			),
			registerCommand('gitlens.views.scm.grouped.branches.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('branches'),
			),
			registerCommand('gitlens.views.commits.attach', () => this.toggleScmViewGrouping('commits', true)),
			registerCommand('gitlens.views.scm.grouped.commits.detach', () =>
				this.toggleScmViewGrouping('commits', false),
			),
			registerCommand('gitlens.views.scm.grouped.commits.attach', () =>
				this.toggleScmViewGrouping('commits', true),
			),
			registerCommand('gitlens.views.scm.grouped.commits.visibility.hide', () =>
				this.toggleScmViewVisibility('commits', false),
			),
			registerCommand('gitlens.views.scm.grouped.commits.visibility.show', () =>
				this.toggleScmViewVisibility('commits', true),
			),
			registerCommand('gitlens.views.scm.grouped.commits.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('commits'),
			),
			registerCommand('gitlens.views.contributors.attach', () =>
				this.toggleScmViewGrouping('contributors', true),
			),
			registerCommand('gitlens.views.scm.grouped.contributors.detach', () =>
				this.toggleScmViewGrouping('contributors', false),
			),
			registerCommand('gitlens.views.scm.grouped.contributors.attach', () =>
				this.toggleScmViewGrouping('contributors', true),
			),
			registerCommand('gitlens.views.scm.grouped.contributors.visibility.hide', () =>
				this.toggleScmViewVisibility('contributors', false),
			),
			registerCommand('gitlens.views.scm.grouped.contributors.visibility.show', () =>
				this.toggleScmViewVisibility('contributors', true),
			),
			registerCommand('gitlens.views.scm.grouped.contributors.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('contributors'),
			),
			registerCommand('gitlens.views.fileHistory.attach', () => this.toggleScmViewGrouping('fileHistory', true)),
			registerCommand('gitlens.views.scm.grouped.fileHistory.detach', () =>
				this.toggleScmViewGrouping('fileHistory', false),
			),
			registerCommand('gitlens.views.scm.grouped.fileHistory.attach', () =>
				this.toggleScmViewGrouping('fileHistory', true),
			),
			registerCommand('gitlens.views.scm.grouped.fileHistory.visibility.hide', () =>
				this.toggleScmViewVisibility('fileHistory', false),
			),
			registerCommand('gitlens.views.scm.grouped.fileHistory.visibility.show', () =>
				this.toggleScmViewVisibility('fileHistory', true),
			),
			registerCommand('gitlens.views.scm.grouped.fileHistory.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('fileHistory'),
			),
			registerCommand('gitlens.views.remotes.attach', () => this.toggleScmViewGrouping('remotes', true)),
			registerCommand('gitlens.views.scm.grouped.remotes.detach', () =>
				this.toggleScmViewGrouping('remotes', false),
			),
			registerCommand('gitlens.views.scm.grouped.remotes.attach', () =>
				this.toggleScmViewGrouping('remotes', true),
			),
			registerCommand('gitlens.views.scm.grouped.remotes.visibility.hide', () =>
				this.toggleScmViewVisibility('remotes', false),
			),
			registerCommand('gitlens.views.scm.grouped.remotes.visibility.show', () =>
				this.toggleScmViewVisibility('remotes', true),
			),
			registerCommand('gitlens.views.scm.grouped.remotes.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('remotes'),
			),
			registerCommand('gitlens.views.repositories.attach', () =>
				this.toggleScmViewGrouping('repositories', true),
			),
			registerCommand('gitlens.views.scm.grouped.repositories.detach', () =>
				this.toggleScmViewGrouping('repositories', false),
			),
			registerCommand('gitlens.views.scm.grouped.repositories.attach', () =>
				this.toggleScmViewGrouping('repositories', true),
			),
			registerCommand('gitlens.views.scm.grouped.repositories.visibility.hide', () =>
				this.toggleScmViewVisibility('repositories', false),
			),
			registerCommand('gitlens.views.scm.grouped.repositories.visibility.show', () =>
				this.toggleScmViewVisibility('repositories', true),
			),
			registerCommand('gitlens.views.scm.grouped.repositories.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('repositories'),
			),
			registerCommand('gitlens.views.searchAndCompare.attach', () =>
				this.toggleScmViewGrouping('searchAndCompare', true),
			),
			registerCommand('gitlens.views.scm.grouped.searchAndCompare.detach', () =>
				this.toggleScmViewGrouping('searchAndCompare', false),
			),
			registerCommand('gitlens.views.scm.grouped.searchAndCompare.attach', () =>
				this.toggleScmViewGrouping('searchAndCompare', true),
			),
			registerCommand('gitlens.views.scm.grouped.searchAndCompare.visibility.hide', () =>
				this.toggleScmViewVisibility('searchAndCompare', false),
			),
			registerCommand('gitlens.views.scm.grouped.searchAndCompare.visibility.show', () =>
				this.toggleScmViewVisibility('searchAndCompare', true),
			),
			registerCommand('gitlens.views.scm.grouped.searchAndCompare.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('searchAndCompare'),
			),
			registerCommand('gitlens.views.stashes.attach', () => this.toggleScmViewGrouping('stashes', true)),
			registerCommand('gitlens.views.scm.grouped.stashes.detach', () =>
				this.toggleScmViewGrouping('stashes', false),
			),
			registerCommand('gitlens.views.scm.grouped.stashes.attach', () =>
				this.toggleScmViewGrouping('stashes', true),
			),
			registerCommand('gitlens.views.scm.grouped.stashes.visibility.hide', () =>
				this.toggleScmViewVisibility('stashes', false),
			),
			registerCommand('gitlens.views.scm.grouped.stashes.visibility.show', () =>
				this.toggleScmViewVisibility('stashes', true),
			),
			registerCommand('gitlens.views.scm.grouped.stashes.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('stashes'),
			),
			registerCommand('gitlens.views.tags.attach', () => this.toggleScmViewGrouping('tags', true)),
			registerCommand('gitlens.views.scm.grouped.tags.detach', () => this.toggleScmViewGrouping('tags', false)),
			registerCommand('gitlens.views.scm.grouped.tags.attach', () => this.toggleScmViewGrouping('tags', true)),
			registerCommand('gitlens.views.scm.grouped.tags.visibility.hide', () =>
				this.toggleScmViewVisibility('tags', false),
			),
			registerCommand('gitlens.views.scm.grouped.tags.visibility.show', () =>
				this.toggleScmViewVisibility('tags', true),
			),
			registerCommand('gitlens.views.scm.grouped.tags.setAsDefault', () =>
				this.setAsScmGroupedDefaultView('tags'),
			),
			registerCommand('gitlens.views.scm.grouped.branches', () => this.setScmGroupedView('branches', true)),
			registerCommand('gitlens.views.scm.grouped.commits', () => this.setScmGroupedView('commits', true)),
			registerCommand('gitlens.views.scm.grouped.contributors', () =>
				this.setScmGroupedView('contributors', true),
			),
			registerCommand('gitlens.views.scm.grouped.fileHistory', () => this.setScmGroupedView('fileHistory', true)),
			registerCommand('gitlens.views.scm.grouped.remotes', () => this.setScmGroupedView('remotes', true)),
			registerCommand('gitlens.views.scm.grouped.repositories', () =>
				this.setScmGroupedView('repositories', true),
			),
			registerCommand('gitlens.views.scm.grouped.searchAndCompare', () =>
				this.setScmGroupedView('searchAndCompare', true),
			),
			registerCommand('gitlens.views.scm.grouped.stashes', () => this.setScmGroupedView('stashes', true)),
			registerCommand('gitlens.views.scm.grouped.tags', () => this.setScmGroupedView('tags', true)),
			registerCommand('gitlens.views.scm.grouped.refresh', () => {
				if (this._scmGroupedView?.view == null) return;

				executeCommand(`gitlens.views.${this._scmGroupedView.view.type}.refresh`);
			}),
			registerCommand('gitlens.views.scm.grouped.attachAll', () =>
				updateScmGroupedViewsInConfig(getGroupedViews(allScmGroupedViews)),
			),
			registerCommand('gitlens.views.scm.grouped.detachAll', () => updateScmGroupedViewsInConfig(new Set())),
			registerCommand('gitlens.views.scm.grouped.resetAll', () =>
				updateScmGroupedViewsInConfig(getGroupedViews(defaultScmGroupedViews)),
			),
		];
	}

	private registerViews(): Disposable[] {
		return [(this._lineHistoryView = new LineHistoryView(this.container))];
	}

	private registerWebviewViews(webviews: WebviewsController) {
		return [(this._commitDetailsView = registerCommitDetailsWebviewView(webviews))];
	}

	private readonly _scmGroupedViewProxyCache = new Map<
		GroupableTreeViewTypes,
		TreeViewByType[GroupableTreeViewTypes]
	>();

	private getScmGroupedView<T extends GroupableTreeViewTypes>(type: T): TreeViewByType[T] {
		let proxy = this._scmGroupedViewProxyCache.get(type) as TreeViewByType[T] | undefined;
		if (proxy != null) return proxy;

		// oxlint-disable-next-line typescript/no-unsafe-function-type
		const methodCache = new Map<string | symbol, Function | undefined>();

		// Use a proxy to lazily initialize the view (guard against the view not existing or having been disposed) and cache method bindings for performance

		let view: TreeViewByType[T] | undefined;
		const ensureView = () => {
			if (view == null || view.disposed) {
				methodCache.clear();

				if (this._scmGroupedView == null) {
					this.updateScmGroupedViewsRegistration(true);
				}
				view = this._scmGroupedView!.setView(type);
				if (view == null) {
					debugger;
					throw new Error(`Unable to initialize view: ${type}`);
				}
			}
			return view;
		};

		proxy = new Proxy<TreeViewByType[T]>(Object.create(null) as TreeViewByType[T], {
			get: function (_, prop) {
				// Fast path for visibility check
				if (prop === 'visible') {
					return view != null && !view.disposed && view.visible;
				}

				const target = ensureView();
				const value = Reflect.get(target, prop, target);

				// Fast return for non-functions
				if (typeof value !== 'function') return value;

				// Check method cache
				let method = methodCache.get(prop);
				if (method == null) {
					method = value.bind(target);
					methodCache.set(prop, method);
				}
				return method;
			},
			set: function (_target, prop, value, receiver) {
				return Reflect.set(ensureView(), prop, value, receiver);
			},
			has: function (_target, prop) {
				return Reflect.has(ensureView(), prop);
			},
			getOwnPropertyDescriptor: function (_target, prop) {
				return Reflect.getOwnPropertyDescriptor(ensureView(), prop);
			},
			defineProperty: function (_target, prop, descriptor) {
				return Reflect.defineProperty(ensureView(), prop, descriptor);
			},
			deleteProperty: function (_target, prop) {
				return Reflect.deleteProperty(ensureView(), prop);
			},
			ownKeys: function (_target) {
				return Reflect.ownKeys(ensureView());
			},
		});

		this._scmGroupedViewProxyCache.set(type, proxy);
		return proxy;
	}

	private async setAsScmGroupedDefaultView(type: GroupableTreeViewTypes) {
		this.lastSelectedScmGroupedView = type;
		await configuration.updateEffective('views.scm.grouped.default', type);
	}

	private async setScmGroupedView<T extends GroupableTreeViewTypes>(type: T, focus?: boolean) {
		if (this._scmGroupedView != null) {
			await this._scmGroupedView.clearView(type);
			return this._scmGroupedView.setView(type, { focus: focus, preventReveal: !focus });
		}

		if (!this.scmGroupedViews?.has(type)) {
			type = this.scmGroupedViews?.size ? (first(this.scmGroupedViews) as T) : undefined!;
		}
		this.lastSelectedScmGroupedView = type;

		if (focus) {
			void executeCoreCommand(getViewFocusCommand('gitlens.views.scm.grouped'), { preserveFocus: false });
		}

		return undefined;
	}

	private async toggleScmViewGrouping(type: GroupableTreeViewTypes, grouped: boolean) {
		if (this._scmGroupedViews == null) return;

		if (grouped) {
			if (!this._scmGroupedViews.has(type)) {
				this._scmGroupedViews.add(type);
				this.lastSelectedScmGroupedView = type;
			}
		} else if (this._scmGroupedViews.has(type)) {
			this._scmGroupedViews.delete(type);
			if (type === this.lastSelectedScmGroupedView) {
				this.lastSelectedScmGroupedView = first(this._scmGroupedViews);
			}
		}

		await updateScmGroupedViewsInConfig(this._scmGroupedViews);

		// Show the view after the configuration change has been applied
		setTimeout(() => executeCoreCommand(getViewFocusCommand(`gitlens.views.${grouped ? 'scm.grouped' : type}`), 1));
	}

	private toggleScmViewVisibility(type: GroupableTreeViewTypes, visible: boolean) {
		const hiddenViews = configuration.get(`views.scm.grouped.hiddenViews`);
		hiddenViews[type] = !visible;
		configuration.updateEffective(`views.scm.grouped.hiddenViews`, hiddenViews);

		if (visible) {
			void this.container.views.showView(type);
		}
	}

	private updateScmGroupedViewsRegistration(_bypassWelcomeView?: boolean) {
		void setContext('gitlens:views:scm:grouped:welcome', false);

		this._scmGroupedViews = getScmGroupedViewsFromConfig();
		if (getContext('gitlens:hasVirtualFolders')) {
			for (const view of localOnlyGroupedViews) {
				this._scmGroupedViews.delete(view);
			}
		}

		if (this._scmGroupedViews.size) {
			if (this._scmGroupedView == null) {
				this._scmGroupedView = new ScmGroupedView(this.container, this);
			} else {
				void this.setScmGroupedView(this.lastSelectedScmGroupedView ?? first(this._scmGroupedViews.keys())!);
			}
		} else {
			this._scmGroupedView?.dispose();
			this._scmGroupedView = undefined;
		}

		if (!this._scmGroupedViews.has('branches')) {
			this._branchesView ??= new BranchesView(this.container);
		} else {
			this._branchesView?.dispose();
			this._branchesView = undefined;
		}

		if (!this._scmGroupedViews.has('commits')) {
			this._commitsView ??= new CommitsView(this.container);
		} else {
			this._commitsView?.dispose();
			this._commitsView = undefined;
		}

		if (!this._scmGroupedViews.has('contributors')) {
			this._contributorsView ??= new ContributorsView(this.container);
		} else {
			this._contributorsView?.dispose();
			this._contributorsView = undefined;
		}

		if (!this._scmGroupedViews.has('fileHistory')) {
			this._fileHistoryView ??= new FileHistoryView(this.container);
		} else {
			this._fileHistoryView?.dispose();
			this._fileHistoryView = undefined;
		}

		if (!this._scmGroupedViews.has('remotes')) {
			this._remotesView ??= new RemotesView(this.container);
		} else {
			this._remotesView?.dispose();
			this._remotesView = undefined;
		}

		if (!this._scmGroupedViews.has('repositories')) {
			this._repositoriesView ??= new RepositoriesView(this.container);
		} else {
			this._repositoriesView?.dispose();
			this._repositoriesView = undefined;
		}

		if (!this._scmGroupedViews.has('searchAndCompare')) {
			this._searchAndCompareView ??= new SearchAndCompareView(this.container);
		} else {
			this._searchAndCompareView?.dispose();
			this._searchAndCompareView = undefined;
		}

		if (!this._scmGroupedViews.has('stashes')) {
			this._stashesView ??= new StashesView(this.container);
		} else {
			this._stashesView?.dispose();
			this._stashesView = undefined;
		}

		if (!this._scmGroupedViews.has('tags')) {
			this._tagsView ??= new TagsView(this.container);
		} else {
			this._tagsView?.dispose();
			this._tagsView = undefined;
		}
	}

	private _branchesView: BranchesView | undefined;
	get branches(): BranchesView {
		return this._branchesView ?? this.getScmGroupedView('branches');
	}

	private _commitsView: CommitsView | undefined;
	get commits(): CommitsView {
		return this._commitsView ?? this.getScmGroupedView('commits');
	}

	private _commitDetailsView!: ReturnType<typeof registerCommitDetailsWebviewView>;
	get commitDetails(): ReturnType<typeof registerCommitDetailsWebviewView> {
		return this._commitDetailsView;
	}

	private _contributorsView: ContributorsView | undefined;
	get contributors(): ContributorsView {
		return this._contributorsView ?? this.getScmGroupedView('contributors');
	}

	private _fileHistoryView!: FileHistoryView | undefined;
	get fileHistory(): FileHistoryView {
		return this._fileHistoryView ?? this.getScmGroupedView('fileHistory');
	}

	private _lineHistoryView!: LineHistoryView;
	// get lineHistory(): LineHistoryView {
	// 	return this._lineHistoryView;
	// }

	private _remotesView: RemotesView | undefined;
	get remotes(): RemotesView {
		return this._remotesView ?? this.getScmGroupedView('remotes');
	}

	private _repositoriesView!: RepositoriesView | undefined;
	get repositories(): RepositoriesView {
		return this._repositoriesView ?? this.getScmGroupedView('repositories');
	}

	private _searchAndCompareView: SearchAndCompareView | undefined;
	get searchAndCompare(): SearchAndCompareView {
		return this._searchAndCompareView ?? this.getScmGroupedView('searchAndCompare');
	}

	private _stashesView: StashesView | undefined;
	get stashes(): StashesView {
		return this._stashesView ?? this.getScmGroupedView('stashes');
	}

	private _tagsView: TagsView | undefined;
	get tags(): TagsView {
		return this._tagsView ?? this.getScmGroupedView('tags');
	}

	async revealBranch(branch: GitBranchReference, options?: RevealOptions): Promise<ViewNode | undefined> {
		const branches = branch.remote ? this.remotes : this.branches;
		const view = branches.canReveal ? branches : this.repositories;

		const node = await view.revealBranch(branch, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealCommit(commit: GitRevisionReference, options?: RevealOptions): Promise<ViewNode | undefined> {
		const { commits } = this;
		const view = commits.canReveal ? commits : this.repositories;

		const node = await view.revealCommit(commit, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealContributor(contributor: GitContributor, options?: RevealOptions): Promise<ViewNode | undefined> {
		const { contributors } = this;
		const view = contributors.canReveal ? contributors : this.repositories;

		const node = await view.revealContributor(contributor, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealRemote(remote: GitRemote | undefined, options?: RevealOptions): Promise<ViewNode | undefined> {
		const { remotes } = this;
		const view = remotes.canReveal ? remotes : this.repositories;

		const node = remote != null ? await view.revealRemote(remote, options) : undefined;
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealRepository(
		repoPath: string,
		useView?: ViewsWithRepositoryFolders,
		options?: RevealOptions,
	): Promise<ViewNode | undefined> {
		const view = useView == null || useView.canReveal === false ? this.repositories : useView;

		const node = await view.revealRepository(repoPath, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealStash(stash: GitStashReference, options?: RevealOptions): Promise<ViewNode | undefined> {
		const { stashes } = this;
		const view = stashes.canReveal ? stashes : this.repositories;

		const node = await view.revealStash(stash, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealTag(tag: GitTagReference, options?: RevealOptions): Promise<ViewNode | undefined> {
		const { tags } = this;
		const view = tags.canReveal ? tags : this.repositories;

		const node = await view.revealTag(tag, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async revealWorktree(worktree: GitWorktree, options?: RevealOptions): Promise<ViewNode | undefined> {
		const view = this.repositories;
		const node = await view.revealWorktree(worktree, options);
		await view.show({ preserveFocus: !options?.focus });
		return node;
	}

	async showView(view: TreeViewTypes): Promise<void> {
		const show = async (
			type: GroupableTreeViewTypes,
			view: TreeViewByType[GroupableTreeViewTypes] | undefined,
		): Promise<void> => {
			if (view != null) return view.show();

			await this.setScmGroupedView(type, true);
		};

		switch (view) {
			case 'branches':
				return show('branches', this._branchesView);
			case 'commits':
				return show('commits', this._commitsView);
			case 'contributors':
				return show('contributors', this._contributorsView);
			case 'fileHistory':
				return show('fileHistory', this._fileHistoryView);
			case 'lineHistory':
				return this._lineHistoryView.show();
			case 'remotes':
				return show('remotes', this._remotesView);
			case 'repositories':
				return show('repositories', this._repositoriesView);
			case 'searchAndCompare':
				return show('searchAndCompare', this._searchAndCompareView);
			case 'stashes':
				return show('stashes', this._stashesView);
			case 'tags':
				return show('tags', this._tagsView);
			case 'scm.grouped':
				return void executeCoreCommand(getViewFocusCommand('gitlens.views.scm.grouped'));
		}
	}
}

function getGroupedViews(cfg: Readonly<Record<GroupableTreeViewTypes, boolean>>) {
	const groupedViews = new Set<GroupableTreeViewTypes>();

	for (const [key, value] of Object.entries(cfg) as [GroupableTreeViewTypes, boolean][]) {
		if (value) {
			groupedViews.add(key);
		}
		void setContext(`gitlens:views:scm:grouped:views:${key}`, value);
	}

	return groupedViews;
}

function getScmGroupedViewsFromConfig() {
	const groupedViewsCfg = {
		...defaultScmGroupedViews,
		...configuration.get('views.scm.grouped.views', undefined, defaultScmGroupedViews),
	};

	return getGroupedViews(groupedViewsCfg);
}

async function updateScmGroupedViewsInConfig(groupedViews: Set<GroupableTreeViewTypes>) {
	await configuration.updateEffective('views.scm.grouped.views', {
		commits: groupedViews.has('commits'),
		branches: groupedViews.has('branches'),
		remotes: groupedViews.has('remotes'),
		stashes: groupedViews.has('stashes'),
		tags: groupedViews.has('tags'),
		contributors: groupedViews.has('contributors'),
		fileHistory: groupedViews.has('fileHistory'),
		repositories: groupedViews.has('repositories'),
		searchAndCompare: groupedViews.has('searchAndCompare'),
	});
}
