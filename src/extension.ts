import type { ExtensionContext } from 'vscode';
import { version as codeVersion, env, ExtensionMode, LogLevel, Uri, window, workspace } from 'vscode';
import { isWeb } from '@env/platform.js';
import { defaultResolver as envDefaultResolver } from '@env/resolver.js';
import { setAbbreviatedShaLength } from '@gitlens/git/utils/revision.utils.js';
import { setDefaultDateLocales } from '@gitlens/utils/date.js';
import { setDefaultResolver } from '@gitlens/utils/decorators/resolver.js';
import { once } from '@gitlens/utils/event.js';
import { microhash } from '@gitlens/utils/hash.js';
import { isLoggable } from '@gitlens/utils/loggable.js';
import { getLoggableName, Logger } from '@gitlens/utils/logger.js';
import { Stopwatch } from '@gitlens/utils/stopwatch.js';
import { compare, fromString } from '@gitlens/utils/version.js';
import { Api } from './api/api.js';
import type { GitLensApi, OpenIssueActionContext } from './api/gitlens.d.js';
import type { OpenIssueOnRemoteCommandArgs } from './commands/openIssueOnRemote.js';
import { trackableSchemes } from './constants.js';
import { SyncedStorageKeys } from './constants.storage.js';
import { Container } from './container.js';
import { isGitUri } from './git/gitUri.js';
import { showDebugLoggingWarningMessage, showWhatsNewMessage } from './messages.js';
import { registerResourceUsage } from './resourceUsage.js';
import { settingsMigrations } from './settingsMigrations.js';
import { executeCommand, registerCommands } from './system/-webview/command.js';
import { configuration, Configuration } from './system/-webview/configuration.js';
import { setContext } from './system/-webview/context.js';
import { Storage } from './system/-webview/storage.js';
import { getExtensionModeLabel } from './system/-webview/vscode.js';
import { isTextDocument } from './system/-webview/vscode/documents.js';
import { isTextEditor } from './system/-webview/vscode/editors.js';
import { isWorkspaceFolder } from './system/-webview/vscode/workspaces.js';
import './commands.js';

