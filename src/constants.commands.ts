import type { ContributedCommands, ContributedPaletteCommands } from './constants.commands.generated.js';
import type {
	CoreViewContainerIds,
	CustomEditorTypes,
	TreeViewIds,
	TreeViewTypes,
	ViewContainerIds,
	ViewIds,
	WebviewPanelTypes,
	WebviewTypes,
	WebviewViewTypes,
} from './constants.views.js';

export const actionCommandPrefix = 'gitlens.action.';

export type GlCommandsDeprecated =
	| 'gitlens.diffHeadWith'
	| 'gitlens.diffWorkingWith'
	| 'gitlens.openBranchesInRemote'
	| 'gitlens.openBranchInRemote'
	| 'gitlens.openCommitInRemote'
	| 'gitlens.openFileInRemote'
	| 'gitlens.openInRemote'
	| 'gitlens.openRepoInRemote'
	| 'gitlens.showFileHistoryInView';

type InternalRebaseEditorCommands = 'gitlens.pausedOperation.showConflicts:rebase';

type InternalScmGroupedViewCommands =
	| 'gitlens.views.scm.grouped.welcome.dismiss'
	| 'gitlens.views.scm.grouped.welcome.restore';

type InternalViewCommands = 'gitlens.views.loadMoreChildren';

type InternalGlCommands =
	| `gitlens.action.${string}`
	| 'gitlens.diffWith'
	| 'gitlens.diffWithPrevious:codelens'
	| 'gitlens.diffWithPrevious:command'
	| 'gitlens.diffWithPrevious:views'
	| 'gitlens.diffWithWorking:command'
	| 'gitlens.diffWithWorking:views'
	| 'gitlens.openOnRemote'
	| 'gitlens.openWorkingFile:command'
	| 'gitlens.refreshHover'
	| 'gitlens.runTaskOnWorktree'
	| 'gitlens.onboarding.dismiss'
	| 'gitlens.showQuickCommitDetails'
	| 'gitlens.toggleFileBlame:codelens'
	| 'gitlens.toggleFileBlame:mode'
	| 'gitlens.toggleFileBlame:statusbar'
	| 'gitlens.toggleFileChanges:codelens'
	| 'gitlens.toggleFileChanges:mode'
	| 'gitlens.toggleFileChanges:statusbar'
	| 'gitlens.toggleFileHeatmap:codelens'
	| 'gitlens.toggleFileHeatmap:mode'
	| 'gitlens.toggleFileHeatmap:statusbar'
	| InternalRebaseEditorCommands
	| InternalScmGroupedViewCommands
	| InternalViewCommands;

export type GlCommands = ContributedCommands | InternalGlCommands; // | GlCommandsDeprecated;
/** Non-webview commands */
export type GlExtensionCommands = Exclude<GlCommands, GlWebviewCommands>;
export type GlPaletteCommands = ContributedPaletteCommands;

