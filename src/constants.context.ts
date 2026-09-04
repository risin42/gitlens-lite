import type { Uri } from 'vscode';
import type { FileAnnotationType } from './config.js';
import type { AnnotationStatus, Keys } from './constants.js';
import type {
	CustomEditorTypes,
	GroupableTreeViewTypes,
	WebviewPanelTypes,
	WebviewViewTypes,
} from './constants.views.js';
import type { Features } from './features.js';

interface CompareSelectedInfo {
	label: string;
	ref: string;
	repoPath: string;
}

interface CompareSelectedFileInfo {
	ref: string;
	repoPath: string | undefined;
	uri: Uri;
}

export type ContextKeys = {
	'gitlens:debugging': boolean;
	'gitlens:disabled': boolean;
	'gitlens:disabledToggleCodeLens': boolean;
	'gitlens:enabled': boolean;
	'gitlens:hasVirtualFolders': boolean;
	/** Indicates that this is the first run of a new install of GitLens */
	'gitlens:install:new': boolean;
	/** Indicates that this is the first run after an upgrade of GitLens */
	'gitlens:install:upgradedFrom': string;
	'gitlens:readonly': boolean;
	'gitlens:rebase:editor:enabled': boolean;
	'gitlens:repos:withRemotes': string[];
	'gitlens:schemes:trackable': string[];
	'gitlens:tabs:annotated': Uri[];
	'gitlens:tabs:annotated:changes': Uri[];
	'gitlens:tabs:annotated:computing': Uri[];
	'gitlens:tabs:blameable': Uri[];
	'gitlens:tabs:tracked': Uri[];
	'gitlens:untrusted': boolean;
	'gitlens:views:canCompare': CompareSelectedInfo;
	'gitlens:views:canCompare:file': CompareSelectedFileInfo;
	'gitlens:views:commits:filtered': boolean;
	'gitlens:views:commits:hideMergeCommits': boolean;
	'gitlens:views:contributors:hideMergeCommits': boolean;
	'gitlens:views:fileHistory:canPin': boolean;
	'gitlens:views:fileHistory:cursorFollowing': boolean;
	'gitlens:views:fileHistory:editorFollowing': boolean;
	'gitlens:views:fileHistory:mode': 'commits' | 'contributors';
	'gitlens:views:lineHistory:editorFollowing': boolean;
	'gitlens:views:repositories:autoRefresh': boolean;
	'gitlens:views:scm:grouped:loading': boolean;
	'gitlens:views:scm:grouped:view': GroupableTreeViewTypes;
	'gitlens:views:scm:grouped:welcome': boolean;
	'gitlens:window:annotated': AnnotationStatus | `${AnnotationStatus}:${FileAnnotationType}`;
} & Record<`gitlens:action:${string}`, number> &
	Record<`gitlens:feature:unsupported:${Features}`, boolean> &
	Record<`gitlens:key:${Keys}`, boolean> &
	Record<`gitlens:views:scm:grouped:views:${GroupableTreeViewTypes}`, boolean> &
	Record<`gitlens:webview:${CustomEditorTypes | WebviewPanelTypes}:visible`, boolean> &
	Record<`gitlens:webviewView:${WebviewViewTypes}:visible`, boolean>;

/** Context carried by local commands to identify their originating view. */
export type Sources = string;
export type Source = { source: Sources; correlationId?: string; detail?: string | Record<string, unknown> };

/** Locally stored usage state for contextual UI; never sent to a server. */
export type TrackedUsage = { count: number; firstUsedAt: number; lastUsedAt: number };
export type TrackedUsageFeatures = string;
export type TrackedUsageKeys = string;
