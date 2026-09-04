import { window } from 'vscode';
import { RebaseError, SigningError } from '@gitlens/git/errors.js';
import type { GitBranch } from '@gitlens/git/models/branch.js';
import type { GitLog } from '@gitlens/git/models/log.js';
import type { GitReference } from '@gitlens/git/models/reference.js';
import { parseGitBoolean } from '@gitlens/git/utils/config.utils.js';
import { getReferenceLabel, isRevisionReference } from '@gitlens/git/utils/reference.utils.js';
import { createRevisionRange } from '@gitlens/git/utils/revision.utils.js';
import { createDisposable } from '@gitlens/utils/disposable.js';
import { Logger } from '@gitlens/utils/logger.js';
import { getSettledValue } from '@gitlens/utils/promise.js';
import { pluralize } from '@gitlens/utils/string.js';
import type { Container } from '../../container.js';
import { showPausedOperationStatus } from '../../git/actions/pausedOperation.js';
import type { GlRepository } from '../../git/models/repository.js';
import { isRebaseTodoEditorEnabled, reopenRebaseTodoEditor } from '../../git/utils/-webview/rebase.utils.js';
import { showGitErrorMessage } from '../../messages.js';
import { createQuickPickSeparator } from '../../quickpicks/items/common.js';
import type { ConfirmToggleQuickPickItem, DirectiveQuickPickItem } from '../../quickpicks/items/directive.js';
import {
	createConfirmToggleQuickPickItem,
	createDirectiveQuickPickItem,
	Directive,
} from '../../quickpicks/items/directive.js';
import type { FlagsQuickPickItem } from '../../quickpicks/items/flags.js';
import { createFlagsQuickPickItem } from '../../quickpicks/items/flags.js';
import { getHostEditorCommand } from '../../system/-webview/vscode.js';
import type { ViewsWithRepositoryFolders } from '../../views/viewBase.js';
import type {
	AsyncStepResultGenerator,
	PartialStepState,
	StepGenerator,
	StepsContext,
	StepSelection,
	StepState,
} from '../quick-wizard/models/steps.js';
import { StepResultBreak } from '../quick-wizard/models/steps.js';
import type { QuickPickStep } from '../quick-wizard/models/steps.quickpick.js';
import { QuickCommand } from '../quick-wizard/quickCommand.js';
import { pickCommitStep } from '../quick-wizard/steps/commits.js';
import { pickBranchOrTagStep } from '../quick-wizard/steps/references.js';
import { canSkipRepositoryPick, pickRepositoryStep } from '../quick-wizard/steps/repositories.js';
import { StepsController } from '../quick-wizard/stepsController.js';
import {
	appendReposToTitle,
	assertStepState,
	canPickStepContinue,
	confirmOptionsSeparatorLabel,
	refreshConfirmStepItems,
} from '../quick-wizard/utils/steps.utils.js';

const Steps = {
	PickRepo: 'rebase-pick-repo',
	PickBranchOrTag: 'rebase-pick-branch-or-tag',
	PickCommit: 'rebase-pick-commit',
	Confirm: 'rebase-confirm',
} as const;
type StepNames = (typeof Steps)[keyof typeof Steps];

interface Context extends StepsContext<StepNames> {
	repos: GlRepository[];
	associatedView: ViewsWithRepositoryFolders;
	cache: Map<string, Promise<GitLog | undefined>>;
	branch: GitBranch;
	pickCommit: boolean;
	pickCommitForItem: boolean;
	selectedBranchOrTag: GitReference | undefined;
	showTags: boolean;
	title: string;
}

type Flags = '--autosquash' | '--interactive' | '--update-refs';
interface State<Repo = string | GlRepository> {
	repo: Repo;
	destination: GitReference;
	flags: Flags[];
}

export interface RebaseGitCommandArgs {
	readonly command: 'rebase';
	state?: Partial<State>;
}

export class RebaseGitCommand extends QuickCommand<State> {
	constructor(container: Container, args?: RebaseGitCommandArgs) {
		super(container, 'rebase', 'rebase', 'Rebase', {
			description:
				'integrates changes from a specified branch into the current branch, by changing the base of the branch and reapplying the commits on top',
		});

		this.initialState = { confirm: true, ...args?.state };
	}

	override get canSkipConfirm(): boolean {
		return false;
	}

