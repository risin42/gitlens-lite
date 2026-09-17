import type { MessageItem, Uri } from 'vscode';
import { ThemeIcon, window } from 'vscode';
import { BranchError, WorktreeDeleteError } from '@gitlens/git/errors.js';
import type { GitBranch } from '@gitlens/git/models/branch.js';
import { GitWorktree } from '@gitlens/git/models/worktree.js';
import { getBranchNameAndRemote } from '@gitlens/git/utils/branch.utils.js';
import { getNumericFormat } from '@gitlens/utils/date.js';
import { Logger } from '@gitlens/utils/logger.js';
import { getSettledValue } from '@gitlens/utils/promise.js';
import type { Container } from '../../../container.js';
import type { GlRepository } from '../../../git/models/repository.js';
import { getReferenceFromBranch } from '../../../git/utils/-webview/reference.utils.js';
import { showGitErrorMessage } from '../../../messages.js';
import { createQuickPickSeparator } from '../../../quickpicks/items/common.js';
import type { ConfirmToggleQuickPickItem, DirectiveQuickPickItem } from '../../../quickpicks/items/directive.js';
import {
	createConfirmToggleQuickPickItem,
	createDirectiveQuickPickItem,
	Directive,
} from '../../../quickpicks/items/directive.js';
import type { FlagsQuickPickItem } from '../../../quickpicks/items/flags.js';
import { createFlagsQuickPickItem } from '../../../quickpicks/items/flags.js';
import { revealInFileExplorer } from '../../../system/-webview/vscode.js';
import { getWorkspaceFriendlyPath } from '../../../system/-webview/vscode/workspaces.js';
import type {
	PartialStepState,
	StepGenerator,
	StepResultGenerator,
	StepsContext,
	StepSelection,
	StepState,
} from '../../quick-wizard/models/steps.js';
import { StepResultBreak } from '../../quick-wizard/models/steps.js';
import type { QuickPickStep } from '../../quick-wizard/models/steps.quickpick.js';
import { QuickCommand } from '../../quick-wizard/quickCommand.js';
import { canSkipRepositoryPick, pickRepositoryStep } from '../../quick-wizard/steps/repositories.js';
import { pickWorktreesStep } from '../../quick-wizard/steps/worktrees.js';
import { StepsController } from '../../quick-wizard/stepsController.js';
import {
	appendReposToTitle,
	assertStepState,
	canPickStepContinue,
	confirmOptionsSeparatorLabel,
	createConfirmStep,
	refreshConfirmStepItems,
} from '../../quick-wizard/utils/steps.utils.js';
import type { WorktreeContext } from '../worktree.js';

const Steps = {
	PickRepo: 'worktree-delete-pick-repo',
	PickWorktrees: 'worktree-delete-pick-worktrees',
	Confirm: 'worktree-delete-confirm',
} as const;
type StepNames = (typeof Steps)[keyof typeof Steps];
export type WorktreeDeleteStepNames = StepNames;

type Context = WorktreeContext<StepNames> & {
	/** Whether the confirm step's pre-flight dirty check had settled (its notice had its chance to render) before the user accepted */
	dirtyCheckSettledBeforeConfirm?: boolean;
};

type Flags = '--force' | '--delete-branches' | '--delete-upstreams';
interface State<Repo = string | GlRepository> {
	repo: Repo;
	uris: Uri[];
	flags: Flags[];

	/** Entered from branch delete/prune -- pre-checks Delete Branch(es) and uses branch-first copy */
	fromBranchDelete?: 'delete' | 'prune';
	overrides?: {
		title?: string;
	};
}
export type WorktreeDeleteState = State;

export interface WorktreeDeleteGitCommandArgs {
	readonly command: 'worktree-delete';
	confirm?: boolean;
	state?: Partial<State>;
}