export async function activate(context: ExtensionContext): Promise<GitLensApi | undefined> {
	const gitlensVersion: string = context.extension.packageJSON.version;

	const defaultDateLocale = configuration.get('defaultDateLocale');
	Logger.configure(
		{
			name: 'GitLens',
			createChannel: function (name: string) {
				const channel = window.createOutputChannel(name, { log: true });
				context.subscriptions.push(channel);

				// Show message if debug logging is not enabled (level > Debug)
				if (channel.logLevel === LogLevel.Off || channel.logLevel > LogLevel.Debug) {
					channel.appendLine(
						'To enable debug logging, run "GitLens: Enable Debug Logging" or "Developer: Set Log Level..." from the Command Palette',
					);
				}
				return channel;
			},
			toLoggable: function (o: any) {
				if (isGitUri(o)) {
					return `GitUri(${o.toString(true)}${o.repoPath ? ` repoPath=${o.repoPath}` : ''}${
						o.sha ? ` sha=${o.sha}` : ''
					})`;
				}
				if (o instanceof Uri) return `Uri(${o.toString(true)})`;
				if (isLoggable(o)) return o.toLoggable();

				if ('rootUri' in o && o.rootUri instanceof Uri) {
					return `ScmRepository(${o.rootUri.toString(true)})`;
				}

				if ('uri' in o && o.uri instanceof Uri) {
					if (isWorkspaceFolder(o)) {
						return `WorkspaceFolder(${o.name}, index=${o.index}, ${o.uri.toString(true)})`;
					}

					if (isTextDocument(o)) {
						return `TextDocument(${o.languageId}, dirty=${o.isDirty}, ${o.uri.toString(true)})`;
					}

					return `${getLoggableName(o)}(${o.uri.toString(true)})`;
				}

				if (isTextEditor(o)) {
					return `TextEditor(${o.viewColumn}, ${o.document.uri.toString(true)} ${o.selections
						?.map(s => `[${s.anchor.line}:${s.anchor.character}-${s.active.line}:${s.active.character}]`)
						.join(',')})`;
				}

				// Use custom toString() if available (covers Repository, Branch, Commit, Tag, Remote, Worktree, ViewNode, Container, etc.)
				if (o.toString !== Object.prototype.toString) {
					return o.toString() as string;
				}

				return undefined;
			},
			hash: microhash,
			// Redact env var maps (e.g. `GitOperationRunOptions.env` carrying SSH_ASKPASS tokens) from debug logs.
			sanitizeKeys: new Set(['env']),
		},
		context.extensionMode === ExtensionMode.Development,
	);

	const sw = new Stopwatch(`GitLens v${gitlensVersion}`, {
		log: {
			level: 'info',
			message: ` activating in ${env.appName} (${codeVersion}) on the ${isWeb ? 'web' : 'desktop'}; mode=${getExtensionModeLabel(
				context.extensionMode,
			)},language='${
				env.language
			}', logLevel='${Logger.logLevel}', defaultDateLocale='${defaultDateLocale}' (${env.uriScheme}|${env.machineId}|${
				env.sessionId
			})`,
		},
	});

	if (!workspace.isTrusted) {
		void setContext('gitlens:untrusted', true);
	}

	// Clear any leftover terminal env-var state from older versions (see #4977). The
	// current code no longer contributes terminal env vars, but VS Code may still have
	// persisted entries cached against the extension id, which keeps surfacing the
	// "terminal needs to be relaunched" warning.
	context.environmentVariableCollection.clear();

	setKeysForSync(context);

	const storage = new Storage(context);
	const syncedVersion = storage.get('synced:version');
	const localVersion = storage.get('version');

	let previousVersion: string | undefined;
	if (localVersion == null || syncedVersion == null) {
		previousVersion = syncedVersion ?? localVersion;
	} else if (compare(syncedVersion, localVersion) === 1) {
		previousVersion = syncedVersion;
	} else {
		previousVersion = localVersion;
	}

	// If there is no local or synced previous version, this is a new install
	if (localVersion == null || previousVersion == null) {
		void setContext('gitlens:install:new', true);
	} else if (gitlensVersion !== previousVersion && compare(gitlensVersion, previousVersion) === 1) {
		void setContext('gitlens:install:upgradedFrom', previousVersion);
	}

	let exitMessage;
	if (Logger.enabled('trace')) {
		exitMessage = `syncedVersion=${syncedVersion}, localVersion=${localVersion}, previousVersion=${previousVersion}`;
	}

	Configuration.configure(context);

	setDefaultResolver(envDefaultResolver);
	setDefaultDateLocales(defaultDateLocale ?? env.language);
	context.subscriptions.push(
		configuration.onDidChange(e => {
			if (configuration.changed(e, 'defaultDateLocale')) {
				setDefaultDateLocales(configuration.get('defaultDateLocale') ?? env.language);
			}

			if (configuration.changed(e, 'advanced.abbreviatedShaLength')) {
				setAbbreviatedShaLength(configuration.get('advanced.abbreviatedShaLength'));
			}
		}),
	);

	await migrateSettings(storage);

	const container = Container.create(context, storage, gitlensVersion, previousVersion);
	once(container.onReady)(() => {
		context.subscriptions.push(...registerCommands(container));
		context.subscriptions.push(...registerResourceUsage(container));
		registerBuiltInActionRunners(container);

		// Activate the Git Health service so its auto-tier maintenance pass + slowness counters start
		// running (the getter is otherwise lazy). Gated internally on `gitlens-lite.gitOptimizations.enabled`.
		void container.gitHealth;

		if (!workspace.isTrusted) {
			context.subscriptions.push(
				workspace.onDidGrantWorkspaceTrust(() => {
					void setContext('gitlens:untrusted', undefined);
				}),
			);
		}

		void showWhatsNew(container, gitlensVersion, previousVersion);

		void storage.store('version', gitlensVersion).catch();

		// Only update our synced version if the new version is greater
		if (syncedVersion == null || compare(gitlensVersion, syncedVersion) === 1) {
			void storage.store('synced:version', gitlensVersion).catch();
		}

		if (Logger.enabled('trace')) {
			setTimeout(async () => {
				if (!Logger.enabled('trace')) return;

				if (!container.debugging) {
					if (await showDebugLoggingWarningMessage()) {
						void executeCommand('gitlens.disableDebugLogging');
					}
				}
			}, 60000);
		}
	});

	if (container.debugging) {
		// Set context to only show some commands when debugging
		void setContext('gitlens:debugging', true);
	}
	// NOTE: We might have to add more schemes to this list, because the schemes that are used in the `resource*` context keys don't match was URI scheme is returned in the APIs
	// For example, using the remote extensions the `resourceScheme` is `vscode-remote`, but the URI scheme is `file`
	void setContext('gitlens:schemes:trackable', [...trackableSchemes]);

	// Signal that the container is now ready
	await container.ready();

	// TODO@eamodio do we want to capture any vscode settings that are relevant to GitLens?
	const api = new Api(container);
	const mode = container.mode;

	sw.stop({
		message: `activated${exitMessage != null ? `, ${exitMessage}` : ''}${
			mode != null ? `, mode: ${mode.name}` : ''
		}`,
	});

	return Promise.resolve(api);
}

