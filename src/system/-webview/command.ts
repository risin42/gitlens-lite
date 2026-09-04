import type { Command, Disposable, Uri } from 'vscode';
import { commands } from 'vscode';
import type { Action, ActionContext } from '../../api/gitlens.d.js';
import type { GlCommandBase } from '../../commands/commandBase.js';
import type { CodeLensCommands } from '../../config.js';
import type {
	CoreCommands,
	CoreGitCommands,
	GlCommands,
	GlCommandsDeprecated,
	GlWebviewCommands,
} from '../../constants.commands.js';
import { actionCommandPrefix } from '../../constants.commands.js';
import { Container } from '../../container.js';

export type CommandCallback = Parameters<typeof commands.registerCommand>[1];

type CommandConstructor = new (container: Container, ...args: any[]) => GlCommandBase;
const registrableCommands: CommandConstructor[] = [];

export function command(): ClassDecorator {
	return (target: any) => {
		registrableCommands.push(target);
	};
}

export function registerCommand(
	command: GlCommands | GlCommandsDeprecated,
	callback: CommandCallback,
	thisArg?: any,
	options?: { returnResult?: boolean },
): Disposable {
	return commands.registerCommand(
		command,
		function (this: any, ...args) {
			void Container.instance.usage.track(`command:${command}:executed`).catch();
			if (options?.returnResult) {
				// oxlint-disable-next-line typescript/no-unsafe-return
				return callback.call(this, ...args);
			}

			callback.call(this, ...args);
		},
		thisArg,
	);
}

export function registerWebviewCommand(
	command: GlWebviewCommands,
	callback: CommandCallback,
	thisArg?: any,
	options?: { returnResult?: boolean },
): Disposable {
	return commands.registerCommand(
		command,
		function (this: any, ...args) {
			void Container.instance.usage.track(`command:${command}:executed`).catch();
			if (options?.returnResult) {
				// oxlint-disable-next-line typescript/no-unsafe-return
				return callback.call(this, ...args);
			}

			callback.call(this, ...args);
		},
		thisArg,
	);
}

export function registerCommands(container: Container): Disposable[] {
	return registrableCommands.map(c => new c(container));
}

export function executeActionCommand<T extends ActionContext>(
	action: Action<T>,
	args: Omit<T, 'type'>,
	runnerId?: number,
): Thenable<unknown> {
	return commands.executeCommand(`${actionCommandPrefix}${action}`, { ...args, type: action }, runnerId);
}

export function createCommand<T extends unknown[]>(
	command: GlCommands | CodeLensCommands,
	title: string,
	...args: T
): Command {
	return { command: command, title: title, arguments: args };
}

export function createTerminalLinkCommand<T extends object>(
	command: GlCommands,
	args: T,
): { command: GlCommands; args: T } {
	return { command: command, args: args };
}

export function executeCommand<U = any>(command: GlCommands): Thenable<U>;
export function executeCommand<T = unknown, U = any>(command: GlCommands, arg: T): Thenable<U>;
export function executeCommand<T extends [...unknown[]] = [], U = any>(command: GlCommands, ...args: T): Thenable<U>;
export function executeCommand<T extends [...unknown[]] = [], U = any>(command: GlCommands, ...args: T): Thenable<U> {
	return commands.executeCommand<U>(command, ...args);
}

export function createCoreCommand<T extends unknown[]>(command: CoreCommands, title: string, ...args: T): Command {
	return { command: command, title: title, arguments: args };
}

export function executeCoreCommand<T = unknown, U = any>(command: CoreCommands, arg: T): Thenable<U>;
export function executeCoreCommand<T extends [...unknown[]] = [], U = any>(
	command: CoreCommands,
	...args: T
): Thenable<U>;
export function executeCoreCommand<T extends [...unknown[]] = [], U = any>(
	command: CoreCommands,
	...args: T
): Thenable<U> {
	return commands.executeCommand<U>(command, ...args);
}

export function createCoreGitCommand<T extends unknown[]>(
	command: CoreGitCommands,
	title: string,
	...args: T
): Command {
	return {
		command: command,
		title: title,
		arguments: args,
	};
}

export function executeCoreGitCommand<U = any>(command: CoreGitCommands): Thenable<U>;
export function executeCoreGitCommand<T = unknown, U = any>(command: CoreGitCommands, arg: T): Thenable<U>;
export function executeCoreGitCommand<T extends [...unknown[]] = [], U = any>(
	command: CoreGitCommands,
	...args: T
): Thenable<U>;
export function executeCoreGitCommand<T extends [...unknown[]] = [], U = any>(
	command: CoreGitCommands,
	...args: T
): Thenable<U> {
	return commands.executeCommand<U>(command, ...args);
}

export function executeEditorCommand<T>(command: GlCommands, uri: Uri | undefined, args: T): Thenable<unknown> {
	return commands.executeCommand(command, uri, args);
}
