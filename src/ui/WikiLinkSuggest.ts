import { Notice, prepareFuzzySearch, renderResults, type App } from 'obsidian';
import { openAnchoredPopover, type AnchoredPopover } from './anchoredPopover';
import { isImeOwnedEvent } from './ime';
import type { InteractionOwnershipPort } from './interactionOwnership';
import { VaultFileSuggestionSource, type VaultLinkSuggestion } from './NoteSuggest';
import { textFieldAnchor, textFieldViewport } from './textFieldAnchor';
import { wikiLinkInputRange, type WikiLinkInputRange } from './wikiLinkInput';

export interface WikiLinkSuggestOptions {
  readonly app: App;
  readonly input: HTMLInputElement | HTMLTextAreaElement;
  readonly sourcePath: () => string | undefined;
  readonly interactionOwnership?: InteractionOwnershipPort;
  readonly registerSurface?: (surface: HTMLElement) => () => void;
}

interface Draft {
  readonly value: string;
  readonly cursor: number;
  readonly sourcePath: string;
  readonly range: WikiLinkInputRange;
}
let nextListId = 0;

/** Owns suggestions only. The field's existing owner still owns saving its draft. */
export class WikiLinkSuggest {
  readonly #options: WikiLinkSuggestOptions;
  #source: VaultFileSuggestionSource | undefined;
  readonly #cleanup: Array<() => void> = [];
  readonly #aria = new Map<string, string | null>();
  #popover: AnchoredPopover | undefined;
  #releaseSurface: (() => void) | undefined;
  #request: AbortController | undefined;
  #draft: Draft | undefined;
  #items: VaultLinkSuggestion[] = [];
  #selected = 0;
  #composing = false;
  #inserting = false;
  #destroyed = false;

