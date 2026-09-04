import type { MessageItem } from 'vscode';
import { ConfigurationTarget, ThemeIcon, window } from 'vscode';
import type { BlameIgnoreRevsFileError, GitCommandContext } from '@gitlens/git/errors.js';
import { BlameIgnoreRevsFileBadRevisionError, GitCommandError } from '@gitlens/git/errors.js';
import type { GitCommit } from '@gitlens/git/models/commit.js';
import { filterMap } from '@gitlens/utils/array.js';
import { Logger } from '@gitlens/utils/logger.js';
import type { SuppressedMessages } from './config.js';
import { formatIdentityDisplayName, getCommitFormattedDate } from './git/utils/-webview/commit.utils.js';
import { executeCommand } from './system/-webview/command.js';
import { configuration } from './system/-webview/configuration.js';
import { openTerminal } from './system/-webview/terminal.js';
import { openUrl } from './system/-webview/vscode/uris.js';

export function showBlameInvalidIgnoreRevsFileWarningMessage(
	ex: BlameIgnoreRevsFileError | BlameIgnoreRevsFileBadRevisionError,
): Promise<MessageItem | undefined> {
	if (ex instanceof BlameIgnoreRevsFileBadRevisionError) {
		return showMessage(
			'error',
			`Unable to show blame. Invalid revision (${ex.revision}) specified in the blame.ignoreRevsFile in your Git config.`,
			'suppressBlameInvalidIgnoreRevsFileBadRevisionWarning',
		);
	}

	return showMessage(
		'error',
		`Unable to show blame. Invalid or missing blame.ignoreRevsFile (${ex.fileName}) specified in your Git config.`,
		'suppressBlameInvalidIgnoreRevsFileWarning',
	);
}

export function showCommitHasNoPreviousCommitWarningMessage(commit?: GitCommit): Promise<MessageItem | undefined> {
	if (commit == null) {
		return showMessage('info', 'There is no previous commit.', 'suppressCommitHasNoPreviousCommitWarning');
	}
	return showMessage(
		'info',
		`Commit ${commit.shortSha} (${formatIdentityDisplayName(commit.author)}, ${getCommitFormattedDate(commit)}) has no previous commit.`,
		'suppressCommitHasNoPreviousCommitWarning',
	);
}

export function showCommitNotFoundWarningMessage(message: string): Promise<MessageItem | undefined> {
	return showMessage('warn', `${message}. The commit could not be found.`, 'suppressCommitNotFoundWarning');
}

export async function showCreatePullRequestPrompt(branch: string): Promise<boolean> {
	const create = { title: 'Create Pull Request...' };
	const result = await showMessage(
		'info',
		`Would you like to create a Pull Request for branch '${branch}'?`,
		'suppressCreatePullRequestPrompt',
		{ title: "Don't Show Again" },
		create,
	);
	return result === create;
}

export async function showDebugLoggingWarningMessage(): Promise<boolean> {
	const disable = { title: 'Disable Debug Logging' };
	const result = await showMessage(
		'warn',
		'GitLens debug logging is currently enabled. Unless you are reporting an issue, it is recommended to be disabled. Would you like to disable it?',
		'suppressDebugLoggingWarning',
		{ title: "Don't Show Again" },
		disable,
	);

	return result === disable;
}

export async function showGenericErrorMessage(message: string): Promise<void> {
	if (Logger.enabled('error')) {
		const result = await showMessage('error', `${message}. See output channel for more details.`, undefined, null, {
			title: 'Open Output Channel',
		});

		if (result != null) {
			Logger.showOutputChannel();
		}
	} else {
		const result = await showMessage(
			'error',
			`${message}. If the error persists, please enable debug logging and try again.`,
			undefined,
			null,
			{
				title: 'Enable Debug Logging',
			},
		);

		if (result != null) {
			void executeCommand('gitlens.enableDebugLogging');
		}
	}
}

