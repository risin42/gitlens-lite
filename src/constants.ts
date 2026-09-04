export const extensionPrefix = 'gitlens';
export const configurationPrefix = 'gitlens-lite';
export const quickPickTitleMaxChars = 80;

export const experimentalBadge = 'ᴇxᴘᴇʀɪᴍᴇɴᴛᴀʟ';

export const whitespaceRegex = /\s/;

export type AnnotationStatus = 'computing' | 'computed';

export type {
	DeprecatedGkConfigKeys,
	GitConfigKeys,
	GitCoreConfigKeys,
	GkConfigKeys,
} from '@gitlens/git/providers/config.js';

export const enum GlyphChars {
	AngleBracketLeftHeavy = '\u2770',
	AngleBracketRightHeavy = '\u2771',
	ArrowBack = '\u21a9',
	ArrowDown = '\u2193',
	ArrowDownUp = '\u21F5',
	ArrowDropRight = '\u2937',
	ArrowHeadRight = '\u27A4',
	ArrowLeft = '\u2190',
	ArrowLeftDouble = '\u21d0',
	ArrowLeftRight = '\u2194',
	ArrowLeftRightDouble = '\u21d4',
	ArrowLeftRightDoubleStrike = '\u21ce',
	ArrowLeftRightLong = '\u27f7',
	ArrowRight = '\u2192',
	ArrowRightDouble = '\u21d2',
	ArrowRightHollow = '\u21e8',
	ArrowUp = '\u2191',
	ArrowUpDown = '\u21C5',
	ArrowUpRight = '\u2197',
	ArrowsHalfLeftRight = '\u21cb',
	ArrowsHalfRightLeft = '\u21cc',
	ArrowsLeftRight = '\u21c6',
	ArrowsRightLeft = '\u21c4',
	Asterisk = '\u2217',
	Bullseye = '\u25CE',
	Check = '\u2714',
	Dash = '\u2014',
	Dot = '\u2022',
	Ellipsis = '\u2026',
	EnDash = '\u2013',
	Envelope = '\u2709',
	EqualsTriple = '\u2261',
	Flag = '\u2691',
	FlagHollow = '\u2690',
	MiddleEllipsis = '\u22EF',
	MuchLessThan = '\u226A',
	MuchGreaterThan = '\u226B',
	Pencil = '\u270E',
	Space = '\u00a0',
	SpaceThin = '\u2009',
	SpaceThinnest = '\u200A',
	SquareWithBottomShadow = '\u274F',
	SquareWithTopShadow = '\u2750',
	Warning = '\u26a0',
	ZeroWidthSpace = '\u200b',
}

export const imageMimetypes: Record<string, string> = Object.freeze({
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.jpe': 'image/jpeg',
	'.webp': 'image/webp',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.bmp': 'image/bmp',
});

export const keys = Object.freeze([
	'left',
	'alt+left',
	'ctrl+left',
	'right',
	'alt+right',
	'ctrl+right',
	'alt+,',
	'alt+.',
	'alt+enter',
	'ctrl+enter',
	'escape',
] as const);
export type Keys = (typeof keys)[number];

export const enum Schemes {
	File = 'file',
	Git = 'git',
	GitHub = 'github',
	GitLens = 'gitlens',
	GitLensVirtual = 'gitlens-virtual',
	PRs = 'pr',
	Remote = 'vscode-remote',
	Virtual = 'vscode-vfs',
}

export const trackableSchemes = Object.freeze(
	new Set<Schemes>([
		Schemes.File,
		Schemes.Git,
		Schemes.GitLens,
		Schemes.PRs,
		Schemes.Remote,
		Schemes.Virtual,
		Schemes.GitHub,
	]),
);

export const urls = Object.freeze({
	githubNewIssue: 'https://github.com/gitkraken/vscode-gitlens/issues/new/choose',
	githubDiscussions: 'https://github.com/gitkraken/vscode-gitlens/discussions/',
	helpCenter: 'https://help.gitkraken.com/gitlens/gitlens-start-here/',
	releaseNotes: 'https://help.gitkraken.com/gitlens/gitlens-release-notes-current/',
});