	private async execute(state: StepState<State<GlRepository>>) {
		const interactive = state.flags.includes('--interactive');
		const updateRefs = state.flags.includes('--update-refs');
		// Tri-state: the toggle's choice is passed explicitly BOTH ways where git accepts the flag —
		// `--no-autosquash` included, since a `rebase.autosquash=true` config would otherwise fold
		// fixups with the toggle off. Non-interactive rebases only accept the flag (and only honor the
		// config) on git 2.44+ — below that, pass neither and let the (inert) config lie. `supports()`
		// is cached, so recomputing here beats threading it from the confirm step.
		let autosquash: boolean | undefined;
		if (interactive || (await state.repo.git.supports('git:rebase:autosquash'))) {
			autosquash = state.flags.includes('--autosquash');
		}

		// If the editor is not enabled, listen for the rebase todo file to be opened and then reopen it with our editor
		const disposable =
			interactive && !isRebaseTodoEditorEnabled()
				? window.onDidChangeActiveTextEditor(async e => {
						if (e?.document.uri.path.endsWith('git-rebase-todo')) {
							await reopenRebaseTodoEditor('gitlens.rebase');
							disposable?.dispose();
						}
					})
				: undefined;

		using _ = createDisposable(() => void disposable?.dispose());

		try {
			const result = await state.repo.git.ops?.rebase(state.destination.ref, {
				editor: interactive ? await getHostEditorCommand(true) : undefined,
				interactive: interactive,
				updateRefs: updateRefs,
				autosquash: autosquash,
			});
			if (result?.conflicted) {
				void window.showWarningMessage(
					'Unable to rebase due to conflicts. Resolve the conflicts before continuing, or abort the rebase.',
				);
				void showPausedOperationStatus(this.container, state.repo.path, { source: { source: 'quick-wizard' } });
			}
		} catch (ex) {
			// Don't show an error message if the user intentionally aborted the rebase
			if (RebaseError.is(ex, 'aborted')) {
				Logger.debug(ex.message, this.title);
				return;
			}

			Logger.error(ex, this.title);

			if (RebaseError.is(ex, 'uncommittedChanges') || RebaseError.is(ex, 'wouldOverwriteChanges')) {
				void window.showWarningMessage(
					'Unable to rebase. Your local changes would be overwritten. Please commit or stash your changes before trying again.',
				);
				return;
			}

			if (RebaseError.is(ex, 'alreadyInProgress')) {
				void window.showWarningMessage(
					'Unable to rebase. A rebase is already in progress. Continue or abort the current rebase first.',
				);
				void showPausedOperationStatus(this.container, state.repo.path, { source: { source: 'quick-wizard' } });
				return;
			}

			void showGitErrorMessage(ex, RebaseError.is(ex) || SigningError.is(ex) ? undefined : 'Unable to rebase');
		}
	}

	protected createContext(context?: StepsContext<any>): Context {
		return {
			...context,
			container: this.container,
			repos: this.container.git.openRepositories,
			associatedView: this.container.views.commits,
			cache: new Map<string, Promise<GitLog | undefined>>(),
			branch: undefined!,
			pickCommit: false,
			pickCommitForItem: false,
			selectedBranchOrTag: undefined,
			showTags: true,
			title: this.title,
		};
	}

