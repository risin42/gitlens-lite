import type { GitFeatures } from '@gitlens/git/features.js';

// Re-export Git feature types and constants from @gitlens/git
export type { FilteredGitFeatures, GitFeatureOrPrefix, GitFeatures } from '@gitlens/git/features.js';
export { gitFeaturesByVersion, gitMinimumVersion } from '@gitlens/git/features.js';

export type Features = 'stashes' | GitFeatures;
