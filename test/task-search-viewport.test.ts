import { MarkdownRenderer } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, expectDefined, flushMicrotasks, task, useRealMoment } from './helpers';
import { taskCardMountBound } from './support/taskPanelViewport';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';

useRealMoment();
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
});
function frames() {
  const queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queued.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => queued.delete(id));
  return {
    queued,
    flush() {
      const current = [...queued.values()];
      queued.clear();
      for (const callback of current) callback(0);
      return current.length;
    },
  };
}
function source(count: number, markdown = false) {
  return Array.from(
    { length: count },
    (_, line) => `- [ ] ${markdown ? '**needle**' : 'needle'} ${line}`,
  ).join('\n');
}
async function harness(
  count = 1200,
  before?: (h: Awaited<ReturnType<typeof mountCanonicalSearchUi>>) => void,
  markdown = false,
) {
  const clock = frames();
  const h = await mountCanonicalSearchUi(
    { 'search.md': source(count, markdown) },
    structuredClone(DEFAULT_SETTINGS),
  );
  cleanup.push(() => {
    h.dispose();
  });
  const complete = vi.spyOn(h.panel, 'completeTaskCardRender_abyssPrivate');
  const mount = vi.spyOn(h.panel, 'mountSearchRows_abyssPrivate');
  const list = vi.spyOn(h.index, 'list');
  const openList = vi.spyOn(h.panel['navigation_abyssPrivate'], 'openList');
  before?.(h);
  h.query('needle');
  const results = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
  const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-search-global'));
  return {
    ...h,
    clock,
    complete,
    mount,
    list,
    openList,
    results,
    input,
    async replace(text: string) {
      h.index.installCommittedContent('search.md', text);
      await h.completed();
    },
  };
}

