import { window } from 'vscode';
import { once } from '@gitlens/utils/function.js';
import { Logger } from '@gitlens/utils/logger.js';
import { executeCoreCommand } from './command.js';

/**
 * Wraps a webpack-split `import()` so a missing chunk file — typically the result of VS Code
 * background-upgrading the extension while the host keeps running the old build — surfaces an
 * actionable reload prompt instead of an opaque `MODULE_NOT_FOUND`. The original error is always
 * re-thrown so existing fallback paths still run.
 */
export async function loadChunk<T>(loader: () => Promise<T>): Promise<T> {
	try {
		return await loader();
	} catch (ex) {
		if (isChunkLoadError(ex)) {
			onChunkLoadError(ex);
		}
		throw ex;
	}
}

/** True when `ex` looks like a webpack chunk that couldn't be `require()`'d from disk. */
export function isChunkLoadError(ex: unknown): boolean {
	if (ex == null || typeof ex !== 'object') return false;

	const e = ex as { code?: unknown; name?: unknown; message?: unknown };
	if (e.code === 'MODULE_NOT_FOUND') return true;
	if (e.name === 'ChunkLoadError') return true;
	if (typeof e.message === 'string' && /Cannot find module ['"]\.\//.test(e.message)) return true;

	return false;
}

/** Asks the user to reload once per host session — repeated prompts after the first add no value. */
const promptExtensionUpgradedReload = once((): void => {
	const reload = { title: 'Reload Window' };
	const dismiss = { title: 'Not Now', isCloseAffordance: true };
	void window
		.showWarningMessage(
			'GitLens was updated in the background. Reload the window to continue using all features.',
			reload,
			dismiss,
		)
		.then(r => {
			if (r === reload) {
				void executeCoreCommand('workbench.action.reloadWindow');
			}
		});
});

function onChunkLoadError(ex: unknown): void {
	// Log every failure; the reload prompt below is one-shot, but the output remains useful when
	// diagnosing repeated failures after a background upgrade.
	Logger.warn(
		`Lazy chunk failed to load — extension was likely upgraded while the host kept running the old build. ${String(ex)}`,
	);

	promptExtensionUpgradedReload();
}
