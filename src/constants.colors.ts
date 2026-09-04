import type { configurationPrefix } from './constants.js';

export type Colors =
	| `${typeof configurationPrefix}.closedAutolinkedIssueIconColor`
	| `${typeof configurationPrefix}.closedPullRequestIconColor`
	| `${typeof configurationPrefix}.decorations.addedForegroundColor`
	| `${typeof configurationPrefix}.decorations.branchAheadForegroundColor`
	| `${typeof configurationPrefix}.decorations.branchBehindForegroundColor`
	| `${typeof configurationPrefix}.decorations.branchDivergedForegroundColor`
	| `${typeof configurationPrefix}.decorations.branchMissingUpstreamForegroundColor`
	| `${typeof configurationPrefix}.decorations.branchUpToDateForegroundColor`
	| `${typeof configurationPrefix}.decorations.branchUnpublishedForegroundColor`
	| `${typeof configurationPrefix}.decorations.copiedForegroundColor`
	| `${typeof configurationPrefix}.decorations.deletedForegroundColor`
	| `${typeof configurationPrefix}.decorations.ignoredForegroundColor`
	| `${typeof configurationPrefix}.decorations.modifiedForegroundColor`
	| `${typeof configurationPrefix}.decorations.statusMergingOrRebasingConflictForegroundColor`
	| `${typeof configurationPrefix}.decorations.statusMergingOrRebasingForegroundColor`
	| `${typeof configurationPrefix}.decorations.renamedForegroundColor`
	| `${typeof configurationPrefix}.decorations.statusPausedOperationReadyForegroundColor`
	| `${typeof configurationPrefix}.decorations.untrackedForegroundColor`
	| `${typeof configurationPrefix}.decorations.workspaceCurrentForegroundColor`
	| `${typeof configurationPrefix}.decorations.workspaceRepoMissingForegroundColor`
	| `${typeof configurationPrefix}.decorations.workspaceRepoOpenForegroundColor`
	| `${typeof configurationPrefix}.decorations.worktreeHasUncommittedChangesForegroundColor`
	| `${typeof configurationPrefix}.decorations.worktreeMissingForegroundColor`
	| `${typeof configurationPrefix}.gutterBackgroundColor`
	| `${typeof configurationPrefix}.gutterForegroundColor`
	| `${typeof configurationPrefix}.gutterUncommittedForegroundColor`
	| `${typeof configurationPrefix}.lineHighlightBackgroundColor`
	| `${typeof configurationPrefix}.lineHighlightOverviewRulerColor`
	| `${typeof configurationPrefix}.mergedPullRequestIconColor`
	| `${typeof configurationPrefix}.openAutolinkedIssueIconColor`
	| `${typeof configurationPrefix}.openPullRequestIconColor`
	| `${typeof configurationPrefix}.trailingLineBackgroundColor`
	| `${typeof configurationPrefix}.trailingLineForegroundColor`
	| `${typeof configurationPrefix}.unpublishedChangesIconColor`
	| `${typeof configurationPrefix}.unpublishedCommitIconColor`
	| `${typeof configurationPrefix}.unpulledChangesIconColor`;

export type CoreColors =
	| 'editorOverviewRuler.addedForeground'
	| 'editorOverviewRuler.deletedForeground'
	| 'editorOverviewRuler.modifiedForeground'
	| 'list.foreground'
	| 'list.warningForeground'
	| 'statusBarItem.warningBackground';
