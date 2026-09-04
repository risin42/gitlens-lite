import type { MessageItem } from 'vscode';
import { window } from 'vscode';
import { resetApprovedAvatarTemplates, resetAvatarCache } from '../avatars.js';
import type { Container } from '../container.js';
import type { QuickPickItemOfT } from '../quickpicks/items/common.js';
import { createQuickPickSeparator } from '../quickpicks/items/common.js';
import { settingsMigrations } from '../settingsMigrations.js';
import { command, executeCoreCommand } from '../system/-webview/command.js';
import { configuration } from '../system/-webview/configuration.js';
import { GlCommandBase } from './commandBase.js';

const resetTypes = [
	'avatars',
	'migrations',
	'onboarding',
	'repositoryAccess',
	'suppressedWarnings',
	'workspace',
] as const;
type ResetType = 'all' | (typeof resetTypes)[number];

@command()
export class ResetCommand extends GlCommandBase {
	constructor(private readonly container: Container) {
		super('gitlens.reset');
	}
	async execute(): Promise<void> {
		type ResetQuickPickItem = QuickPickItemOfT<ResetType>;

		const items: ResetQuickPickItem[] = [
			{
				label: 'Avatars...',
				detail: 'Clears the stored avatar cache and any approvals granted to custom remote avatar URL templates',
				item: 'avatars',
			},
			{
				label: 'Onboarding...',
				detail: 'Resets dismissed banners/notices and tracked usage — restores the first-time experience',
				item: 'onboarding',
			},
			{
				label: 'Repository Access...',
				detail: 'Clears the stored repository access cache',
				item: 'repositoryAccess',
			},
			{
				label: 'Suppressed Warnings...',
				detail: 'Clears any suppressed warnings, e.g. messages with "Don\'t Show Again" options',
				item: 'suppressedWarnings',
			},
			{
				label: 'Workspace Storage...',
				detail: 'Clears stored data associated with the current workspace',
				item: 'workspace',
			},
			createQuickPickSeparator(),
			{
				label: 'Everything...',
				description: ' — \u00a0be very careful with this!',
				detail: 'Clears ALL locally stored data; ALL GitLens state will be LOST',
				item: 'all',
			},
		];

		if (DEBUG) {
			items.push(createQuickPickSeparator('DEBUG'), {
				label: 'Reset Migrations...',
				detail: 'Re-arms selected one-time migrations, so they run again on the next reload',
				item: 'migrations',
			});
		}

		// create a quick pick with options to clear all the different resets that GitLens supports
		const pick = await window.showQuickPick<ResetQuickPickItem>(items, {
			title: 'Reset Stored Data',
			placeHolder: 'Choose which data to reset, will be prompted to confirm',
		});

		if (pick?.item == null) return;

		const confirm: MessageItem = { title: 'Reset' };
		const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };

		let confirmationMessage: string | undefined;
		switch (pick?.item) {
			case 'all':
				confirmationMessage = 'Are you sure you want to reset EVERYTHING?';
				confirm.title = 'Reset Everything';
				break;
			case 'avatars':
				confirmationMessage =
					'Are you sure you want to reset the avatar cache and all approvals for custom remote avatar URL templates? Approvals are synced, so this will affect your other devices.';
				confirm.title = 'Reset Avatars';
				break;
			case 'migrations':
				// No modal — the multi-select in `reset` is the deliberate step, and re-running
				// idempotent migrations is recoverable, unlike the data wipes above
				break;
			case 'onboarding':
				confirmationMessage =
					'Are you sure you want to reset the onboarding/first-time experience? This clears all dismissed banners/notices and tracked usage.';
				confirm.title = 'Reset Onboarding';
				break;
			case 'repositoryAccess':
				confirmationMessage = 'Are you sure you want to reset the repository access cache?';
				confirm.title = 'Reset Repository Access';
				break;
			case 'suppressedWarnings':
				confirmationMessage = 'Are you sure you want to reset all of the suppressed warnings?';
				confirm.title = 'Reset Suppressed Warnings';
				break;
			case 'workspace':
				confirmationMessage = 'Are you sure you want to reset the stored data for the current workspace?';
				confirm.title = 'Reset Workspace Storage';
				break;
			default: {
				const _exhaustiveCheck: never = pick.item;
				break;
			}
		}

		if (confirmationMessage != null) {
			const result = await window.showWarningMessage(
				`This is IRREVERSIBLE!\n${confirmationMessage}`,
				{ modal: true },
				confirm,
				cancel,
			);
			if (result !== confirm) return;
		}

		await this.reset(pick.item);
	}

	private async reset(reset: ResetType) {
		switch (reset) {
			case 'all':
				for (const r of resetTypes) {
					// Interactive picker; the `storage.reset` below wipes `settings:migrated` anyway
					if (r === 'migrations') continue;

					await this.reset(r);
				}

				// Secrets can't be enumerated, so anything not covered by a sub-reset must be named here
				await this.container.storage.deleteSecret('deepLinks:pending');

				await this.container.storage.reset();

				// Services cache their state in memory and write it back (feature flags, graph columns, ...),
				// so without a reload the wipe partially undoes itself
				void this.promptToReload(
					'All GitLens data has been reset. Reload the window to finish clearing any state still held in memory.',
				);
				break;

			case 'avatars':
				// Approvals first — it clears only failed entries, so the full cache reset must follow it
				await resetApprovedAvatarTemplates();
				resetAvatarCache('all');
				break;

			case 'migrations': {
				const applied = this.container.storage.get('settings:migrated');
				if (!applied?.length) {
					void window.showInformationMessage('There are no completed migrations to reset.');
					break;
				}

				const picks = await window.showQuickPick(
					applied.map(id => {
						const migration = settingsMigrations.find(m => m.id === id);
						return {
							label: id,
							description: migration?.status?.(this.container.storage),
							detail: migration?.description ?? 'Unknown migration — no longer exists in this version',
						};
					}),
					{
						title: 'Reset Migrations',
						placeHolder: 'Choose migrations to re-run on the next reload',
						canPickMany: true,
					},
				);
				if (!picks?.length) break;

				await this.container.storage.store(
					'settings:migrated',
					applied.filter(id => !picks.some(p => p.label === id)),
				);

				void this.promptToReload('The selected migrations will run again once the window is reloaded.');
				break;
			}

			case 'onboarding':
				await this.container.onboarding.resetAll();
				await this.container.usage.reset();
				break;

			case 'repositoryAccess':
				await this.container.git.clearAllRepoVisibilityCaches();
				break;

			case 'suppressedWarnings':
				// Clear every target — a workspace/folder override would otherwise keep a warning suppressed
				await configuration.clear('advanced.messages');
				break;

			case 'workspace':
				await this.container.storage.resetWorkspace();
				break;
		}
	}

	private async promptToReload(message: string): Promise<void> {
		const reload: MessageItem = { title: 'Reload' };
		const result = await window.showInformationMessage(message, reload, {
			title: 'Later',
			isCloseAffordance: true,
		});
		if (result !== reload) return;

		void executeCoreCommand('workbench.action.reloadWindow');
	}
}