export function deactivate(): void {
	Logger.info('GitLens deactivating...');
	Container.instance.deactivate();
}

async function migrateSettings(storage: Storage): Promise<void> {
	const applied = new Set(storage.get('settings:migrated'));

	let changed = false;
	for (const migration of settingsMigrations) {
		if (applied.has(migration.id)) continue;

		try {
			await migration.migrate(storage);
			// Mark only on success — leave a failed migration unmarked so it retries next activation
			// (migrations are idempotent).
			applied.add(migration.id);
			changed = true;
		} catch (ex) {
			Logger.error(ex, 'migrateSettings', migration.id);
		}
	}

	if (changed) {
		await storage.store('settings:migrated', [...applied]);
	}
}

function setKeysForSync(context: ExtensionContext, ...keys: (SyncedStorageKeys | string)[]) {
	context.globalState?.setKeysForSync([
		...keys,
		SyncedStorageKeys.ApprovedAvatarRemoteTemplates,
		SyncedStorageKeys.Version,
	]);
}

function registerBuiltInActionRunners(container: Container): void {
	container.context.subscriptions.push(
		container.actionRunners.registerBuiltIn<OpenIssueActionContext>('openIssue', {
			label: ctx => `Open Issue on ${ctx.provider?.name ?? 'Remote'}`,
			run: async ctx => {
				if (ctx.type !== 'openIssue') return;

				void (await executeCommand<OpenIssueOnRemoteCommandArgs>('gitlens.openIssueOnRemote', {
					issue: { url: ctx.issue.url },
				}));
			},
		}),
	);
}

async function showWhatsNew(container: Container, version: string, previousVersion: string | undefined) {
	if (previousVersion == null) {
		Logger.info(`GitLens first-time install; window.focused=${window.state.focused}`);

		return;
	}

	if (previousVersion !== version) {
		Logger.info(`GitLens upgraded from v${previousVersion} to v${version}; window.focused=${window.state.focused}`);
	}

	const current = fromString(version);
	const previous = fromString(previousVersion);

	// Don't notify on downgrades
	if (current.major < previous.major || (current.major === previous.major && current.minor < previous.minor)) {
		return;
	}

	if (current.major === previous.major) return;

	version = String(current.major);

	if (configuration.get('showWhatsNewAfterUpgrades')) {
		if (window.state.focused) {
			await container.storage.delete('pendingWhatsNewOnFocus');
			await showWhatsNewMessage(version);
		} else {
			// Save pending on window getting focus
			await container.storage.store('pendingWhatsNewOnFocus', true);
			const disposable = window.onDidChangeWindowState(e => {
				if (!e.focused) return;

				disposable.dispose();

				// If the window is now focused and we are pending the what's new, clear the pending state and show the what's new
				if (container.storage.get('pendingWhatsNewOnFocus') === true) {
					void container.storage.delete('pendingWhatsNewOnFocus');
					if (configuration.get('showWhatsNewAfterUpgrades')) {
						void showWhatsNewMessage(version);
					}
				}
			});
			container.context.subscriptions.push(disposable);
		}
	}
}
