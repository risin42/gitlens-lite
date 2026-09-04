import type { Uri } from 'vscode';

export class ExtensionNotFoundError extends Error {
	constructor(
		public readonly extensionId: string,
		public readonly extensionName: string,
	) {
		super(
			`Unable to find the ${extensionName} extension (${extensionId}). Please ensure it is installed and enabled.`,
		);

		Error.captureStackTrace?.(this, new.target);
	}
}

export class ProviderNotFoundError extends Error {
	constructor(pathOrUri: string | Uri | undefined) {
		super(
			`No provider registered for '${
				pathOrUri == null
					? String(pathOrUri)
					: typeof pathOrUri === 'string'
						? pathOrUri
						: pathOrUri.toString(true)
			}'`,
		);

		Error.captureStackTrace?.(this, new.target);
	}
}

export class ProviderNotSupportedError extends Error {
	constructor(provider: string) {
		super(`Action is not supported on the ${provider} provider.`);

		Error.captureStackTrace?.(this, new.target);
	}
}
