import { Notice } from 'obsidian';
import { TaskSearchError } from '../tasks';
/** Surface-owned request identity and a single failure episode; no service ownership. */
export class SearchStatus {
  #request = 0;
  #failed = false;
  readonly #text: HTMLElement;
  readonly #retry: HTMLButtonElement;
  constructor(
    private readonly root: HTMLElement,
    host: HTMLElement,
    retry: () => void,
  ) {
    this.#text = host.createDiv({
      cls: 'abyss-search-status',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.#retry = host.createEl('button', { cls: 'abyss-search-retry', text: 'Retry' });
    this.#retry.hidden = true;
    this.#retry.addEventListener('click', retry);
    root.dataset['searchPhase'] = 'idle';
    root.setAttribute('aria-busy', 'false');
  }
  pending(request: number, _query: string): void {
    this.#request = request;
    this.root.dataset['searchRequest'] = String(request);
    this.root.dataset['searchPhase'] = 'pending';
    this.root.setAttribute('aria-busy', 'true');
    this.#retry.hidden = true;
    this.#text.setText('Searching…');
  }
  complete(request: number, generation: number): void {
    if (request !== this.#request) return;
    this.root.dataset['searchGeneration'] = String(generation);
    this.root.dataset['searchPhase'] = 'complete';
    this.root.setAttribute('aria-busy', 'false');
    this.#text.setText('Search complete');
    this.#failed = false;
  }
  fail(request: number, error: unknown): void {
    if (request !== this.#request) return;
    if (error instanceof TaskSearchError && (error.code === 'aborted' || error.code === 'stale'))
      return;
    const invalid =
      error instanceof TaskSearchError &&
      (error.code === 'invalid-query' || error.code === 'invalid-request');
    const message = invalid
      ? 'Search supports up to 2,048 characters and 32 distinct terms. Shorten the query and try again.'
      : 'Could not load task results. Try again.';
    this.root.dataset['searchPhase'] = 'error';
    this.root.setAttribute('aria-busy', 'false');
    this.#text.setText(message);
    this.#retry.hidden = false;
    if (!invalid && !this.#failed) {
      this.#failed = true;
      new Notice(message);
    }
  }
  dispose(): void {
    this.#request++;
    this.root.dataset['searchPhase'] = 'idle';
    this.root.setAttribute('aria-busy', 'false');
    this.#text.remove();
    this.#retry.remove();
  }
}
