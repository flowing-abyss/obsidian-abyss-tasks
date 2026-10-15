import { Component, MarkdownRenderer, type App } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import * as projection from '../src/markdown/searchText';
import { fallbackSearchWords, prepareSearchQuery } from '../src/tasks/domain/searchMatchPolicy';
import * as marking from '../src/ui/markSearchText';
import { RetainedTaskText, type RetainedTaskTextInput } from '../src/ui/retainedTaskText';
import { deferred, expectDefined } from './helpers';
import { mockReadingView } from './support/linkEditHarness';
afterEach(() => {
  vi.restoreAllMocks();
  document.body.empty();
});
function harness() {
  mockReadingView();
  const owner = new Component();
  owner.load();
  const host = document.body.createDiv();
  const field = new RetainedTaskText(host, owner);
  const input = (
    text = '[needle](https://example.com)',
    query = 'need',
  ): RetainedTaskTextInput => ({
    source: {
      target: {
        type: 'title',
        target: { type: 'task', ref: { filePath: 'a.md', line: 0, revision: 'a' } },
      },
      markdown: text,
      path: 'a.md',
      presentation: 'title',
    },
    decoration: {
      kind: 'complete',
      query: prepareSearchQuery(query, fallbackSearchWords),
      segment: fallbackSearchWords,
    },
    callbacks: { app: {} as App, isCurrent: () => true },
  });
  return {
    host,
    field,
    input,
    close: () => {
      field.destroy();
      owner.unload();
    },
  };
}
it.each([true, false])(
  'renders a fresh plain field in its final host without connected staging (connected: %s)',
  async (connected) => {
    const h = harness();
    if (!connected) h.host.remove();
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true });
    const render = vi.spyOn(MarkdownRenderer, 'render');
    try {
      const input = h.input('plain needle');
      const first = h.field.prepare({ ...input, decoration: { kind: 'complete' } });
      expect(h.host.textContent).toBe('plain needle');
      const text = h.host.firstChild;
      expect(observer.takeRecords()).toHaveLength(0);
      expect(first.commit()).toBe(true);
      expect(h.host.firstChild).toBe(text);
      expect(await first.ready).toEqual({ type: 'ready' });
      expect(render).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
    } finally {
      observer.disconnect();
      h.close();
    }
  },
);
it('retires an uncommitted first render before preparing the same source again', async () => {
  const h = harness();
  const held = deferred<void>();
  let holder: HTMLElement | undefined;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce((_app, _source, element) => {
    holder = element;
    return held.promise;
  });
  try {
    const first = h.field.prepare(h.input());
    const second = h.field.prepare(h.input());
    expect(await first.ready).toEqual({ type: 'cancelled' });
    expect(holder?.isConnected).toBe(false);
    expect(await second.ready).toEqual({ type: 'ready' });
    expect(second.commit()).toBe(true);
    const anchor = expectDefined(h.host.querySelector('a'));
    holder?.createSpan({ text: 'obsolete output' });
    held.resolve();
    await Promise.resolve();
    first.cancel();
    expect(first.commit()).toBe(false);
    expect(h.host.querySelector('a')).toBe(anchor);
    expect(h.host.textContent).toBe('needle');
  } finally {
    held.resolve();
    h.close();
  }
});
it.each([true, false])(
  'stages first Markdown until its renderer finishes (connected: %s)',
  async (connected) => {
    const h = harness();
    if (!connected) h.host.remove();
    const held = deferred<void>();
    let holder: HTMLElement | undefined;
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation((_app, _source, element) => {
      holder = element;
      element.textContent = 'Needle';
      return held.promise;
    });
    try {
      const first = h.field.prepare(h.input());
      const rendered = expectDefined(holder);
      expect(rendered.isConnected).toBe(true);
      expect(rendered.parentElement).not.toBe(h.host);
      expect(rendered.closest('[hidden][aria-hidden="true"]')).not.toBeNull();
      expect(h.host.hasChildNodes()).toBe(false);
      expect(first.commit()).toBe(false);
      held.resolve();
      expect(await first.ready).toEqual({ type: 'ready' });
      expect(first.commit()).toBe(true);
      expect(h.host.querySelector('.abyss-md')).toBe(rendered);
      expect(document.querySelector('[inert]')).toBeNull();
    } finally {
      held.resolve();
      h.close();
    }
  },
);
it('does not cancel a newer field when a completed first render was never committed', async () => {
  const h = harness();
  try {
    const first = h.field.prepare(h.input('needle'));
    expect(await first.ready).toEqual({ type: 'ready' });
    const second = h.field.prepare(h.input('needle'));
    expect(first.commit()).toBe(false);
    expect(await second.ready).toEqual({ type: 'ready' });
    expect(second.commit()).toBe(true);
    const text = h.host.firstChild;
    first.cancel();
    expect(h.host.firstChild).toBe(text);
    expect(h.host.textContent).toBe('needle');
  } finally {
    h.close();
  }
});
it('does not write an already-stale first plain field', async () => {
  const h = harness();
  try {
    const input = h.input('needle');
    const first = h.field.prepare({
      ...input,
      callbacks: { ...input.callbacks, isCurrent: () => false },
    });
    expect(h.host.hasChildNodes()).toBe(false);
    expect(await first.ready).toEqual({ type: 'cancelled' });
    expect(first.commit()).toBe(false);
    expect(h.host.hasChildNodes()).toBe(false);
  } finally {
    h.close();
  }
});
it('retires only its own plain text when currentness is lost before first commit', async () => {
  const h = harness();
  let current = true;
  try {
    const input = h.input('needle');
    const first = h.field.prepare({
      ...input,
      callbacks: { ...input.callbacks, isCurrent: () => current },
    });
    expect(await first.ready).toEqual({ type: 'ready' });
    current = false;
    expect(first.canCommit()).toBe(false);
    expect(first.commit()).toBe(false);
    first.cancel();
    expect(h.host.hasChildNodes()).toBe(false);
  } finally {
    h.close();
  }
});
it('cleans provisional plain text when the renderer loses currentness after writing', async () => {
  const h = harness();
  try {
    const input = h.input('needle');
    const first = h.field.prepare({
      ...input,
      callbacks: { ...input.callbacks, isCurrent: () => !h.host.hasChildNodes() },
    });
    expect(await first.ready).toEqual({ type: 'cancelled' });
    expect(h.host.hasChildNodes()).toBe(false);
    expect(first.commit()).toBe(false);
  } finally {
    h.close();
  }
});
it('preserves a successor installed by the renderer currentness callback', async () => {
  const h = harness();
  const successor = document.body.createEl('input');
  successor.remove();
  try {
    const input = h.input('needle');
    const first = h.field.prepare({
      ...input,
      callbacks: {
        ...input.callbacks,
        isCurrent: () => {
          if (h.host.hasChildNodes()) {
            h.host.replaceChildren(successor);
            successor.focus();
          }
          return true;
        },
      },
    });
    expect(await first.ready).toEqual({ type: 'cancelled' });
    expect(first.commit()).toBe(false);
    expect(h.host.firstChild).toBe(successor);
    expect(document.activeElement).toBe(successor);
  } finally {
    h.close();
  }
});
it.each(['replace', 'append'] as const)(
  'preserves a foreign focused successor on provisional cancellation (%s)',
  async (change) => {
    const h = harness();
    try {
      const first = h.field.prepare(h.input('needle'));
      expect(await first.ready).toEqual({ type: 'ready' });
      const successor = h.host.createEl('input');
      successor.value = 'Recoverable draft';
      if (change === 'replace') h.host.replaceChildren(successor);
      successor.focus();
      expect(first.canCommit()).toBe(false);
      expect(first.commit()).toBe(false);
      first.cancel();
      expect(h.host.childNodes).toHaveLength(1);
      expect(h.host.firstChild).toBe(successor);
      expect(successor.value).toBe('Recoverable draft');
      expect(document.activeElement).toBe(successor);
    } finally {
      h.close();
    }
  },
);
it('does not cancel provisional nodes after their host is adopted by another document', async () => {
  const h = harness();
  try {
    const first = h.field.prepare(h.input('needle'));
    expect(await first.ready).toEqual({ type: 'ready' });
    const nodes = [...h.host.childNodes];
    const frame = document.body.createEl('iframe');
    const destination = expectDefined(frame.contentDocument);
    destination.body.append(h.host);
    const successor = h.host.createEl('input');
    successor.focus();
    expect(first.canCommit()).toBe(false);
    expect(first.commit()).toBe(false);
    first.cancel();
    expect([...h.host.childNodes]).toEqual([...nodes, successor]);
    expect(destination.activeElement).toBe(successor);
  } finally {
    h.close();
  }
});
it('rechecks the document after a currentness callback before the first plain write', async () => {
  const h = harness();
  const frame = document.body.createEl('iframe');
  const destination = expectDefined(frame.contentDocument);
  try {
    const input = h.input('needle');
    const first = h.field.prepare({
      ...input,
      callbacks: {
        ...input.callbacks,
        isCurrent: () => {
          destination.body.append(h.host);
          return true;
        },
      },
    });
    expect(h.host.hasChildNodes()).toBe(false);
    expect(await first.ready).toEqual({ type: 'cancelled' });
    expect(first.commit()).toBe(false);
  } finally {
    h.close();
  }
});
it.each(['replace', 'adopt'] as const)(
  'rechecks direct node ownership after a currentness callback before commit (%s)',
  async (change) => {
    const h = harness();
    const frame = document.body.createEl('iframe');
    const destination = expectDefined(frame.contentDocument);
    const successor = document.body.createEl('input');
    successor.remove();
    let armed = false;
    try {
      const input = h.input('needle');
      const first = h.field.prepare({
        ...input,
        callbacks: {
          ...input.callbacks,
          isCurrent: () => {
            if (armed) {
              h.host.replaceChildren(successor);
              if (change === 'adopt') destination.body.append(h.host);
              successor.focus();
            }
            return true;
          },
        },
      });
      expect(await first.ready).toEqual({ type: 'ready' });
      armed = true;
      expect(first.commit()).toBe(false);
      first.cancel();
      expect(h.host.firstChild).toBe(successor);
      expect(successor.ownerDocument.activeElement).toBe(successor);
    } finally {
      h.close();
    }
  },
);
it('re-marks complete fields without reparsing source and skips equivalent token work', async () => {
  const h = harness();
  const render = vi.spyOn(MarkdownRenderer, 'render');
  const project = vi.spyOn(projection, 'projectSearchText');
  const mark = vi.spyOn(marking, 'markSearchText');
  try {
    const first = h.field.prepare(h.input());
    await first.ready;
    expect(first.commit()).toBe(true);
    const anchor = expectDefined(h.host.querySelector('a'));
    const calls = render.mock.calls.length;
    const projects = project.mock.calls.length;
    const second = h.field.prepare(h.input(undefined, 'needle'));
    await second.ready;
    second.commit();
    expect(h.host.querySelector('a')).toBe(anchor);
    expect(anchor.querySelector('mark')?.textContent).toBe('needle');
    expect(render.mock.calls).toHaveLength(calls);
    expect(project.mock.calls).toHaveLength(projects);
    const marks = mark.mock.calls.length;
    const third = h.field.prepare(h.input(undefined, 'needle '));
    await third.ready;
    third.commit();
    expect(mark.mock.calls).toHaveLength(marks);
    expect(project.mock.calls).toHaveLength(projects);
  } finally {
    h.close();
  }
});
it('keeps settled nodes during replacement and cancels late publication', async () => {
  const h = harness();
  try {
    const first = h.field.prepare(h.input());
    await first.ready;
    first.commit();
    const anchor = expectDefined(h.host.querySelector('a'));
    const held = deferred<void>();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(async (_app, _text, el) => {
      await held.promise;
      el.textContent = 'Late';
    });
    const pending = h.field.prepare(h.input('[other](https://example.com)'));
    expect(h.host.querySelector('a')).toBe(anchor);
    pending.cancel();
    expect(await pending.ready).toEqual({ type: 'cancelled' });
    held.resolve();
    await Promise.resolve();
    expect(pending.commit()).toBe(false);
    expect(h.host.querySelector('a')).toBe(anchor);
  } finally {
    h.close();
  }
});
it('defers destructive commits while the visible link is focused', async () => {
  const h = harness();
  try {
    const first = h.field.prepare(h.input());
    await first.ready;
    first.commit();
    const anchor = expectDefined(h.host.querySelector('a'));
    anchor.focus();
    const next = h.field.prepare(h.input('[other](https://example.com)'));
    await next.ready;
    expect(next.commit()).toBe(false);
    expect(h.host.querySelector('a')).toBe(anchor);
    anchor.blur();
    expect(next.commit()).toBe(true);
    expect(h.host.textContent).toBe('other');
  } finally {
    h.close();
  }
});

