import { window } from 'vscode';
import { CherryPickError, SigningError } from '@gitlens/git/errors.js';
import type { GitBranch } from '@gitlens/git/models/branch.js';
import type { GitLog } from '@gitlens/git/models/log.js';
import type { GitPausedOperationStatus } from '@gitlens/git/models/pausedOperationStatus.js';
import type { GitReference } from '@gitlens/git/models/reference.js';
import { getReferenceLabel, isRevisionReference } from '@gitlens/git/utils/reference.utils.js';
import { createRevisionRange } from '@gitlens/git/utils/revision.utils.js';
import { Logger } from '@gitlens/utils/logger.js';
import type { Container } from '../../container.js';
import { showPausedOperationStatus, skipPausedOperation } from '../../git/actions/pausedOperation.js';
import type { GlRepository } from '../../git/models/repository.js';
import { showGitErrorMessage } from '../../messages.js';
import { createDirectiveQuickPickItem, Directive } from '../../quickpicks/items/directive.js';
import type { FlagsQuickPickItem } from '../../quickpicks/items/flags.js';
import { createFlagsQuickPickItem } from '../../quickpicks/items/flags.js';
import type { ViewsWithRepositoryFolders } from '../../views/viewBase.js';
import type {
	PartialStepState,
	StepGenerator,
	StepResult,
	StepResultGenerator,
	StepsContext,
	StepSelection,
	StepState,
} from '../quick-wizard/models/steps.js';
import { StepResultBreak } from '../quick-wizard/models/steps.js';
import { QuickCommand } from '../quick-wizard/quickCommand.js';
import { pickCommitsStep } from '../quick-wizard/steps/commits.js';
import { pickBranchOrTagStep } from '../quick-wizard/steps/references.js';
import { canSkipRepositoryPick, pickRepositoryStep } from '../quick-wizard/steps/repositories.js';
import { StepsController } from '../quick-wizard/stepsController.js';
import { appendReposToTitle, assertStepState, canPickStepContinue } from '../quick-wizard/utils/steps.utils.js';

const Steps = {
	PickRepo: 'cherry-pick-pick-repo',
	PickBranchOrTag: 'cherry-pick-pick-branch-or-tag',
	PickCommits: 'cherry-pick-pick-commits',
	Confirm: 'cherry-pick-confirm',
} as const;
type StepNames = (typeof Steps)[keyof typeof Steps];

interface Context extends StepsContext<StepNames> {
	repos: GlRepository[];
	associatedView: ViewsWithRepositoryFolders;
	cache: Map<string, Promise<GitLog | undefined>>;
	destination: GitBranch;
	selectedBranchOrTag: GitReference | undefined;
	showTags: boolean;
	title: string;
}

type Flags = '--edit' | '--no-commit';
interface State<Repo = string | GlRepository, Refs = GitReference | GitReference[]> {
	repo: Repo;
	references: Refs;
	flags: Flags[];
}

export interface CherryPickGitCommandArgs {
	readonly command: 'cherry-pick';
	state?: Partial<State>;
}

export class CherryPickGitCommand extends QuickCommand<State> {
	constructor(container: Container, args?: CherryPickGitCommandArgs) {
		super(container, 'cherry-pick', 'cherry-pick', 'Cherry Pick', {
			description: 'integrates changes from specified commits into the current branch',
		});

		this.initialState = { confirm: true, ...args?.state };
	}

	override get canSkipConfirm(): boolean {
		return false;
	}

