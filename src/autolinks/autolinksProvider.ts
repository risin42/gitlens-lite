import type { ConfigurationChangeEvent } from 'vscode';
import { Disposable } from 'vscode';
import type { DynamicAutolinkReference } from '@gitlens/git/models/autolink.js';
import type { GitRemote } from '@gitlens/git/models/remote.js';
import { fromNow } from '@gitlens/utils/date.js';
import { trace } from '@gitlens/utils/decorators/log.js';
import { encodeUrl } from '@gitlens/utils/encoding.js';
import { join, map } from '@gitlens/utils/iterable.js';
import { Logger } from '@gitlens/utils/logger.js';
import { escapeMarkdown, unescapeMarkdown } from '@gitlens/utils/markdown.js';
import { PromiseCache } from '@gitlens/utils/promiseCache.js';
import type { ResourceUsage } from '@gitlens/utils/resourceUsage.js';
import { capitalize, encodeHtmlWeak, getSuperscript } from '@gitlens/utils/string.js';
import type { OpenIssueActionContext } from '../api/gitlens.d.js';
import { OpenIssueOnRemoteCommand } from '../commands/openIssueOnRemote.js';
import type { Source } from '../constants.context.js';
import { GlyphChars } from '../constants.js';
import type { Container } from '../container.js';
import { getIssueOrPullRequestHtmlIcon, getIssueOrPullRequestMarkdownIcon } from '../git/utils/-webview/icons.js';
import { configuration } from '../system/-webview/configuration.js';
import type {
	Autolink,
	GlCacheableAutolinkReference,
	GlDynamicAutolinkReference,
	MaybeEnrichedAutolink,
	RefSet,
} from './models/autolinks.js';
import {
	ensureCachedRegex,
	getAutolinks,
	getBranchAutolinks,
	isDynamic,
	numRegex,
} from './utils/-webview/autolinks.utils.js';

const emptyAutolinkMap = Object.freeze(new Map<string, Autolink>());
const tokenRegex = /(\x00\d+\x00)/g; // oxlint-disable-line no-control-regex
const quoteRegex = /"/g;

export class AutolinksProvider implements Disposable {
	private _disposable: Disposable | undefined;
	private _references: GlCacheableAutolinkReference[] = [];
	private _refsetCache = new PromiseCache<string | undefined, RefSet[]>({ accessTTL: 1000 * 60 * 60 });
	constructor(_container: Container) {
		this._disposable = Disposable.from(configuration.onDidChange(this.onConfigurationChanged, this));

		this.setAutolinksFromConfig();
	}

	dispose(): void {
		this._disposable?.dispose();
	}