describe('Search supplied result viewport', () => {
  it('keeps compact complete order and bounds demanded mounts without querying or completing on scroll', async () => {
    const h = await harness();
    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe('1200');
    const organization = expectDefined(h.mount.mock.calls[0]?.[1]);
    expect(organization.occurrences).toHaveLength(1200);
    expect(h.results.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
      taskCardMountBound(h.root, 1),
    );
    const reads = h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0);
    const completions = h.complete.mock.calls.length;
    h.input.focus();
    h.input.setSelectionRange(1, 4);
    h.results.scrollTop = 2000;
    h.results.dispatchEvent(new Event('scroll'));
    expect(h.clock.flush()).toBeGreaterThan(0);
    expect(h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0)).toBe(reads);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(completions);
    expect(h.input.isConnected).toBe(true);
    expect([h.input.value, h.input.selectionStart, h.input.selectionEnd]).toEqual(['needle', 1, 4]);
    expect(document.activeElement).toBe(h.input);
    await vi.waitFor(() => {
      expect(h.results.querySelector('.abyss-task-card[data-line]')).not.toBeNull();
    });
    const card = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card[data-line]'));
    const line = Number(card.dataset['line']);
    card.click();
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    await vi.waitFor(() => {
      h.clock.flush();
      expect(h.root.dataset['searchPhase']).toBe('complete');
    });
    await h.completed();
    expect(h.openList).toHaveBeenCalledTimes(1);
    expect(h.state.get('taskStack')[0]?.ref).toMatchObject({ line });
    expect(h.root.querySelector('.is-search-revealed')).not.toBeNull();
    expect(document.activeElement).not.toBe(card);
  });

  it.each([12345.625, -0.625])(
    'preserves native scroll %s on an executed viewport frame',
    async (top) => {
      const h = await harness();
      await h.completed();
      h.clock.flush();
      let nativeTop = top;
      const write = vi.fn((value: number) => {
        nativeTop = value;
      });
      Object.defineProperty(h.results, 'scrollTop', { get: () => nativeTop, set: write });
      h.results.dispatchEvent(new Event('scroll'));
      expect(h.clock.flush()).toBeGreaterThan(0);
      expect(write).not.toHaveBeenCalled();
      expect(h.results.scrollTop).toBe(top);
    },
  );

  it('preserves same-query card identity and current navigation while invalidating a saved source handler', async () => {
    const h = await harness(1);
    await h.completed();
    const card = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card'));
    const stale = expectDefined(h.mount.mock.calls[0]?.[2].onActivate);
    const original = expectDefined(h.mount.mock.calls[0]?.[1].occurrences[0]?.address);
    const add = vi.spyOn(card, 'addEventListener');
    for (let revision = 1; revision <= 4; revision++) {
      await h.replace(`- [ ] needle revision ${revision} 📅 2099-07-01`);
      expect(h.results.querySelector('.abyss-task-card')).toBe(card);
      stale(original);
      await flushMicrotasks();
      expect(h.openList).not.toHaveBeenCalled();
    }
    expect(
      add.mock.calls.filter(([event, , options]) => event === 'click' && options === true),
    ).toHaveLength(0);
    card.click();
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    expect(h.state.get('selectedList')).toBe('upcoming');
    expect(h.state.get('taskStack')[0]?.title).toBe('needle revision 4');
    expect(h.openList).toHaveBeenCalledTimes(1);
  });

  it('releases removed navigation and rebinds a newly mounted occurrence', async () => {
    const h = await harness(1);
    await h.completed();
    const card = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card'));
    await h.replace('');
    card.click();
    await flushMicrotasks();
    expect(h.openList).not.toHaveBeenCalled();
    expect(card.isConnected).toBe(false);
    await h.replace('- [ ] needle returned');
    expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card')).click();
    await vi.waitFor(() => {
      expect(h.state.get('taskStack')[0]?.title).toBe('needle returned');
    });
    expect(h.openList).toHaveBeenCalledTimes(1);
  });

  it('consumes a renderer-only ordered subset without expanding it', async () => {
    const h = await harness(0);
    await h.completed();
    const supplied = Array.from({ length: 50 }, (_, i) =>
      task({ title: `row ${249 - i}`, source: { filePath: 'subset.md', line: 249 - i } }),
    );
    const calls = h.list.mock.calls.length;
    h.panel['renderFlat_abyssPrivate'](h.results, supplied, [], { onCard: () => undefined });
    const logical = h.panel['mountedRows_abyssPrivate'].rows;
    expect(logical.taskKeys).toHaveLength(50);
    expect(
      logical.taskKeys.map((key) =>
        'source' in (logical.task(key) ?? {})
          ? (logical.task(key) as ReturnType<typeof task>).source.line
          : undefined,
      ),
    ).toEqual(Array.from({ length: 50 }, (_, i) => 249 - i));
    expect(h.list).toHaveBeenCalledTimes(calls);
  });

  it('ignores obsolete queued query work after replacement and host teardown', async () => {
    const h = await harness(1);
    await h.completed();
    h.query('obsolete');
    h.query('needle 0');
    await h.completed();
    expect(h.results.textContent).toContain('needle 0');
    const completions = h.complete.mock.calls.length;
    h.query('obsolete');
    h.panel.destroy();
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    h.clock.flush();
    expect(h.complete).toHaveBeenCalledTimes(completions);
  });

  it('contains an initial direct Search host failure without completing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness(1, (ui) => {
      vi.spyOn(ui.panel, 'mountSearchRows_abyssPrivate').mockImplementation(() => {
        throw new Error('initial host');
      });
    });
    await expect(h.completed()).rejects.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.root.dataset['searchPhase']).toBe('error');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not activate an obsolete supplied callback onto a replaced result host', async () => {
    const h = await harness(1);
    await h.completed();
    const old = expectDefined(h.mount.mock.calls[0]);
    const activate = expectDefined(old[2].onActivate);
    h.query('needle 0');
    await h.completed();
    activate(expectDefined(old[1].occurrences[0]?.address));
    await flushMicrotasks();
    expect(h.openList).not.toHaveBeenCalled();
  });

  it('does not complete a synchronous row mount failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness(1, (ui) => {
      vi.spyOn(ui.panel['taskCardRenderer_abyssPrivate'], 'mountInto').mockImplementation(() => {
        throw new Error('row mount');
      });
    });
    await expect(h.completed()).rejects.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.results.querySelector('.abyss-task-card')).toBeNull();
  });

  it('cleans partial initial rows before their pending text failure and permits retry', async () => {
    let reject!: (error: Error) => void;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness(
      2,
      () => {
        vi.spyOn(MarkdownRenderer, 'render')
          .mockImplementationOnce(
            () =>
              new Promise<void>((_resolve, fail) => {
                reject = fail;
              }),
          )
          .mockImplementationOnce(() => {
            throw new Error('second row');
          });
      },
      true,
    );
    await expect(h.completed()).rejects.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.results.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    reject(new Error('old text'));
    await flushMicrotasks();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(h.input.isConnected).toBe(true);
    vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    h.panel.refresh();
    await h.completed();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.results.querySelectorAll('.abyss-task-card')).toHaveLength(2);
  });

  it('destroys a failed retained update and then recovers', async () => {
    let fail = true;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness(1, (ui) => {
      const renderer = ui.panel['taskCardRenderer_abyssPrivate'];
      const mount = renderer.mountInto.bind(renderer);
      vi.spyOn(renderer, 'mountInto').mockImplementation((...args) => {
        const card = mount(...args);
        const update = card.update.bind(card);
        return {
          ...card,
          update: (...next) => {
            if (fail) {
              throw new Error('retained update');
            }
            update(...next);
          },
        };
      });
    });
    await h.completed();
    const card = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card'));
    h.complete.mockClear();
    h.panel.refresh();
    await expect(h.completed()).rejects.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(card.isConnected).toBe(false);
    card.click();
    await flushMicrotasks();
    expect(h.state.get('mode')).toBe('search');
    fail = false;
    h.panel.refresh();
    await h.completed();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('destroys a newly created card when external navigation binding throws', async () => {
    const h = await harness(0);
    await h.completed();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('binding failed');
    expect(() => {
      h.panel['renderFlat_abyssPrivate'](h.results, [task()], [], {
        onCard: () => {
          throw error;
        },
        failure: 'throw',
      });
    }).toThrow(error);
    expect(h.results.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('reports live viewport text failure once and ignores late failure after query replacement', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    const h = await harness(50, undefined, true);
    await h.completed();
    h.clock.flush();
    let rejectLive!: (error: Error) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLive = reject;
        }),
    );
    h.results.scrollTop = 1800;
    h.results.dispatchEvent(new Event('scroll'));
    h.clock.flush();
    await vi.waitFor(() => {
      expect(rejectLive).toBeDefined();
    });
    rejectLive(new Error('live text'));
    await flushMicrotasks();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.panel.refresh();
    await h.completed();
    let rejectOld!: (error: Error) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    h.results.scrollTop = 0;
    h.results.dispatchEvent(new Event('scroll'));
    h.clock.flush();
    await vi.waitFor(() => {
      expect(rejectOld).toBeDefined();
    });
    h.query('needle ');
    await h.completed();
    rejectOld(new Error('obsolete text'));
    await flushMicrotasks();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(3);
  });

  it('preserves the same-query anchor and replaces lifetimes on a changed query', async () => {
    const h = await harness(50);
    await h.completed();
    h.clock.flush();
    h.results.scrollTop = 1800.625;
    h.results.dispatchEvent(new Event('scroll'));
    h.clock.flush();
    const retained = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-card'));
    h.panel.refresh();
    await h.completed();
    expect(h.results.scrollTop).toBe(1800.625);
    expect(retained.isConnected).toBe(true);
    h.query('needle ');
    await h.completed();
    expect(retained.isConnected).toBe(false);
    expect(h.root.querySelector('.abyss-center-scroll')).toBe(h.results);
  });

  it('does not fail or complete a superseded reentrant result pass', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness(1);
    await h.completed();
    h.mount.mockRestore();
    const mount = h.panel['mountSearchRows_abyssPrivate'].bind(h.panel);
    vi.spyOn(h.panel, 'mountSearchRows_abyssPrivate')
      .mockImplementationOnce(() => {
        h.query('needle 0');
        throw new Error('obsolete pass');
      })
      .mockImplementation(mount);
    h.complete.mockClear();
    h.panel.refresh();
    await vi.waitFor(() => {
      expect(h.input.value).toBe('needle 0');
    });
    await h.completed();
    expect(diagnostic).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

it('scrolls active Search after transient popout adoption without requery or completion', async () => {
  const h = await harness(50);
  await h.completed();
  h.clock.flush();
  h.input.setSelectionRange(1, 4);
  h.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  const reads = h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0);
  const completions = h.complete.mock.calls.length;
  h.root.remove();
  h.results.dispatchEvent(new Event('scroll'));
  h.clock.flush();
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
  });
  owner.doc.body.append(h.root);
  h.panel.onWindowMigrated();
  h.results.scrollTop = 2800.5;
  h.results.dispatchEvent(new owner.win.Event('scroll'));
  owner.flush();
  await vi.waitFor(() => {
    owner.flush();
    expect(
      [...h.results.querySelectorAll<HTMLElement>('.abyss-task-card')].some(
        (card) => Number(card.dataset['line']) > 40,
      ),
    ).toBe(true);
  });
  const cards = [...h.results.querySelectorAll<HTMLElement>('.abyss-task-card')];
  expect(cards.length).toBeLessThanOrEqual(taskCardMountBound(h.root, 1));
  expect(h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0)).toBe(reads);
  expect(h.complete).toHaveBeenCalledTimes(completions);
  expect(h.input.value).toBe('needle');
  expect([h.input.selectionStart, h.input.selectionEnd]).toEqual([1, 4]);
  expect(h.results.scrollTop).toBe(2800.5);
  h.input.dispatchEvent(
    new owner.win.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
  );
  expect(h.input.isConnected).toBe(true);
});

