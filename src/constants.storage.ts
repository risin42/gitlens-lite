import type { GitHealthSlowness, GitHealthSlownessSample } from '@gitlens/git/gitHealth.js';
import type { GitRevisionRangeNotation } from '@gitlens/git/models/revision.js';
import type { ViewShowBranchComparison } from './config.js';
import type { TrackedUsage, TrackedUsageKeys } from './constants.context.js';
import type { GroupableTreeViewTypes, TreeViewTypes } from './constants.views.js';
import type { OnboardingStorage } from './onboarding/models/onboarding.js';

export type SecretKeys = string;

export const enum SyncedStorageKeys {
	Version = 'gitlens:synced:version',
	ApprovedAvatarRemoteTemplates = 'gitlens:avatars:approvedRemoteTemplates',
}

export type DeprecatedGlobalStorage = {
	pendingWelcomeOnFocus: boolean;
	'views:layout': 'gitlens' | 'scm';
	'views:commitDetails:dismissed': 'sidebar'[];
	'views:welcome:visible': boolean;
	'views:scm:grouped:welcome:dismissed': boolean;
};

export interface GlobalStorage {
	avatars: [string, StoredAvatar][];
	'avatars:approvedRemoteTemplates': Record<string, 'allow' | 'deny'>;
	repoVisibility: [string, StoredRepoVisibilityInfo][];
	pendingWhatsNewOnFocus: boolean;
	'settings:migrated': string[];
	'synced:version': string;
	usages: Record<TrackedUsageKeys, TrackedUsage>;
	version: string;
	'onboarding:state': OnboardingStorage;
}

export type DeprecatedWorkspaceStorage = {
	'views:searchAndCompare:keepResults': boolean;
	'gitHealth:slowness': Record<string, GitHealthSlownessSample>;
	'gitHealth:slowness:v2': Record<string, GitHealthSlownessSample>;
};

export type StoredGitHealthSlowness = GitHealthSlowness;
export type StoredGitHealthBannerSuppression = { dismissedAt?: number; visitedAt?: number };

interface WorkspaceStorageCore {
	assumeRepositoriesOnStartup?: boolean;
	'branch:comparisons': StoredBranchComparisons;
	'gitComandPalette:usage': StoredRecentUsage;
	'gitComandPalette:switch:viaWorktree': Record<string, boolean>;
	'gitComandPalette:worktreeDelete:actions': StoredWorktreeDeleteActions;
	'gitHealth:banner:v1': Record<string, StoredGitHealthBannerSuppression>;
	'gitHealth:slowness:v3': Record<string, StoredGitHealthSlowness>;
	gitPath: string;
	'onboarding:state': OnboardingStorage;
	'starred:repositories': StoredStarred;
	'views:commitDetails:showSearchBox': boolean;
	'views:commitDetails:searchBoxFilter': boolean;
	'views:repositories:autoRefresh': boolean;
	'views:searchAndCompare:pinned': StoredSearchAndCompareItems;
	'views:scm:grouped:selected': GroupableTreeViewTypes;
}

export type RepositoryFilterValue = 'all' | 'exclude-worktrees' | string[] | undefined;

type WorkspaceStorageDynamic = Record<`views:${TreeViewTypes}:repositoryFilter`, RepositoryFilterValue>;

export type WorkspaceStorage = WorkspaceStorageCore & WorkspaceStorageDynamic;

export interface Stored<T, SchemaVersion extends number = 1> {
	v: SchemaVersion;
	data: T;
	timestamp?: number;
}

export interface StoredAvatar {
	uri: string;
	timestamp: number;
}

export type StoredRepositoryVisibility = 'private' | 'public' | 'local';

export interface StoredRepoVisibilityInfo {
	visibility: StoredRepositoryVisibility;
	timestamp: number;
	remotesHash?: string;
}

export interface StoredBranchComparison {
	ref: string;
	label?: string;
	notation: GitRevisionRangeNotation | undefined;
	type: Exclude<ViewShowBranchComparison, false> | undefined;
	checkedFiles?: string[];
}

export type StoredBranchComparisons = Record<string, string | StoredBranchComparison>;

export interface StoredNamedRef {
	label?: string;
	ref: string;
}

export interface StoredComparison {
	type: 'comparison';
	timestamp: number;
	path: string;
	ref1: StoredNamedRef;
	ref2: StoredNamedRef;
	notation?: GitRevisionRangeNotation;
	checkedFiles?: string[];
}

export interface StoredSearch {
	type: 'search';
	timestamp: number;
	path: string;
	labels: {
		label: string;
		queryLabel: string | { label: string; resultsType?: { singular: string; plural: string } };
	};
	search: StoredSearchQuery;
}

export interface StoredSearchQuery {
	pattern: string;
	matchAll?: boolean;
	matchCase?: boolean;
	matchRegex?: boolean;
	matchWholeWord?: boolean;
}

export type StoredSearchAndCompareItem = StoredComparison | StoredSearch;
export type StoredSearchAndCompareItems = Record<string, StoredSearchAndCompareItem>;
export type StoredStarred = Record<string, boolean>;
export type StoredRecentUsage = Record<string, number>;
export type StoredWorktreeDeleteActions = { branch: boolean; upstream: boolean };