	private onConfigurationChanged(e?: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'autolinks')) {
			this.setAutolinksFromConfig();
			this._refsetCache.clear();
		}
	}

	/** Resource usage retained by autolink caches and configuration. */
	getResourceUsage(): ResourceUsage {
		return {
			'refsets.entries.count': this._refsetCache.size,
			'configured.references.count': this._references.length,
		};
	}

	private setAutolinksFromConfig() {
		const autolinks = configuration.get('autolinks');
		// Since VS Code's configuration objects are live we need to copy them to avoid writing back to the configuration
		this._references =
			autolinks
				?.filter(a => a.prefix && a.url)
				?.map(a => ({
					prefix: a.prefix,
					url: a.url,
					alphanumeric: a.alphanumeric ?? false,
					ignoreCase: a.ignoreCase ?? false,
					title: a.title ?? undefined,
				})) ?? [];
	}

	/** Collects remote provider autolink references into @param refsets */
	private collectRemoteAutolinks(remote: GitRemote | undefined, refsets: RefSet[], forBranch?: boolean): void {
		if (remote?.provider?.autolinks.length) {
			let autolinks = remote.provider.autolinks;
			if (forBranch) {
				autolinks = autolinks.filter(autolink => !isDynamic(autolink) && autolink.referenceType === 'branch');
			}
			refsets.push([remote.provider, autolinks]);
		}
	}

	/** Collects custom-configured autolink references into @param refsets */
	private collectCustomAutolinks(refsets: RefSet[]): void {
		if (this._references.length) {
			refsets.push([undefined, this._references]);
		}
	}

	private async getRefSets(remote?: GitRemote, forBranch?: boolean) {
		return this._refsetCache.getOrCreate(`${remote?.remoteKey}${forBranch ? ':branch' : ''}`, () => {
			const refsets: RefSet[] = [];

			this.collectRemoteAutolinks(remote, refsets, forBranch);
			this.collectCustomAutolinks(refsets);

			return Promise.resolve(refsets);
		});
	}

	/** @returns A sorted list of autolinks. the first match is the most relevant */
	async getBranchAutolinks(branchName: string, remote?: GitRemote): Promise<Map<string, Autolink>> {
		const refsets = await this.getRefSets(remote, true);
		if (!refsets.length) return emptyAutolinkMap;

		return getBranchAutolinks(branchName, refsets);
	}

	@trace({ args: () => ({ message: '<message>' }) })
	async getAutolinks(message: string, remote?: GitRemote): Promise<Map<string, Autolink>> {
		const refsets = await this.getRefSets(remote);
		if (!refsets.length) return emptyAutolinkMap;

		return getAutolinks(message, refsets);
	}

	linkify(
		text: string,
		outputFormat: 'html' | 'markdown' | 'plaintext',
		remotes?: GitRemote[],
		enrichedAutolinks?: Map<string, MaybeEnrichedAutolink>,
		prs?: Set<string>,
		footnotes?: Map<number, string>,
		source?: Source,
	): string {
		const includeFootnotesInText = outputFormat === 'plaintext' && footnotes == null;
		if (includeFootnotesInText) {
			footnotes = new Map<number, string>();
		}

		const tokenMapping = new Map<string, string>();

		if (enrichedAutolinks?.size) {
			for (const [, [, link]] of enrichedAutolinks) {
				if (this.ensureAutolinkRegexCached(link)) {
					text = renderCacheableAutolink(
						link,
						text,
						outputFormat,
						tokenMapping,
						enrichedAutolinks,
						prs,
						footnotes,
						source,
					);
				}
			}
		} else {
			for (const ref of this._references) {
				if (this.ensureAutolinkRegexCached(ref)) {
					text = renderCacheableAutolink(
						ref,
						text,
						outputFormat,
						tokenMapping,
						enrichedAutolinks,
						prs,
						footnotes,
						source,
					);
				}
			}

			if (remotes?.length) {
				for (const r of remotes) {
					if (r.provider == null) continue;

					for (const ref of r.provider.autolinks) {
						if (isDynamic(ref)) {
							text = renderDynamicAutolink(
								ref,
								text,
								outputFormat,
								tokenMapping,
								enrichedAutolinks,
								prs,
								footnotes,
							);
						} else if (this.ensureAutolinkRegexCached(ref)) {
							text = renderCacheableAutolink(
								ref,
								text,
								outputFormat,
								tokenMapping,
								enrichedAutolinks,
								prs,
								footnotes,
								source,
							);
						}
					}
				}
			}
		}

		if (tokenMapping.size) {
			text = text.replace(tokenRegex, (_, t: string) => tokenMapping.get(t) ?? t);
		}

		if (includeFootnotesInText && footnotes?.size) {
			text += `\n${GlyphChars.Dash.repeat(2)}\n${join(
				map(footnotes, ([i, footnote]) => `${getSuperscript(i)} ${footnote}`),
				'\n',
			)}`;
		}

		return text;
	}

	private ensureAutolinkRegexCached(
		ref: GlCacheableAutolinkReference | GlDynamicAutolinkReference | Autolink,
	): ref is GlCacheableAutolinkReference | Autolink {
		if (isDynamic(ref)) return false;
		if (!ref.prefix || !ref.url) return false;

		try {
			ensureCachedRegex(ref, 'markdown');
			ensureCachedRegex(ref, 'html');
			ensureCachedRegex(ref, 'plaintext');
		} catch (ex) {
			Logger.error(
				ex,
				`Failed to cache autolink regex: prefix=${ref.prefix}, url=${ref.url}, title=${ref.title}`,
			);
			return false;
		}

		return true;
	}
}