function escapeShellArg(arg: string): string {
	// If the argument contains spaces, quotes, or special characters, wrap it in single quotes
	// and escape any single quotes within it
	if (/[\s"'`$\\|&;<>(){}[\]!*?#~]/.test(arg)) {
		// Escape single quotes by replacing ' with '\''
		return `'${arg.replace(/'/g, "'\\''")}'`;
	}
	return arg;
}

function showGitCommandInTerminal(gitCommand: GitCommandContext, error: GitCommandError<any>): void {
	const terminal = openTerminal({
		cwd: gitCommand.repoPath,
		name: 'GitLens',
		hideFromUser: false,
		iconPath: new ThemeIcon('gitlens-gitlens'),
		isTransient: true,
		message: `\x1b[1mGitLens attempted to run this Git command and it failed:\x1b[0m\r\n\x1b[31m${error.message}\x1b[0m\r\n\x1b[3mYou can run it again or modify it to diagnose the issue.\x1b[0m\r\n`,
	});
	const command = `git ${filterMap(gitCommand.args, a => (a != null ? escapeShellArg(a) : undefined)).join(' ')}`;
	terminal.sendText(command, false);
	terminal.show();
}

export async function showGitErrorMessage(error: Error | GitCommandError<any>, message?: string): Promise<void> {
	if (!GitCommandError.is(error)) {
		return void showGenericErrorMessage(message ?? error.message);
	}

	const { gitCommand } = error.details;
	message = message ?? error.message;
	const loggingEnabled = Logger.enabled('error');

	const openOutputChannelOrEnableLogging: MessageItem = {
		title: loggingEnabled ? 'Open Output Channel' : 'Enable Debug Logging',
	};
	const openInTerminalAction: MessageItem = { title: 'Open in Terminal' };

	const result = await showMessage(
		'error',
		`${message.endsWith('.') ? message : `${message}.`} ${loggingEnabled ? 'See output channel for more details.' : 'If the error persists, please enable debug logging and try again.'}`,
		undefined,
		null,
		...(gitCommand != null
			? [openInTerminalAction, openOutputChannelOrEnableLogging]
			: [openOutputChannelOrEnableLogging]),
	);

	if (result === openInTerminalAction) {
		showGitCommandInTerminal(gitCommand, error);
		return;
	}

	if (result === openOutputChannelOrEnableLogging) {
		if (loggingEnabled) {
			Logger.showOutputChannel();
		} else {
			void executeCommand('gitlens.enableDebugLogging');
		}
	}
}

export async function showBitbucketPRCommitLinksAppNotInstalledWarningMessage(revLink: string): Promise<void> {
	const allowAccess = { title: 'Allow Access' };
	const result = await showMessage(
		'warn',
		`GitLens cannot access Bitbucket PRs for commits.
		Allow access by visiting [this commit](${revLink}) on Bitbucket and click “Pull requests” under the “Apps” section on the bottom right
		or [read our docs](https://help.gitkraken.com/gitlens/gitlens-troubleshooting/#enable-showing-bitbucket-pull-request-for-a-commit) for more info.`,
		'suppressBitbucketPRCommitLinksAppNotInstalledWarning',
		{ title: "Don't Show Again" },
		allowAccess,
	);
	if (result === allowAccess) {
		void openUrl(revLink);
	}
}

export function showFileNotUnderSourceControlWarningMessage(message: string): Promise<MessageItem | undefined> {
	return showMessage(
		'warn',
		`${message}. The file is probably not under source control.`,
		'suppressFileNotUnderSourceControlWarning',
	);
}

export function showGitDisabledErrorMessage(): Promise<MessageItem | undefined> {
	return showMessage(
		'error',
		'GitLens requires Git to be enabled. Please re-enable Git \u2014 set `git.enabled` to true and reload.',
		'suppressGitDisabledWarning',
	);
}

export function showGitInvalidConfigErrorMessage(): Promise<MessageItem | undefined> {
	return showMessage(
		'error',
		'GitLens is unable to use Git. Your Git configuration seems to be invalid. Please resolve any issues with your Git configuration and reload.',
	);
}

export function showGitMissingErrorMessage(): Promise<MessageItem | undefined> {
	return showMessage(
		'error',
		"GitLens was unable to find Git. Please make sure Git is installed. Also ensure that Git is either in the PATH, or that 'git.path' is pointed to its installed location.",
		'suppressGitMissingWarning',
	);
}

export function showGitVersionUnsupportedErrorMessage(
	version: string,
	required: string,
): Promise<MessageItem | undefined> {
	return showMessage(
		'error',
		`GitLens requires a newer version of Git (>= ${required}) than is currently installed (${version}). Please install a more recent version of Git.`,
		'suppressGitVersionWarning',
	);
}

export function showLineUncommittedWarningMessage(message: string): Promise<MessageItem | undefined> {
	return showMessage('warn', `${message}. The line has uncommitted changes.`, 'suppressLineUncommittedWarning');
}

export function showNoRepositoryWarningMessage(message: string): Promise<MessageItem | undefined> {
	return showMessage('warn', `${message}. No repository could be found.`, 'suppressNoRepositoryWarning');
}

export async function showWhatsNewMessage(majorVersion: string): Promise<void> {
	await showMessage('info', `GitLens upgraded to ${majorVersion}.`, undefined, null, {
		title: 'OK',
		isCloseAffordance: true,
	});
}

export async function showMessage(
	type: 'info' | 'warn' | 'error',
	message: string,
	suppressionKey?: SuppressedMessages,
	dontShowAgain: MessageItem | null = { title: "Don't Show Again" },
	...actions: MessageItem[]
): Promise<MessageItem | undefined> {
	Logger.debug(`ShowMessage(${type}, '${message}', ${suppressionKey}, ${JSON.stringify(dontShowAgain)})`);

	if (suppressionKey != null && configuration.get(`advanced.messages.${suppressionKey}` as const)) {
		Logger.debug(`ShowMessage(${type}, '${message}', ${suppressionKey}, ${JSON.stringify(dontShowAgain)}) skipped`);
		return undefined;
	}

	if (suppressionKey != null && dontShowAgain !== null) {
		actions.push(dontShowAgain);
	}

	let result: MessageItem | undefined = undefined;
	switch (type) {
		case 'info':
			result = await window.showInformationMessage(message, ...actions);
			break;

		case 'warn':
			result = await window.showWarningMessage(message, ...actions);
			break;

		case 'error':
			result = await window.showErrorMessage(message, ...actions);
			break;
	}

	if (suppressionKey != null && (dontShowAgain === null || result === dontShowAgain)) {
		Logger.debug(
			`ShowMessage(${type}, '${message}', ${suppressionKey}, ${JSON.stringify(
				dontShowAgain,
			)}) don't show again requested`,
		);
		await suppressedMessage(suppressionKey);

		if (result === dontShowAgain) return undefined;
	}

	Logger.debug(
		`ShowMessage(${type}, '${message}', ${suppressionKey}, ${JSON.stringify(dontShowAgain)}) returned ${
			result != null ? result.title : result
		}`,
	);
	return result;
}

function suppressedMessage(suppressionKey: SuppressedMessages) {
	const messages = { ...configuration.get('advanced.messages') };

	messages[suppressionKey] = true;

	for (const [key, value] of Object.entries(messages)) {
		if (value !== true) {
			// oxlint-disable-next-line typescript/no-dynamic-delete
			delete messages[key as keyof typeof messages];
		}
	}

	return configuration.update('advanced.messages', messages, ConfigurationTarget.Global);
}
