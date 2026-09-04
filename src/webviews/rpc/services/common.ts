/**
 * Shared webview services — convenience type and factory.
 *
 * Webviews that use all shared services can extend `SharedWebviewServices` and
 * call `createSharedServices()`. Complex webviews that override most
 * sub-services should import individual classes directly instead.
 *
 */

import type { Container } from '../../../container.js';
import type { EventVisibilityBuffer, SubscriptionTracker } from '../eventVisibilityBuffer.js';
import type { WebviewViewServiceHost } from '../webviewViewService.js';
import { WebviewViewService } from '../webviewViewService.js';
import { AutolinksService } from './autolinks.js';
import { CommandsService } from './commands.js';
import { ConfigService } from './config.js';
import { FilesService } from './files.js';
import { RepositoriesService } from './repositories.js';
import { RepositoryService } from './repository.js';
import { StorageService } from './storage.js';
import type { RpcServiceHost } from './types.js';

// ============================================================
// Convenience Type
// ============================================================

/**
 * Shared webview services interface.
 *
 * This is a convenience type for webviews that use all shared services.
 * Complex webviews should define their own services type, importing only
 * the sub-service classes they need.
 */
export interface SharedWebviewServices {
	readonly repositories: RepositoriesService;
	readonly repository: RepositoryService;
	readonly config: ConfigService;
	readonly storage: StorageService;
	readonly autolinks: AutolinksService;
	readonly commands: CommandsService;
	readonly files: FilesService;
	readonly webview: WebviewViewService;
}

// ============================================================
// Convenience Factory
// ============================================================

/**
 * Create all shared webview services from Container.
 *
 * Use this for simple webviews that need all shared services without overrides.
 * Complex webviews should instantiate individual service classes directly.
 *
 * @param container - The GitLens Container
 * @param host - The webview host
 * @param buffer - Optional event visibility buffer
 * @returns SharedWebviewServices ready to be exposed via RPC
 */
export function createSharedServices(
	container: Container,
	host: RpcServiceHost & WebviewViewServiceHost,
	buffer?: EventVisibilityBuffer,
	tracker?: SubscriptionTracker,
): SharedWebviewServices {
	return {
		repositories: new RepositoriesService(container, buffer, tracker),
		repository: new RepositoryService(container, buffer, tracker),
		config: new ConfigService(buffer, tracker),
		storage: new StorageService(container),
		autolinks: new AutolinksService(container),
		commands: new CommandsService(container, host),
		files: new FilesService(container),
		webview: new WebviewViewService(host, buffer, tracker),
	};
}
