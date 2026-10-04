import { Component, MarkdownRenderer, Menu, type App, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTaskText } from '../src/ui/renderTaskText';
import { deferred, expectDefined } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.empty();
});

describe('inline task title presentation', () => {
  it('routes formatted and escaped no-link titles through the host with the original owner', () => {
    vi.useFakeTimers();
    const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    const app = {} as App;
    const component = new Component();
    const formatted = '**bold** *italic* `code` \\*literal\\*';
    renderTaskText(document.body.createDiv(), formatted, {
      app,
      sourcePath: 'tasks.md',
      component,
      presentation: 'title',
    });
    expect(render).toHaveBeenCalledWith(
      app,
      formatted,
      expect.any(HTMLElement),
      'tasks.md',
      component,
    );
  });

  it('keeps genuine plain titles synchronous without a Markdown owner or timer', () => {
    vi.useFakeTimers();
    const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    const host = document.body.createDiv();
    renderTaskText(host, 'Ordinary task title', {
      app: {} as App,
      sourcePath: 'tasks.md',
      component: new Component(),
      presentation: 'title',
    });
    expect(render).not.toHaveBeenCalled();
    expect(host.textContent).toBe('Ordinary task title');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transforms only title embeds while preserving default non-title Markdown', () => {
    vi.useFakeTimers();
    const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    const source = '![[Folder/Preview.md]] [[Real]]';
    const options = { app: {} as App, sourcePath: 'tasks.md', component: new Component() };
    renderTaskText(document.body.createDiv(), source, { ...options, presentation: 'title' });
    expect(render).toHaveBeenLastCalledWith(
      options.app,
      '📎 Preview [[Real]]',
      expect.any(HTMLElement),
      'tasks.md',
      options.component,
    );
    renderTaskText(document.body.createDiv(), source, options);
    expect(render).toHaveBeenLastCalledWith(
      options.app,
      source,
      expect.any(HTMLElement),
      'tasks.md',
      options.component,
    );
  });
});

describe('renderTaskText link occurrence pairing', () => {
  it('renders an exact link label without installing interactive link behavior', async () => {
    vi.useFakeTimers();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      const anchor = holder.createEl('a', { text: 'Rendered label' });
      anchor.addClass('internal-link');
      anchor.setAttribute('data-href', 'Projects/Alpha');
    });
    const openLinkText = vi.fn().mockResolvedValue(undefined);
    const trigger = vi.fn();
    const onEditLink = vi.fn();
    const host = document.body.createDiv();

    renderTaskText(host, '[[Projects/Alpha|Raw label]]', {
      app: { workspace: { openLinkText, trigger } } as unknown as App,
      sourcePath: 'Projects/Current.md',
      component: new Component(),
      exactLinkLabel: 'Picker label',
      interactiveLinks: false,
      onEditLink,
    });
    await vi.runAllTimersAsync();
    const anchor = expectDefined(host.querySelector<HTMLAnchorElement>('a.internal-link'));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });

    anchor.dispatchEvent(click);
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(anchor.textContent).toBe('Picker label');
    expect(openLinkText).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
    expect(onEditLink).not.toHaveBeenCalled();
  });

  it('cancels pending link wiring when its row component is unloaded', async () => {
    vi.useFakeTimers();
    vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    const component = new Component();
    component.load();
    const receipt = renderTaskText(document.body.createDiv(), '[[Project]]', {
      app: {} as App,
      sourcePath: 'tasks.md',
      component,
    });
    component.unload();
    expect(await receipt.settled).toEqual({ type: 'cancelled' });
  });

  it('identifies hover-link events with the abyss-tasks plugin ID', async () => {
    vi.useFakeTimers();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      const anchor = holder.createEl('a', { text: 'Project' });
      anchor.addClass('internal-link');
      anchor.setAttribute('data-href', 'Project');
    });
    const trigger = vi.fn();
    const host = document.body.createDiv();

    renderTaskText(host, '[[Project]]', {
      app: { workspace: { trigger } } as unknown as App,
      sourcePath: 'tasks.md',
      component: new Component(),
    });
    await vi.runAllTimersAsync();
    expectDefined(host.querySelector('a')).dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );

    expect(trigger).toHaveBeenCalledWith(
      'hover-link',
      expect.objectContaining({ source: 'abyss-tasks' }),
    );
  });

  it('waits for the navigation guard and preserves modifier intent', async () => {
    vi.useFakeTimers();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
      const anchor = holder.createEl('a', { text: 'Project' });
      anchor.addClass('internal-link');
      anchor.setAttribute('data-href', 'Project');
    });
    let release: ((value: boolean) => void) | undefined;
    const beforeOpenLink = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const openLinkText = vi.fn().mockResolvedValue(undefined);
    const host = document.body.createDiv();
    renderTaskText(host, '[[Project]]', {
      app: { workspace: { openLinkText, trigger: vi.fn() } } as unknown as App,
      sourcePath: 'tasks.md',
      component: new Component(),
      beforeOpenLink,
    });
    await vi.runAllTimersAsync();
    expectDefined(host.querySelector('a')).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(openLinkText).not.toHaveBeenCalled();
    expectDefined(release)(true);
    await Promise.resolve();

    expect(beforeOpenLink).toHaveBeenCalledOnce();
    expect(openLinkText).toHaveBeenCalledWith('Project', 'tasks.md', 'tab');
  });

  it.each([
    ['`[[Same]]` [[Same]]', 'Same', '[[Same]]'],
    ['![[Very long preview name]] [[Same]]', 'Same', '[[Same]]'],
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
      presentation: 'title',
    });
    await vi.runAllTimersAsync();

    expectDefined(host.querySelector('a')).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    click?.(new MouseEvent('click'));

    expect(onEditLink).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ raw, index: source.lastIndexOf(raw) }),
    );
  });
});