it('preserves the full supplied native order and far-window adoption independently of compact Search allocation batches', async () => {
  const h = await harness();
  await h.completed();
  const supplied = h.index.list();
  h.panel['renderFlat_abyssPrivate'](h.results, [...supplied]);
  const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
  expect(surface.rows.taskKeys).toHaveLength(1200);
  expect(
    surface.rows.taskKeys.map((key) =>
      'source' in (surface.rows.task(key) ?? {})
        ? (surface.rows.task(key) as ReturnType<typeof task>).source.line
        : undefined,
    ),
  ).toEqual(Array.from({ length: 1200 }, (_, line) => line));
  const queries = h.list.mock.calls.length;
  const reads = h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0);
  const completions = h.complete.mock.calls.length;
  h.input.focus();
  h.input.setSelectionRange(1, 4);
  h.results.scrollTop = 20000;
  h.results.dispatchEvent(new Event('scroll'));
  h.clock.flush();
  expect(document.activeElement).toBe(h.input);
  expect(h.results.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(100);
  h.root.remove();
  h.results.dispatchEvent(new Event('scroll'));
  h.clock.flush();
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
  });
  owner.doc.body.append(h.root);
  h.results.scrollTop = 76000.5;
  h.results.dispatchEvent(new owner.win.Event('scroll'));
  owner.flush();
  const cards = [...h.results.querySelectorAll<HTMLElement>('.abyss-task-card')];
  expect(cards.some((card) => Number(card.dataset['line']) > 1100)).toBe(true);
  expect(cards.length).toBeLessThanOrEqual(taskCardMountBound(h.root, 1));
  expect(h.list).toHaveBeenCalledTimes(queries);
  expect(h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0)).toBe(reads);
  expect(h.complete).toHaveBeenCalledTimes(completions);
  expect(h.root.querySelector('.abyss-search-global')).toBe(h.input);
  expect([h.input.value, h.input.selectionStart, h.input.selectionEnd]).toEqual(['needle', 1, 4]);
  expect(h.results.scrollTop).toBe(76000.5);
});

