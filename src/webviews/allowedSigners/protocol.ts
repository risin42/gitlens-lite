import type { WebviewState } from '../protocol.js';

export interface CandidateSigner {
	/** Stable id: `${email}\0${keyType}\0${keyData}`. */
	id: string;
	name?: string;
	email: string;
	avatarUrl?: string;
	keyType: string;
	/** The base64-encoded public-key blob (the part written after the key type in an allowed_signers line). */
	keyData: string;
	/** OpenSSH `SHA256:...` fingerprint, for display. */
	fingerprint: string;
	/** Number of commits in the repo signed by this key. */
	commitCount: number;
	/** Whether this entry is already present in the target allowed_signers file. */
	alreadyPresent: boolean;
}

/** Progress reported while discovering signers, so the loading page can show what's happening. */
export interface LoadingProgress {
	message: string;
	/** Items processed so far in the current phase (e.g. commits scanned), when known. */
	current?: number;
	/** Total items in the current phase, when known. */
	total?: number;
	/** Signers discovered so far. */
	found?: number;
}

export interface State extends WebviewState<'gitlens.allowedSigners'> {
	webroot?: string;
	repoPath?: string;
	repoName?: string;
	/** Whether the host is still discovering signers; the webview shows the loading page until this is `false`. */
	loading: boolean;
	/** A terminal error message if signer discovery failed; the webview shows this instead of an endless spinner. */
	error?: string;
	/** The current discovery step, shown on the loading page. */
	progress?: LoadingProgress;
	signers: CandidateSigner[];
	/** The path the file will be written to (default: existing config value, else `~/.ssh/allowed_signers`). */
	targetPath: string;
	/** The current value of `gpg.ssh.allowedSignersFile`, if set. */
	currentAllowedSignersFile?: string;
	/** Whether `gpg.ssh.allowedSignersFile` will be set globally or in the repo's local config. */
	setConfigScope: 'global' | 'local';
	/** Whether the webview is hosted in a Node.js (desktop) environment that can write files. */
	hasNodeHost: boolean;
	/**
	 * The `SHA256:…` fingerprint of a specific signer to pre-check, set when the editor is opened from a commit's
	 * "Add to allowed signers…" action so that commit's signer is pre-selected. Everything else starts unchecked.
	 */
	preselectFingerprint?: string;
}

/** A single allowed_signers entry the user has chosen to write. */
export interface SaveEntry {
	email: string;
	keyType: string;
	keyData: string;
}
