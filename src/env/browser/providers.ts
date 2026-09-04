import type { Cache } from '@gitlens/git/cache.js';
import type { GitProvider } from '@gitlens/git/providers/provider.js';
import type { GitResult, GitRunOptions } from '@gitlens/git/run.types.js';
import type { UnifiedDisposable } from '@gitlens/utils/disposable.js';
import type { Container } from '../../container.js';
import type { GlGitProvider } from '../../git/gitProvider.js';

export function git(
	_container: Container,
	_options: GitRunOptions,
	..._args: any[]
): Promise<GitResult<string | Buffer>> {
	// No git CLI exists in this environment, so nothing ran. Reporting a clean empty exit would tell callers
	// the command succeeded and found nothing — say it never started instead.
	return Promise.resolve({
		stdout: '',
		completion: {
			status: 'failed',
			reason: 'unstarted',
			error: new Error('git is unavailable in this environment'),
		},
	});
}

export function getSupportedGitProviders(
	container: Container,
	cache: Cache,
	register: (provider: GitProvider, canHandle: (repoPath: string) => boolean) => UnifiedDisposable,
): Promise<GlGitProvider[]> {
	void container;
	void cache;
	void register;
	return Promise.resolve([]);
}
