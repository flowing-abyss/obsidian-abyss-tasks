import { setIcon } from 'obsidian';

interface ViewModeChoice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon: string;
}
/** Icon-only collection views share their visual and accessible selected state. */
export class ViewModeSwitcher<T extends string> {
  readonly element: HTMLElement;
  readonly #buttons = new Map<T, HTMLButtonElement>();
  constructor(
    host: HTMLElement,
    label: string,
    choices: ReadonlyArray<ViewModeChoice<T>>,
    options: { readonly onSelect: (value: T) => void; readonly family?: string },
  ) {
    const family = options.family ?? 'abyss-view';
    this.element = host.createDiv({
      cls: `abyss-view-switcher ${family}-switcher`,
      attr: { role: 'group', 'aria-label': label },
    });
    for (const choice of choices) {
      const button = this.element.createEl('button', {
        cls: `abyss-view-mode ${family}-mode ${family}-mode--${choice.value}`,
        attr: { type: 'button', 'aria-label': choice.label, 'aria-pressed': 'false' },
      });
      setIcon(button, choice.icon);
      button.addEventListener('click', () => {
        options.onSelect(choice.value);
      });
      this.#buttons.set(choice.value, button);
    }
  }
  update(value: T): void {
    for (const [mode, button] of this.#buttons) {
      button.toggleClass('is-active', mode === value);
      button.setAttribute('aria-pressed', String(mode === value));
    }
  }
}
