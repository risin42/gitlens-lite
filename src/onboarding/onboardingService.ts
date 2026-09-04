import type { Event } from 'vscode';
import { Disposable, EventEmitter } from 'vscode';
import { Logger } from '@gitlens/utils/logger.js';
import { updateRecordValue } from '@gitlens/utils/object.js';
import type { Deferred } from '@gitlens/utils/promise.js';
import { defer } from '@gitlens/utils/promise.js';
import { compare, fromString, fromVersion, satisfies } from '@gitlens/utils/version.js';
import type { OnboardingItemState, OnboardingKeys } from '../constants.onboarding.js';
import { onboardingDefinitions } from '../constants.onboarding.js';
import { registerCommand } from '../system/-webview/command.js';
import { configuration } from '../system/-webview/configuration.js';
import type { Storage, StorageChangeEvent, StorageType } from '../system/-webview/storage.js';
import type { OnboardingItem, OnboardingStorage } from './models/onboarding.js';
import { onboardingMigrations } from './onboardingMigrations.js';

export interface OnboardingChangeEvent {
	readonly key: OnboardingKeys;
	readonly dismissed: boolean;
}

type OnboardingStorageType = StorageType;

/**
 * Centralized service for managing dismissible/onboarding UI state.
 *
 * Provides a unified API for checking, dismissing, and resetting onboarding items,
 * with built-in versioning support to re-show items after significant changes,
 * and typed data storage with schema migrations.
 */
export class OnboardingService implements Disposable {
	private readonly _onDidChange = new EventEmitter<OnboardingChangeEvent>();
	get onDidChange(): Event<OnboardingChangeEvent> {
		return this._onDidChange.event;
	}

	private readonly _disposable: Disposable;
	/**
	 * Shallow copy of each scope's `items` as of the last read/write this instance observed — used only
	 * to diff same-window external changes (e.g. `storage.reset()`) in `onStorageChanged`. Item records
	 * are replaced (never mutated in place), so a shallow copy stays a stable snapshot even though the
	 * memento can hand back the same underlying object on every `get`. `undefined` means "never seen" —
	 * the first sight of a scope only primes the snapshot, it doesn't diff.
	 */
	private readonly _lastSeen: {
		[key in OnboardingStorageType]: Record<string, OnboardingItem<unknown>> | undefined;
	} = {
		global: undefined,
		workspace: undefined,
	};
	private readonly _ready: Deferred<void>;
	private _version: `${number}.${number}.${number}`;

	constructor(
		private readonly storage: Storage,
		version: string,
		/** Commands are a process-wide singleton surface — VS Code throws on a duplicate id — so an
		 *  instance beyond the container's own (tests) must opt out of claiming them. */
		options?: { registerCommands?: boolean },
	) {
		this._version = fromVersion(fromString(version), false);
		this._ready = defer<void>();
		this._disposable = Disposable.from(
			this.storage.onDidChange(this.onStorageChanged, this),
			...((options?.registerCommands ?? true)
				? [
						registerCommand('gitlens.onboarding.dismiss', args => {
							if (args.id in onboardingDefinitions) {
								void this.dismiss(args.id);
							} else {
								debugger;
								Logger.warn(`Unknown onboarding key: ${args.id}`);
							}
						}),
					]
				: []),
		);

		this._ready.fulfill(undefined);
	}

	/** Promise that resolves when the service is ready for use. */
	get ready(): Promise<void> {
		return this._ready.promise;
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._disposable.dispose();
	}

	private onStorageChanged(e: StorageChangeEvent): void {
		if (!e.keys.includes('onboarding:state')) return;

		const previousItems = this._lastSeen[e.type];
		const currentState = this.getOnboarding(e.type);
		this._lastSeen[e.type] = { ...currentState.items };

		// Own writes already updated `_lastSeen` (in `saveOnboarding`/`resetAll`) before triggering this
		// event, so the diff below sees no delta for them — only same-window external changes (e.g.
		// `storage.reset()`) produce one. `previousItems == null` means this is the first sight of the
		// scope — prime the snapshot without diffing.
		if (previousItems == null) return;

		const keys = new Set([...Object.keys(previousItems), ...Object.keys(currentState.items)]);
		for (const key of keys) {
			const previous = previousItems[key]?.dismissedAt != null;
			const current = currentState.items[key]?.dismissedAt != null;

			if (previous !== current) {
				this._onDidChange.fire({ key: key as OnboardingKeys, dismissed: current });
			}
		}
	}