export type CoreCommands =
	| '_open.mergeEditor'
	| 'cursorMove'
	| 'editor.action.clipboardPasteAction'
	| 'editor.action.showHover'
	| 'editor.action.showReferences'
	| 'editor.action.webvieweditor.showFind'
	| 'editorScroll'
	| 'list.collapseAllToFocus'
	| 'openInIntegratedTerminal'
	| 'openInTerminal'
	| 'reopenActiveEditorWith' // Requires VS Code 1.100 or later
	| 'revealFileInOS'
	| 'revealInExplorer'
	| 'revealLine'
	| 'setContext'
	| 'vscode.open'
	| 'vscode.openFolder'
	| 'vscode.openWith'
	| 'vscode.changes'
	| 'vscode.diff'
	| 'vscode.executeCodeLensProvider'
	| 'vscode.executeDocumentSymbolProvider'
	| 'vscode.moveViews'
	| 'vscode.previewHtml'
	| 'workbench.action.closeActiveEditor'
	| 'workbench.action.closeAllEditors'
	| 'workbench.action.closeWindow'
	| 'workbench.action.moveEditorToNewWindow'
	| 'workbench.action.focusFirstEditorGroup'
	| 'workbench.action.focusSecondEditorGroup'
	| 'workbench.action.focusThirdEditorGroup'
	| 'workbench.action.focusFourthEditorGroup'
	| 'workbench.action.focusFifthEditorGroup'
	| 'workbench.action.focusSixthEditorGroup'
	| 'workbench.action.focusSeventhEditorGroup'
	| 'workbench.action.focusEighthEditorGroup'
	| 'workbench.action.focusLastEditorGroup'
	| 'workbench.action.focusRightGroup'
	| 'workbench.action.nextEditor'
	| 'workbench.action.newGroupRight'
	| 'workbench.action.openSettings'
	| 'workbench.action.openWalkthrough'
	| 'workbench.action.reopenTextEditor'
	| 'workbench.action.reopenWithEditor'
	| 'workbench.action.reloadWindow'
	| 'workbench.action.terminal.paste'
	| 'workbench.action.terminal.sendSequence'
	| 'workbench.action.focusPanel'
	| 'workbench.action.togglePanel'
	| 'workbench.files.action.focusFilesExplorer'
	| 'workbench.view.explorer'
	| 'workbench.view.extension.gitlensInspect'
	| 'workbench.view.scm'
	| `${ViewContainerIds | CoreViewContainerIds}.resetViewContainerLocation`
	| `${ViewIds}.${'focus' | 'open' | 'removeView' | 'resetViewLocation' | 'toggleVisibility'}`;

export type CoreGitCommands =
	| 'git.commit'
	| 'git.commitAmend'
	| 'git.fetch'
	| 'git.publish'
	| 'git.pull'
	| 'git.pullRebase'
	| 'git.push'
	| 'git.pushForce'
	| 'git.stageAll'
	| 'git.undoCommit'
	| 'git.unstageAll';

type ExtractSuffix<Prefix extends string, U> = U extends `${Prefix}${infer V}` ? V : never;
type FilterCommands<Prefix extends string, U, Suffix extends string = ''> = U extends `${Prefix}${infer V}${Suffix}`
	? U extends `${Prefix}${V}${Suffix}`
		? U
		: never
	: never;

export type GlTreeViewCommands =
	| FilterCommands<`gitlens.views.${TreeViewTypes}`, GlCommands>
	| FilterCommands<`gitlens.`, GlCommands, ':views'>;

export type GlTreeViewCommandsByViewId<T extends TreeViewIds> = FilterCommands<T, GlCommands>;
export type GlTreeViewCommandsByViewType<T extends TreeViewTypes> = FilterCommands<`gitlens.views.${T}.`, GlCommands>;
export type GlTreeViewCommandSuffixesByViewType<T extends TreeViewTypes> = ExtractSuffix<
	`gitlens.views.${T}.`,
	GlTreeViewCommandsByViewType<T>
>;

type CustomEditorOrWebviewPanelCommands<T extends CustomEditorTypes | WebviewPanelTypes> =
	| FilterCommands<`gitlens.${T}`, GlCommands>
	| FilterCommands<'gitlens.', GlCommands, `:${T}`>;

type WebviewViewCommands<T extends WebviewViewTypes> =
	| FilterCommands<`gitlens.views.${T}`, GlCommands>
	| FilterCommands<'gitlens.views.', GlCommands, `:${T}`>
	| FilterCommands<'gitlens.', GlCommands, `:${T}`>;

export type GlWebviewCommands<T extends WebviewTypes = WebviewTypes> =
	| (T extends CustomEditorTypes | WebviewPanelTypes ? CustomEditorOrWebviewPanelCommands<T> : never)
	| (T extends WebviewViewTypes ? WebviewViewCommands<T> : never);

/** Extracts command prefixes (before the type suffix) for use with decorated commands */
type ExtractCommandPrefix<T, U extends string> = T extends `${infer Prefix}:${U}` ? `${Prefix}:` : never;

export type GlWebviewCommandsOrCommandsWithSuffix<T extends WebviewTypes = WebviewTypes> =
	| GlWebviewCommands<T>
	| ExtractCommandPrefix<GlWebviewCommands<T>, T>;
