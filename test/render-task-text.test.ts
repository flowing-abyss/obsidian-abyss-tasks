import { Component, MarkdownRenderer, Menu, type App, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTaskText } from '../src/ui/renderTaskText';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.empty();
});

describe('renderTaskText link occurrence pairing', () => {
  it.each([
    ['`[[Same]]` [[Same]]', 'Same', '[[Same]]'],
    ['`[Same](Same)` [Same](Same)', 'Same', '[Same](Same)'],
  ])('pairs the real link outside inline code as occurrence zero', async (source, href, raw) => {
    vi.useFakeTimers();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      holder.createEl('code', { text: raw });
      const anchor = holder.createEl('a', { text: 'Same' });
      anchor.setAttribute('href', href);
    });

    let click: ((event: MouseEvent) => unknown) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      build: (item: MenuItem) => unknown,
    ) {
      const item = {
        setTitle() {
          return this;
        },
        setIcon() {
          return this;
        },
        onClick(handler: (event: MouseEvent) => unknown) {
          click = handler;
          return this;
        },
      } as unknown as MenuItem;
      build(item);
      return this;
    });
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });

    const onEditLink = vi.fn();
    const host = document.body.createDiv();
    renderTaskText(host, source, {
      app: {} as App,
      sourcePath: 'tasks.md',
      component: new Component(),
      onEditLink,
    });
    await vi.runAllTimersAsync();

    host
      .querySelector('a')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    click?.(new MouseEvent('click'));

    expect(onEditLink).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ raw, index: source.lastIndexOf(raw) }),
      host.querySelector('a'),
    );
  });
});