it('retires a held context action with its native row generation', async () => {
  const clock = frames();
  const h = await mountCanonicalSearchUi(
    {
      'contexts.md': Array.from(
        { length: 50 },
        (_, line) => `- [ ] Task ${line}\n  - > needle context`,
      ).join('\n'),
    },
    DEFAULT_SETTINGS,
  );
  cleanup.push(() => {
    h.dispose();
  });
  h.query('needle');
  await h.completed();
  const held = expectDefined(
    h.root.querySelector<HTMLElement>('.abyss-search-context .abyss-task-desc'),
  );
  const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
  surface.reveal(expectDefined(surface.rows.taskKeys[surface.rows.taskKeys.length - 1]));
  clock.flush();
  expect(held.isConnected).toBe(false);
  const navigate = vi.spyOn(h.panel['navigation_abyssPrivate'], 'openList');
  held.click();
  await flushMicrotasks();
  expect(navigate).not.toHaveBeenCalled();
  expect(h.state.get('mode')).toBe('search');
});

it('finishes deferred focused text after publication without reopening a sealed render scope', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
    holder.createEl('a', {
      cls: 'internal-link',
      text,
      attr: { 'data-href': 'Target', tabindex: '0' },
    });
  });
  const h = await harness(1, undefined, true);
  await h.completed();
  await flushMicrotasks();
  const old = expectDefined(h.results.querySelector<HTMLElement>('.abyss-task-title a'));
  old.tabIndex = 0;
  old.focus();
  expect(document.activeElement).toBe(old);
  h.panel.refresh();
  await h.completed();
  expect(old.isConnected).toBe(true);
  h.input.focus();
  await flushMicrotasks();
  expect(diagnostic).not.toHaveBeenCalled();
  expect(h.root.dataset['searchPhase']).toBe('complete');
  expect(old.isConnected).toBe(false);
  expect(h.results.textContent).toContain('needle');
});

