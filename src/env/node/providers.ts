import { workspace } from 'vscode';
import { Git } from '@gitlens/git-cli/exec/git.js';
import { findGitPath } from '@gitlens/git-cli/exec/locator.js';
import type { Cache } from '@gitlens/git/cache.js';
import type { GitProvider } from '@gitlens/git/providers/provider.js';
import type { GitResult, GitRunOptions } from '@gitlens/git/run.types.js';
import type { UnifiedDisposable } from '@gitlens/utils/disposable.js';
import type { Container } from '../../container.js';
import type { GlGitProvider } from '../../git/gitProvider.js';
import { configuration } from '../../system/-webview/configuration.js';
import { GlCliGitProvider } from './git/cliGitProvider.js';

let gitInstance: Git | undefined;

function ensureGit(): Git {
	gitInstance ??= new Git(() => findGitPath(configuration.getCore('git.path')), {
		isTrusted: () => workspace.isTrusted,
	});
	return gitInstance;
}

export function git(
	_container: Container,
	options: GitRunOptions,
	...args: any[]
): Promise<GitResult<string | Buffer>> {
	return ensureGit().run(options, ...args);
}

export function getSupportedGitProviders(
	container: Container,
	cache: Cache,
	register: (provider: GitProvider, canHandle: (repoPath: string) => boolean) => UnifiedDisposable,
): Promise<GlGitProvider[]> {
	return Promise.resolve([new GlCliGitProvider(container, cache, register)]);
}
