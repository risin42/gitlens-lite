import type { OnboardingItemState, OnboardingKeys } from '../constants.onboarding.js';

/**
 * Migrations are maps of GitLens version → migration function.
 * Each migration transforms data from the previous schema to the version's schema.
 * Migrations run in semver order for all versions between stored and current schema.
 *
 * IMPORTANT: Bumping the `schema` version in `onboardingDefinitions` and adding a corresponding
 * migration entry here are a coupled operation. When the state shape for an item changes:
 *   1. Bump the `schema` version in `constants.onboarding.ts` to the new GitLens version
 *   2. Add a migration entry here keyed by that same version
 * Without both steps, either the migration won't run or data won't be marked as current.
 */
export type OnboardingMigration<T> = Record<`${number}.${number}.${number}`, (state: unknown) => T>;

export const onboardingMigrations: {
	[K in OnboardingKeys]?: OnboardingMigration<OnboardingItemState<K>>;
} = {};
