import type { Disposable } from 'vscode';
import type { Container } from '../container.js';
import { builtInActionRunnerName } from './actionRunners.js';
import type { Action, ActionContext, ActionRunner, GitLensApi } from './gitlens.d.js';

export class Api implements GitLensApi {
	readonly #container: Container;
	constructor(container: Container) {
		this.#container = container;
	}

	registerActionRunner<T extends ActionContext>(action: Action<T>, runner: ActionRunner): Disposable {
		if (runner.name === builtInActionRunnerName) {
			throw new Error(`Cannot use the reserved name '${builtInActionRunnerName}'`);
		}

		if ((action as string) === 'hover.commandHelp') {
			action = 'hover.commands';
		}
		return this.#container.actionRunners.register(action, runner);
	}

	// registerAutolinkProvider(provider: RemoteProvider): Disposable;
	// registerPullRequestProvider(provider: RemoteProvider): Disposable;
	// registerRemoteProvider(matcher: string | RegExp, provider: RemoteProvider | RichRemoteProvider): Disposable;
}
