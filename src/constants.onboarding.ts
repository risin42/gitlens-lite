import type { OnboardingItemDefinition } from './onboarding/models/onboarding.js';

/** Central registry of all dismissible/onboarding keys */
export const onboardingDefinitions = {
	'views:scmGrouped:welcome': { schema: '17.8.0', scope: 'global' },
	'rebaseEditor:closeWarning': { schema: '17.8.0', scope: 'global' },
	'terminal:locationCallout': { schema: '19.1.0', scope: 'global' },
} as const satisfies Record<string, OnboardingItemDefinition<unknown>>;

export type OnboardingKeys = keyof typeof onboardingDefinitions;

/** Extract state type for a specific item key */
export type OnboardingItemState<K extends OnboardingKeys> = (typeof onboardingDefinitions)[K] extends {
	state: infer State;
}
	? State
	: undefined;