	/**
	 * Checks if an onboarding item is dismissed
	 * Respects `reshowAfter` - if the user dismissed before that version, returns false
	 */
	isDismissed(key: OnboardingKeys): boolean {
		// `advanced.skipOnboarding` opts out of onboarding entirely — treat every dismissible surface as
		// already dismissed so this is the single, service-wide switch (no per-call-site checks). Gated to
		// post-init so the setting is applied consistently after construction.
		if (!this._ready.pending && configuration.get('advanced.skipOnboarding')) return true;

		const item = this.getItem(key);
		if (!item?.dismissedAt) {
			return false;
		}

		// If reshowAfter is set and user dismissed before that version, re-show
		const { reshowAfter } = onboardingDefinitions[key] as { reshowAfter?: `${number}.${number}.${number}` };
		if (reshowAfter && item.dismissedVersion) {
			if (satisfies(item.dismissedVersion, `< ${reshowAfter}`)) {
				return false;
			}
		}

		return true;
	}

	/** Dismiss an onboarding item, recording the current timestamp and GitLens version */
	async dismiss(key: OnboardingKeys): Promise<void> {
		const { scope } = onboardingDefinitions[key];

		const onboarding = this.getOnboarding(scope);
		const existing = onboarding.items[key];

		onboarding.items[key] = {
			...existing,
			dismissedAt: new Date().toISOString(),
			dismissedVersion: this._version,
		};

		await this.saveOnboarding(scope, onboarding, key);
		this._onDidChange.fire({ key: key, dismissed: true });
	}

	/** Get item state, running migrations if needed */
	getItemState<T extends OnboardingKeys>(key: T): OnboardingItemState<T> | undefined {
		const item = this.getItem(key);
		if (!item?.state) return undefined;

		const { schema: currentSchema, scope } = onboardingDefinitions[key];
		const storedSchema = item.schema;

		// No schema defined or already current - no migration needed
		if (!currentSchema || (storedSchema && compare(storedSchema, currentSchema) >= 0)) {
			return item.state;
		}

		// Run migrations in version order for versions between stored and current
		const migrations = onboardingMigrations[key];
		let state: OnboardingItemState<T> = item.state;

		if (migrations) {
			// Sort migration versions and run applicable ones
			const migrationVersions = Object.keys(migrations).sort((a, b) => compare(a, b));

			for (const version of migrationVersions) {
				// Skip migrations at or before stored schema
				if (storedSchema && compare(version, storedSchema) <= 0) {
					continue;
				}

				// Skip migrations after current schema
				if (compare(version, currentSchema) > 0) {
					continue;
				}

				const migrate = migrations[version as `${number}.${number}.${number}`];
				if (migrate) {
					state = migrate(state);
				}
			}
		}

		// Persist migrated data so we don't re-migrate next time
		void this.setItemStateCore(key, state, scope, currentSchema);

		return state;
	}

	/** Set typed data for an item */
	async setItemState<T extends OnboardingKeys>(key: T, state: OnboardingItemState<T>): Promise<void> {
		const { scope, schema } = onboardingDefinitions[key];
		await this.setItemStateCore(key, state, scope, schema);
	}

	/** Resets a specific onboarding item */
	async reset(key: OnboardingKeys): Promise<void> {
		const { scope } = onboardingDefinitions[key];

		const onboarding = this.getOnboarding(scope);
		const dismissed = onboarding.items[key]?.dismissedAt != null;

		onboarding.items = updateRecordValue(onboarding.items, key, undefined);

		await this.saveOnboarding(scope, onboarding, key);
		if (dismissed) {
			this._onDidChange.fire({ key: key, dismissed: false });
		}
	}