	private async execute(state: StepState<State<GlRepository, GitReference[]>>) {
		try {
			const result = await state.repo.git.ops?.cherryPick?.(
				state.references.map(c => c.ref),
				{
					edit: state.flags.includes('--edit'),
					noCommit: state.flags.includes('--no-commit'),
				},
			);
			if (result?.conflicted) {
				void window.showWarningMessage(
					'Unable to cherry-pick due to conflicts. Resolve the conflicts before continuing, or abort the cherry-pick.',
				);
				void showPausedOperationStatus(this.container, state.repo.path, { source: { source: 'quick-wizard' } });
			}
		} catch (ex) {
			// Don't show an error message if the user intentionally aborted the cherry-pick
			if (CherryPickError.is(ex, 'aborted')) {
				Logger.debug(ex.message, this.title);
				return;
			}

			Logger.error(ex, this.title);

			if (CherryPickError.is(ex, 'wouldOverwriteChanges')) {
				void window.showWarningMessage(
					'Unable to cherry-pick. Your local changes would be overwritten. Please commit or stash your changes before trying again.',
				);
				return;
			}

			if (CherryPickError.is(ex, 'alreadyInProgress')) {
				void window.showWarningMessage(
					'Unable to cherry-pick. A cherry-pick is already in progress. Continue or abort the current cherry-pick first.',
				);
				void showPausedOperationStatus(this.container, state.repo.path, { source: { source: 'quick-wizard' } });
				return;
			}

			if (CherryPickError.is(ex, 'emptyCommit')) {
				let pausedOperation: GitPausedOperationStatus | undefined;
				try {
					pausedOperation = await state.repo.git.pausedOps?.getPausedOperationStatus?.();
					pausedOperation ??= await state.repo
						.waitForRepoChange(500)
						.then(() => state.repo.git.pausedOps?.getPausedOperationStatus?.());
				} catch {}

				const pausedAt = pausedOperation
					? getReferenceLabel(pausedOperation?.incoming, { icon: false, label: true, quoted: true })
					: undefined;

				const skip = { title: 'Skip' };
				const cancel = { title: 'Cancel', isCloseAffordance: true };
				const result = await window.showInformationMessage(
					`Unable to complete the cherry-pick operation because ${pausedAt ?? 'it'} resulted in an empty commit.\n\nDo you want to skip ${pausedAt ?? 'this commit'}?`,
					{ modal: true },
					skip,
					cancel,
				);
				if (result === skip) {
					return void skipPausedOperation(this.container, state.repo.git, { source: 'quick-wizard' });
				}

				void showPausedOperationStatus(this.container, state.repo.path, { source: { source: 'quick-wizard' } });
				return;
			}

			void showGitErrorMessage(
				ex,
				CherryPickError.is(ex) || SigningError.is(ex) ? undefined : 'Unable to cherry-pick',
			);
		}
	}

	override isFuzzyMatch(name: string): boolean {
		return super.isFuzzyMatch(name) || name === 'cherry';
	}

	protected createContext(context?: StepsContext<any>): Context {
		return {
			...context,
			container: this.container,
			repos: this.container.git.openRepositories,
			associatedView: this.container.views.commits,
			cache: new Map<string, Promise<GitLog | undefined>>(),
			destination: undefined!,
			selectedBranchOrTag: undefined,
			showTags: true,
			title: this.title,
		};
	}