	protected async *steps(state: PartialStepState<State>, context?: Context): StepGenerator {
		context ??= this.createContext();
		using steps = new StepsController<StepNames>(context, this);

		state.flags ??= [];

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

			if (context.branch == null) {
				const branch = await state.repo.git.branches.getBranch();
				if (branch == null) break;

				context.branch = branch;
			}

			context.title = `${this.title} ${getReferenceLabel(context.branch, {
				icon: false,
				label: false,
			})} onto`;
			context.pickCommitForItem = false;

			if (steps.isAtStep(Steps.PickBranchOrTag) || state.destination == null) {
				using step = steps.enterStep(Steps.PickBranchOrTag);

				// A worded row at the top of the ref list rather than the old icon-only title-bar toggle —
				// a modifier that changes what the next step does should say so where it can be read
				const pickCommitRow = createConfirmToggleQuickPickItem({
					label: 'Choose a Specific Commit',
					detail: 'After choosing the branch, pick the exact commit to rebase onto',
					checked: context.pickCommit,
					onDidChange: (item, quickpick) => {
						context.pickCommit = item.checked;
						quickpick.items = [...quickpick.items];
					},
				});

				const result = yield* pickBranchOrTagStep(state, context, {
					placeholder: context => `Choose a branch${context.showTags ? ' or tag' : ''} to rebase onto`,
					picked: context.selectedBranchOrTag?.ref,
					value: context.selectedBranchOrTag == null ? state.destination?.ref : undefined,
					prependItems: [pickCommitRow, createQuickPickSeparator()],
				});
				if (result === StepResultBreak) {
					state.destination = undefined!;
					if (step.goBack() == null) break;
					continue;
				}

				state.destination = result;
				context.selectedBranchOrTag = undefined;
			}

			if (!isRevisionReference(state.destination)) {
				context.selectedBranchOrTag = state.destination;
			}

			if (
				context.selectedBranchOrTag != null &&
				(steps.isAtStep(Steps.PickCommit) ||
					context.pickCommit ||
					context.pickCommitForItem ||
					state.destination.ref === context.branch.ref)
			) {
				using step = steps.enterStep(Steps.PickCommit);

				const rev = context.selectedBranchOrTag.ref;

				let log = context.cache.get(rev);
				if (log == null) {
					log = state.repo.git.commits.getLog(rev, { merges: 'first-parent' });
					context.cache.set(rev, log);
				}

				const result = yield* pickCommitStep(state, context, {
					emptyItems: [
						createDirectiveQuickPickItem(Directive.Cancel, true, {
							label: 'OK',
							detail: `No commits found on ${getReferenceLabel(context.selectedBranchOrTag, { icon: false })}`,
						}),
					],
					ignoreFocusOut: true,
					log: await log,
					onDidLoadMore: log => context.cache.set(rev, Promise.resolve(log)),
					placeholder: (context, log) =>
						!log?.commits.size
							? `No commits found on ${getReferenceLabel(context.selectedBranchOrTag, { icon: false })}`
							: `Choose a commit to rebase ${getReferenceLabel(context.branch, { icon: false })} onto`,
					picked: state.destination?.ref,
				});
				if (result === StepResultBreak) {
					if (step.goBack() == null) break;
					continue;
				}

				state.destination = result;
			}

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

			steps.markStepsComplete();
			void this.execute(state);
		}

