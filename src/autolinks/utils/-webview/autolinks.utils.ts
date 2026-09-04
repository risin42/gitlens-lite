import {
	ensureCachedBranchNameRegexes,
	ensureCachedRegex,
	getAutolinks,
	isCacheable,
	isDynamic,
	numRegex,
	serializeAutolink,
} from '@gitlens/git/utils/autolink.utils.js';
import type { Autolink, RefSet } from '../../models/autolinks.js';

// Re-export @gitlens/git functions that are identical
export {
	serializeAutolink,
	isDynamic,
	isCacheable,
	ensureCachedRegex,
	ensureCachedBranchNameRegexes,
	numRegex,
	getAutolinks,
};

export function getBranchAutolinks(branchName: string, refsets: Readonly<RefSet[]>): Map<string, Autolink> {
	const autolinks = new Map<string, Autolink>();

	let num;
	let match;
	for (const [provider, refs] of refsets) {
		for (const ref of refs) {
			if (
				!isCacheable(ref) ||
				ref.type === 'pullrequest' ||
				(ref.referenceType && ref.referenceType !== 'branch')
			) {
				continue;
			}

			ensureCachedBranchNameRegexes(ref);
			for (const regex of ref.branchNameRegexes) {
				match = branchName.match(regex);
				if (!match?.groups) continue;

				num = match.groups.issueKeyNumber;
				const linkUrl = ref.url?.replace(numRegex, num);
				autolinks.set(linkUrl, {
					...ref,
					provider: provider,
					id: num,
					url: linkUrl,
					title: ref.title?.replace(numRegex, num),
					description: ref.description?.replace(numRegex, num),
					descriptor: ref.descriptor,
				});

				// Stop at the first match
				return autolinks;
			}
		}
	}

	return autolinks;
}
