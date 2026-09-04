import { css } from 'lit';

export const prIconStyles = css`
	.pr-icon--opened {
		color: var(--vscode-gitlens-lite-openPullRequestIconColor);
	}

	.pr-icon--closed {
		color: var(--vscode-gitlens-lite-closedPullRequestIconColor);
	}

	.pr-icon--merged {
		color: var(--vscode-gitlens-lite-mergedPullRequestIconColor);
	}

	.pr-icon--draft {
		color: var(--vscode-descriptionForeground);
	}
`;