	protected async *steps(state: PartialStepState<State>, context?: Context): StepGenerator {
		context = this.createContext();
		using steps = new StepsController<StepNames>(context, this);

		state.flags ??= [];

		if (state.references != null && !Array.isArray(state.references)) {
			state.references = [state.references];
		}

		while (!steps.isComplete) {
			context.title = this.title;

			if (steps.isAtStep(Steps.PickRepo) || state.repo == null || typeof state.repo === 'string') {
				// Skip the picker only when the sole available repo is the one requested
				if (canSkipRepositoryPick(context.repos, state.repo)) {
					[state.repo] = context.repos;
				} else {
					using step = steps.enterStep(Steps.PickRepo);

					const result = yield* pickRepositoryStep(state, context, step);
					if (result === StepResultBreak) {
						state.repo = undefined!;
						if (step.goBack() == null) break;
						continue;
					}

					state.repo = result;
				}
			}

			assertStepState<State<GlRepository>>(state);

			if (context.destination == null) {
				const branch = await state.repo.git.branches.getBranch();
				if (branch == null) break;

				context.destination = branch;
			}

			context.title = `${this.title} into ${getReferenceLabel(context.destination, {
				icon: false,
				label: false,
			})}`;

			if (steps.isAtStep(Steps.PickBranchOrTag) || !state.references?.length) {
				using step = steps.enterStep(Steps.PickBranchOrTag);

				const result: StepResult<GitReference> = yield* pickBranchOrTagStep(state, context, {
					filter: { branches: b => b.id !== context.destination.id },
					placeholder: context => `Choose a branch${context.showTags ? ' or tag' : ''} to cherry-pick from`,
					picked: context.selectedBranchOrTag?.ref,
					value: context.selectedBranchOrTag == null ? state.references?.[0]?.ref : undefined,
				});
				if (result === StepResultBreak) {
					state.references = undefined!;
					if (step.goBack() == null) break;
					continue;
				}

				if (isRevisionReference(result)) {
					state.references = [result];
					context.selectedBranchOrTag = undefined;
				} else {
					context.selectedBranchOrTag = result;
				}
			}

			if (context.selectedBranchOrTag == null && state.references?.length) {
				const branches: string[] = await state.repo.git.branches.getBranchesWithCommits(
					state.references.map(r => r.ref),
					undefined,
					{ mode: 'contains' },
				);
				if (branches.length) {
					const branch = await state.repo.git.branches.getBranch(branches[0]);
					if (branch != null) {
						context.selectedBranchOrTag = branch;
					}
				}
			}

			if (
				context.selectedBranchOrTag != null &&
				(steps.isAtStep(Steps.PickCommits) || !state.references?.length)
			) {
				using step = steps.enterStep(Steps.PickCommits);

				const rev = createRevisionRange(context.destination.ref, context.selectedBranchOrTag.ref, '..');

				let log = context.cache.get(rev);
				if (log == null) {
					log = state.repo.git.commits.getLog(rev, { merges: 'first-parent' });
					context.cache.set(rev, log);
				}

				const result: StepResult<GitReference[]> = yield* pickCommitsStep(state, context, {
					emptyItems: [
						createDirectiveQuickPickItem(Directive.Cancel, true, {
							label: 'OK',
							detail: `No pickable commits found on ${getReferenceLabel(context.selectedBranchOrTag, { icon: false })}`,
						}),
					],
					log: await log,
					onDidLoadMore: log => context.cache.set(rev, Promise.resolve(log)),
					picked: state.references?.map(r => r.ref),
					placeholder: (context, log) =>
						!log?.commits.size
							? `No pickable commits found on ${getReferenceLabel(context.selectedBranchOrTag, { icon: false })}`
							: `Choose commits to cherry-pick into ${getReferenceLabel(context.destination, { icon: false })}`,
				});
				if (result === StepResultBreak) {
					state.references = undefined!;
					if (step.goBack() == null) break;
					continue;
				}

				state.references = result;
			}

			assertStepState<State<GlRepository, GitReference[]>>(state);

			if (this.confirm(state.confirm)) {
				using step = steps.enterStep(Steps.Confirm);

				const result = yield* this.confirmStep(state, context);
				if (result === StepResultBreak) {
					state.flags = [];
					if (step.goBack() == null) break;
					continue;
				}

				state.flags = result;
			}

			steps.markStepsComplete();
			void this.execute(state);
		}

		return steps.isComplete ? undefined : StepResultBreak;
	}

	private *confirmStep(
		state: StepState<State<GlRepository, GitReference[]>>,
		context: Context,
	): StepResultGenerator<Flags[]> {
		const items: FlagsQuickPickItem<Flags>[] = [
			createFlagsQuickPickItem<Flags>(state.flags, [], {
				label: this.title,
				detail: `Will apply ${getReferenceLabel(state.references, { label: false })} to ${getReferenceLabel(
					context.destination,
					{ label: false },
				)}`,
			}),
			createFlagsQuickPickItem<Flags>(state.flags, ['--edit'], {
				label: `${this.title} & Edit`,
				description: '--edit',
				detail: `Will edit and apply ${getReferenceLabel(state.references, {
					label: false,
				})} to ${getReferenceLabel(context.destination, {
					label: false,
				})}`,
			}),
			createFlagsQuickPickItem<Flags>(state.flags, ['--no-commit'], {
				label: `${this.title} without Committing`,
				description: '--no-commit',
				detail: `Will apply ${getReferenceLabel(state.references, { label: false })} to ${getReferenceLabel(
					context.destination,
					{ label: false },
				)} without Committing`,
			}),
		];

		const step = this.createConfirmStep(appendReposToTitle(`Confirm ${context.title}`, state, context), items);
		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}
}
