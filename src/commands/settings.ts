import { command, executeCoreCommand } from '../system/-webview/command.js';
import { GlCommandBase } from './commandBase.js';

const localSettingsCommands = [
	'gitlens.showSettingsPage',
	'gitlens.showSettingsPage!autolinks',
	'gitlens.showSettingsPage!branches-view',
	'gitlens.showSettingsPage!commits-view',
	'gitlens.showSettingsPage!contributors-view',
	'gitlens.showSettingsPage!current-line',
	'gitlens.showSettingsPage!file-annotations',
	'gitlens.showSettingsPage!file-history-view',
	'gitlens.showSettingsPage!line-history-view',
	'gitlens.showSettingsPage!remotes-view',
	'gitlens.showSettingsPage!repositories-view',
	'gitlens.showSettingsPage!search-compare-view',
	'gitlens.showSettingsPage!stashes-view',
	'gitlens.showSettingsPage!tags-view',
] as const;

@command()
export class ShowSettingsCommand extends GlCommandBase {
	constructor() {
		super([...localSettingsCommands]);
	}

	execute(): void {
		void executeCoreCommand('workbench.action.openSettings', '@ext:local.gitlens-lite');
	}
}
