import { css } from 'lit';

export const detailsHeaderStyles = css`
	:host {
		display: contents;
		color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
	}

	.details-header {
		position: sticky;
		top: 0;
		z-index: var(--gl-z-sticky);
		display: flex;
		flex: none;
		flex-direction: column;
		background-color: var(--titlebar-bg, var(--vscode-sideBar-background, var(--color-background)));
	}

	.details-header__row {
		display: flex;
		align-items: center;
		padding: 0.7rem 1.2rem 0.5rem;
		container-name: gl-action-chip-host;
		container-type: inline-size;
	}

	.details-header__content {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
	}

	.details-header__spacer {
		flex: 1 1 0;
		min-width: var(--gl-space-4);
	}

	.details-header__actions {
		display: flex;
		flex-shrink: 0;
		gap: var(--gl-space-2);
		align-items: center;
	}

	.details-header__actions-secondary {
		display: none;
	}

	.details-header__actions-secondary.has-actions {
		display: flex;
		flex-shrink: 0;
		gap: var(--gl-space-2);
		align-items: center;
	}
`;