it('rejects a replacement prepared in a document that has since lost ownership', async () => {
  const h = harness();
  try {
    const first = h.field.prepare(h.input());
    await first.ready;
    first.commit();
    const next = h.field.prepare(h.input('[other](https://example.com)'));
    await next.ready;
    const frame = document.body.createEl('iframe');
    expectDefined(frame.contentDocument).body.append(h.host);
    expect(next.commit()).toBe(false);
  } finally {
    h.close();
  }
});
it('replaces equal visible text when its exact source revision changes', async () => {
  const h = harness();
  try {
    const first = h.field.prepare(h.input());
    await first.ready;
    first.commit();
    const anchor = expectDefined(h.host.querySelector('a'));
    const input = h.input();
    const next = h.field.prepare({
      ...input,
      source: {
        ...input.source,
        target: {
          type: 'title',
          target: { type: 'task', ref: { filePath: 'a.md', line: 0, revision: 'b' } },
        },
      },
    });
    await next.ready;
    next.commit();
    expect(h.host.querySelector('a')).not.toBe(anchor);
    expect(h.host.textContent).toBe('needle');
  } finally {
    h.close();
  }
});
it.each([
  { term: 'nee', prefix: false, edits: 0 as const, swaps: [] },
  { term: 'needle', prefix: false, edits: 0 as const, swaps: [] },
  { term: 'needel', prefix: false, edits: 1 as const, swaps: ['needle'] },
])('applies changed matching semantics for $term', async (token) => {
  const h = harness();
  try {
    const input = h.input();
    const first = h.field.prepare({
      ...input,
      decoration: {
        ...input.decoration,
        query: {
          original: 'same',
          tokens: [{ term: token.term, prefix: true, edits: 0, swaps: [] }],
        },
      },
    });
    await first.ready;
    first.commit();
    const mark = vi.spyOn(marking, 'markSearchText');
    const next = h.field.prepare({
      ...input,
      decoration: { ...input.decoration, query: { original: 'same', tokens: [token] } },
    });
    await next.ready;
    next.commit();
    expect(mark).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
  }
});