function renderCacheableAutolink(
	ref: GlCacheableAutolinkReference | Autolink,
	text: string,
	outputFormat: 'html' | 'markdown' | 'plaintext',
	tokenMapping: Map<string, string>,
	enrichedAutolinks?: Map<string, MaybeEnrichedAutolink>,
	prs?: Set<string>,
	footnotes?: Map<number, string>,
	source?: Source,
): string {
	let footnoteIndex: number;

	switch (outputFormat) {
		case 'markdown':
			ensureCachedRegex(ref, outputFormat);
			return text.replace(
				ref.messageMarkdownRegex,
				(_: string, prefix: string, linkText: string, num: string) => {
					const rawUrl = encodeUrl(ref.url.replace(numRegex, num));
					const footnoteSource = source && { ...source, detail: 'footnote' };
					const urlCommandContext: {
						provider: undefined | OpenIssueActionContext['provider'];
						issue: { url: string };
					} = {
						provider: undefined,
						issue: { url: rawUrl },
					};

					let title = '';
					if (ref.title) {
						title = ` "${ref.title.replace(numRegex, num)}`;

						const issueResult = enrichedAutolinks?.get(num)?.[0];
						if (issueResult?.value != null) {
							if (issueResult.paused) {
								if (footnotes != null && !prs?.has(num)) {
									const url = OpenIssueOnRemoteCommand.createMarkdownCommandLink({
										...urlCommandContext,
										source: footnoteSource,
									});
									const name =
										ref.description?.replace(numRegex, num) ??
										`Custom Autolink ${ref.prefix}${num}`;
									footnoteIndex = footnotes.size + 1;
									footnotes.set(
										footnoteIndex,
										`[${getIssueOrPullRequestMarkdownIcon()} ${name} $(loading~spin)](${url}${title}")`,
									);
								}

								title += `\n${GlyphChars.Dash.repeat(2)}\nLoading...`;
							} else {
								const issue = issueResult.value;
								const issueTitle = escapeMarkdown(issue.title.trim());
								const issueTitleQuoteEscaped = issueTitle.replace(quoteRegex, '\\"');

								urlCommandContext.provider = issue.provider && {
									id: issue.provider.id,
									name: issue.provider.name,
									domain: issue.provider.domain,
								};
								const url = OpenIssueOnRemoteCommand.createMarkdownCommandLink({
									...urlCommandContext,
									source: footnoteSource,
								});

								if (footnotes != null && !prs?.has(num)) {
									footnoteIndex = footnotes.size + 1;
									footnotes.set(
										footnoteIndex,
										`[${getIssueOrPullRequestMarkdownIcon(
											issue,
										)} **${issueTitle}**](${url}${title}")\\\n${GlyphChars.Space.repeat(
											5,
										)}${linkText} ${issue.state} ${fromNow(issue.closedDate ?? issue.createdDate)}`,
									);
								}

								title += `\n${GlyphChars.Dash.repeat(
									2,
								)}\n${issueTitleQuoteEscaped}\n${capitalize(issue.state)}, ${fromNow(
									issue.closedDate ?? issue.createdDate,
								)}`;
							}
						} else if (footnotes != null && !prs?.has(num)) {
							const url = OpenIssueOnRemoteCommand.createMarkdownCommandLink({
								...urlCommandContext,
								source: footnoteSource,
							});
							const name =
								ref.description?.replace(numRegex, num) ?? `Custom Autolink ${ref.prefix}${num}`;
							footnoteIndex = footnotes.size + 1;
							footnotes.set(
								footnoteIndex,
								`[${getIssueOrPullRequestMarkdownIcon()} ${name}](${url}${title}")`,
							);
						}
						title += '"';
					}

					const url = OpenIssueOnRemoteCommand.createMarkdownCommandLink({
						...urlCommandContext,
						source: source,
					});
					const token = `\x00${tokenMapping.size}\x00`;
					tokenMapping.set(token, `[${linkText}](${url}${title})`);
					return `${prefix}${token}`;
				},
			);

		case 'html':
			ensureCachedRegex(ref, outputFormat);
			return text.replace(ref.messageHtmlRegex, (_: string, prefix: string, linkText: string, num: string) => {
				const url = encodeUrl(ref.url.replace(numRegex, num));

				let title = '';
				if (ref.title) {
					title = `"${encodeHtmlWeak(ref.title.replace(numRegex, num))}`;

					const issueResult = enrichedAutolinks?.get(num)?.[0];
					if (issueResult?.value != null) {
						if (issueResult.paused) {
							if (footnotes != null && !prs?.has(num)) {
								const name =
									ref.description?.replace(numRegex, num) ?? `Custom Autolink ${ref.prefix}${num}`;
								footnoteIndex = footnotes.size + 1;
								footnotes.set(
									footnoteIndex,
									`<a href="${url}" title=${title}>${getIssueOrPullRequestHtmlIcon()} ${name}</a>`,
								);
							}

							title += `\n${GlyphChars.Dash.repeat(2)}\nLoading...`;
						} else {
							const issue = issueResult.value;
							const issueTitle = encodeHtmlWeak(issue.title.trim());
							const issueTitleQuoteEscaped = issueTitle.replace(quoteRegex, '&quot;');

							if (footnotes != null && !prs?.has(num)) {
								footnoteIndex = footnotes.size + 1;
								footnotes.set(
									footnoteIndex,
									`<a href="${url}" title=${title}>${getIssueOrPullRequestHtmlIcon(
										issue,
									)} <b>${issueTitle}</b></a><br /><span>${GlyphChars.Space.repeat(
										5,
									)}${linkText} ${issue.state} ${fromNow(
										issue.closedDate ?? issue.createdDate,
									)}</span>`,
								);
							}

							title += `\n${GlyphChars.Dash.repeat(
								2,
							)}\n${issueTitleQuoteEscaped}\n${capitalize(issue.state)}, ${fromNow(
								issue.closedDate ?? issue.createdDate,
							)}`;
						}
					} else if (footnotes != null && !prs?.has(num)) {
						const name = ref.description?.replace(numRegex, num) ?? `Custom Autolink ${ref.prefix}${num}`;
						footnoteIndex = footnotes.size + 1;
						footnotes.set(
							footnoteIndex,
							`<a href="${url}" title=${title}>${getIssueOrPullRequestHtmlIcon()} ${name}</a>`,
						);
					}
					title += '"';
				}

				const token = `\x00${tokenMapping.size}\x00`;
				tokenMapping.set(token, `<a href="${url}" title=${title}>${linkText}</a>`);
				return `${prefix}${token}`;
			});

		default:
			ensureCachedRegex(ref, outputFormat);
			return text.replace(ref.messageRegex, (_: string, prefix: string, linkText: string, num: string) => {
				const issueResult = enrichedAutolinks?.get(num)?.[0];
				if (issueResult?.value == null) return linkText;

				if (footnotes != null && !prs?.has(num)) {
					footnoteIndex = footnotes.size + 1;
					footnotes.set(
						footnoteIndex,
						`${linkText}: ${
							issueResult.paused
								? 'Loading...'
								: `${issueResult.value.title}  ${GlyphChars.Dot}  ${capitalize(
										issueResult.value.state,
									)}, ${fromNow(issueResult.value.closedDate ?? issueResult.value.createdDate)}`
						}`,
					);
				}

				const token = `\x00${tokenMapping.size}\x00`;
				tokenMapping.set(token, `${linkText}${getSuperscript(footnoteIndex)}`);
				return `${prefix}${token}`;
			});
	}
}

