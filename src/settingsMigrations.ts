import { configuration } from './system/-webview/configuration.js';
import type { Storage } from './system/-webview/storage.js';

export type SettingsMigration = {
	/** Stable identifier, tracked in the `settings:migrated` storage key */
	id: string;
	/** What the migration does — shown in the `Reset Stored Data → Migrations` picker */
	description: string;
	/** Live state worth surfacing in the picker (e.g. a still-armed deferred step) */
	status?: (storage: Storage) => string | undefined;
	migrate: (storage: Storage) => Promise<void>;
};

// One-time settings migrations, each identified by a stable `id` and applied at most once per
// install (tracked by id in the `settings:migrated` storage key). Append new entries — no
// per-migration storage key, and no reliance on the install version. Migrations MUST be
// idempotent (a fresh install runs them as no-ops).
export const settingsMigrations: SettingsMigration[] = [
	{
		// Replace the boolean `terminalLinks.showDetailsView` with the `terminalLinks.showIn` enum.
		// Old default (`true` = show the Inspect view) maps to `inspect`; `false` maps to `quickpick`.
		// Unset users fall through to the `inspect` default.
		id: 'terminalLinks.showIn:enum',
		description:
			"Replaced the boolean 'terminalLinks.showDetailsView' setting with the 'terminalLinks.showIn' enum",
		migrate: async () => {
			await configuration.migrate('terminalLinks.showDetailsView', 'terminalLinks.showIn', {
				migrationFn: (v: unknown) => (v === false ? 'quickpick' : 'inspect'),
			});
		},
	},
];
