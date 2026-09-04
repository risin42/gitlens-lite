import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { boxSizingBase } from '../styles/lit/base.css.js';
import { detailsHeaderStyles } from './gl-details-header.css.js';
import '../progress.js';

/** Header chrome shared by the standalone Inspect commit panel. */
@customElement('gl-details-header')
export class GlDetailsHeader extends LitElement {
	static override styles = [boxSizingBase, detailsHeaderStyles];

	@property({ type: Boolean }) loading = false;

	@state() private hasActions = false;

	override render() {
		return html`<div class="details-header">
			<div class="details-header__row">
				<div class="details-header__content">
					<slot></slot>
				</div>
				<div class="details-header__spacer"></div>
				<slot
					name="actions"
					class=${classMap({
						'details-header__actions-secondary': true,
						'has-actions': this.hasActions,
					})}
					@slotchange=${this.onActionsSlotChange}
				></slot>
			</div>
			<slot name="secondary"></slot>
			<progress-indicator position="bottom" ?active=${this.loading}></progress-indicator>
		</div>`;
	}

	private onActionsSlotChange(e: Event): void {
		this.hasActions = (e.target as HTMLSlotElement).assignedElements().length > 0;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'gl-details-header': GlDetailsHeader;
	}
}
