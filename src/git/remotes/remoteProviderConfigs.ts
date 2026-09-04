import type { RemoteProviderId } from '@gitlens/git/models/remoteProvider.js';
import type { RemoteProviderConfig } from '@gitlens/git/remotes/matcher.js';

/**
 * Configuration shape for user-configured custom remotes (from VS Code settings).
 * Subset of the full RemotesConfig — only the fields needed for remote provider matching.
 */
export interface RemotesConfigLike {
	readonly type: string;
	readonly domain?: string | null;
	readonly regex?: string | null;
	readonly protocol?: string;
	readonly name?: string;
	readonly urls?: RemoteProviderConfig['urls'];
}

/**
 * Converts a PascalCase config type value (from `gitlens-lite.remotes[].type` in package.json)
 * to a kebab-case {@link RemoteProviderId}.
 */
const configTypeMap: Record<string, RemoteProviderId> = {
	AzureDevOps: 'azure-devops',
	Bitbucket: 'bitbucket',
	BitbucketServer: 'bitbucket-server',
	Custom: 'custom',
	Gerrit: 'gerrit',
	GoogleSource: 'google-source',
	Gitea: 'gitea',
	GitHub: 'github',
	GitLab: 'gitlab',
};

/**
 * Converts user-configured custom remotes
 * into library-compatible {@link RemoteProviderConfig} entries.
 *
 * Used by both the host context adapter (for git operations) and standalone callers
 *  that need to build a remote provider matcher.
 */
export function buildRemoteProviderConfigs(
	configuredRemotes: RemotesConfigLike[] | null | undefined,
): RemoteProviderConfig[] | undefined {
	const configs: RemoteProviderConfig[] = [];

	// User-configured custom remotes from settings
	if (configuredRemotes?.length) {
		for (const rc of configuredRemotes) {
			if (rc.domain == null && rc.regex == null) continue;

			const type = configTypeMap[rc.type];
			if (type == null) continue;

			configs.push({
				type: type,
				domain: rc.domain ?? undefined,
				regex: rc.regex ?? undefined,
				protocol: rc.protocol,
				name: rc.name,
				urls: rc.urls,
			});
		}
	}

	return configs.length ? configs : undefined;
}