function renderDynamicAutolink(
	ref: DynamicAutolinkReference,
	text: string,
	outputFormat: 'html' | 'markdown' | 'plaintext',
	tokenMapping: Map<string, string>,
	enrichedAutolinks?: Map<string, MaybeEnrichedAutolink>,
	prs?: Set<string>,
	footnotes?: Map<number, string>,
): string {
	if (outputFormat === 'plaintext' || !ref.descriptors?.length) return text;

	for (const desc of ref.descriptors) {
		desc.regex.lastIndex = 0;
		text = text.replace(desc.regex, (linkText: string, repo: string, num: string) => {
			const url = encodeUrl(desc.url(unescapeMarkdown(repo), num));
			const title = ` "${desc.title(repo, num)}"`;

			const token = `\x00${tokenMapping.size}\x00`;
			if (outputFormat === 'markdown') {
				tokenMapping.set(token, `[${linkText}](${url}${title})`);
			} else {
				tokenMapping.set(token, `<a href="${url}" title=${title}>${linkText}</a>`);
			}

			appendFootnote(desc.label(repo, num), num, url, title, linkText, enrichedAutolinks, prs, footnotes);
			return token;
		});
	}

	return text;
}

function appendFootnote(
	label: string,
	num: string,
	url: string,
	title: string,
	linkText: string,
	enrichedAutolinks?: Map<string, MaybeEnrichedAutolink>,
	prs?: Set<string>,
	footnotes?: Map<number, string>,
): void {
	if (footnotes == null || prs?.has(num)) return;

	const issueResult = enrichedAutolinks?.get(num)?.[0];
	if (issueResult?.value != null) {
		if (issueResult.paused) {
			const footnoteIndex = footnotes.size + 1;
			footnotes.set(
				footnoteIndex,
				`[${getIssueOrPullRequestMarkdownIcon()} ${label} $(loading~spin)](${url}${title}")`,
			);
		} else {
			const issue = issueResult.value;
			const issueTitle = escapeMarkdown(issue.title.trim());
			const footnoteIndex = footnotes.size + 1;
			footnotes.set(
				footnoteIndex,
				`[${getIssueOrPullRequestMarkdownIcon(issue)} **${issueTitle}**](${url}${title})\\\n${GlyphChars.Space.repeat(5)}${linkText} ${issue.state} ${fromNow(issue.closedDate ?? issue.createdDate)}`,
			);
		}
	} else {
		const footnoteIndex = footnotes.size + 1;
		footnotes.set(footnoteIndex, `[${getIssueOrPullRequestMarkdownIcon()} ${label}](${url}${title})`);
	}
}