export class WorktreeDeleteGitCommand extends QuickCommand<State> {
	constructor(container: Container, args?: WorktreeDeleteGitCommandArgs) {
		super(container, 'worktree-delete', 'delete', 'Delete Worktrees', {
			description: 'deletes the specified worktrees',
		});

		this.initialState = { confirm: args?.confirm, flags: [], ...args?.state };
	}

	override get canSkipConfirm(): boolean {
		return false;
	}

	protected createContext(context?: StepsContext<any>): Context {
		return {
			...context,
			container: this.container,
			repos: this.container.git.openRepositories,
			associatedView: this.container.views.repositories,
			showTags: false,
			title: this.title,
		};
	}

	protected async *steps(state: PartialStepState<State>, context?: Context): StepGenerator {
		context ??= this.createContext();
		using steps = new StepsController<StepNames>(context, this);

		state.flags ??= [];

		while (!steps.isComplete) {
			// The pre-confirm steps need the entry title too -- a Community user deleting a branch with a
			// worktree sees the access gate before ever reaching the confirm
			context.title =
				state.overrides?.title ??
				(state.fromBranchDelete != null
					? this.getEntryTitle(state.fromBranchDelete, state.uris?.length === 1)
					: this.title);

			if (steps.isAtStep(Steps.PickRepo) || state.repo == null || typeof state.repo === 'string') {
				// Skip the picker only when the sole available repo is the one requested
				if (canSkipRepositoryPick(context.repos, state.repo)) {
					[state.repo] = context.repos;
				} else {
					using step = steps.enterStep(Steps.PickRepo);

					const result = yield* pickRepositoryStep(state, context, step, { excludeWorktrees: true });
					if (result === StepResultBreak) {
						state.repo = undefined!;
						if (step.goBack() == null) break;
						continue;
					}

					state.repo = result;
				}
			}

			assertStepState<State<GlRepository>>(state);

			context.worktrees = (await state.repo.git.worktrees?.getWorktrees()) ?? [];

			if (steps.isAtStep(Steps.PickWorktrees) || !state.uris?.length) {
				using step = steps.enterStep(Steps.PickWorktrees);

				context.title = this.title;

				const result = yield* pickWorktreesStep(state, context, {
					// Can't delete the main or opened worktree
					excludeOpened: true,
					filter: wt => !wt.isDefault,
					includeStatus: true,
					picked: state.uris?.map(uri => uri.toString()),
					placeholder: 'Choose worktrees to delete',
				});
				if (result === StepResultBreak) {
					state.uris = undefined!;
					if (step.goBack() == null) break;
					continue;
				}

				state.uris = result.map(w => w.uri);
			}

			context.title = this.title;

			{
				using step = steps.enterStep(Steps.Confirm);

				const result = yield* this.confirmStep(state, context);
				if (result === StepResultBreak) {
					state.flags = [];
					if (step.goBack() == null) break;
					continue;
				}

				state.flags = result;
			}

			const deleteBranches = state.flags.includes('--delete-branches');
			const deleteUpstreams = state.flags.includes('--delete-upstreams');
			// Confirmed up front via the Force toggle -- distinct from the mutable `force` below, which can
			// also become truthy through reactive escalation (a failed attempt asked and the user agreed)
			const forceConfirmed = state.flags.includes('--force');

			const branchesToDelete: GitBranch[] = [];

			for (const uri of state.uris) {
				let skipHasChangesPrompt = false;
				let succeeded: boolean;

				// `'locked'` escalates to a double `--force`, which is required to delete a locked worktree
				let force: boolean | 'locked' = forceConfirmed;
				const worktree = context.worktrees?.find(wt => wt.uri.toString() === uri.toString());

				while (true) {
					succeeded = false;

					try {
						// Force chosen at the confirm step already carries the notice's warning — but only if the
						// pre-flight dirty check actually surfaced before the user accepted; on a fast accept (or
						// reactive escalation below) verify here so uncommitted changes are never destroyed unwarned
						if (force && (!forceConfirmed || !context.dirtyCheckSettledBeforeConfirm)) {
							let hasChanges;
							try {
								hasChanges =
									worktree != null ? await GitWorktree.hasWorkingChanges(worktree) : undefined;
							} catch {}

							if ((hasChanges ?? false) && !skipHasChangesPrompt) {
								const confirm: MessageItem = { title: 'Force Delete' };
								const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
								const result = await window.showWarningMessage(
									`The worktree in '${uri.fsPath}' has uncommitted changes.\n\nDeleting it will cause those changes to be FOREVER LOST.\nThis is IRREVERSIBLE!\n\nAre you sure you still want to delete it?`,
									{ modal: true },
									confirm,
									cancel,
								);

								if (result !== confirm) break;
							}
						}

						await state.repo.git.worktrees?.deleteWorktree(uri, { force: force });
						succeeded = true;
					} catch (ex) {
						if (WorktreeDeleteError.is(ex)) {
							if (ex.details.reason === 'defaultWorkingTree') {
								void window.showErrorMessage('Cannot delete the default worktree.');
								break;
							}

							if (ex.details.reason === 'directoryNotEmpty') {
								// Force already told us to proceed without interruption -- the notice warned up front
								if (forceConfirmed) {
									succeeded = true;
									break;
								}

								const openFolder: MessageItem = { title: 'Open Folder' };
								const confirm: MessageItem = { title: 'OK', isCloseAffordance: true };
								const result = await window.showErrorMessage(
									`Unable to fully clean up the delete worktree in '${uri.fsPath}' because the folder is not empty.`,
									{ modal: true },
									openFolder,
									confirm,
								);

								if (result === openFolder) {
									void revealInFileExplorer(uri);
								}

								succeeded = true;
								break;
							}

							// Handled before the `!force` check below, because a single `--force` can't delete a
							// locked worktree -- it takes a double `--force`, so this must escalate even when forcing
							if (ex.details.reason === 'locked') {
								// Already double-forced and it's still locked, so there's nothing left to escalate to
								if (force !== 'locked') {
									const confirm: MessageItem = { title: 'Force Delete' };
									const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
									const result = await window.showWarningMessage(
										ex.details.lockReason
											? `Unable to delete worktree in '${uri.fsPath}' because it is locked.\n\nLock reason: ${ex.details.lockReason}\n\nSomething may still be using this worktree. Forcibly deleting it could disrupt whatever locked it.\n\nWould you like to forcibly delete it?`
											: `Unable to delete worktree in '${uri.fsPath}' because it is locked.\n\nSomething may still be using this worktree. Forcibly deleting it could disrupt whatever locked it.\n\nWould you like to forcibly delete it?`,
										{ modal: true },
										confirm,
										cancel,
									);

									if (result === confirm) {
										// If we were already forcing, the changes prompt (if any) has been answered -- don't re-ask on the retry
										skipHasChangesPrompt = force === true;
										force = 'locked';
										continue;
									}

									break;
								}
							} else if (!force) {
								const confirm: MessageItem = { title: 'Force Delete' };
								const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
								const result = await window.showErrorMessage(
									ex.details.reason === 'uncommittedChanges'
										? `Unable to delete worktree because there are UNCOMMITTED changes in '${uri.fsPath}'.\n\nForcibly deleting it will cause those changes to be FOREVER LOST.\nThis is IRREVERSIBLE!\n\nWould you like to forcibly delete it?`
										: `Unable to delete worktree in '${uri.fsPath}'.\n\nWould you like to try to forcibly delete it?`,
									{ modal: true },
									confirm,
									cancel,
								);

								if (result === confirm) {
									force = true;
									skipHasChangesPrompt = ex.details.reason === 'uncommittedChanges';
									continue;
								}

								break;
							}
						}

						void showGitErrorMessage(ex, `Unable to delete worktree in '${uri.fsPath}'`);
					}

					break;
				}

				if (succeeded && (deleteBranches || deleteUpstreams) && worktree?.branch) {
					branchesToDelete.push(worktree.branch);
				}
			}

			steps.markStepsComplete();

			for (const branch of branchesToDelete) {
				await this.deleteBranch(state.repo, branch, { force: forceConfirmed, deleteUpstream: deleteUpstreams });
			}

			// Force is never sticky -- only the Additional Actions choices are remembered, and only when this
			// wasn't entered from branch delete (where Delete Branch is seeded on, not chosen by the user)
			if (state.fromBranchDelete == null) {
				await this.container.storage.storeWorkspace('gitComandPalette:worktreeDelete:actions', {
					branch: deleteBranches,
					upstream: deleteUpstreams,
				});
			}
		}

		return steps.isComplete ? undefined : StepResultBreak;
	}