it('does not resurrect a completed compact order when blank Search migrates', async () => {
  const h = await harness(101);
  await h.completed();
  h.query('');
  await h.completed();
  const reads = h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0);
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
  });
  owner.doc.body.append(h.root);
  h.panel.onWindowMigrated();
  await vi.waitFor(() => {
    owner.flush();
    expect(h.root.dataset['searchLogicalResults']).toBe('0');
  });
  expect(h.root.querySelector('.abyss-task-card')).toBeNull();
  expect(h.root.textContent).toContain('Type to search');
  expect(h.backends.reduce((sum, backend) => sum + backend.searchCalls, 0)).toBe(reads);
});

it('retains the ordinary Tasks surface through the actual panel migration hook', async () => {
  const h = await mountCanonicalSearchUi(
    { 'ordinary.md': source(1200) },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  const owner = taskViewportOwner();
  try {
    const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
    const reads = vi.spyOn(h.index, 'list');
    const complete = vi.spyOn(h.panel, 'completeTaskCardRender_abyssPrivate');
    owner.doc.body.append(h.root);
    h.panel.onWindowMigrated();
    expect(h.panel['taskSurface_abyssPrivate']?.surface).toBe(surface);
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 1200 * 64;
    scroll.dispatchEvent(new owner.win.Event('scroll'));
    await vi.waitFor(() => {
      owner.flush();
      expect(h.root.textContent).toContain('needle 1199');
    });
    expect(reads).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  } finally {
    h.dispose();
    owner.destroy();
  }
});

it.each(['accepted', 'cancelled'] as const)(
  'waits for later destination neighbor hydration and Markdown after the exact target settles: %s',
  async (outcome) => {
    const h = await mountCanonicalSearchUi(
      {
        'search.md': Array.from({ length: 1200 }, (_, n) => {
          const title = n === 1199 ? 'needle target' : `neighbor ${n}`;
          return `- [ ] **${title}**`;
        }).join('\n'),
      },
      structuredClone(DEFAULT_SETTINGS),
    );
    const markdown = deferred<void>();
    const hydration = deferred<void>();
    let targetRendered = false;
    let neighborHydrating = false;
    let neighborRendering = false;
    let holdHydration = false;
    const originalRead = h.index.resolveSearchHits.bind(h.index);
    const reads = vi
      .spyOn(h.index, 'resolveSearchHits')
      .mockImplementation(async (hits, signal) => {
        if (holdHydration && h.state.get('mode') === 'tasks') {
          neighborHydrating = true;
          await hydration.promise;
        }
        return originalRead(hits, signal);
      });
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, host) => {
      host.createEl('strong', { text });
      if (h.state.get('mode') !== 'tasks') return;
      if (text.includes('needle target')) {
        targetRendered = true;
        holdHydration = true;
      } else if (targetRendered) {
        neighborRendering = true;
        await markdown.promise;
      }
    });
    const fullReads = vi.spyOn(h.index, 'list');
    const fullNodes = vi.spyOn(h.index, 'listNodes');
    try {
      h.query('needle');
      await h.completed();
      expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-title')).click();
      await vi.waitFor(() => {
        expect({
          targetRendered,
          mode: h.state.get('mode'),
          phase: h.root.dataset['searchPhase'],
        }).toMatchObject({ targetRendered: true });
      });
      const compact = expectDefined(h.panel['taskSurface_abyssPrivate']?.search);
      const key = expectDefined(compact.order.occurrencesOf('search.md:1199')[0]);
      expect(await compact.rows.settleRow(key, compact.identity.signal)).toEqual({ type: 'ready' });
      expect(h.root.querySelector('.is-search-revealed')).toBeNull();
      await vi.waitFor(() => {
        expect(neighborHydrating).toBe(true);
      });
      expect(h.root.querySelector('.abyss-task-card[aria-busy="true"]')).not.toBeNull();
      expect(h.root.querySelector('.is-search-revealed')).toBeNull();
      expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
        taskCardMountBound(h.root, 1),
      );
      hydration.resolve();
      await vi.waitFor(() => {
        expect(neighborRendering).toBe(true);
      });
      expect(h.root.querySelector('.is-search-revealed')).toBeNull();
      if (outcome === 'cancelled') h.state.set('taskStack', []);
      markdown.resolve();
      await h.completed();
      const target = h.root.querySelector<HTMLElement>('.is-search-revealed');
      if (outcome === 'cancelled') expect(target).toBeNull();
      else {
        const card = expectDefined(target);
        const viewport = expectDefined(
          card.closest<HTMLElement>('.abyss-center-scroll'),
        ).getBoundingClientRect();
        expect(card.textContent).toContain('needle target');
        expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top);
        expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom);
        expect(card.ownerDocument.activeElement).not.toBe(card);
      }
      expect(
        reads.mock.calls.every(
          ([hits]) =>
            hits.length <= 200 && new Set(hits.map((hit) => hit.address.rootId)).size <= 50,
        ),
      ).toBe(true);
      expect(
        new Set(reads.mock.calls.flatMap(([hits]) => hits.map((hit) => hit.address.rootId))).size,
      ).toBeLessThan(1200);
      expect(fullReads).not.toHaveBeenCalled();
      expect(fullNodes).not.toHaveBeenCalled();
      h.dispose();
      expect(await compact.rows.settleMounted(new AbortController().signal)).toEqual({
        type: 'cancelled',
      });
      expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    } finally {
      markdown.resolve();
      hydration.resolve();
      h.dispose();
    }
  },
);