  constructor(options: WikiLinkSuggestOptions) {
    this.#options = options;
    const { input } = options;
    for (const name of [
      'role',
      'aria-autocomplete',
      'aria-expanded',
      'aria-controls',
      'aria-activedescendant',
    ])
      this.#aria.set(name, input.getAttribute(name));
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
      capture = false,
    ): void => {
      target.addEventListener(type, listener, capture);
      this.#cleanup.push(() => {
        target.removeEventListener(type, listener, capture);
      });
    };
    listen(input, 'input', () => {
      if (!this.#inserting) this.#update();
    });
    listen(input, 'click', () => {
      this.#update();
    });
    listen(input, 'compositionstart', () => {
      this.#composing = true;
      this.#dismiss();
    });
    listen(input, 'compositionend', () => {
      this.#composing = false;
      this.#update();
    });
    listen(input, 'blur', () => {
      this.#dismiss();
    });
    listen(
      input,
      'keydown',
      (event) => {
        this.#keydown(event as KeyboardEvent);
      },
      true,
    );
    listen(input.ownerDocument, 'selectionchange', () => {
      if (this.#draft !== undefined && !this.#matches(this.#draft)) this.#update();
    });
  }

  owns(target: EventTarget | null): boolean {
    const { input } = this.#options;
    const win = input.ownerDocument.defaultView;
    return (
      target === input ||
      (win !== null &&
        target instanceof win.Node &&
        this.#popover?.element.contains(target) === true)
    );
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#dismiss();
    this.#cleanup.splice(0).forEach((dispose) => {
      dispose();
    });
    for (const [name, value] of this.#aria) {
      if (value === null) this.#options.input.removeAttribute(name);
      else this.#options.input.setAttribute(name, value);
    }
  }

  #matches(draft: Draft): boolean {
    const { input, sourcePath } = this.#options;
    return (
      input.isConnected &&
      input.ownerDocument.activeElement === input &&
      !input.disabled &&
      !input.readOnly &&
      input.value === draft.value &&
      input.selectionStart === draft.cursor &&
      input.selectionEnd === draft.cursor &&
      sourcePath() === draft.sourcePath
    );
  }

  #dismiss(): void {
    this.#request?.abort();
    this.#request = undefined;
    this.#draft = undefined;
    this.#items = [];
    const popup = this.#popover;
    this.#popover = undefined;
    popup?.close(false);
    this.#releaseSurface?.();
    this.#releaseSurface = undefined;
    const { input } = this.#options;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
  }

  #update(): void {
    this.#dismiss();
    const { input, sourcePath } = this.#options;
    if (!this.#editable()) return;
    const path = sourcePath();
    const cursor = input.selectionStart;
    if (path === undefined || cursor === null) return;
    const range = wikiLinkInputRange(input.value, cursor, input.selectionEnd ?? cursor);
    if (range === undefined) return;
    const draft: Draft = { value: input.value, cursor, sourcePath: path, range };
    this.#draft = draft;
    const request = new AbortController();
    this.#request = request;
    void this.#suggestions(range.query, request.signal, input.win)
      .then((items) => {
        if (request.signal.aborted || this.#destroyed || !this.#matches(draft)) return;
        if (items.length === 0) {
          this.#dismiss();
          return;
        }
        this.#items = items;
        this.#selected = 0;
        this.#render(draft);
      })
      .catch(() => {
        if (!request.signal.aborted && !this.#destroyed) this.#failed();
      });
  }

  async #suggestions(
    query: string,
    signal: AbortSignal,
    win: Window,
  ): Promise<VaultLinkSuggestion[]> {
    this.#source ??= new VaultFileSuggestionSource(this.#options.app);
    return await this.#source.links(query, signal, win);
  }

  #failed(): void {
    this.#dismiss();
    console.error(
      '[abyss-tasks] Task link completion failed while reading vault suggestions or formatting a link',
    );
    new Notice(
      'Could not suggest a note link. Your task text is unchanged; try typing the link again.',
    );
  }

  #render(draft: Draft): void {
    const { input } = this.#options;
    const listId = `abyss-link-suggest-${++nextListId}`;
    const popup = openAnchoredPopover({
      owner: input.ownerDocument.body,
      anchor: input,
      boundary: input.ownerDocument.body,
      preferred: 'below-start',
      cls: 'abyss-link-suggest',
      attr: { id: listId, role: 'listbox', 'aria-label': 'Note links' },
      getAnchorRect: () => textFieldAnchor(input, draft.range.from),
      getBoundaryRect: () => textFieldViewport(input),
      viewportPositioned: true,
      retainAnchorFocus: true,
      handleEscape: false,
      ownership: this.#options.interactionOwnership,
      onClose: () => {
        this.#dismiss();
      },
    });
    this.#popover = popup;
    this.#releaseSurface = this.#options.registerSurface?.(popup.element);
    const keepFocus = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    popup.element.addEventListener('pointerdown', keepFocus);
    popup.element.addEventListener('mousedown', keepFocus);
    const search = prepareFuzzySearch(draft.range.query);
    this.#items.forEach((item, index) => {
      const row = popup.element.createDiv({
        cls: 'abyss-link-suggest-option',
        attr: { role: 'option', id: `${listId}-${index}` },
      });
      row.classList.toggle('is-excluded', item.ignored);
      const label = row.createDiv({ cls: 'abyss-suggest-title' });
      renderResults(label, item.label, search(item.label) ?? { score: 0, matches: [] });
      row.createDiv({
        cls: 'abyss-suggest-path',
        text: item.alias === undefined ? (item.file.parent?.path ?? '/') : item.path,
      });
      row.addEventListener('pointermove', () => {
        this.#selected = index;
        this.#highlight();
      });
      row.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#choose(index);
      });
    });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', listId);
    this.#highlight();
    popup.reposition();
  }

  #highlight(): void {
    const list = this.#popover?.element;
    if (list === undefined) return;
    list.querySelectorAll<HTMLElement>('[role="option"]').forEach((row, index) => {
      row.setAttribute('aria-selected', String(index === this.#selected));
      row.classList.toggle('is-selected', index === this.#selected);
      if (index === this.#selected) {
        this.#options.input.setAttribute('aria-activedescendant', row.id);
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
          list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
      }
    });
  }

  #keydown(event: KeyboardEvent): void {
    if (this.#draft === undefined || this.#composing || isImeOwnedEvent(event) || this.#inserting)
      return;
    if (!completionKey(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      this.#dismiss();
      return;
    }
    if (event.key === 'Enter') {
      this.#choose(this.#selected);
      return;
    }
    if (this.#items.length > 0) {
      this.#selected =
        (this.#selected + (event.key === 'ArrowDown' ? 1 : -1) + this.#items.length) %
        this.#items.length;
      this.#highlight();
    }
  }

  #editable(): boolean {
    const { input } = this.#options;
    return (
      !this.#destroyed &&
      !this.#composing &&
      !this.#inserting &&
      !input.disabled &&
      !input.readOnly &&
      input.isConnected &&
      input.ownerDocument.activeElement === input
    );
  }

  #choose(index: number): void {
    const draft = this.#draft;
    const item = this.#items[index];
    if (draft === undefined || item === undefined) return;
    if (!this.#matches(draft)) {
      this.#dismiss();
      return;
    }
    try {
      if (this.#source?.isCurrent(item, draft.range.query) !== true) {
        this.#update();
        return;
      }
      const text = this.#options.app.fileManager.generateMarkdownLink(
        item.file,
        draft.sourcePath,
        undefined,
        item.alias,
      );
      this.#dismiss();
      this.#inserting = true;
      insertLink(this.#options.input, draft.range, text);
    } catch {
      this.#failed();
    } finally {
      this.#inserting = false;
    }
  }
}

function insertLink(
  input: HTMLInputElement | HTMLTextAreaElement,
  range: WikiLinkInputRange,
  text: string,
): void {
  const doc = input.ownerDocument;
  const win = doc.defaultView;
  if (win === null) return;
  const previous = input.value;
  const state = { emitted: false };
  const observe = (): void => {
    state.emitted = true;
  };
  input.addEventListener('input', observe);
  try {
    input.setSelectionRange(range.from, range.to);
    // Chromium/WebKit preserve native Undo here; setRangeText alone does not.
    // https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
    const legacy = doc as unknown as LegacyTextEditing;
    legacy.execCommand?.('insertText', false, text);
    if (input.value === previous) input.setRangeText(text, range.from, range.to, 'end');
    const cursor = range.from + text.length;
    input.setSelectionRange(cursor, cursor);
    if (!state.emitted) input.dispatchEvent(new win.Event('input', { bubbles: true }));
  } finally {
    input.removeEventListener('input', observe);
  }
}

/** Narrow optional compatibility boundary for native undo; not a general editing API. */
interface LegacyTextEditing {
  execCommand?: (command: 'insertText', showUI: false, text: string) => boolean;
}

function completionKey(event: KeyboardEvent): boolean {
  if (event.key === 'Escape') return true;
  return (
    ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}