	/** Deletes a worktree's checked-out branch (and, when requested, its upstream) directly via the same
	 *  ops branch-delete's execute uses -- not the branch GitCommand wizard, which would open a second
	 *  confirm step and can't run while this step's modals are still settling. */
	private async deleteBranch(
		repo: GlRepository,
		branch: GitBranch,
		options: { force: boolean; deleteUpstream: boolean },
	): Promise<void> {
		const [name, remote] = getBranchNameAndRemote(getReferenceFromBranch(branch));
		try {
			await repo.git.branches.deleteLocalBranch?.(name, { force: options.force });
			if (options.deleteUpstream && remote) {
				await repo.git.branches.deleteRemoteBranch?.(name, remote);
			}
		} catch (ex) {
			if (BranchError.is(ex, 'notFullyMerged')) {
				const confirm: MessageItem = { title: 'Delete Branch' };
				const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
				const result = await window.showWarningMessage(
					`Unable to delete branch '${name}' as it is not fully merged. Do you want to delete it anyway?`,
					{ modal: true },
					confirm,
					cancel,
				);

				if (result === confirm) {
					try {
						await repo.git.branches.deleteLocalBranch?.(name, { force: true });
						if (options.deleteUpstream && remote) {
							await repo.git.branches.deleteRemoteBranch?.(name, remote);
						}
					} catch (ex) {
						Logger.error(ex, 'Delete Worktrees');
						void showGitErrorMessage(ex, BranchError.is(ex) ? undefined : 'Unable to force delete branch');
					}
				}

				return;
			}

			Logger.error(ex, 'Delete Worktrees');
			void showGitErrorMessage(ex, BranchError.is(ex) ? undefined : 'Unable to delete branch');
		}
	}

