import type { ConfigurationChangeEvent, DecorationOptions, TextEditor, TextEditorDecorationType } from 'vscode';
import { CancellationTokenSource, Disposable, Range, window } from 'vscode';
import { GitCommit } from '@gitlens/git/models/commit.js';
import { debug, trace } from '@gitlens/utils/decorators/log.js';
import { once } from '@gitlens/utils/event.js';
import { getScopedLogger } from '@gitlens/utils/logger.scoped.js';
import { getSettledValue } from '@gitlens/utils/promise.js';
import type { Container } from '../container.js';
import { CommitFormatter } from '../git/formatters/commitFormatter.js';
import { detailsMessage } from '../hovers/hovers.js';
import { configuration } from '../system/-webview/configuration.js';
import { isTrackableTextEditor } from '../system/-webview/vscode/editors.js';
import type { LinesChangeEvent, LineState } from '../trackers/lineTracker.js';
import { getInlineDecoration } from './annotations.js';
import type { BlameFontOptions } from './gutterBlameAnnotationProvider.js';

const annotationDecoration: TextEditorDecorationType = window.createTextEditorDecorationType({
	after: {
		margin: '0 0 0 3em',
		textDecoration: 'none',
	},
});
const maxSmallIntegerV8 = 2 ** 30 - 1; // Max number that can be stored in V8's smis (small integers)

export class LineAnnotationController implements Disposable {
	private _cancellation: CancellationTokenSource | undefined;
	private readonly _disposable: Disposable;
	private _editor: TextEditor | undefined;
	private _enabled: boolean = false;

	constructor(private readonly container: Container) {
		this._disposable = Disposable.from(
			once(container.onReady)(this.onReady, this),
			configuration.onDidChange(this.onConfigurationChanged, this),
			container.fileAnnotations.onDidToggleAnnotations(this.onFileAnnotationsToggled, this),
		);
	}

	dispose(): void {
		this.clearAnnotations(this._editor);

		this.container.lineTracker.unsubscribe(this);
		this._disposable.dispose();
	}

	private onReady(): void {
		this.onConfigurationChanged();
	}

	private onConfigurationChanged(e?: ConfigurationChangeEvent) {
		let refresh = false;

		if (configuration.changed(e, 'defaultCurrentUserNameStyle')) {
			refresh = true;
		}

		if (configuration.changed(e, 'currentLine')) {
			if (configuration.changed(e, 'currentLine.enabled')) {
				if (configuration.get('currentLine.enabled')) {
					this._enabled = true;
					this.resume();
				} else {
					this._enabled = false;
					this.setLineTracker(false);
				}
			}
			refresh = true;
		}

		if (refresh) {
			void this.refresh(window.activeTextEditor);
		}
	}

	private _suspended: boolean = false;
	get suspended(): boolean {
		return !this._enabled || this._suspended;
	}

	@debug()
	resume(): boolean {
		this.setLineTracker(true);

		if (this._suspended) {
			this._suspended = false;
			return true;
		}

		return false;
	}

	@debug()
	suspend(): boolean {
		this.setLineTracker(false);

		if (!this._suspended) {
			this._suspended = true;
			return true;
		}

		return false;
	}

	@trace({
		args: e => ({
			e: {
				editor: e.editor,
				selection: e.selections?.map(s => `[${s.anchor}-${s.active}]`).join(','),
				pending: Boolean(e.pending),
				reason: e.reason,
			},
		}),
	})
	private onActiveLinesChanged(e: LinesChangeEvent) {
		// Editing event — user is typing on the current line.
		// Clear decorations so annotations don't interfere with editing.
		// They'll reappear when the cursor moves to a different line.
		if (e.editing) {
			this.clearAnnotations(e.editor);
			return;
		}

		// Real event with blame data ready — refresh decorations
		if (!e.pending && e.selections != null) {
			void this.refresh(e.editor);
			return;
		}

		// Pending event — cursor moved, blame data not ready yet.
		// Clear stale decorations so old blame doesn't "stick" on the wrong line,
		// but DON'T cancel in-flight work — let it complete or detect staleness.
		if (e.pending) {
			if (this._editor !== e.editor && this._editor != null) {
				this.clearAnnotations(this._editor);
			}
			this.clearAnnotations(e.editor);
			return;
		}

		// No selections / suspended / error — full clear including work cancellation
		this.clear(e.editor);
	}

	private onFileAnnotationsToggled() {
		void this.refresh(window.activeTextEditor);
	}

	@trace({ args: false, onlyExit: true })
	clear(editor: TextEditor | undefined): void {
		this._cancellation?.cancel();
		if (this._editor !== editor && this._editor != null) {
			this.clearAnnotations(this._editor);
		}
		this.clearAnnotations(editor);
	}

	@debug({ args: false })
	async toggle(editor: TextEditor | undefined): Promise<void> {
		this._enabled = !(this._enabled && !this.suspended);

		if (this._enabled) {
			if (this.resume()) {
				await this.refresh(editor);
			}
		} else if (this.suspend()) {
			await this.refresh(editor);
		}
	}

	private clearAnnotations(editor: TextEditor | undefined) {
		if (editor === undefined || (editor as any)._disposed === true) return;

		editor.setDecorations(annotationDecoration, []);
	}

