import type { ListSelection } from '../../app/AppState';
import { isListViewCustomized, resolveListViewStateKey } from '../../app/listViewState';
import type { CalendarSettings } from '../../settings/types';

/** A label can outlive a collection view change or be replaced by a section refresh. */
export class ListNavigationLabels {
  readonly #selections = new WeakMap<HTMLElement, ListSelection>();

  constructor(private readonly settings: Pick<CalendarSettings, 'listViewStates' | 'tagGroups'>) {}

  append(parent: HTMLElement, text: string, selection: ListSelection): void {
    const label = parent.createSpan({ cls: 'abyss-left-label', text });
    this.#selections.set(label, selection);
    this.#update(label, selection, this.#configuredGroups());
  }

  refresh(host: HTMLElement): void {
    const groups = this.#configuredGroups();
    for (const label of host.querySelectorAll<HTMLElement>('.abyss-left-label')) {
      const selection = this.#selections.get(label);
      if (selection !== undefined) this.#update(label, selection, groups);
    }
  }

  #configuredGroups(): Set<string> {
    return new Set(this.settings.tagGroups.map((group) => group.id));
  }

  #update(label: HTMLElement, selection: ListSelection, groups: ReadonlySet<string>): void {
    const states = this.settings.listViewStates;
    const key = resolveListViewStateKey(selection, states, groups);
    const saved = states?.[key];
    const dot = label.nextElementSibling;
    const hasDot = dot?.hasClass('abyss-left-custom-dot') === true;
    if (saved == null || !isListViewCustomized(saved, key)) {
      if (hasDot) dot.remove();
    } else if (!hasDot) {
      const indicator = label.ownerDocument.createElement('span');
      indicator.className = 'abyss-left-custom-dot';
      indicator.setAttribute('role', 'img');
      indicator.setAttribute('aria-label', 'Custom view applied');
      label.after(indicator);
    }
  }
}