	/** The wizard's title for how it was entered -- branch delete/prune hands both deletions here, so the
	 *  title names both. Prune keeps each verb on its own noun: `git worktree prune` means something else
	 *  entirely (cleaning stale worktree records), so "Prune Worktree" would actively mislead. */
	private getEntryTitle(mode: 'delete' | 'prune' | undefined, isSingleWorktree: boolean): string {
		if (mode === 'delete') {
			return isSingleWorktree ? 'Delete Branch & Worktree' : 'Delete Branches & Worktrees';
		}

		if (mode === 'prune') {
			return isSingleWorktree ? 'Prune Branch & Delete Worktree' : 'Prune Branches & Delete Worktrees';
		}

		return isSingleWorktree ? 'Delete Worktree' : 'Delete Worktrees';
	}

	private *confirmStep(state: StepState<State<GlRepository>>, context: Context): StepResultGenerator<Flags[]> {
		const isSingleWorktree = state.uris.length === 1;
		context.title = this.getEntryTitle(state.fromBranchDelete, isSingleWorktree);

		const formattedWorktreeCount = getNumericFormat()(state.uris.length);

		const selectedWorktrees = state.uris
			.map(uri => context.worktrees?.find(wt => wt.uri.toString() === uri.toString()))
			.filter((wt): wt is GitWorktree => wt != null);
		// A missing upstream is still a non-null upstream (`missing: true`) -- offering to delete a remote
		// branch already known not to exist would just fail
		const canDeleteUpstreams = selectedWorktrees.some(
			wt => wt.branch?.upstream != null && !wt.branch.upstream.missing,
		);

		const stored = this.container.storage.getWorkspace('gitComandPalette:worktreeDelete:actions');

		// Force is never sticky and never seeded from storage -- only the Additional Actions choices are
		// remembered. Entering from branch delete pre-checks Delete Branch regardless of what's remembered,
		// since deleting the branch is the whole point of that entry -- the user can still uncheck it.
		let force = state.flags.includes('--force');
		let deleteBranches =
			state.fromBranchDelete != null || state.flags.includes('--delete-branches') || (stored?.branch ?? false);
		let deleteUpstreams =
			canDeleteUpstreams && (state.flags.includes('--delete-upstreams') || (stored?.upstream ?? false));

		// Folds the live toggle values into the mode row's flags and detail -- the accepted item's flags
		// are the whole contract with the delete loop above, so the list says what will actually happen.
		const buildItem = (): FlagsQuickPickItem<Flags> => {
			const flags: Flags[] = [];
			if (force) {
				flags.push('--force');
			}
			if (deleteBranches) {
				flags.push('--delete-branches');
			}
			if (deleteUpstreams) {
				flags.push('--delete-upstreams');
			}

			// Branch-first copy only while the branch is actually going to be deleted -- if the user unchecks
			// Delete Branch this falls back to the worktree-only wording, since the row has to say what will
			// actually happen
			const branchFirst = state.fromBranchDelete != null && deleteBranches;

			let label: string;
			if (branchFirst && state.fromBranchDelete === 'prune') {
				if (isSingleWorktree) {
					label = force ? 'Force Prune Branch & Delete Worktree' : 'Prune Branch & Delete Worktree';
				} else {
					label = force ? 'Force Prune Branches & Delete Worktrees' : 'Prune Branches & Delete Worktrees';
				}
			} else if (branchFirst) {
				if (isSingleWorktree) {
					label = force ? 'Force Delete Branch & Worktree' : 'Delete Branch & Worktree';
				} else {
					label = force ? 'Force Delete Branches & Worktrees' : 'Delete Branches & Worktrees';
				}
			} else if (isSingleWorktree) {
				label = force ? 'Force Delete Worktree' : 'Delete Worktree';
			} else {
				label = force ? 'Force Delete Worktrees' : 'Delete Worktrees';
			}

			// `GitWorktree.branch` is optional, so fall back to the worktree-first wording when there's no name
			const branchName = branchFirst && isSingleWorktree ? selectedWorktrees[0]?.branch?.name : undefined;

			let detail: string;
			if (branchName != null) {
				const worktreePath = getWorkspaceFriendlyPath(state.uris[0]);
				if (deleteUpstreams) {
					detail = force
						? `Will forcibly delete branch ${branchName}, its upstream, and its worktree in $(folder) ${worktreePath}, discarding uncommitted changes and any unmerged commits`
						: `Will delete branch ${branchName}, its upstream, and its worktree in $(folder) ${worktreePath}`;
				} else {
					detail = force
						? `Will forcibly delete branch ${branchName} and its worktree in $(folder) ${worktreePath}, discarding uncommitted changes and any unmerged commits`
						: `Will delete branch ${branchName} and its worktree in $(folder) ${worktreePath}`;
				}
			} else if (branchFirst && !isSingleWorktree) {
				if (deleteUpstreams) {
					detail = force
						? `Will forcibly delete ${formattedWorktreeCount} branches, their upstreams, and their worktrees, discarding uncommitted changes and any unmerged commits`
						: `Will delete ${formattedWorktreeCount} branches, their upstreams, and their worktrees`;
				} else {
					detail = force
						? `Will forcibly delete ${formattedWorktreeCount} branches and their worktrees, discarding uncommitted changes and any unmerged commits`
						: `Will delete ${formattedWorktreeCount} branches and their worktrees`;
				}
			} else if (isSingleWorktree) {
				const worktreePath = getWorkspaceFriendlyPath(state.uris[0]);
				if (deleteUpstreams) {
					detail = force
						? `Will forcibly delete worktree in $(folder) ${worktreePath}, along with its branch and upstream, discarding uncommitted changes and any unmerged commits`
						: `Will delete worktree in $(folder) ${worktreePath}, along with its branch and upstream`;
				} else if (deleteBranches) {
					detail = force
						? `Will forcibly delete worktree in $(folder) ${worktreePath}, along with its branch, discarding uncommitted changes and any unmerged commits`
						: `Will delete worktree in $(folder) ${worktreePath}, along with its branch`;
				} else {
					detail = force
						? `Will forcibly delete worktree in $(folder) ${worktreePath}, even with uncommitted changes`
						: `Will delete worktree in $(folder) ${worktreePath}`;
				}
			} else if (deleteUpstreams) {
				detail = force
					? `Will forcibly delete ${formattedWorktreeCount} worktrees, along with their branches and upstreams, discarding uncommitted changes and any unmerged commits`
					: `Will delete ${formattedWorktreeCount} worktrees, along with their branches and upstreams`;
			} else if (deleteBranches) {
				detail = force
					? `Will forcibly delete ${formattedWorktreeCount} worktrees, along with their branches, discarding uncommitted changes and any unmerged commits`
					: `Will delete ${formattedWorktreeCount} worktrees, along with their branches`;
			} else {
				detail = force
					? `Will forcibly delete ${formattedWorktreeCount} worktrees, even with uncommitted changes`
					: `Will delete ${formattedWorktreeCount} worktrees`;
			}

			return createFlagsQuickPickItem<Flags>(state.flags, flags, {
				label: label,
				description: force ? '--force' : undefined,
				detail: detail,
				picked: true,
			});
		};

		let items: FlagsQuickPickItem<Flags>[] = [buildItem()];

		let step: QuickPickStep<FlagsQuickPickItem<Flags> | DirectiveQuickPickItem>;

		const notices: DirectiveQuickPickItem[] = [];
		let dirtyCheckSettled = false;

		interface Toggles {
			force?: ConfirmToggleQuickPickItem;
			deleteBranch?: ConfirmToggleQuickPickItem;
			deleteUpstream?: ConfirmToggleQuickPickItem;
		}
		// A mutable holder rather than separate variables so each toggle's `onDidChange` can reach its
		// siblings without forward-referencing a not-yet-declared `const` (an `eslint(no-use-before-define)`
		// build error) -- the `force` property is always populated below before `buildRows` is ever called.
		const toggles: Toggles = {};

		/** Every row the confirm step shows, minus the separator + Cancel that `createConfirmStep` appends. */
		const buildRows = (): (FlagsQuickPickItem<Flags> | DirectiveQuickPickItem)[] => [
			...notices,
			...items,
			createQuickPickSeparator(confirmOptionsSeparatorLabel),
			toggles.force!,
			...(toggles.deleteBranch != null
				? [
						createQuickPickSeparator<FlagsQuickPickItem<Flags> | DirectiveQuickPickItem>(
							'Additional Actions',
						),
						toggles.deleteBranch,
						...(toggles.deleteUpstream != null ? [toggles.deleteUpstream] : []),
					]
				: []),
		];

		toggles.force = createConfirmToggleQuickPickItem({
			label: force ? '$(warning) Force' : 'Force',
			detail: force
				? 'Delete even with uncommitted changes — the changes will be lost'
				: 'Delete even with uncommitted changes',
			checked: force,
			onDidChange: item => {
				force = item.checked;
				item.label = force ? '$(warning) Force' : 'Force';
				item.detail = force
					? 'Delete even with uncommitted changes — the changes will be lost'
					: 'Delete even with uncommitted changes';
				items = [buildItem()];
				refreshConfirmStepItems(step, buildRows());
			},
		});

		toggles.deleteBranch = createConfirmToggleQuickPickItem({
			label: isSingleWorktree ? 'Delete Branch' : 'Delete Branches',
			detail: isSingleWorktree
				? 'Also delete the branch checked out in the worktree'
				: 'Also delete the branches checked out in the worktrees',
			checked: deleteBranches,
			onDidChange: item => {
				deleteBranches = item.checked;
				if (!deleteBranches && toggles.deleteUpstream != null) {
					deleteUpstreams = false;
					toggles.deleteUpstream.checked = false;
					toggles.deleteUpstream.iconPath = new ThemeIcon('gitlens-checkbox-unchecked');
				}
				items = [buildItem()];
				refreshConfirmStepItems(step, buildRows());
			},
		});

		if (canDeleteUpstreams) {
			toggles.deleteUpstream = createConfirmToggleQuickPickItem({
				label: isSingleWorktree ? 'Delete Upstream' : 'Delete Upstreams',
				detail: isSingleWorktree
					? "Also delete the branch's upstream from the remote"
					: "Also delete the branches' upstreams from their remotes",
				checked: deleteUpstreams,
				onDidChange: item => {
					deleteUpstreams = item.checked;
					if (deleteUpstreams && toggles.deleteBranch != null) {
						deleteBranches = true;
						toggles.deleteBranch.checked = true;
						toggles.deleteBranch.iconPath = new ThemeIcon('gitlens-checkbox-checked');
					}
					items = [buildItem()];
					refreshConfirmStepItems(step, buildRows());
				},
			});
		}

		// Async pre-flight: check each selected worktree for uncommitted changes so Force's stakes are
		// visible before the user picks a mode, mirroring the conflict-notice pattern used elsewhere.
		if (state.uris.length) {
			void Promise.allSettled(
				state.uris.map(async uri => {
					const worktree = context.worktrees?.find(wt => wt.uri.toString() === uri.toString());
					if (worktree == null) return undefined;

					try {
						return (await GitWorktree.hasWorkingChanges(worktree)) ? worktree : undefined;
					} catch {
						return undefined;
					}
				}),
			).then(results => {
				dirtyCheckSettled = true;

				const dirty = results.map(r => getSettledValue(r)).filter((wt): wt is GitWorktree => wt != null);

				if (dirty.length) {
					notices.splice(
						0,
						1,
						createDirectiveQuickPickItem(Directive.Noop, false, {
							label: 'Contains uncommitted changes',
							iconPath: new ThemeIcon('warning'),
							detail:
								dirty.length === 1
									? `${dirty[0].name} has uncommitted changes — enable Force to delete anyway`
									: `${dirty.length} worktrees have uncommitted changes — enable Force to delete anyway`,
						}),
					);
				} else {
					// Fail open on a check error too -- no evidence of dirty state means no notice, the
					// execute-time checks still protect against data loss either way
					notices.splice(0, notices.length);
				}

				refreshConfirmStepItems(step, buildRows());
			});

			notices.push(
				createDirectiveQuickPickItem(Directive.Noop, false, {
					label: '$(loading~spin)  Checking Worktrees...',
				}),
				createQuickPickSeparator(),
			);
		}

		let confirmTitle: string;
		if (state.fromBranchDelete === 'delete') {
			confirmTitle = isSingleWorktree
				? 'Confirm Delete Branch & Worktree'
				: 'Confirm Delete Branches & Worktrees';
		} else if (state.fromBranchDelete === 'prune') {
			confirmTitle = isSingleWorktree
				? 'Confirm Prune Branch & Delete Worktree'
				: 'Confirm Prune Branches & Delete Worktrees';
		} else {
			confirmTitle = isSingleWorktree ? 'Confirm Delete Worktree' : 'Confirm Delete Worktrees';
		}

		step = createConfirmStep(appendReposToTitle(confirmTitle, state, context), buildRows(), confirmTitle);

		const selection: StepSelection<typeof step> = yield step;
		context.dirtyCheckSettledBeforeConfirm = dirtyCheckSettled;

		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}
}