describe('task text render receipts', () => {
  it('settles only after actual Markdown completion, unwrapping, link wiring and callback', async () => {
    let finish!: () => void;
    const openLinkText = vi.fn().mockResolvedValue(undefined);
    const app = {
      workspace: { openLinkText },
    } as unknown as App;
    const component = new Component();
    component.load();
    const el = document.body.createDiv();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _text, holder) => {
      await new Promise<void>((r) => {
        finish = r;
      });
      holder
        .createEl('p')
        .createEl('a', { cls: 'internal-link', text: 'Alias', attr: { 'data-href': 'Note' } });
    });
    const callback = vi.fn();
    const receipt = renderTaskText(el, '[[Note|Alias]]', {
      app,
      sourcePath: 'a.md',
      component,
      onRendered: callback,
    });
    let settled = false;
    void receipt.settled.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await receipt.settled).toEqual({ type: 'ready' });
    expect(el.querySelector('p')).toBeNull();
    expect(callback).toHaveBeenCalledWith(el.querySelector('.abyss-md'));
    expectDefined(el.querySelector('a')).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    expect(openLinkText).toHaveBeenCalledWith('Note', 'a.md', false);
    component.unload();
    el.remove();
  });
  it('cancels promptly on replacement and suppresses late callbacks', async () => {
    let finish!: () => void;
    const component = new Component();
    component.load();
    const el = document.body.createDiv();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
    });
    const callback = vi.fn();
    const receipt = renderTaskText(el, '[[Note]]', {
      app: {} as App,
      sourcePath: 'a.md',
      component,
      onRendered: callback,
    });
    const next = renderTaskText(el, 'plain', {
      presentation: 'title',
      app: {} as App,
      sourcePath: 'a.md',
      component,
    });
    expect(el.textContent).toBe('plain');
    expect(await receipt.settled).toEqual({ type: 'cancelled' });
    expect(await next.settled).toEqual({ type: 'ready' });
    finish();
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    component.unload();
    el.remove();
  });
});

it.each(['signal', 'detach', 'unload'] as const)(
  'settles pending Markdown as cancelled on %s',
  async (kind) => {
    const component = new Component();
    component.load();
    const el = document.body.createDiv();
    const signal = new AbortController();
    const finish = deferred<void>();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async () => {
      await finish.promise;
    });
    const callback = vi.fn();
    const receipt = renderTaskText(el, '[[Note]]', {
      app: {} as App,
      component,
      sourcePath: 'a.md',
      signal: signal.signal,
      onRendered: callback,
    });
    if (kind === 'signal') signal.abort();
    else if (kind === 'detach') el.remove();
    else component.unload();
    expect(await receipt.settled).toEqual({ type: 'cancelled' });
    finish.resolve();
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    component.unload();
    el.remove();
  },
);
it('reports onRendered callback failure in the render receipt', async () => {
  const component = new Component();
  component.load();
  const el = document.body.createDiv();
  const error = new Error('callback failed');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
  const receipt = renderTaskText(el, '[[Note]]', {
    app: {} as App,
    component,
    sourcePath: 'a.md',
    onRendered: () => {
      throw error;
    },
  });
  expect(await receipt.settled).toEqual({ type: 'failed', error });
  component.unload();
  el.remove();
});
