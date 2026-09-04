export type CustomEditorTypes = 'rebase';
export type CustomEditorIds = `gitlens.${CustomEditorTypes}`;

export type CustomEditorTypeFromId<T extends CustomEditorIds> = T extends `gitlens.${infer U}`
	? U extends CustomEditorTypes
		? U
		: never
	: never;

export type TreeViewTypes =
	| 'branches'
	| 'commits'
	| 'contributors'
	| 'fileHistory'
	| 'scm.grouped'
	| 'lineHistory'
	| 'remotes'
	| 'repositories'
	| 'searchAndCompare'
	| 'stashes'
	| 'tags';
export type TreeViewIds<T extends TreeViewTypes = TreeViewTypes> = `gitlens.views.${T}`;
export type TreeViewTypeFromId<T extends TreeViewIds> = T extends `gitlens.views.${infer U}` ? U : never;

export type GroupableTreeViewTypes = Extract<
	TreeViewTypes,
	| 'branches'
	| 'commits'
	| 'contributors'
	| 'fileHistory'
	| 'remotes'
	| 'repositories'
	| 'searchAndCompare'
	| 'stashes'
	| 'tags'
>;
export type GroupableTreeViewIds<T extends GroupableTreeViewTypes = GroupableTreeViewTypes> = TreeViewIds<T>;

/** Grouped views that require a local repository and are unavailable for virtual repositories */
export const localOnlyGroupedViews: ReadonlySet<GroupableTreeViewTypes> = new Set(['stashes']);

/**
 * Authoritative, ordered list of the groupable views — each entry is
 * compiler-checked against `GroupableTreeViewTypes` (a typo'd entry fails to
 * compile), though unlike the `Extract`-derived union above, this array isn't
 * verified to be exhaustive; a future addition to the union must be added
 * here too. Drives the Settings "GitLens SCM" editor's row order.
 */
export const groupableViewTypes: readonly GroupableTreeViewTypes[] = [
	'commits',
	'branches',
	'remotes',
	'stashes',
	'tags',
	'contributors',
	'repositories',
	'searchAndCompare',
	'fileHistory',
];

/** Display labels for the groupable views, keyed the same as {@link groupableViewTypes}. */
export const groupableViewTypeLabels: Readonly<Record<GroupableTreeViewTypes, string>> = {
	commits: 'Commits',
	branches: 'Branches',
	remotes: 'Remotes',
	stashes: 'Stashes',
	tags: 'Tags',
	contributors: 'Contributors',
	repositories: 'Repositories',
	searchAndCompare: 'Search & Compare',
	fileHistory: 'File History',
};

export type WebviewPanelTypes = 'allowedSigners';
export type WebviewPanelIds = `gitlens.${WebviewPanelTypes}`;

export type WebviewViewTypes = 'commitDetails';
export type WebviewViewIds<T extends WebviewViewTypes = WebviewViewTypes> = `gitlens.views.${T}`;

export type WebviewTypes = CustomEditorTypes | WebviewPanelTypes | WebviewViewTypes;
export type WebviewIds = CustomEditorIds | WebviewPanelIds | WebviewViewIds;

export type WebviewPanelTypeFromId<T extends WebviewPanelIds> = T extends `gitlens.${infer U}`
	? U extends WebviewPanelTypes
		? U
		: never
	: never;
export type WebviewViewTypeFromId<T extends WebviewViewIds> = T extends `gitlens.views.${infer U}`
	? U extends WebviewViewTypes
		? U
		: never
	: never;

export type WebviewTypeFromId<T extends WebviewIds | CustomEditorIds> = T extends CustomEditorIds
	? CustomEditorTypeFromId<T>
	: T extends WebviewPanelIds
		? WebviewPanelTypeFromId<T>
		: T extends WebviewViewIds
			? WebviewViewTypeFromId<T>
			: never;

export type ViewTypes = TreeViewTypes | WebviewViewTypes;
export type ViewIds = TreeViewIds | WebviewViewIds;

export type ViewContainerTypes = 'gitlensInspect';
export type ViewContainerIds = `workbench.view.extension.${ViewContainerTypes}`;

export type CoreViewContainerTypes = 'scm';
export type CoreViewContainerIds = `workbench.view.${CoreViewContainerTypes}`;

export const viewIdsByDefaultContainerId = new Map<ViewContainerIds | CoreViewContainerIds, ViewTypes[]>([
	['workbench.view.scm', ['branches', 'commits', 'remotes', 'repositories', 'stashes', 'tags', 'contributors']],
	['workbench.view.extension.gitlensInspect', ['commitDetails', 'fileHistory', 'lineHistory', 'searchAndCompare']],
]);

export type TreeViewRefNodeTypes = 'branch' | 'commit' | 'stash' | 'tag';
export const treeViewRefNodeTypes: TreeViewRefNodeTypes[] = ['branch', 'commit', 'stash', 'tag'];
export type TreeViewRefFileNodeTypes =
	| 'commit-file'
	| 'file-commit'
	| 'results-file'
	| 'stash-file'
	| 'status-file'
	| 'uncommitted-file';
export const treeViewRefFileNodeTypes: TreeViewRefFileNodeTypes[] = [
	'commit-file',
	'file-commit',
	'results-file',
	'stash-file',
	'status-file',
	'uncommitted-file',
];
export type TreeViewFileNodeTypes = TreeViewRefFileNodeTypes | 'conflict-file';
export const treeViewFileNodeTypes: TreeViewFileNodeTypes[] = [...treeViewRefFileNodeTypes, 'conflict-file'];
export type TreeViewSubscribableNodeTypes =
	| 'autolinks'
	| 'commits-current-branch'
	| 'compare-branch'
	| 'compare-results'
	| 'file-history'
	| 'file-history-tracker'
	| 'line-history'
	| 'line-history-tracker'
	| 'repositories'
	| 'repository'
	| 'repo-folder'
	| 'search-results'
	| 'workspace';
export type TreeViewNodeTypes =
	| TreeViewRefNodeTypes
	| TreeViewFileNodeTypes
	| TreeViewSubscribableNodeTypes
	| 'autolink'
	| 'branch-tag-folder'
	| 'branches'
	| 'contributor'
	| 'contributors'
	| 'conflict-files'
	| 'conflict-current-changes'
	| 'conflict-incoming-changes'
	| 'folder'
	| 'grouping'
	| 'message'
	| 'pager'
	| 'paused-operation-status'
	| 'reflog'
	| 'reflog-record'
	| 'remote'
	| 'remotes'
	| 'results-commits'
	| 'results-files'
	| 'search-compare'
	| 'stashes'
	| 'status-files'
	| 'tags'
	| 'tracking-status'
	| 'tracking-status-files'
	| 'uncommitted-files'
	| 'worktree'
	| 'worktrees';
