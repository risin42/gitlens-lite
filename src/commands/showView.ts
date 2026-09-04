import { window } from 'vscode';
import type { Container } from '../container.js';
import { command, executeCoreCommand } from '../system/-webview/command.js';
import { GlCommandBase } from './commandBase.js';
import type { CommandContext } from './commandContext.js';

@command()
export class ShowViewCommand extends GlCommandBase {
	constructor(private readonly container: Container) {
		super([
			'gitlens.showBranchesView',
			'gitlens.showCommitDetailsView',
			'gitlens.showCommitsView',
			'gitlens.showContributorsView',
			'gitlens.showFileHistoryView',
			'gitlens.showLineHistoryView',
			'gitlens.showRemotesView',
			'gitlens.showRepositoriesView',
			'gitlens.showSearchAndCompareView',
			'gitlens.showStashesView',
			'gitlens.showTagsView',
		]);
	}

	protected override preExecute(context: CommandContext, ...args: unknown[]): Promise<void> {
		return this.execute(context, ...args);
	}

	async waitForRepo(): Promise<void> {
		if (this.container.git.openRepositoryCount > 0) return;

		// Wait for repository discovery to complete
		if (this.container.git.isDiscoveringRepositories) {
			await this.container.git.isDiscoveringRepositories;
		}
	}

	async waitForRepoOrNotify(featureName?: string): Promise<void> {
		await this.waitForRepo();
		if (this.container.git.openRepositoryCount > 0) return;

		const message = featureName
			? `No repository detected. To view ${featureName}, open a folder containing a git repository or clone from a URL in Source Control.`
			: 'No repository detected. To use GitLens, open a folder containing a git repository or clone from a URL in Source Control.';

		const openRepo = { title: 'Open a Folder or Repo', isCloseAffordance: true };
		const result = await window.showInformationMessage(message, openRepo);
		if (result === openRepo) {
			void executeCoreCommand('workbench.view.scm');
		}
	}

	async execute(context: CommandContext, ..._args: unknown[]): Promise<void> {
		const command = context.command;
		switch (command) {
			case 'gitlens.showBranchesView':
				await this.waitForRepo();
				return this.container.views.showView('branches');
			case 'gitlens.showCommitDetailsView':
				await this.waitForRepoOrNotify('Inspect');
				return this.container.views.commitDetails.show();
			case 'gitlens.showCommitsView':
				await this.waitForRepo();
				return this.container.views.showView('commits');
			case 'gitlens.showContributorsView':
				await this.waitForRepo();
				return this.container.views.showView('contributors');
			case 'gitlens.showFileHistoryView':
				await this.waitForRepo();
				return this.container.views.showView('fileHistory');
			case 'gitlens.showLineHistoryView':
				await this.waitForRepo();
				return this.container.views.showView('lineHistory');
			case 'gitlens.showRemotesView':
				await this.waitForRepo();
				return this.container.views.showView('remotes');
			case 'gitlens.showRepositoriesView':
				await this.waitForRepo();
				return this.container.views.showView('repositories');
			case 'gitlens.showSearchAndCompareView':
				return this.container.views.showView('searchAndCompare');
			case 'gitlens.showStashesView':
				await this.waitForRepo();
				return this.container.views.showView('stashes');
			case 'gitlens.showTagsView':
				await this.waitForRepo();
				return this.container.views.showView('tags');
		}

		return Promise.resolve(undefined);
	}
}