	@trace()
	private async refresh(editor: TextEditor | undefined) {
		if (editor == null && this._editor == null) return;

		const scope = getScopedLogger();

		const selections = this.container.lineTracker.selections;
		const selectionsVersion = this.container.lineTracker.selectionsVersion;
		if (editor == null || selections == null || !isTrackableTextEditor(editor)) {
			scope?.addExitInfo('Skipped because there is no valid editor or no valid selections');

			this.clear(this._editor);
			return;
		}

		if (this._editor !== editor) {
			// Clear any annotations on the previously active editor
			this.clear(this._editor);

			this._editor = editor;
		}

		const cfg = configuration.get('currentLine');
		if (this.suspended) {
			scope?.addExitInfo('Skipped because the controller is suspended');

			this.clear(editor);
			return;
		}

		// Don't show annotations while actively editing the current line
		if (this.container.lineTracker.isEditing) {
			scope?.addExitInfo('Skipped because the user is actively editing');

			this.clearAnnotations(editor);
			return;
		}

		const trackedDocument = await this.container.documentTracker.getOrAdd(editor.document);
		const status = await trackedDocument?.getStatus();
		if (!status?.blameable || this.suspended) {
			scope?.addExitInfo(
				`Skipped because the ${this.suspended ? 'controller is suspended' : 'document is not blameable'}`,
			);

			this.clear(editor);
			return;
		}

		// Make sure the editor hasn't died since the await above and that we are still on the same line(s)
		if (editor.document == null || selectionsVersion !== this.container.lineTracker.selectionsVersion) {
			scope?.addExitInfo(
				`Skipped because the ${
					editor.document == null
						? 'editor is gone'
						: `selection=${selections.map(s => `[${s.anchor}-${s.active}]`).join()} are no longer current`
				}`,
			);
			this.clearAnnotations(editor);
			return;
		}

		scope?.addExitInfo(`selection=${selections.map(s => `[${s.anchor}-${s.active}]`).join()}`);

		const hoverOptions: RequireSome<Parameters<typeof detailsMessage>[4], 'autolinks' | 'sourceName'> | undefined =
			undefined;

		const commitPromises = new Map<string, Promise<void>>();
		const lines = new Map<number, LineState>();
		for (const selection of selections) {
			const state = this.container.lineTracker.getState(selection.active);
			if (state?.commit == null) {
				scope?.trace(`Line ${selection.active} returned no commit`);
				continue;
			}

			// Ensure full details only when the commit does not already include its message.
			if (hoverOptions != null && state.commit.message == null && !commitPromises.has(state.commit.ref)) {
				commitPromises.set(state.commit.ref, GitCommit.ensureFullDetails(state.commit));
			}
			lines.set(selection.active, state);
		}

		const repoPath = trackedDocument.uri.repoPath;

		this._cancellation?.cancel();
		this._cancellation = new CancellationTokenSource();
		const cancellation = this._cancellation.token;

		const getBranchAndTagTipsPromise =
			repoPath && CommitFormatter.has(cfg.format, 'tips')
				? this.container.git.getRepositoryService(repoPath).getBranchesAndTagsTipsLookup()
				: undefined;

		async function updateDecorations(
			container: Container,
			editor: TextEditor,
			getBranchAndTagTips: Awaited<typeof getBranchAndTagTipsPromise> | undefined,
			timeout?: number,
		) {
			const fontOptions: BlameFontOptions = {
				family: cfg.fontFamily,
				size: cfg.fontSize,
				style: cfg.fontStyle,
				weight: cfg.fontWeight,
			};

			const decorations = [];

			for (const [l, state] of lines) {
				const commit = state.commit;
				if (commit == null || (commit.isUncommitted && cfg.uncommittedChangesFormat === '')) continue;

				const decoration = getInlineDecoration(
					commit,
					// await GitUri.fromUri(editor.document.uri),
					// l,
					commit.isUncommitted ? (cfg.uncommittedChangesFormat ?? cfg.format) : cfg.format,
					{
						dateFormat: cfg.dateFormat ?? configuration.get('defaultDateFormat'),
						getBranchAndTagTips: getBranchAndTagTips,
						source: { source: 'editor:hover' },
					},
					fontOptions,
					cfg.scrollable,
				) as DecorationOptions;
				decoration.range = editor.document.validateRange(new Range(l, maxSmallIntegerV8, l, maxSmallIntegerV8));

				if (hoverOptions != null) {
					decoration.hoverMessage = await detailsMessage(container, commit, trackedDocument.uri, l, {
						...hoverOptions,
						timeout: timeout,
					});
				}

				decorations.push(decoration);
			}

			editor.setDecorations(annotationDecoration, decorations);
		}

		const [getBranchAndTagTipsResult] = await Promise.allSettled([
			getBranchAndTagTipsPromise,
			...commitPromises.values(),
		]);

		if (cancellation.isCancellationRequested) {
			this.clearAnnotations(editor);
			return;
		}

		await updateDecorations(this.container, editor, getSettledValue(getBranchAndTagTipsResult), 100);
	}

	private setLineTracker(enabled: boolean) {
		if (enabled) {
			if (!this.container.lineTracker.subscribed(this)) {
				this.container.lineTracker.subscribe(
					this,
					this.container.lineTracker.onDidChangeActiveLines(this.onActiveLinesChanged, this),
				);
			}

			return;
		}

		this.container.lineTracker.unsubscribe(this);
	}
}
