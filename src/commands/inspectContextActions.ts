import type { GitRevisionReference, GitStashReference } from '@gitlens/git/models/reference.js';
import { RemoteResourceType } from '@gitlens/git/models/remoteResource.js';
import type { GlCommands } from '../constants.commands.js';
import * as BranchActions from '../git/actions/branch.js';
import * as RepoActions from '../git/actions/repository.js';
import * as StashActions from '../git/actions/stash.js';
import * as TagActions from '../git/actions/tag.js';
import * as WorktreeActions from '../git/actions/worktree.js';
import { command, executeCommand } from '../system/-webview/command.js';
import type { WebviewItemContext } from '../system/webview.js';
import { GlCommandBase } from './commandBase.js';
import type { CommandContext } from './commandContext.js';
import type { OpenOnRemoteCommandArgs } from './openOnRemote.js';

type InspectContextValue = { type: 'commit'; ref: GitRevisionReference } | { type: 'stash'; ref: GitStashReference };

type InspectContext = WebviewItemContext<InspectContextValue>;

const inspectContextCommands: GlCommands[] = [
	'gitlens.inspect.createBranch',
	'gitlens.inspect.cherryPick',
	'gitlens.inspect.createTag',
	'gitlens.inspect.createWorktree',
	'gitlens.inspect.openCommitOnRemote',
	'gitlens.inspect.rebaseOntoCommit',
	'gitlens.inspect.resetToCommit',
	'gitlens.inspect.switchToCommit',
	'gitlens.inspect.stashApply',
	'gitlens.inspect.stashDelete',
	'gitlens.inspect.stashRename',
];

@command()
export class InspectContextActionsCommand extends GlCommandBase {
	constructor() {
		super(inspectContextCommands);
	}

	protected override preExecute(context: CommandContext, item?: unknown): Promise<void> {
		return this.execute(context.command as GlCommands, item);
	}

	async execute(command: GlCommands, item?: unknown): Promise<void> {
		const value = getInspectContextValue(item);
		if (value == null) return;

		const ref = value.ref;
		switch (command) {
			case 'gitlens.inspect.createBranch':
				return BranchActions.create(ref.repoPath, ref);
			case 'gitlens.inspect.cherryPick':
				if (value.type === 'commit') return RepoActions.cherryPick(ref.repoPath, [value.ref]);
				return;
			case 'gitlens.inspect.createTag':
				return TagActions.create(ref.repoPath, ref);
			case 'gitlens.inspect.createWorktree':
				await WorktreeActions.create(ref.repoPath, undefined, ref);
				return;
			case 'gitlens.inspect.openCommitOnRemote':
				await executeCommand<OpenOnRemoteCommandArgs>('gitlens.openOnRemote', {
					repoPath: ref.repoPath,
					resource: { type: RemoteResourceType.Commit, sha: ref.ref },
				});
				return;
			case 'gitlens.inspect.rebaseOntoCommit':
				return RepoActions.rebase(ref.repoPath, ref);
			case 'gitlens.inspect.resetToCommit':
				if (value.type === 'commit') return RepoActions.reset(ref.repoPath, value.ref);
				return;
			case 'gitlens.inspect.switchToCommit':
				if (value.type === 'commit') return RepoActions.switchTo(ref.repoPath, value.ref);
				return;
			case 'gitlens.inspect.stashApply':
				return StashActions.apply(ref.repoPath, value.type === 'stash' ? value.ref : undefined);
			case 'gitlens.inspect.stashDelete':
				if (value.type === 'stash') return StashActions.drop(ref.repoPath, [value.ref]);
				return;
			case 'gitlens.inspect.stashRename':
				if (value.type === 'stash') return StashActions.rename(ref.repoPath, value.ref);
		}
	}
}

function getInspectContextValue(item: unknown): InspectContextValue | undefined {
	if (item == null || typeof item !== 'object' || !('webviewItemValue' in item)) return undefined;

	const value = (item as InspectContext).webviewItemValue;
	if (value?.type !== 'commit' && value?.type !== 'stash') return undefined;
	if (value.ref == null || typeof value.ref !== 'object') return undefined;

	return value;
}