		return steps.isComplete ? undefined : StepResultBreak;
	}

	private async *confirmStep(
		state: StepState<State<GlRepository>>,
		context: Context,
	): AsyncStepResultGenerator<Flags[]> {
		const counts = await state.repo.git.commits.getLeftRightCommitCount(
			createRevisionRange(state.destination.ref, context.branch.ref, '...'),
			{ excludeMerges: true },
		);

		const title = `${context.title} ${getReferenceLabel(state.destination, { icon: false, label: false })}`;
		const ahead = counts?.right ?? 0;
		const behind = counts?.left ?? 0;
		if (behind === 0 && ahead === 0) {
			const step: QuickPickStep<DirectiveQuickPickItem> = this.createConfirmStep(
				appendReposToTitle(`Confirm ${title}`, state, context),
				[],
				createDirectiveQuickPickItem(Directive.Cancel, true, {
					label: 'OK',
					detail: `${getReferenceLabel(context.branch, {
						capitalize: true,
					})} is already up to date with ${getReferenceLabel(state.destination, { label: false })}`,
				}),
				{
					placeholder: `Nothing to rebase; ${getReferenceLabel(context.branch, {
						label: false,
						icon: false,
					})} is already up to date`,
				},
			);
			const selection: StepSelection<typeof step> = yield step;
			canPickStepContinue(step, state, selection);
			return StepResultBreak;
		}

		const branchLabel = getReferenceLabel(context.branch, { label: false });
		const destinationLabel = getReferenceLabel(state.destination, { label: false });
		const applying = `by applying ${pluralize('commit', ahead)} on top of ${destinationLabel}`;
		// Appended to whichever mode is chosen while the Update Branches toggle is on — `--update-refs`
		// modifies every mode identically, so it's a toggle rather than a duplicate of each item.
		const updateRefsClause = ', and update any branches pointing to the rebased commits';
		// Appended to whichever mode is chosen while the Autosquash toggle is on — `--autosquash` modifies
		// every mode identically, so it's a toggle rather than a duplicate of each item.
		const autosquashClause = ', folding fixup commits into their targets';
		const autosquashDetail = 'Also fold fixup! and squash! commits into the commits they target';

		type Mode = { flags: Flags[]; label: string; description?: string; detail: string; picked: boolean };
		const modes: Mode[] = [];

		if (behind > 0) {
			modes.push({
				flags: [],
				label: this.title,
				detail: `Will update ${branchLabel} ${applying}`,
				picked: true,
			});
		}

		modes.push({
			flags: ['--interactive'],
			label: `Interactive ${this.title}`,
			description: '--interactive',
			detail: `Will interactively update ${branchLabel} ${applying}`,
			picked: behind === 0,
		});

		// A seeded wizard flag wins; otherwise the user's `rebase.updateRefs`/`rebase.autosquash` config
		// decides, so each toggle reflects what git will actually do if left untouched. Independent reads,
		// so they run in parallel.
		const [updateRefsConfigResult, autosquashConfigResult, autosquashNonInteractiveSupportedResult] =
			await Promise.allSettled([
				state.repo.git.config.getConfig?.('rebase.updateRefs'),
				state.repo.git.config.getConfig?.('rebase.autosquash'),
				state.repo.git.supports('git:rebase:autosquash'),
			]);
		const updateRefsConfig = parseGitBoolean(getSettledValue(updateRefsConfigResult)) ?? false;
		let updateRefs = state.flags.includes('--update-refs') || updateRefsConfig;

		const autosquashConfig = parseGitBoolean(getSettledValue(autosquashConfigResult)) ?? false;
		let autosquash = state.flags.includes('--autosquash') || autosquashConfig;
		// Interactive rebases support autosquash on every git version GitLens supports — this only gates
		// the plain/automatic (non-interactive) modes, so the toggle's detail can call that out.
		const autosquashNonInteractiveSupported = getSettledValue(autosquashNonInteractiveSupportedResult) ?? false;

		// Folds the live toggle values into each item's flags — the accepted item's flags are the whole
		// contract with `execute()` — and into its detail, so the list says what will actually happen.
		const buildItems = (): FlagsQuickPickItem<Flags>[] =>
			modes.map(m => {
				const flags: Flags[] = [...m.flags];
				let detail = m.detail;
				if (updateRefs) {
					flags.push('--update-refs');
					detail += updateRefsClause;
				}
				if (autosquash) {
					flags.push('--autosquash');
					detail += autosquashClause;
				}

				return createFlagsQuickPickItem<Flags>(state.flags, flags, {
					label: m.label,
					description: m.description,
					detail: detail,
					picked: m.picked,
				});
			});

		let items = buildItems();

		let step: QuickPickStep<DirectiveQuickPickItem | FlagsQuickPickItem<Flags>>;

		interface Toggles {
			updateRefs?: ConfirmToggleQuickPickItem;
			autosquash?: ConfirmToggleQuickPickItem;
		}
		// A mutable holder rather than separate variables so each toggle's handler can reach the other
		// without forward-referencing a not-yet-declared `const` (an `eslint(no-use-before-define)` build
		// error) — both properties are always populated below before `buildRows` is ever called.
		const toggles: Toggles = {};

		/** Every row the confirm step shows, minus the separator + Cancel that `createConfirmStep` appends.
		 *  The separator is labelled so the toggles read as modifiers on the modes above them rather than
		 *  extra modes — the divider alone doesn't carry that. */
		const buildRows = (): (DirectiveQuickPickItem | FlagsQuickPickItem<Flags>)[] => [
			...items,
			createQuickPickSeparator(confirmOptionsSeparatorLabel),
			toggles.updateRefs!,
			toggles.autosquash!,
		];

		toggles.updateRefs = createConfirmToggleQuickPickItem({
			label: 'Update Branches',
			detail: 'Also move any branches pointing to the rebased commits',
			checked: updateRefs,
			onDidChange: item => {
				updateRefs = item.checked;
				items = buildItems();
				refreshConfirmStepItems(step, buildRows());
			},
		});

		toggles.autosquash = createConfirmToggleQuickPickItem({
			label: 'Autosquash',
			detail: autosquashNonInteractiveSupported
				? autosquashDetail
				: `${autosquashDetail} · non-interactive rebases require Git 2.44`,
			checked: autosquash,
			onDidChange: item => {
				autosquash = item.checked;
				items = buildItems();
				refreshConfirmStepItems(step, buildRows());
			},
		});

		step = this.createConfirmStep(appendReposToTitle(`Confirm ${title}`, state, context), buildRows());
		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}
}