	/** Resets all onboarding state */
	async resetAll(): Promise<void> {
		// Collect previously dismissed keys before clearing — use getOnboarding()
		// to ensure storage is read (not just the cache) so change events fire correctly
		const dismissedKeys: OnboardingKeys[] = [];
		for (const scope of ['global', 'workspace'] as const) {
			const onboarding = this.getOnboarding(scope);
			for (const [key, item] of Object.entries(onboarding.items)) {
				if (item?.dismissedAt != null) {
					dismissedKeys.push(key as OnboardingKeys);
				}
			}
		}

		this._lastSeen.global = {};
		this._lastSeen.workspace = {};
		await this.storage.store('onboarding:state', undefined);
		await this.storage.storeWorkspace('onboarding:state', undefined);

		for (const key of dismissedKeys) {
			this._onDidChange.fire({ key: key, dismissed: false });
		}
	}

	private async setItemStateCore<T extends OnboardingKeys>(
		key: T,
		state: OnboardingItemState<T>,
		scope: OnboardingStorageType,
		schema: `${number}.${number}.${number}` | undefined,
	): Promise<void> {
		const onboarding = this.getOnboarding(scope);
		const existing = onboarding.items[key] ?? {};

		const updated: OnboardingItem<OnboardingItemState<T>> = {
			...existing,
			schema: schema,
			state: state,
		};
		onboarding.items[key] = updated;

		await this.saveOnboarding(scope, onboarding, key);
	}

	private getItem<T extends OnboardingKeys>(key: T): OnboardingItem<OnboardingItemState<T>> | undefined {
		const scope = onboardingDefinitions[key].scope;
		return this.getOnboarding(scope).items[key] as OnboardingItem<OnboardingItemState<T>> | undefined;
	}

	/** Reads fresh on every call — memento reads are cheap, and this is how other windows' writes are picked up */
	private getOnboarding(scope: OnboardingStorageType): OnboardingStorage {
		const onboarding = (scope === 'workspace'
			? this.storage.getWorkspace('onboarding:state')
			: this.storage.get('onboarding:state')) ?? { items: {} };

		// Prime the diff snapshot on first sight so a same-window external delete (e.g. `storage.reset()`)
		// that happens before any write still fires change events for the dismissals it wipes
		this._lastSeen[scope] ??= { ...onboarding.items };

		return onboarding;
	}

	private async saveOnboarding(
		scope: OnboardingStorageType,
		onboarding: OnboardingStorage,
		changedKey?: OnboardingKeys,
	): Promise<void> {
		// Set before writing: `store`/`storeWorkspace` fire the storage-change event synchronously, and
		// `onStorageChanged` must see this write reflected already so its diff finds no delta — `dismiss`
		// and `reset` fire their own `_onDidChange` event for it instead.
		this._lastSeen[scope] = { ...onboarding.items };
		if (scope === 'workspace') {
			await this.storage.storeWorkspace('onboarding:state', onboarding);
			return;
		}

		await this.storage.store('onboarding:state', onboarding);

		// Verify the write actually stuck. Under heavy workbench churn (observed with `vscode.moveViews`),
		// a global-memento update can resolve and then be clobbered by a stale storage broadcast landing
		// during the await — retry once so a just-made change isn't silently reverted. Re-apply only the
		// changed item onto a fresh read; re-storing this whole blob could revert a legitimate concurrent
		// write from another window.
		const current = this.storage.get('onboarding:state');
		if (current === onboarding) return;

		if (changedKey != null) {
			if (JSON.stringify(current?.items[changedKey]) === JSON.stringify(onboarding.items[changedKey])) {
				return;
			}

			const fresh = current ?? { items: {} };
			fresh.items = updateRecordValue(fresh.items, changedKey, onboarding.items[changedKey]);
			this._lastSeen[scope] = { ...fresh.items };
			await this.storage.store('onboarding:state', fresh);
		} else if (JSON.stringify(current) !== JSON.stringify(onboarding)) {
			await this.storage.store('onboarding:state', onboarding);
		}
	}
}