it('reports a current failed replacement once while keeping settled text and releasing staging', async () => {
  const h = harness();
  const failure = vi.fn();
  try {
    const first = h.field.prepare(h.input());
    await first.ready;
    first.commit();
    const anchor = expectDefined(h.host.querySelector('a'));
    vi.spyOn(MarkdownRenderer, 'render').mockRejectedValueOnce(new Error('host failed'));
    const input = h.input('[other](https://example.com)');
    const pending = h.field.prepare({
      ...input,
      callbacks: { ...input.callbacks, onRenderFailure: failure },
    });
    expect((await pending.ready).type).toBe('failed');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(h.host.querySelector('a')).toBe(anchor);
    h.close();
    expect(document.querySelector('[inert]')).toBeNull();
  } finally {
    h.close();
  }
});

it('keeps an opened link edit callback bound to its original occurrence after query refresh', async () => {
  const h = harness();
  const original = vi.fn();
  const newer = vi.fn();
  try {
    const input = h.input('[needle](https://first.example) [needle](https://second.example)');
    const first = h.field.prepare({
      ...input,
      callbacks: { ...input.callbacks, onEditLink: original },
    });
    await first.ready;
    first.commit();
    const links = h.host.querySelectorAll('a');
    const anchor = expectDefined(links[1]);
    const { captureMenus } = await import('./support/linkEditHarness');
    const menus = captureMenus();
    anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const next = h.field.prepare({
      ...input,
      decoration: {
        ...input.decoration,
        query: prepareSearchQuery('needle ', fallbackSearchWords),
      },
      callbacks: { ...input.callbacks, onEditLink: newer },
    });
    await next.ready;
    next.commit();
    expectDefined(menus[0]).pick('Edit link…');
    expect(original).toHaveBeenCalledExactlyOnceWith(
      1,
      expect.objectContaining({ target: 'https://second.example' }),
    );
    expect(newer).not.toHaveBeenCalled();
    expect(h.host.querySelectorAll('a')[1]).toBe(anchor);
  } finally {
    h.close();
  }
});
