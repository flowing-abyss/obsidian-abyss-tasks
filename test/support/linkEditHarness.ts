// The link edit modal's harness: links drawn as Obsidian 1.13.7's reading view draws them, the
// menus and link edit modals a row opens, and the modal's fields and Save. No panel is imported.
import { MarkdownRenderer, Menu, Modal } from 'obsidian';
import { vi } from 'vitest';
import { parseLinks } from '../../src/markdown/links';
import { LinkEditModal } from '../../src/ui/LinkEditModal';
import { expectDefined, flushMicrotasks } from '../helpers';

/**
 * A wiki link's href and anchor text as the reading view reads its content (app.js `QE` and
 * `$E`): the alias when written, else the content with each `#` shown as " > ".
 */
function readingTitle(content: string): { href: string; title: string } {
  const pipe = content.indexOf('|');
  if (pipe > 0) {
    const written = content.slice(0, pipe).trim();
    const href = written.endsWith('\\') ? written.slice(0, -1) : written;
    return { href: href.trim(), title: content.slice(pipe + 1).trim() };
  }
  const href = content.trim();
  const title = href
    .split('#')
    .filter((part) => part.length > 0)
    .join(' > ')
    .trim();
  return { href, title };
}

function appendLines(el: HTMLElement, text: string): void {
  text.split('\n').forEach((part, index) => {
    if (index > 0) el.createEl('br');
    if (part.length > 0) el.appendText(part);
  });
}

/**
 * Renders links as the reading view does, for the inputs the rows use: the plugin's own reading
 * finds where each link is, and the anchor text follows Obsidian, with a line end as `<br>`.
 */
function renderLikeObsidian(markdown: string, holder: HTMLElement): void {
  const text = markdown.replace(/\r\n|\r/gu, '\n');
  const paragraph = holder.createEl('p');
  let last = 0;
  for (const token of parseLinks(text)) {
    appendLines(paragraph, text.slice(last, token.index));
    if (token.type === 'wiki') {
      const { href, title } = readingTitle(token.raw.slice(2, -2));
      const anchor = paragraph.createEl('a', { cls: 'internal-link', text: title });
      anchor.setAttribute('data-href', href);
      anchor.setAttribute('href', href);
    } else {
      const anchor = paragraph.createEl('a', { cls: 'external-link' });
      anchor.setAttribute('href', token.target);
      appendLines(anchor, token.display);
    }
    last = token.index + token.raw.length;
  }
  appendLines(paragraph, text.slice(last));
}

export function mockReadingView(): void {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
    renderLikeObsidian(markdown, holder);
    await Promise.resolve();
  });
}

export interface ShownMenu {
  readonly titles: readonly string[];
  readonly pick: (title: string) => void;
}

/** Records every menu shown, with its items' titles and a pick that clicks one and hides it. */
export function captureMenus(): ShownMenu[] {
  const shown: ShownMenu[] = [];
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    const items = (
      this as unknown as {
        menuItems__: Array<{ title__: string; onClick__: ((event: MouseEvent) => unknown) | null }>;
      }
    ).menuItems__;
    shown.push({
      titles: items.map((item) => item.title__),
      pick: (title) => {
        const item = expectDefined(items.find((candidate) => candidate.title__ === title));
        item.onClick__?.(new MouseEvent('click'));
        this.hide();
      },
    });
    return this;
  });
  return shown;
}

/**
 * Opens each link edit modal on the body and keeps it there until it closes. The host's `open`
 * and `close` are mocked, never the modal's own, since the mock's `open` would close it on the
 * next tick.
 */
export function captureLinkModals(): { readonly last: () => LinkEditModal } {
  const opened: LinkEditModal[] = [];
  vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
    if (!(this instanceof LinkEditModal)) throw new Error('Expected a link edit modal');
    opened.push(this);
    activeDocument.body.append(this.containerEl);
    this.onOpen();
  });
  vi.spyOn(Modal.prototype, 'close').mockImplementation(function (this: Modal) {
    this.onClose();
    this.containerEl.remove();
  });
  return { last: () => expectDefined(opened[opened.length - 1]) };
}

/** The modal's note or URL field and its alias or text field. */
export function modalInputs(modal: LinkEditModal): {
  target: HTMLInputElement;
  display: HTMLInputElement;
} {
  const inputs = modal.contentEl.querySelectorAll<HTMLInputElement>('input');
  return { target: expectDefined(inputs[0]), display: expectDefined(inputs[1]) };
}

export function clickSave(modal: LinkEditModal): void {
  expectDefined(
    [...modal.contentEl.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save',
    ),
  ).click();
}

export function rightClick(element: Element): void {
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

/** Waits for the render's promise and for `renderTaskText`'s link wiring timer. */
export async function settleRender(): Promise<void> {
  await flushMicrotasks();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await flushMicrotasks();
}
