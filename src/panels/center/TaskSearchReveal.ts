import type { ListSelection } from '../../app/AppState';
import type { TaskSearchAddress } from '../../tasks';

export interface TaskRevealReceipt {
  readonly id: number;
  readonly address: TaskSearchAddress;
  readonly selection: ListSelection;
}
/** CenterPanel's transient inclusion and focus receipt; never saved with list preferences. */
export class TaskSearchReveal {
  #receipt: TaskRevealReceipt | undefined;
  #cancelPulse: (() => void) | undefined;
  #intent: number | undefined;
  #installing = false;
  #consumedScroll = false;
  #pulseUntil: number | undefined;
  constructor(
    private readonly owner: () => Window | null,
    private readonly intent: () => number,
    private readonly reveal: (card: HTMLElement) => void,
  ) {}
  install(receipt: TaskRevealReceipt): void {
    this.clear();
    this.#receipt = receipt;
    this.#installing = true;
  }
  current(): TaskRevealReceipt | undefined {
    return this.#receipt;
  }
  committed(changed: ReadonlySet<string>): void {
    if (this.#installing) {
      this.#installing = false;
      this.#intent = this.intent();
      return;
    }
    if (
      ['mode', 'selectedList', 'centerFilter', 'centerListViewState'].some((key) =>
        changed.has(key),
      )
    )
      this.clear();
    if (this.#intent !== this.intent()) this.cancelPulse();
  }
  get consumedScroll(): boolean {
    return this.#consumedScroll;
  }
  refresh(card: HTMLElement): void {
    if (this.#consumedScroll) this.show(card);
  }
  show(card: HTMLElement): void {
    const owner = this.owner();
    if (
      this.#receipt === undefined ||
      this.#intent !== this.intent() ||
      owner === null ||
      !card.isConnected
    )
      return;
    const now = (owner as Window & typeof window).Date.now();
    if (!this.#consumedScroll) {
      this.#consumedScroll = true;
      this.#pulseUntil = now + 2000;
      this.reveal(card);
    }
    this.cancelPulse();
    if (this.#pulseUntil === undefined || now >= this.#pulseUntil) return;
    card.classList.add('is-search-revealed');
    const timer = owner.setTimeout(() => {
      this.cancelPulse();
      this.#pulseUntil = undefined;
    }, this.#pulseUntil - now);
    this.#cancelPulse = () => {
      owner.clearTimeout(timer);
      card.classList.remove('is-search-revealed');
    };
  }
  cancelPulse(): void {
    this.#cancelPulse?.();
    this.#cancelPulse = undefined;
  }
  clear(): void {
    this.cancelPulse();
    this.#receipt = undefined;
    this.#consumedScroll = false;
    this.#pulseUntil = undefined;
    this.#intent = undefined;
    this.#installing = false;
  }
  dispose(): void {
    this.clear();
  }
}
