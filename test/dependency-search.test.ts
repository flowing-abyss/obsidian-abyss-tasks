import { Notice, Scope } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as browserScheduler from '../src/browserTaskScheduler';
import * as taskRows from '../src/panels/task-list/taskListRows';
import { TaskListSurface } from '../src/panels/task-list/TaskListSurface';
import { RowViewport } from '../src/panels/virtualization/rowViewport';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  TaskSearchError,
  type DependencyDirection,
  type TaskNodeRef,
  type TaskSearchApi,
} from '../src/tasks';
import {
  mountDependencySearch,
  rejectionLabel,
  type DependencyPickerCommitResult,
} from '../src/ui/dependencySearch';
import type { DependencyCandidate } from '../src/ui/TaskDependencySearchProvider';
import { createTaskDependencySearchProvider } from '../src/ui/TaskDependencySearchProvider';
import { deferred, dispatchImeKey, expectDefined, flushMicrotasks, methodOf } from './helpers';
import { scopeKeyboardEvent } from './support/scopeKeyboardEvent';
import * as harnessModule from './support/taskSearchHarness';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';
import { recordVirtualSurfaceResources } from './support/virtualSurfaceResources';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => {
      close();
    });
  activeDocument.body.empty();
  vi.restoreAllMocks();
});
async function fixture(
  count = 65,
  direction: DependencyDirection = 'blocks',
  files?: Record<string, string>,
  setupSignal?: AbortSignal,
) {
  const candidates = Array.from({ length: count }, (_, i) => `- [ ] Candidate ${i} 🆔 c${i}`).join(
    '\n',
  );
  const h = await createCanonicalSearchHarness(
    files ?? {
      'tasks.md': `- [ ] Current 🆔 current\n${candidates}`,
    },
    DEFAULT_SETTINGS,
    true,
    undefined,
    undefined,
    undefined,
    setupSignal,
  );
  if (setupSignal?.aborted === true) {
    h.close();
    setupSignal.throwIfAborted();
  }
  cleanup.push(() => {
    h.close();
  });
  let current: TaskNodeRef | undefined = expectDefined(h.index.listNodes()[0]).target;
  const writes: Array<{ title: string; direction: DependencyDirection; target: TaskNodeRef }> = [];
  const creates: Array<readonly [string, DependencyDirection]> = [];
  const provider = createTaskDependencySearchProvider(h.search, h.index, h.scheduler);
  const release = vi.fn();
  const callbacks = {
    direction,
    position: (element: HTMLElement) => {
      positionDemandSurface(element, { doc: element.ownerDocument }, 256);
    },
    canChangeDirection: true,
    provider,
    search: h.search,
    current: () => current,
    selectExisting: async (
      option: { task: { target: TaskNodeRef; node: { title: string } } },
      chosen: DependencyDirection,
    ): Promise<DependencyPickerCommitResult> => {
      writes.push({ title: option.task.node.title, target: option.task.target, direction: chosen });
      return { type: 'committed' as const };
    },
    createNew: async (
      text: string,
      chosen: DependencyDirection,
    ): Promise<DependencyPickerCommitResult> => {
      creates.push([text, chosen]);
      return { type: 'committed' as const };
    },
    onClose: vi.fn(),
    ownership: { acquire: () => ({ release }) },
  };
  const mount = (owner?: ReturnType<typeof taskViewportOwner>) => {
    const handle = mountDependencySearch(
      activeDocument.body,
      owner === undefined
        ? callbacks
        : {
            ...callbacks,
            position: (element: HTMLElement) => {
              positionDemandSurface(element, owner);
            },
          },
    );
    cleanup.push(() => {
      handle.destroy();
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    const key = (key: string) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const query = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const completed = () => searchUiCompleted(handle.element);
    const active = () => {
      const id = input.getAttribute('aria-activedescendant');
      return id === null ? null : handle.element.ownerDocument.getElementById(id);
    };
    return { handle, input, key, query, completed, active };
  };
  return {
    ...h,
    callbacks,
    mount,
    writes,
    creates,
    release,
    setCurrent: (ref: TaskNodeRef | undefined) => {
      current = ref;
    },
  };
}
it('paints and focuses the shell before a held real range and never creates while pending', async () => {
  const h = await fixture();
  const held = deferred<void>();
  const original = h.callbacks.provider.open.bind(h.callbacks.provider);
  h.callbacks.provider.open = async (...args) => {
    const session = await original(...args);
    const readRange = session.readRange.bind(session);
    session.readRange = async (...read) => {
      await held.promise;
      return readRange(...read);
    };
    return session;
  };
  const ui = h.mount();
  expect(activeDocument.activeElement).toBe(ui.input);
  expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(0);
  ui.query('Candidate');
  ui.key('Enter');
  await flushMicrotasks(30);
  expect(h.creates).toEqual([]);
  held.resolve();
  await ui.completed();
  expect(ui.handle.element.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  expect(ui.handle.element.querySelectorAll('[role="option"]').length).toBeLessThan(30);
});
it('bounds mounted options and reaches both logical edges and the former Arrow boundary on one cursor', async () => {
  const h = await fixture();
  const open = vi.spyOn(h.search, 'open');
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  expect(ui.handle.element.querySelectorAll('[role="option"]').length).toBeLessThan(30);
  ui.key('Home');
  expect(ui.active()?.textContent).toContain('Candidate 0');
  for (let offset = 1; offset <= 31; offset++) {
    ui.key('ArrowDown');
    if (ui.active() !== null)
      expect(ui.active()?.getAttribute('aria-posinset')).toBe(String(offset + 1));
    await vi.waitFor(() => {
      expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(
        `Candidate ${offset}`,
      );
    });
  }
  ui.key('ArrowUp');
  await vi.waitFor(() => {
    expect(ui.active()?.textContent).toContain('Candidate 30');
  });
  ui.key('End');
  await vi.waitFor(() => {
    expect(ui.active()?.textContent).toContain('Candidate 64');
  });
  expect(ui.active()?.getAttribute('aria-posinset')).toBe('65');
  expect(ui.active()?.getAttribute('aria-setsize')).toBe('65');
  ui.key('Home');
  await vi.waitFor(() => {
    expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe('Candidate 0');
  });
  expect(open).toHaveBeenCalledTimes(1);
});
it.each(['input', 'direction'] as const)(
  'preserves actual %s focus across a held native scroll demand',
  async (focus) => {
    const h = await fixture();
    const held = deferred<void>();
    let hold = false;
    const original = h.callbacks.provider.open.bind(h.callbacks.provider);
    h.callbacks.provider.open = async (...args) => {
      const session = await original(...args);
      const read = session.readRange.bind(session);
      session.readRange = async (...args) => {
        if (hold) await held.promise;
        return read(...args);
      };
      return session;
    };
    const ui = h.mount();
    ui.query('  Candidate  ');
    await ui.completed();
    ui.key('Home');
    const selected = ui.active()?.textContent;
    let focused: HTMLElement = ui.input;
    if (focus === 'direction')
      focused = expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
      );
    focused.focus();
    hold = true;
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    list.scrollTop = 2500;
    list.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(ui.active()).toBeNull();
    });
    expect(activeDocument.activeElement).toBe(focused);
    expect(ui.input.value).toBe('  Candidate  ');
    ui.key('Enter');
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    held.resolve();
    await vi.waitFor(() => {
      expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
    });
    expect(activeDocument.activeElement).toBe(focused);
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(ui.active()?.textContent).toBe(selected);
    });
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
  },
);
it.each(['input', 'direction', 'outside'] as const)(
  'preserves focus across source publication (focus=%s)',
  async (focus) => {
    const h = await fixture();
    const ui = h.mount();
    ui.query('  Candidate  ');
    await ui.completed();
    let focused: HTMLElement = ui.input;
    if (focus === 'direction')
      focused = expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
      );
    if (focus === 'outside') focused = activeDocument.body.createEl('input');
    focused.focus();
    h.index.installCommittedContent('other.md', '- [ ] Other');
    expect(activeDocument.activeElement).toBe(focused);
    if (focus === 'outside') {
      await flushMicrotasks(30);
      expect(ui.handle.element.isConnected).toBe(false);
    } else {
      await ui.completed();
      expect(ui.input.value).toBe('  Candidate  ');
      expect(ui.handle.element.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    }
    expect(activeDocument.activeElement).toBe(focused);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
  },
);

it.each(['blocks', 'blocked-by'] as const)(
  'freshly resolves the exact selected target in %s',
  async (direction) => {
    const h = await fixture(2, direction);
    const resolve = vi.spyOn(h.search, 'resolveHits');
    const ui = h.mount();
    ui.query('Candidate 1');
    await ui.completed();
    ui.key('ArrowDown');
    const mounted = expectDefined(
      h.index.listNodes().find(({ node }) => node.title === 'Candidate 1'),
    );
    resolve.mockClear();
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]).toEqual({ title: 'Candidate 1', direction, target: mounted.target });
    // The first hydration after Enter is the exact fresh selection; success also opens a new browse window.
    expect(resolve.mock.calls[0]?.[0]).toHaveLength(1);
    expect(resolve.mock.calls[0]?.[0]).toHaveLength(1);
    expect(h.creates).toEqual([]);
  },
);
it.each([
  { outcome: 'committed', returnToStart: false },
  { outcome: 'failed', returnToStart: false },
  { outcome: 'validation-error', returnToStart: false },
  { outcome: 'validation-error', returnToStart: true },
] as const)(
  'selection owner defers scrolled viewport reads until fresh resolve finishes ($outcome, return=$returnToStart)',
  async ({ outcome, returnToStart }) => {
    const h = await fixture(100);
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    const ui = h.mount(owner);
    ui.query('Candidate');
    owner.flush();
    await ui.completed();
    ui.key('Home');
    expect(ui.active()?.textContent).toContain('Candidate 0');
    await ui.completed();
    const target = expectDefined(
      h.index.listNodes().find(({ node }) => node.title === 'Candidate 0'),
    ).target;
    const held = deferred<void>();
    cleanup.push(() => {
      held.resolve();
    });
    const original = h.search.resolveHits.bind(h.search);
    let signal: AbortSignal | undefined;
    vi.spyOn(h.search, 'resolveHits').mockImplementationOnce(async (...args) => {
      signal = args[1];
      await held.promise;
      if (outcome !== 'committed')
        throw new TaskSearchError(
          outcome === 'failed' ? 'unavailable' : 'stale',
          'Held selection failed',
        );
      return original(...args);
    });
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    const selected = expectDefined(ui.active());
    list.scrollTop = 70 * 48;
    list.dispatchEvent(new owner.win.Event('scroll'));
    owner.flush();
    await flushMicrotasks(40);
    expect(selected.isConnected).toBe(false);
    expect(list.querySelector('[aria-hidden="true"]')).not.toBeNull();
    if (returnToStart) {
      list.scrollTop = 0;
      list.dispatchEvent(new owner.win.Event('scroll'));
      owner.flush();
      await flushMicrotasks(40);
    }
    // These keys cannot overwrite the accepted address or queue a later submit.
    for (const key of ['End', 'ArrowDown', 'Home', 'ArrowUp', 'Enter']) ui.key(key);
    expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
    ).click();
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    expect(signal?.aborted).toBe(false);
    held.resolve();
    if (outcome === 'committed') {
      await vi.waitFor(() => {
        expect(h.writes).toHaveLength(1);
      });
      expect(h.writes).toEqual([{ title: 'Candidate 0', direction: 'blocks', target }]);
      owner.flush();
      await ui.completed();
    } else {
      const position = returnToStart ? '1' : '71';
      const title = returnToStart ? 'Candidate 0' : 'Candidate 70';
      await vi.waitFor(() => {
        owner.flush();
        expect(list.querySelector(`[aria-posinset="${position}"]`)?.textContent).toContain(title);
        expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
        expect(ui.handle.element.getAttribute('aria-busy')).toBe('false');
      });
      expect(h.writes).toEqual([]);
      if (!returnToStart) {
        expect(ui.active()).toBeNull();
        ui.key('Enter');
        expect(h.writes).toEqual([]);
        expect(h.creates).toEqual([]);
      }
      // The current window is usable after the failed selection, with exact selection anew.
      expectDefined(list.querySelector<HTMLButtonElement>(`[aria-posinset="${position}"]`)).click();
      await vi.waitFor(() => {
        expect(h.writes).toHaveLength(1);
      });
      expect(h.writes[0]).toEqual({
        title,
        direction: 'blocks',
        target: expectDefined(h.index.listNodes().find(({ node }) => node.title === title)).target,
      });
    }
    await flushMicrotasks(40);
    expect(h.writes).toHaveLength(1);
    expect(h.creates).toEqual([]);
  },
);

it.each(['query', 'source', 'current', 'close', 'detach', 'adoption'] as const)(
  'selection owner retires deferred viewport work after %s cancellation',
  async (change) => {
    const h = await fixture(100);
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    const ui = h.mount(owner);
    ui.query('Candidate');
    owner.flush();
    await ui.completed();
    ui.key('Home');
    await ui.completed();
    const held = deferred<void>();
    cleanup.push(() => {
      held.resolve();
    });
    const original = h.search.resolveHits.bind(h.search);
    let signal: AbortSignal | undefined;
    vi.spyOn(h.search, 'resolveHits').mockImplementationOnce(async (...args) => {
      signal = args[1];
      await held.promise;
      return original(...args);
    });
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    list.scrollTop = 70 * 48;
    list.dispatchEvent(new owner.win.Event('scroll'));
    owner.flush();
    await flushMicrotasks(40);
    expect(signal?.aborted).toBe(false);
    const retire: Record<typeof change, () => void> = {
      query: () => {
        ui.query('Candidate 9');
      },
      source: () => {
        h.index.installCommittedContent('other.md', '- [ ] Other');
      },
      current: () => {
        h.setCurrent(undefined);
        ui.handle.refresh();
      },
      close: () => {
        ui.handle.close(false);
      },
      detach: () => {
        ui.handle.detach();
        ui.handle.element.remove();
      },
      adoption: () => {
        activeDocument.body.append(ui.handle.element);
        ui.handle.attach();
      },
    };
    retire[change]();
    const outside = activeDocument.body.createEl('input');
    outside.focus();
    held.resolve();
    owner.flush();
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });
    await flushMicrotasks(40);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    expect(activeDocument.activeElement).toBe(outside);
    if (change === 'query' || change === 'source') {
      owner.flush();
      await ui.completed();
      expect(ui.input.value).toBe(change === 'query' ? 'Candidate 9' : 'Candidate');
      expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
    }
  },
);

it('preserves original creation text only after a settled query and no implicit selection', async () => {
  const h = await fixture(1);
  const ui = h.mount();
  ui.query('  Candidate 0  ');
  await ui.completed();
  expect(ui.active()).toBeNull();
  ui.key('Enter');
  await vi.waitFor(() => {
    expect(h.creates).toHaveLength(1);
  });
  expect(h.creates).toEqual([['  Candidate 0  ', 'blocks']]);
  expect(ui.input.value).toBe('');
  expect(activeDocument.activeElement).toBe(ui.input);
});
it('discards held direction and current-task replies before mounting or committing', async () => {
  const h = await fixture(2);
  const held = deferred<void>();
  const original = h.callbacks.provider.open.bind(h.callbacks.provider);
  let first = true;
  h.callbacks.provider.open = async (...args) => {
    const session = await original(...args);
    if (first) {
      first = false;
      await held.promise;
    }
    return session;
  };
  const ui = h.mount();
  await vi.waitFor(() => {
    expect(first).toBe(false);
  });
  expectDefined(
    ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
  ).click();
  await ui.completed();
  held.resolve();
  await flushMicrotasks(30);
  ui.key('ArrowDown');
  ui.key('Enter');
  await vi.waitFor(() => {
    expect(h.writes).toHaveLength(1);
  });
  expect(h.writes[0]?.direction).toBe('blocked-by');
  await ui.completed();
  ui.query('Candidate');
  await ui.completed();
  ui.key('ArrowDown');
  const resolve = h.search.resolveHits.bind(h.search);
  const wait = deferred<void>();
  vi.spyOn(h.search, 'resolveHits').mockImplementation(async (...args) => {
    await wait.promise;
    return resolve(...args);
  });
  ui.key('Enter');
  h.setCurrent(expectDefined(h.index.listNodes()[1]).target);
  ui.handle.refresh();
  wait.resolve();
  await flushMicrotasks(100);
  expect(h.writes).toHaveLength(1);
});
it('keeps logical selection across refresh and never transfers a disappeared candidate to creation', async () => {
  const h = await fixture(2);
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key('ArrowDown');
  ui.handle.refresh();
  await ui.completed();
  expect(ui.active()?.textContent).toContain('Candidate 0');
  h.index.installCommittedContent('tasks.md', '- [ ] Current 🆔 current\n- [ ] Candidate 1 🆔 c1');
  await ui.completed();
  ui.key('Enter');
  await flushMicrotasks(40);
  expect(h.writes).toEqual([]);
  expect(h.creates).toEqual([]);
  expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toContain(
    'Task changed',
  );
});
it.each(['', 'Candidate'])(
  'uses one failure owner for %j and recovers through ordinary input',
  async (query) => {
    const h = await fixture(1);
    const messages: string[] = [];
    vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: string): void },
      'constructor__',
    ).mockImplementation((message) => {
      messages.push(message);
    });
    const original = h.callbacks.provider.open.bind(h.callbacks.provider);
    let fail = true;
    h.callbacks.provider.open = async (...args) => {
      if (fail) throw new TaskSearchError('unavailable', 'Unavailable');
      return original(...args);
    };
    const ui = h.mount();
    ui.query(query);
    await vi.waitFor(() => {
      expect(ui.handle.element.dataset['searchPhase']).toBe('error');
    });
    ui.key('Enter');
    expect(h.creates).toEqual([]);
    ui.query(`${query} `);
    await vi.waitFor(() => {
      expect(ui.handle.element.dataset['searchPhase']).toBe('error');
    });
    expect(messages).toHaveLength(1);
    expect(ui.handle.element.querySelector('[aria-label="Retry"]')).toBeNull();
    fail = false;
    ui.query('Candidate');
    await ui.completed();
    expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(1);
  },
);
it('releases session, listeners and lease once and cancels pending focus on close', async () => {
  const h = await fixture(1);
  const release = vi.spyOn(h.search, 'release');
  const remove = vi.spyOn(activeDocument, 'removeEventListener');
  const ui = h.mount();
  await ui.completed();
  ui.handle.destroy();
  ui.handle.destroy();
  ui.handle.close();
  expect(h.release).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(remove.mock.calls.filter(([type]) => type === 'focusin')).toHaveLength(1);
  expect(remove.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(1);
  const second = h.mount();
  second.handle.destroy();
  const outside = activeDocument.body.createEl('input');
  outside.focus();
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  expect(activeDocument.activeElement).toBe(outside);
  expect(second.handle.element.isConnected).toBe(false);
});
it.each(['composing', 'legacy'] as const)(
  'preserves IME-owned keyboard events (%s)',
  async (ime) => {
    const h = await fixture(1);
    const ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    expect(
      ['ArrowDown', 'Enter', 'Escape'].map(
        (key) => dispatchImeKey(ui.input, key, ime).defaultPrevented,
      ),
    ).toEqual([false, false, false]);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    expect(ui.handle.element.isConnected).toBe(true);
  },
);
it('detaches a held selection, releases owned reads and cannot revive focus after reattachment', async () => {
  const h = await fixture(2);
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key('ArrowDown');
  const original = h.search.resolveHits.bind(h.search),
    held = deferred<void>();
  vi.spyOn(h.search, 'resolveHits').mockImplementationOnce(async (...args) => {
    await held.promise;
    return original(...args);
  });
  ui.key('Enter');
  ui.handle.detach();
  ui.handle.element.remove();
  expect(h.release).toHaveBeenCalledOnce();
  activeDocument.body.append(ui.handle.element);
  ui.handle.attach();
  const direction = expectDefined(
    ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
  );
  direction.focus();
  held.resolve();
  await ui.completed();
  await flushMicrotasks(30);
  expect(h.writes).toEqual([]);
  expect(activeDocument.activeElement).toBe(direction);
  ui.handle.destroy();
  expect(h.release).toHaveBeenCalledTimes(2);
});
it('automatically restarts an expired owned cursor without turning selected intent into creation', async () => {
  const h = await fixture(65);
  const open = vi.spyOn(h.search, 'open');
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key('ArrowDown');
  vi.spyOn(h.search, 'read').mockRejectedValueOnce(
    new TaskSearchError('cursor-expired', 'Expired'),
  );
  ui.key('End');
  ui.key('ArrowDown');
  await ui.completed();
  expect(open).toHaveBeenCalledTimes(2);
  expect(ui.active()?.textContent).toContain('Candidate 0');
  expect(h.creates).toEqual([]);
});
it('browses compact source readiness without a backend and uses raw positions after omitted self', async () => {
  const h = await fixture(35);
  const ui = h.mount();
  await ui.completed();
  expect(h.backends).toHaveLength(0);
  expect(ui.handle.element.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  expect(ui.handle.element.querySelectorAll('[role="option"]').length).toBeLessThan(30);
  ui.key('Home');
  expect(ui.active()?.getAttribute('aria-posinset')).toBe('2');
  expect(ui.active()?.getAttribute('aria-setsize')).toBe('36');
});
it('joins real service recovery through ordinary nonempty input after backend failure', async () => {
  const h = await fixture(2);
  const messages: string[] = [];
  vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: string): void },
    'constructor__',
  ).mockImplementation((message) => {
    messages.push(message);
  });
  const options = (h.search as unknown as { options: { createBackend: () => Promise<unknown> } })
    .options;
  const backend = vi
    .spyOn(options, 'createBackend')
    .mockRejectedValue(new Error('Backend unavailable'));
  const time = vi.spyOn(h.scheduler, 'now').mockReturnValue(0);
  const ui = h.mount();
  ui.query('Candidate');
  await vi.waitFor(() => {
    expect(ui.handle.element.dataset['searchPhase']).toBe('error');
  });
  expect(messages).toHaveLength(1);
  ui.key('Enter');
  expect(h.creates).toEqual([]);
  backend.mockRestore();
  time.mockReturnValue(6000);
  ui.query('Candidate 1');
  await ui.completed();
  expect(ui.handle.element.querySelector('[role="option"]')?.textContent).toContain('Candidate 1');
  expect(messages).toHaveLength(1);
});
it('keeps an actual creation busy through refresh after an unsuccessful fresh selection', async () => {
  const h = await fixture(1);
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key('ArrowDown');
  vi.spyOn(h.search, 'resolveHits').mockRejectedValueOnce(
    new TaskSearchError('stale', 'Task changed'),
  );
  ui.key('Enter');
  await vi.waitFor(() => {
    expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toContain(
      'Task changed',
    );
  });
  const held = deferred<{ type: 'committed' }>();
  expect(ui.input.readOnly, ui.handle.element.outerHTML).toBe(false);
  expect(
    ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create')?.disabled,
    ui.handle.element.outerHTML,
  ).toBe(false);
  let calls = 0;
  h.callbacks.createNew = () => {
    calls++;
    return held.promise;
  };
  expectDefined(
    ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
  ).click();
  ui.handle.refresh();
  await ui.completed();
  expectDefined(
    ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
  ).click();
  expect(calls).toBe(1);
  expect(ui.input.readOnly).toBe(true);
  held.resolve({ type: 'committed' });
  await flushMicrotasks(40);
});
it('does not reset a failed Notice episode when a stale restart cannot settle', async () => {
  const h = await fixture(1);
  const messages: string[] = [];
  vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: string): void },
    'constructor__',
  ).mockImplementation((message) => {
    messages.push(message);
  });
  let code: 'unavailable' | 'stale' = 'unavailable';
  h.callbacks.provider.open = async () => {
    throw new TaskSearchError(code, 'Unavailable');
  };
  const ui = h.mount();
  ui.query('First');
  await vi.waitFor(() => {
    expect(ui.handle.element.dataset['searchPhase']).toBe('error');
  });
  code = 'stale';
  ui.query('Second');
  await vi.waitFor(() => {
    expect(ui.handle.element.getAttribute('aria-busy')).toBe('false');
  });
  ui.key('Enter');
  expect(h.creates).toEqual([]);
  code = 'unavailable';
  ui.query('Third');
  await vi.waitFor(() => {
    expect(ui.handle.element.dataset['searchPhase']).toBe('error');
  });
  expect(messages).toHaveLength(1);
});
it.each(['blocks', 'blocked-by'] as const)(
  'keeps a fixed %s section direction and submits a mouse choice through fresh resolve',
  async (direction) => {
    const h = await fixture(2, direction);
    h.callbacks.canChangeDirection = false;
    const ui = h.mount();
    ui.query('Candidate 1');
    await ui.completed();
    expect(ui.handle.element.querySelector('[data-direction]')).toBeNull();
    expectDefined(ui.handle.element.querySelector<HTMLButtonElement>('[role="option"]')).click();
    await vi.waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]?.direction).toBe(direction);
    expect(h.writes[0]?.title).toBe('Candidate 1');
    expect(h.creates).toEqual([]);
  },
);
it.each(['blocks', 'blocked-by'] as const)(
  'keeps successive %s creation open and focused',
  async (direction) => {
    const h = await fixture(1, direction),
      ui = h.mount();
    for (const text of ['First', 'Second']) {
      ui.query(text);
      await ui.completed();
      ui.key('Enter');
      await vi.waitFor(() => {
        expect(ui.input.value).toBe('');
      });
      expect(activeDocument.activeElement).toBe(ui.input);
      expect(ui.handle.element.isConnected).toBe(true);
    }
    expect(h.creates).toEqual([
      ['First', direction],
      ['Second', direction],
    ]);
    expect(h.callbacks.onClose).not.toHaveBeenCalled();
  },
);
it('clears explicit selection on ordinary input and ignores settled whitespace Enter', async () => {
  const h = await fixture(2),
    ui = h.mount();
  await ui.completed();
  ui.key('ArrowDown');
  expect(ui.active()).not.toBeNull();
  ui.query('Candidate');
  expect(ui.active()).toBeNull();
  await ui.completed();
  expect(ui.active()).toBeNull();
  ui.query('  ');
  await ui.completed();
  ui.key('Enter');
  expect(h.creates).toEqual([]);
  expect(h.writes).toEqual([]);
});
it.each([true, false])(
  'preserves create validation, original draft and duplicate busy protection (general=%s)',
  async (general) => {
    const h = await fixture(1);
    h.callbacks.canChangeDirection = general;
    const held = deferred<DependencyPickerCommitResult>();
    let calls = 0;
    h.callbacks.createNew = () => {
      calls++;
      return held.promise;
    };
    const ui = h.mount();
    ui.query('  New linked task  ');
    await ui.completed();
    const create = expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
    );
    expect(create.closest('[role="listbox"]')).toBeNull();
    expect(create.tabIndex).toBe(0);
    create.focus();
    create.click();
    create.click();
    ui.key('Enter');
    expect(calls).toBe(1);
    expect(create.disabled).toBe(true);
    expect(ui.input.readOnly).toBe(true);
    held.resolve({ type: 'validation-error', message: 'Choose another title' });
    await flushMicrotasks(40);
    expect(ui.input.value).toBe('  New linked task  ');
    expect(activeDocument.activeElement).toBe(ui.input);
    expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toBe(
      'Choose another title',
    );
    expect(create.disabled).toBe(false);
    h.callbacks.createNew = async () => {
      calls++;
      return { type: 'failed' };
    };
    create.click();
    expect(ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-error')?.hidden).toBe(
      true,
    );
    await flushMicrotasks(40);
    expect(calls).toBe(2);
  },
);
it.each(['Escape', 'success', 'validation', 'failed'] as const)(
  'restores opener focus and one lease after %s then Escape',
  async (outcome) => {
    const h = await fixture(1);
    const anchor = activeDocument.body.createEl('button');
    anchor.focus();
    h.callbacks.onClose.mockImplementation((restore: boolean) => {
      if (restore) anchor.focus();
    });
    h.callbacks.createNew = async () => {
      if (outcome === 'success') return { type: 'committed' };
      if (outcome === 'validation') return { type: 'validation-error', message: 'Invalid title' };
      return { type: 'failed' };
    };
    const ui = h.mount();
    ui.query('New');
    await ui.completed();
    if (outcome !== 'Escape') {
      ui.key('Enter');
      await flushMicrotasks(40);
    }
    ui.key('Escape');
    expect(activeDocument.activeElement).toBe(ui.handle.element);
    expect(h.callbacks.onClose).not.toHaveBeenCalled();
    ui.handle.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(activeDocument.activeElement).toBe(anchor);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.callbacks.onClose).toHaveBeenCalledWith(true);
  },
);
it.each(['unchanged', 'reordered', 'disabled', 'disappeared'] as const)(
  'preserves explicit selection identity after actual source publication (%s)',
  async (change) => {
    const h = await fixture(2, 'blocked-by'),
      ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    ui.key('ArrowDown');
    if (change === 'unchanged') h.index.installCommittedContent('unrelated.md', '- [ ] Unrelated');
    else if (change === 'reordered')
      h.index.installCommittedContent(
        'tasks.md',
        '- [ ] Current 🆔 current\n- [ ] Candidate 0 🆔 c0\n- [ ] Candidate 🆔 c1',
      );
    else if (change === 'disabled') {
      h.index.installCommittedContent('unrelated.md', '- [ ] Duplicate 🆔 c0');
    } else
      h.index.installCommittedContent(
        'tasks.md',
        '- [ ] Current 🆔 current\n- [ ] Candidate 1 🆔 c1',
      );
    await ui.completed();
    if (change === 'reordered')
      expect(ui.handle.element.querySelector('.abyss-dep-search-title')?.textContent).toBe(
        'Candidate',
      );
    const lost = ['reordered', 'disabled', 'disappeared'].includes(change);
    if (lost) expect(ui.active()).toBeNull();
    else expect(ui.active()?.textContent).toContain('Candidate 0');
    ui.key('Enter');
    await flushMicrotasks(40);
    expect(h.creates).toEqual([]);
    expect(h.writes.map(({ title }) => title)).toEqual(lost ? [] : ['Candidate 0']);
  },
);
it.each(['input', 'direction', 'arrow', 'create'] as const)(
  'replaces stale existing selection only on explicit %s intent',
  async (intent) => {
    const h = await fixture(2),
      ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    ui.key('ArrowDown');
    h.index.installCommittedContent(
      'tasks.md',
      '- [ ] Current 🆔 current\n- [ ] Candidate 1 🆔 c1',
    );
    await ui.completed();
    if (intent === 'input') {
      ui.query('Candidate');
      await ui.completed();
    }
    if (intent === 'direction') {
      expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
      ).click();
      await ui.completed();
    }
    if (intent === 'arrow') ui.key('ArrowDown');
    if (intent === 'create')
      expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
      ).click();
    else ui.key('Enter');
    await vi.waitFor(() => {
      expect(h.writes.length + h.creates.length).toBe(1);
    });
    if (intent === 'arrow') expect(h.writes[0]?.title).toBe('Candidate 1');
    else
      expect(h.creates).toEqual([['Candidate', intent === 'direction' ? 'blocked-by' : 'blocks']]);
  },
);
it('keeps canonical node matching to title, tags and source path while excluding descriptions', async () => {
  const h = await fixture(1);
  h.index.installCommittedContent(
    'tasks.md',
    '- [ ] Current 🆔 current\n- [ ] Candidate #owned\n  Private description',
  );
  const ui = h.mount();
  ui.query('Private description');
  await ui.completed();
  expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(0);
  ui.query('tasks.md');
  await ui.completed();
  expect(ui.handle.element.querySelector('[role="option"]')?.textContent).toContain('Candidate');
  expect(
    [...ui.handle.element.querySelectorAll('.abyss-dep-search-context mark')].map(
      (mark) => mark.textContent,
    ),
  ).toEqual(['tasks.md']);
  ui.query('owned');
  await ui.completed();
  expect(ui.handle.element.querySelector('[role="option"]')?.textContent).toContain('Candidate');
  expect(ui.handle.element.querySelector('mark')).toBeNull();
});
it.each(['existing', 'create'] as const)(
  'keeps thrown %s command errors in the existing command boundary',
  async (action) => {
    const h = await fixture(1);
    const messages: string[] = [];
    vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: string): void },
      'constructor__',
    ).mockImplementation((message) => {
      messages.push(message);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Command failed');
    const fail = async (): Promise<DependencyPickerCommitResult> => {
      throw failure;
    };
    h.callbacks.createNew = fail;
    h.callbacks.selectExisting = fail;
    const ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    if (action === 'existing') ui.key('ArrowDown');
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '[abyss-tasks] Could not add dependency',
        failure,
      );
    });
    expect(messages).toEqual([]);
    expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
    expect(ui.input.value).toBe('Candidate');
    expect(ui.input.readOnly).toBe(false);
  },
);
it.each([false, true])(
  'does not revive existing selection when explicit Create is retried after validation (stale=%s)',
  async (stale) => {
    const h = await fixture(2);
    let calls = 0;
    h.callbacks.createNew = async () => {
      calls++;
      return calls === 1
        ? { type: 'validation-error', message: 'Try another title' }
        : { type: 'committed' };
    };
    const ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    ui.key('ArrowDown');
    if (stale) {
      h.index.installCommittedContent(
        'tasks.md',
        '- [ ] Current 🆔 current\n- [ ] Candidate 1 🆔 c1',
      );
      await ui.completed();
    }
    expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
    ).click();
    await flushMicrotasks(40);
    expect(ui.active()).toBeNull();
    expect(ui.input.value).toBe('Candidate');
    ui.key('Enter');
    await flushMicrotasks(40);
    expect(calls).toBe(2);
    expect(h.writes).toEqual([]);
  },
);
it('clears previous create validation when an existing selection begins', async () => {
  const h = await fixture(1);
  h.callbacks.createNew = async () => ({ type: 'validation-error', message: 'Try another title' });
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key('Enter');
  await flushMicrotasks(40);
  expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toBe(
    'Try another title',
  );
  ui.key('ArrowDown');
  ui.key('Enter');
  expect(ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-error')?.hidden).toBe(
    true,
  );
  await vi.waitFor(() => {
    expect(h.writes[0]?.title).toBe('Candidate 0');
  });
});
it.each([
  ['ArrowDown', 'Candidate 0'],
  ['ArrowUp', 'Candidate 1'],
] as const)('%s explicitly selects %s before Enter', async (key, title) => {
  const h = await fixture(2),
    ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key(key);
  expect(ui.active()?.textContent).toContain(title);
  ui.key('Enter');
  await vi.waitFor(() => {
    expect(h.writes[0]?.title).toBe(title);
  });
  expect(h.creates).toEqual([]);
});
it('distinguishes equal titles in one note through exact line context without a title count scan', async () => {
  const h = await fixture(2);
  h.index.installCommittedContent(
    'tasks.md',
    '- [ ] Current 🆔 current\n- [ ] Repeated 🆔 c0\n- [ ] Repeated 🆔 c1',
  );
  const ui = h.mount();
  ui.query('Repeated');
  await ui.completed();
  expect(
    [...ui.handle.element.querySelectorAll('.abyss-dep-search-context')].map(
      (element) => element.textContent,
    ),
  ).toEqual(['tasks.md:2', 'tasks.md:3']);
});

it.each([
  ['ambiguous', 'Multiple tasks use this ID'],
  ['unavailable', 'Task unavailable'],
  ['stale', 'Task changed'],
] as const)('preserves the shared %s rejection label', (reason, message) => {
  expect(rejectionLabel(reason)).toBe(message);
});

function gapFiles(kind: 'disabled' | 'omitted', direction: DependencyDirection) {
  const gapEnd = kind === 'disabled' ? 60 : 120;
  const gapIds = Array.from({ length: gapEnd - 30 }, (_, i) => `c${i + 30}`).join(', ');
  let currentDependencies = '';
  let gapDependency = '';
  if (kind === 'disabled') {
    if (direction === 'blocks') currentDependencies = ' ⛔ bridge';
    else gapDependency = ' ⛔ bridge';
  } else if (direction === 'blocks') gapDependency = ' ⛔ current';
  else currentDependencies = ` ⛔ ${gapIds}`;
  const bridgeDependencies = direction === 'blocks' ? gapIds : 'current';
  const candidates = Array.from({ length: gapEnd + 30 }, (_, i) => {
    const dependency = i >= 30 && i < gapEnd ? gapDependency : '';
    return `- [ ] Candidate ${String(i).padStart(3, '0')} 🆔 c${i}${dependency}`;
  });
  return {
    'tasks.md': [
      `- [ ] Current 🆔 current${currentDependencies}`,
      `- [ ] Bridge 🆔 bridge ⛔ ${bridgeDependencies}`,
      ...candidates,
    ].join('\n'),
  };
}

async function reachGapEdge(
  ui: ReturnType<Awaited<ReturnType<typeof fixture>>['mount']>,
  key: 'ArrowDown' | 'ArrowUp',
  gapEnd: number,
): Promise<void> {
  ui.key(key === 'ArrowDown' ? 'Home' : 'End');
  await vi.waitFor(() => {
    expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(
      key === 'ArrowDown' ? 'Candidate 000' : `Candidate ${String(gapEnd + 29).padStart(3, '0')}`,
    );
  });
  await ui.completed();
  const target =
    key === 'ArrowDown' ? 'Candidate 029' : `Candidate ${String(gapEnd).padStart(3, '0')}`;
  for (
    let steps = 0;
    steps < 35 && ui.active()?.querySelector('.abyss-dep-search-title')?.textContent !== target;
    steps++
  ) {
    const previous = ui.active()?.textContent;
    ui.key(key);
    await vi.waitFor(() => {
      expect(ui.active()).not.toBeNull();
      expect(ui.active()?.textContent).not.toBe(previous);
    });
    await ui.completed();
  }
  expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(target);
}

it.each([
  ['disabled', 'ArrowDown', 'blocks'],
  ['disabled', 'ArrowUp', 'blocks'],
  ['omitted', 'ArrowDown', 'blocks'],
  ['omitted', 'ArrowUp', 'blocks'],
  ['disabled', 'ArrowDown', 'blocked-by'],
  ['disabled', 'ArrowUp', 'blocked-by'],
  ['omitted', 'ArrowDown', 'blocked-by'],
  ['omitted', 'ArrowUp', 'blocked-by'],
] as const)(
  'crosses a %s interval with %s without changing commit intent (%s)',
  async (kind, key, direction) => {
    const h = await fixture(0, direction, gapFiles(kind, direction));
    const ui = h.mount();
    ui.query('  Candidate  ');
    await ui.completed();
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    const gapEnd = kind === 'disabled' ? 60 : 120;
    await reachGapEdge(ui, key, gapEnd);
    ui.key(key);
    await vi.waitFor(() => {
      expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(
        key === 'ArrowDown' ? `Candidate ${String(gapEnd).padStart(3, '0')}` : 'Candidate 029',
      );
    });
    await ui.completed();
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    if (kind === 'disabled') {
      list.scrollTop = 35 * 48;
      list.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() => {
        // Crossing already mounted disabled rows; observe the requested scroll window.
        expect(
          list.querySelector('[aria-posinset="41"] .abyss-dep-search-title')?.textContent,
        ).toBe('Candidate 040');
        expect(list.querySelector('[aria-disabled="true"]')).not.toBeNull();
      });
      await ui.completed();
      expect(ui.active()).toBeNull();
      for (const option of list.querySelectorAll('[aria-disabled="true"]'))
        expect(option.textContent).toContain('Would create a cycle');
      ui.key('Enter');
      expect(h.writes).toEqual([]);
      expect(h.creates).toEqual([]);
    }
    const title =
      key === 'ArrowDown' ? `Candidate ${String(gapEnd + 29).padStart(3, '0')}` : 'Candidate 000';
    ui.key(key === 'ArrowDown' ? 'End' : 'Home');
    await vi.waitFor(() => {
      expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(title);
    });
    await ui.completed();
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]?.title).toBe(title);
    expect(h.writes[0]?.direction).toBe(direction);
    expect(h.writes[0]?.target).toEqual(
      expectDefined(h.index.listNodes().find((task) => task.node.title === title)).target,
    );
    expect(h.creates).toEqual([]);
    await ui.completed();
    ui.query('  Candidate  ');
    await ui.completed();
    expect(
      ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create')?.disabled,
      ui.handle.element.outerHTML,
    ).toBe(false);
    expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
    ).click();
    await vi.waitFor(() => {
      expect(h.creates).toEqual([['  Candidate  ', direction]]);
    });
  },
);
it.each([false, true])(
  'keeps direction and creation controls busy through source replacement (replace=%s)',
  async (replace) => {
    const h = await fixture(31);
    const command = deferred<DependencyPickerCommitResult>();
    h.callbacks.createNew = () => command.promise;
    const ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    const create = expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
    );
    create.click();
    const controls = () => [
      ...ui.handle.element.querySelectorAll<HTMLButtonElement>(
        '.abyss-dep-search-direction, .abyss-dep-search-create',
      ),
    ];
    expect(controls().every((button) => button.disabled)).toBe(true);
    if (replace) {
      h.index.installCommittedContent('other.md', '- [ ] Other');
      await ui.completed();
      expect(controls().every((button) => button.disabled)).toBe(true);
    }
    ui.key('End');
    ui.key('Enter');
    expect(h.writes).toEqual([]);
    command.resolve({ type: 'validation-error', message: 'Keep draft' });
    await vi.waitFor(() => {
      expect(ui.input.readOnly).toBe(false);
    });
    expect(controls().every((button) => !button.disabled)).toBe(true);
    ui.key('End');
    await vi.waitFor(() => {
      expect(ui.active()?.textContent).toContain('Candidate 30');
    });
  },
);

it('owns local Find from dependency controls under its blocking lease, blurring before original Escape close', async () => {
  const h = await fixture();
  const p = h.mount();
  p.query('Candidate');
  await p.completed();
  const button = expectDefined(p.handle.element.querySelector<HTMLButtonElement>('button'));
  button.focus();
  const find = new KeyboardEvent('keydown', {
    code: 'KeyF',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(find);
  expect(find.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(p.input);
  expect(p.input.selectionEnd).toBe(9);
  p.key('Escape');
  expect(p.handle.element.isConnected).toBe(true);
  expect(document.activeElement).toBe(p.handle.element);
  p.handle.element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(p.handle.element.isConnected).toBe(false);
  expect(h.callbacks.onClose).toHaveBeenCalledWith(true);
});

it('gives an attached picker finite scope ownership, two Escape steps, and no stale callback after detach/adoption', async () => {
  const h = await fixture(2);
  const register = vi.spyOn(Scope.prototype, 'register');
  const unregister = vi.spyOn(Scope.prototype, 'unregister');
  const host = { parent: new Scope(), keymap: { pushScope: vi.fn(), popScope: vi.fn() } };
  const container = document.body.createDiv();
  const handle = mountDependencySearch(container, { ...h.callbacks, localSearchScope: host });
  cleanup.push(() => {
    handle.destroy();
  });
  const input = expectDefined(handle.element.querySelector('input'));
  const escape = expectDefined(register.mock.calls.find((call) => call[1] === 'Escape'))[2];
  const event = () =>
    scopeKeyboardEvent(
      expectDefined(handle.element.ownerDocument.activeElement),
      {
        key: 'Escape',
      },
      [window],
    );
  input.value = 'preserved';
  expect(escape(event(), { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBe(false);
  expect(document.activeElement).toBe(handle.element);
  expect(input.value).toBe('preserved');
  expect(h.callbacks.onClose).not.toHaveBeenCalled();
  handle.detach();
  handle.detach();
  expect(host.keymap.popScope).toHaveBeenCalledTimes(1);
  expect(unregister).toHaveBeenCalledTimes(2);
  expect(escape(event(), { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBeUndefined();
  const frame = document.body.createEl('iframe');
  const doc = expectDefined(frame.contentDocument);
  doc.body.append(handle.element);
  handle.attach();
  handle.attach();
  expect(host.keymap.pushScope).toHaveBeenCalledTimes(2);
  expect(escape(event(), { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBeUndefined();
  input.focus();
  const nextFind = expectDefined(register.mock.calls[register.mock.calls.length - 2])[2];
  const nextEscape = expectDefined(register.mock.calls[register.mock.calls.length - 1])[2];
  const findEvent = scopeKeyboardEvent(input, { key: 'f', code: 'KeyF', ctrlKey: true }, [window]);
  expect(findEvent.composedPath()[0]).not.toBe(doc.defaultView);
  expect(findEvent.composedPath()[0]).not.toBe(findEvent.target);
  expect(findEvent.view?.document).toBe(doc);
  expect(nextFind(findEvent, { key: 'f', vkey: 'F', modifiers: 'Ctrl' })).toBe(false);
  expect(doc.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 9]);
  const oldView = scopeKeyboardEvent(input, { key: 'Escape', view: window }, [window]);
  expect(nextEscape(oldView, { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBeUndefined();
  expect(doc.activeElement).toBe(input);
  expect(nextEscape(event(), { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBe(false);
  expect(doc.activeElement).toBe(handle.element);
  expect(input.value).toBe('preserved');
  expect(h.callbacks.onClose).not.toHaveBeenCalled();
  expect(nextEscape(event(), { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBe(false);
  expect(h.callbacks.onClose).toHaveBeenCalledExactlyOnceWith(true);
  expect(host.keymap.popScope).toHaveBeenCalledTimes(2);
  frame.remove();
});

it('does not acquire picker leases from detached or hidden DOM', async () => {
  const h = await fixture(2);
  const host = { parent: new Scope(), keymap: { pushScope: vi.fn(), popScope: vi.fn() } };
  const acquire = vi.spyOn(h.callbacks.ownership, 'acquire');
  const container = createDiv();
  const handle = mountDependencySearch(container, { ...h.callbacks, localSearchScope: host });
  cleanup.push(() => {
    handle.destroy();
  });
  expect(acquire).not.toHaveBeenCalled();
  document.body.append(container);
  container.hidden = true;
  handle.attach();
  expect(host.keymap.pushScope).not.toHaveBeenCalled();
  container.hidden = false;
  handle.attach();
  expect(host.keymap.pushScope).toHaveBeenCalledOnce();
});

it('lets only the nearest attached picker own scope keys and excludes another editor', async () => {
  const h = await fixture(2);
  const host = { parent: new Scope(), keymap: { pushScope: vi.fn(), popScope: vi.fn() } };
  const register = vi.spyOn(Scope.prototype, 'register');
  const outer = mountDependencySearch(document.body, { ...h.callbacks, localSearchScope: host });
  cleanup.push(() => {
    outer.destroy();
  });
  const outerFind = expectDefined(register.mock.calls[0])[2];
  const inner = mountDependencySearch(outer.element, { ...h.callbacks, localSearchScope: host });
  cleanup.push(() => {
    inner.destroy();
  });
  const innerFind = expectDefined(register.mock.calls[2])[2];
  const context = { key: 'f', vkey: 'F', modifiers: 'Ctrl' };
  const event = () =>
    scopeKeyboardEvent(
      expectDefined(inner.element.ownerDocument.activeElement),
      {
        code: 'KeyF',
        key: 'а',
        ctrlKey: true,
      },
      [window],
    );
  expect(outerFind(event(), context)).toBeUndefined();
  expect(innerFind(event(), context)).toBe(false);
  const editor = inner.element.createEl('textarea');
  editor.focus();
  expect(innerFind(event(), context)).toBeUndefined();
  const input = expectDefined(inner.element.querySelector('input'));
  input.focus();
  inner.element.hidden = true;
  expect(innerFind(event(), context)).toBeUndefined();
});

const geometryLists = new WeakSet<HTMLElement>();
function positionDemandSurface(
  element: HTMLElement,
  owner: Pick<ReturnType<typeof taskViewportOwner>, 'doc'>,
  height = 766,
  rowHeight: (element: HTMLElement) => number = () => 48,
): void {
  if (element.ownerDocument !== owner.doc) owner.doc.body.append(element);
  const win = expectDefined(owner.doc.defaultView);
  if (!Reflect.has(owner.doc, 'fonts'))
    Object.defineProperty(owner.doc, 'fonts', { configurable: true, value: new win.EventTarget() });
  if (!Reflect.has(win, 'ResizeObserver'))
    Object.defineProperty(win, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  const list = expectDefined(element.querySelector<HTMLElement>('.abyss-dep-search-results'));
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: height },
    clientWidth: { configurable: true, value: 400 },
  });
  list.getBoundingClientRect = () => ({
    top: 0,
    bottom: list.clientHeight,
    left: 0,
    right: 400,
    width: 400,
    height: list.clientHeight,
    x: 0,
    y: 0,
    toJSON() {},
  });
  if (geometryLists.has(list)) return;
  geometryLists.add(list);
  const create = list.createEl.bind(list);
  vi.spyOn(list, 'createEl').mockImplementation((...args: Parameters<typeof list.createEl>) => {
    const element = create(...args);
    element.getBoundingClientRect = () => {
      let top = -list.scrollTop;
      let previous = element.previousElementSibling;
      while (previous !== null) {
        top += previous.classList.contains('abyss-virtual-row-spacer')
          ? Number.parseFloat(
              (previous as HTMLElement).style.getPropertyValue('--abyss-virtual-row-height'),
            )
          : rowHeight(previous as HTMLElement);
        previous = previous.previousElementSibling;
      }
      return {
        top,
        bottom: top + rowHeight(element),
        left: 0,
        right: 400,
        width: 400,
        height: rowHeight(element),
        x: 0,
        y: top,
        toJSON() {},
      };
    };
    return element;
  });
}

// Phase A isolates traversal cost with fixed element-local geometry and the real surface.
async function demandFixture(omitted: number, omittedStart = 0) {
  const h = await fixture(1);
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
  });
  const visits: number[] = [];
  const labels: number[] = [];
  let beforeRead: ((offset: number) => Promise<void>) | undefined;
  const generation = 1;
  const readRange = vi.fn(async (offset: number, limit: number, _signal: AbortSignal) => {
    await beforeRead?.(offset);
    const candidates = Array.from({ length: Math.min(limit, 50_000 - offset) }, (_, i) => {
      const raw = offset + i;
      visits.push(raw);
      return {
        offset: raw,
        hit: { address: { epoch: 'count', version: 1, rootId: raw + 1, childLines: [] }, score: 0 },
        eligibility:
          raw >= omittedStart && raw < omittedStart + omitted
            ? { type: 'rejected' as const, reason: 'duplicate' as const }
            : { type: 'allowed' as const },
      };
    });
    return { generation, offset, candidates };
  });
  const session = {
    generation,
    totalCandidates: 50_000,
    readRange,
    options: vi.fn(async (candidates: readonly DependencyCandidate[]) =>
      candidates.map((c) => {
        labels.push(c.offset);
        return {
          offset: c.offset,
          address: c.hit.address,
          title: `Candidate ${c.offset}`,
          context: 'count.md:1',
          directions: ['blocks' as const],
        };
      }),
    ),
    resolve: vi.fn(async () => {
      throw new Error('No submit in traversal test');
    }),
    close: vi.fn(),
  };
  h.callbacks.provider.open = async () => session;
  vi.spyOn(browserScheduler, 'createBrowserTaskScheduler').mockReturnValue({
    now: () => 0,
    delay: async () => {},
    yield: async () => {},
  });
  const orders = vi.spyOn(taskRows, 'indexedRows');
  const replacements = vi.spyOn(RowViewport.prototype, 'replace');
  const updates = vi.spyOn(TaskListSurface.prototype, 'update');
  const handle = mountDependencySearch(activeDocument.body, {
    ...h.callbacks,
    position: (element) => {
      positionDemandSurface(element, owner);
    },
  });
  cleanup.push(() => {
    handle.destroy();
  });
  owner.flush();
  const list = expectDefined(
    handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
  );
  return {
    ...h,
    owner,
    handle,
    list,
    session,
    visits,
    labels,
    orders,
    replacements,
    updates,
    hold(callback: (offset: number) => Promise<void>) {
      beforeRead = callback;
    },
    completed: () => searchUiCompleted(handle.element),
  };
}

it.each([49_950, 50_000])(
  'Phase A fills 50k with %i omissions in one linear pruning publication',
  async (omitted) => {
    const h = await demandFixture(omitted);
    const held = deferred<void>();
    h.hold(async (offset) => {
      if (offset >= 1820 && offset < 2020) await held.promise;
    });
    await vi.waitFor(() => {
      expect(h.session.readRange.mock.calls.length).toBeGreaterThanOrEqual(11);
    });
    expect(h.session.readRange.mock.calls[0]?.slice(0, 2)).toEqual([0, 20]);
    expect(h.orders.mock.calls.filter(([rows]) => rows.length > 0)).toHaveLength(1);
    expect(h.replacements).toHaveBeenCalledTimes(2);
    expect(h.labels).toEqual([]);
    expect(h.list.querySelectorAll('button')).toHaveLength(20);
    expect(h.list.querySelector('[role="option"]')).toBeNull();
    expect(h.list.textContent).not.toContain('No matching tasks');
    held.resolve();
    await h.completed();
    expect(h.visits.length).toBeLessThanOrEqual(50_000);
    expect(new Set(h.visits).size).toBe(h.visits.length);
    // Exclude only the surface constructor's empty initialization, not final empty pruning.
    expect(h.orders.mock.calls.slice(1)).toHaveLength(2);
    expect(h.replacements.mock.calls.length).toBeLessThanOrEqual(3);
    expect(h.replacements.mock.calls.reduce((n, [rows]) => n + rows.length, 0)).toBeLessThanOrEqual(
      150_000,
    );
    if (omitted === 50_000) {
      expect(h.list.querySelectorAll('[role="option"]')).toHaveLength(0);
      expect(h.list.textContent).toContain('No matching tasks');
    } else {
      expect(h.list.querySelector('[role="option"]')?.textContent).toContain('Candidate 49950');
      expect(h.labels.length).toBeLessThanOrEqual(20);
    }
    const counts = [h.orders.mock.calls.length, h.replacements.mock.calls.length];
    const readCount = h.session.readRange.mock.calls.length;
    const projectionCount = h.session.options.mock.calls.length;
    for (let i = 0; i < 4; i++) {
      h.list.dispatchEvent(new h.owner.win.Event('scroll'));
      h.owner.flush();
      await flushMicrotasks(20);
    }
    expect([h.orders.mock.calls.length, h.replacements.mock.calls.length]).toEqual(counts);
    expect(h.session.readRange).toHaveBeenCalledTimes(readCount);
    expect(h.session.options).toHaveBeenCalledTimes(projectionCount);
  },
);

it('Phase A cancels after ten intervals, drops a late read and jumps directly to the allowed tail', async () => {
  const h = await demandFixture(49_950);
  const held = deferred<void>();
  let late = false;
  h.hold(async (offset) => {
    if (!late && offset >= 1820) {
      late = true;
      await held.promise;
    }
  });
  await vi.waitFor(() => {
    expect(h.session.readRange).toHaveBeenCalledTimes(11);
  });
  const baseline = h.replacements.mock.calls.length;
  const tailHeld = deferred<void>();
  h.hold(async (offset) => {
    if (offset > 49_950) await tailHeld.promise;
  });
  h.list.scrollTop = 49_980 * 48;
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  await vi.waitFor(() => {
    expect(h.session.readRange).toHaveBeenCalledTimes(12);
  });
  expect(h.session.readRange.mock.calls[11]?.[0]).toBeGreaterThan(49_950);
  expect(h.replacements.mock.calls).toHaveLength(baseline);
  const before = h.list.textContent;
  held.resolve();
  await flushMicrotasks(40);
  expect(h.list.textContent).toBe(before);
  expect(h.replacements.mock.calls).toHaveLength(baseline);
  tailHeld.resolve();
  await h.completed();
  expect(h.replacements.mock.calls).toHaveLength(baseline + 1);
  h.list.scrollTop = 0;
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  await h.completed();
  expect(h.visits.filter((offset) => offset < 1820)).toHaveLength(1820);
  // The cancelled interval was not admitted as proof: returning must evaluate it again.
  expect(h.visits.filter((offset) => offset === 1820)).toHaveLength(2);
  h.handle.detach();
  expect(h.session.close).toHaveBeenCalledTimes(1);
  expect(h.owner.frames.size).toBe(0);
  expect(h.owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
});

it('Phase A resumes a cancelled label projection for the unchanged mounted window without rebuilding order', async () => {
  const h = await demandFixture(0);
  const held = deferred<void>();
  const project = h.session.options.getMockImplementation();
  h.session.options.mockImplementationOnce(async (candidates) => {
    await held.promise;
    return expectDefined(project)(candidates);
  });
  await vi.waitFor(() => {
    expect(h.session.options).toHaveBeenCalledTimes(1);
  });
  const counts = [h.orders.mock.calls.length, h.replacements.mock.calls.length];
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  await h.completed();
  expect(h.list.querySelectorAll('[role="option"]')).toHaveLength(20);
  held.resolve();
  await flushMicrotasks(30);
  expect([h.orders.mock.calls.length, h.replacements.mock.calls.length]).toEqual(counts);
});

it('Phase A releases partial native and session owners on a real range failure', async () => {
  const h = await demandFixture(0);
  h.session.readRange.mockRejectedValueOnce(new TaskSearchError('unavailable', 'read failed'));
  await vi.waitFor(() => {
    expect(h.handle.element.dataset['searchPhase']).toBe('error');
  });
  expect(h.session.close).toHaveBeenCalledTimes(1);
  expect(h.owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
  expect(h.owner.frames.size).toBe(0);
  expect(h.list.querySelector('[role="option"]')).toBeNull();
});

it.each(['direction', 'source'] as const)(
  'Phase A discards old omission knowledge on %s replacement',
  async (cause) => {
    const h = await demandFixture(49_950);
    const held = deferred<void>();
    let blocked = false;
    h.hold(async (offset) => {
      if (!blocked && offset >= 1820) {
        blocked = true;
        await held.promise;
      }
    });
    await vi.waitFor(() => {
      expect(h.session.readRange).toHaveBeenCalledTimes(11);
    });
    if (cause === 'direction') {
      const direction = expectDefined(
        h.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
      );
      direction.click();
    } else h.index.installCommittedContent('other.md', '- [ ] Other');
    await flushMicrotasks(20);
    h.owner.flush();
    await vi.waitFor(() => {
      expect(h.visits.filter((offset) => offset === 0)).toHaveLength(2);
    });
    held.resolve();
    await h.completed();
    expect(h.session.close).toHaveBeenCalledTimes(1);
  },
);

it('Phase A preserves a surviving measured tall anchor through one omission publication', async () => {
  const h = await demandFixture(10);
  const list = h.list;
  const held = deferred<void>();
  h.hold(async () => {
    await held.promise;
  });
  await vi.waitFor(() => {
    expect(h.session.readRange).toHaveBeenCalledTimes(1);
  });
  const surface = expectDefined(h.updates.mock.instances[0]);
  if (!(surface instanceof TaskListSurface)) throw new Error('Missing real surface');
  const anchor = expectDefined(surface.element('10'));
  for (const key of surface.mountedKeys()) {
    const element = expectDefined(surface.element(key));
    const height = key === '10' ? 144 : 48;
    element.getBoundingClientRect = () => {
      let top = -list.scrollTop;
      let previous = element.previousElementSibling;
      while (previous !== null) {
        if (previous.classList.contains('abyss-virtual-row-spacer'))
          top += Number.parseFloat(
            (previous as HTMLElement).style.getPropertyValue('--abyss-virtual-row-height'),
          );
        else top += previous === anchor ? 144 : 48;
        previous = previous.previousElementSibling;
      }
      return {
        top,
        bottom: top + height,
        left: 0,
        right: 400,
        width: 400,
        height,
        x: 0,
        y: top,
        toJSON() {},
      };
    };
  }
  surface.refreshMeasurements();
  h.owner.flush();
  await flushMicrotasks(20);
  list.scrollTop = 10 * 48 + 36;
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  await flushMicrotasks(20);
  expect(anchor.getBoundingClientRect().top).toBe(-36);
  const replacements = h.replacements.mock.calls.length;
  held.resolve();
  await h.completed();
  expect(surface.element('10')).toBe(anchor);
  expect(anchor.getBoundingClientRect().top).toBe(-36);
  expect(h.replacements.mock.calls).toHaveLength(replacements + 1);
});

it('Phase A fills both sides of a middle anchor in one publication while preserving a sparse pin', async () => {
  const h = await demandFixture(10, 1000);
  const held = deferred<void>();
  h.hold(async (offset) => {
    if (offset === 0) await held.promise;
  });
  await vi.waitFor(() => {
    expect(h.session.readRange).toHaveBeenCalledTimes(1);
  });
  const surface = expectDefined(h.updates.mock.instances[0]);
  if (!(surface instanceof TaskListSurface)) throw new Error('Missing real surface');
  const unpin = surface.pin('49999');
  cleanup.push(unpin);
  h.list.scrollTop = 1010 * 48 + 12;
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  const anchor = expectDefined(surface.element('1010'));
  expect(anchor.getBoundingClientRect().top).toBe(-12);
  const replacements = h.replacements.mock.calls.length;
  await h.completed();
  expect(h.replacements.mock.calls).toHaveLength(replacements + 1);
  expect(surface.element('1010')).toBe(anchor);
  expect(anchor.getBoundingClientRect().top).toBe(-12);
  expect(h.labels).toContain(49999);
  expect(h.labels).toContain(999);
  expect(new Set(h.visits).size).toBe(h.visits.length);
  expect(h.visits.every((offset) => offset >= 800)).toBe(true);
  expect([...h.labels].sort((a, b) => a - b)).toEqual(surface.mountedKeys().map(Number));
  const current = h.list.textContent;
  held.resolve();
  await flushMicrotasks(40);
  expect(h.list.textContent).toBe(current);
  expect(h.replacements.mock.calls).toHaveLength(replacements + 1);
});

it.each(['current', 'owner'] as const)(
  'Phase A releases a demand whose %s changed during a held read',
  async (cause) => {
    const h = await demandFixture(0);
    const held = deferred<void>();
    h.hold(async () => {
      await held.promise;
    });
    await vi.waitFor(() => {
      expect(h.session.readRange).toHaveBeenCalledTimes(1);
    });
    if (cause === 'current') h.setCurrent(undefined);
    else activeDocument.body.append(h.handle.element);
    held.resolve();
    await flushMicrotasks(40);
    expect(h.session.close).toHaveBeenCalledTimes(1);
    expect(h.owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
    expect(h.session.options).not.toHaveBeenCalled();
    expect(h.list.querySelector('[role="option"]')).toBeNull();
  },
);

it('Phase A validates an empty initial result before settling creation for a captured stale current task', async () => {
  const h = await fixture(0);
  h.index.installCommittedContent('tasks.md', '- [ ] Changed current');
  const check = vi.spyOn(h.index, 'searchEligibility');
  const ui = h.mount();
  ui.query('no matching candidate');
  await vi.waitFor(() => {
    expect(check).toHaveBeenCalledTimes(2);
  });
  // The captured reference stays unchanged; both the initial and one-shot stale attempt validate it.
  expect(check.mock.calls.map(([request]) => request.addresses)).toEqual([[], []]);
  expect(ui.handle.element.dataset['searchPhase']).toBe('idle');
  ui.key('Enter');
  expect(h.creates).toEqual([]);
});

it('Phase A evaluates a sparse pinned tail before forward replacements and hydrates only the final mounted intersection', async () => {
  const h = await demandFixture(49_950);
  const held = deferred<void>();
  let first = true;
  h.hold(async () => {
    if (first) {
      first = false;
      await held.promise;
    }
  });
  await vi.waitFor(() => {
    expect(h.session.readRange).toHaveBeenCalledTimes(1);
  });
  const surface = expectDefined(h.updates.mock.instances[0]);
  if (!(surface instanceof TaskListSurface)) throw new Error('Missing real surface');
  const unpin = surface.pin('49999');
  cleanup.push(unpin);
  h.owner.flush();
  await h.completed();
  expect(h.session.readRange.mock.calls.slice(1, 4).map((call) => call.slice(0, 2))).toEqual([
    [0, 20],
    [49999, 1],
    [20, 200],
  ]);
  expect(new Set(h.visits).size).toBe(h.visits.length);
  expect(h.visits).toHaveLength(50_000);
  expect(h.labels).toContain(49999);
  expect(h.labels).toHaveLength(21);
  expect(h.replacements).toHaveBeenCalledTimes(3);
  const current = h.list.textContent;
  held.resolve();
  await flushMicrotasks(40);
  expect(h.list.textContent).toBe(current);
  expect(h.replacements).toHaveBeenCalledTimes(3);
});

async function evictDependencyCursor(search: TaskSearchApi): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const cursor = await search.open(
      { kind: 'nodes', query: 'Candidate' },
      new AbortController().signal,
    );
    cleanup.push(() => {
      search.release(cursor);
    });
  }
}

it.each([false, true])(
  'Phase A silently renews a real evicted cursor without editing input or changing generation (selected=%s)',
  async (selected) => {
    const h = await fixture(100);
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    const open = vi.spyOn(h.callbacks.provider, 'open');
    const read = vi.spyOn(h.search, 'read');
    const ui = h.mount(owner);
    ui.query('Candidate');
    owner.flush();
    await ui.completed();
    if (selected) {
      ui.key('ArrowDown');
      expect(ui.active()?.textContent).toContain('Candidate 0');
    }
    const generation = ui.handle.element.dataset['searchGeneration'];
    const cursor = expectDefined(read.mock.calls[0]?.[0]);
    await evictDependencyCursor(h.search);
    await expect(h.search.read(cursor, 70, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'cursor-expired',
    });
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    const beforeDemand = read.mock.calls.length;
    list.scrollTop = 48 * 70;
    list.dispatchEvent(new owner.win.Event('scroll'));
    await vi.waitFor(() => {
      owner.flush();
      expect(open).toHaveBeenCalledTimes(2);
      expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
    });
    expect(
      read.mock.calls
        .slice(beforeDemand)
        .some(([readCursor, offset]) => readCursor.id === cursor.id && offset > 20),
    ).toBe(true);
    expect(ui.input.value).toBe('Candidate');
    expect(ui.handle.element.dataset['searchGeneration']).toBe(generation);
    expect(list.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    expect(list.textContent).toContain('Candidate');
    expect(ui.active()).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    // Enter must retain the offscreen selected address, never a new neighbor or creation.
    if (selected) ui.key('Enter');
    else expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toBe('');
    await flushMicrotasks(30);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    ui.handle.refresh();
    owner.flush();
    await flushMicrotasks(30);
    expect(open).toHaveBeenCalledTimes(2);
    if (!selected) {
      // A successful renewal does not replenish the allowance for this same intent.
      await evictDependencyCursor(h.search);
      list.scrollTop = 48 * 10;
      list.dispatchEvent(new owner.win.Event('scroll'));
      await vi.waitFor(() => {
        owner.flush();
        expect(ui.handle.element.dataset['searchPhase']).toBe('idle');
      });
      expect(open).toHaveBeenCalledTimes(2);
      expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toBe('');
      expect(list.querySelector('[role="option"]')).toBeNull();
    }
  },
);

it.each([
  ['cursor-expired', 'input'],
  ['cursor-expired', 'direction'],
  ['cursor-expired', 'source'],
  ['cursor-expired', 'current'],
  ['stale', 'input'],
] as const)(
  'Phase A bounds silent %s recovery to two opens until new %s intent',
  async (code, context) => {
    const h = await fixture(100);
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    const notices: string[] = [];
    vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: string): void },
      'constructor__',
    ).mockImplementation((message) => {
      notices.push(message);
    });
    const open = vi.spyOn(h.callbacks.provider, 'open');
    const original = h.search.read.bind(h.search);
    vi.spyOn(h.search, 'read').mockImplementation(async (...args) => {
      if (code === 'stale') throw new TaskSearchError('stale', 'Task changed');
      await evictDependencyCursor(h.search);
      return original(...args);
    });
    const ui = h.mount(owner);
    ui.query('Candidate');
    await vi.waitFor(() => {
      owner.flush();
      expect(open).toHaveBeenCalledTimes(2);
      expect(ui.handle.element.dataset['searchPhase']).toBe('idle');
    });
    for (let i = 0; i < 3; i++) {
      ui.handle.refresh();
      ui.query('Candidate');
      owner.flush();
      await flushMicrotasks(30);
    }
    expect(open).toHaveBeenCalledTimes(2);
    expect(ui.handle.element.querySelector('.abyss-dep-search-error')?.textContent).toBe('');
    expect(ui.handle.element.querySelector('.abyss-search-status')?.textContent).toBe('');
    expect(notices).toEqual([]);
    ui.key('Enter');
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    expect(owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
    expect(owner.frames.size).toBe(0);
    if (context === 'input') ui.query('Candidate 1');
    else if (context === 'direction') {
      expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
      ).click();
    } else if (context === 'source') h.index.installCommittedContent('other.md', '- [ ] Other');
    else {
      h.setCurrent(expectDefined(h.index.listNodes()[1]).target);
      ui.handle.refresh();
    }
    await vi.waitFor(() => {
      owner.flush();
      expect(open).toHaveBeenCalledTimes(4);
      expect(ui.handle.element.dataset['searchPhase']).toBe('idle');
    });
  },
);

it.each(['close', 'detach', 'current', 'owner', 'query', 'demand'] as const)(
  'Phase A does not resurrect an expired held read after %s supersession',
  async (cause) => {
    const h = await fixture(100);
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    const open = vi.spyOn(h.callbacks.provider, 'open');
    const read = h.search.read.bind(h.search);
    const held = deferred<void>();
    const waiting = deferred<void>();
    vi.spyOn(h.search, 'read').mockImplementationOnce(async (...args) => {
      waiting.resolve();
      await held.promise;
      return read(...args);
    });
    const ui = h.mount(owner);
    ui.query('Candidate');
    owner.flush();
    await waiting.promise;
    await evictDependencyCursor(h.search);
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    if (cause === 'close') ui.handle.close();
    else if (cause === 'detach') ui.handle.detach();
    else if (cause === 'current') h.setCurrent(undefined);
    else if (cause === 'owner') activeDocument.body.append(ui.handle.element);
    else if (cause === 'query') ui.query('Candidate 9');
    else {
      list.scrollTop = 48 * 70;
      list.dispatchEvent(new owner.win.Event('scroll'));
    }
    owner.flush();
    held.resolve();
    if (cause === 'query' || cause === 'demand') {
      await vi.waitFor(() => {
        owner.flush();
        expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
      });
      expect(open).toHaveBeenCalledTimes(2);
      expect(list.textContent).toContain(cause === 'query' ? 'Candidate 9' : 'Candidate 70');
    } else {
      await flushMicrotasks(60);
      owner.flush();
      await flushMicrotasks(30);
      expect(open).toHaveBeenCalledTimes(1);
      expect(list.querySelector('[role="option"]')).toBeNull();
      expect(owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
    }
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
  },
);

describe('R1 unsized dependency list bootstrap', () => {
  async function bootstrap(count = 65, omitted = false, beforeRead?: Promise<void>) {
    const h = await fixture(
      count,
      'blocks',
      omitted
        ? {
            'tasks.md': '- [ ] Current 🆔 current ⛔ c0\n- [ ] Candidate 0 🆔 c0',
          }
        : undefined,
    );
    if (beforeRead !== undefined) {
      const open = h.callbacks.provider.open.bind(h.callbacks.provider);
      h.callbacks.provider.open = async (...args) => {
        const session = await open(...args);
        const read = session.readRange.bind(session);
        session.readRange = async (...args) => {
          await beforeRead;
          return read(...args);
        };
        return session;
      };
    }
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    let available = 256;
    const firstClasses: boolean[] = [];
    const update = methodOf(TaskListSurface.prototype, 'update');
    vi.spyOn(TaskListSurface.prototype, 'update').mockImplementation(function (
      this: TaskListSurface<number>,
      ...args
    ) {
      firstClasses.push(
        owner.doc
          .querySelector('.abyss-dep-search-results')
          ?.classList.contains('has-candidates') === true,
      );
      update.apply(this, args);
    });
    const handle = mountDependencySearch(activeDocument.body, {
      ...h.callbacks,
      position: (element) => {
        positionDemandSurface(element, owner, 0);
        const list = expectDefined(element.querySelector<HTMLElement>('.abyss-dep-search-results'));
        Object.defineProperty(list, 'clientHeight', {
          configurable: true,
          get: () => {
            if (list.classList.contains('has-candidates')) return Math.min(256, available);
            return list.querySelector('.abyss-dep-search-empty') === null ? 0 : 24;
          },
        });
      },
    });
    cleanup.push(() => {
      handle.destroy();
    });
    const list = expectDefined(
      handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    const resize = () => {
      for (const observer of owner.observers)
        if (observer.elements.has(list)) observer.callback([], {} as ResizeObserver);
      owner.win.dispatchEvent(new owner.win.Event('resize'));
      owner.flush();
    };
    return {
      ...h,
      owner,
      handle,
      list,
      input,
      firstClasses,
      resize,
      available: (height: number) => {
        available = height;
      },
      completed: () => searchUiCompleted(handle.element),
    };
  }
  it('reserves intrinsic space before the first update and publishes only ready options', async () => {
    const held = deferred<void>();
    const h = await bootstrap(65, false, held.promise);
    h.owner.flush();
    await vi.waitFor(() => {
      expect(h.firstClasses[0]).toBe(true);
    });
    expect(h.list.querySelector('[role="option"]')).toBeNull();
    for (const holder of h.list.querySelectorAll<HTMLElement>('button')) {
      expect(holder.inert).toBe(true);
      expect(holder.getAttribute('aria-hidden')).toBe('true');
      expect(holder.id).toBe('');
    }
    expect(h.input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(h.owner.doc.activeElement).toBe(h.input);
    held.resolve();
    await h.completed();
    expect(h.list.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    for (const option of h.list.querySelectorAll<HTMLElement>('[role="option"]')) {
      expect(option.inert).toBe(false);
      expect(option.hasAttribute('aria-hidden')).toBe(false);
      expect(option.id).not.toBe('');
    }
    for (const spacer of h.list.querySelectorAll<HTMLElement>('.abyss-virtual-row-spacer')) {
      expect(spacer.inert).toBe(true);
      expect(spacer.getAttribute('aria-hidden')).toBe('true');
      expect(spacer.hasAttribute('tabindex')).toBe(false);
      expect(spacer.hasAttribute('role')).toBe(false);
      expect(spacer.id).toBe('');
    }
    expect(h.input.hasAttribute('aria-activedescendant')).toBe(false);
  });
  it('restores auto height after empty and all-omitted results, then bootstraps a new query', async () => {
    const h = await bootstrap(1, true);
    h.owner.flush();
    await h.completed();
    expect(h.list.classList.contains('has-candidates')).toBe(false);
    expect(h.list.querySelector('[role="option"]')).toBeNull();
    h.input.value = 'missing';
    h.input.dispatchEvent(new Event('input', { bubbles: true }));
    h.owner.flush();
    await h.completed();
    expect(h.list.classList.contains('has-candidates')).toBe(false);
    h.input.value = 'Current';
    h.input.dispatchEvent(new Event('input', { bubbles: true }));
    h.owner.flush();
    await h.completed();
    expect(h.list.classList.contains('has-candidates')).toBe(false);
    h.index.installCommittedContent('other.md', '- [ ] Allowed 🆔 allowed');
    h.owner.flush();
    await h.completed();
    h.input.value = 'Allowed';
    h.input.dispatchEvent(new Event('input', { bubbles: true }));
    h.owner.flush();
    await h.completed();
    expect(h.list.classList.contains('has-candidates')).toBe(true);
    expect(h.list.querySelector('[role="option"]')?.textContent).toContain('Allowed');
  });
  it('starts no zero-size demand and wakes after reattach on a real resize delivery', async () => {
    const h = await bootstrap();
    h.handle.detach();
    h.available(0);
    h.handle.attach();
    h.owner.flush();
    const reads = vi.spyOn(h.index, 'searchEligibility');
    await vi.waitFor(() => {
      expect(h.firstClasses.length).toBeGreaterThan(0);
    });
    expect(reads).not.toHaveBeenCalled();
    h.available(72);
    h.resize();
    await h.completed();
    expect(reads).toHaveBeenCalled();
    expect(h.list.querySelector('[role="option"]')).not.toBeNull();
    h.handle.destroy();
    expect(h.owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
    h.resize();
    expect(h.owner.frames.size).toBe(0);
  });
});

it('Phase B full keyboard reaches the last allowed candidate through a disabled tail and consumes pending Enter', async () => {
  const tail = Array.from({ length: 80 }, (_, i) => `c${i + 100}`).join(', ');
  const candidates = Array.from({ length: 180 }, (_, i) => `- [ ] Candidate ${i} 🆔 c${i}`).join(
    '\n',
  );
  const h = await fixture(0, 'blocks', {
    'tasks.md': `- [ ] Current 🆔 current ⛔ bridge\n- [ ] Bridge 🆔 bridge ⛔ ${tail}\n${candidates}`,
  });
  const held = deferred<void>();
  let hold = false;
  const original = h.callbacks.provider.open.bind(h.callbacks.provider);
  h.callbacks.provider.open = async (...args) => {
    const session = await original(...args);
    const read = session.readRange.bind(session);
    session.readRange = async (...args) => {
      if (hold) await held.promise;
      return read(...args);
    };
    return session;
  };
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  hold = true;
  ui.key('End');
  ui.key('Enter');
  expect(h.writes).toEqual([]);
  expect(h.creates).toEqual([]);
  held.resolve();
  await ui.completed();
  await vi.waitFor(() => {
    expect(ui.active()?.textContent).toContain('Candidate 99');
  });
  ui.key('Enter');
  await vi.waitFor(() => {
    expect(h.writes).toHaveLength(1);
  });
  expect(h.writes[0]?.title).toBe('Candidate 99');
  expect(h.creates).toEqual([]);
});

it.each(['query', 'direction', 'source', 'current', 'detach', 'close', 'adoption'] as const)(
  'Phase B cancels a held logical movement on %s without a late commit or refocus',
  async (change) => {
    const h = await fixture(260);
    h.callbacks.position = (element) => {
      positionDemandSurface(element, { doc: element.ownerDocument }, 256);
    };
    const held = deferred<void>();
    let hold = false;
    let heldSignal: AbortSignal | undefined;
    const open = h.callbacks.provider.open.bind(h.callbacks.provider);
    h.callbacks.provider.open = async (...args) => {
      const session = await open(...args);
      const read = session.readRange.bind(session);
      session.readRange = async (...args) => {
        if (hold && heldSignal === undefined) {
          heldSignal = args[2];
          await held.promise;
        }
        return read(...args);
      };
      return session;
    };
    const ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    hold = true;
    ui.key('End');
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(heldSignal).toBeDefined();
    });
    const retire: Record<typeof change, () => void> = {
      query: () => {
        ui.query('Candidate 1');
      },
      direction: () => {
        expectDefined(
          ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
        ).click();
      },
      source: () => {
        h.index.installCommittedContent('other.md', '- [ ] Other');
      },
      current: () => {
        h.setCurrent(undefined);
      },
      detach: () => {
        ui.handle.detach();
        ui.handle.element.remove();
      },
      close: () => {
        ui.handle.close(false);
      },
      adoption: () => {
        const owner = taskViewportOwner();
        cleanup.push(() => {
          owner.destroy();
        });
        owner.doc.body.append(ui.handle.element);
        ui.handle.attach();
        owner.flush();
      },
    };
    retire[change]();
    const focused = ui.handle.element.isConnected
      ? expectDefined(
          ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
        )
      : activeDocument.body.createEl('input');
    focused.focus();
    held.resolve();
    await vi.waitFor(() => {
      expect(heldSignal?.aborted).toBe(true);
    });
    await flushMicrotasks(30);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    expect(focused.ownerDocument.activeElement).toBe(focused);
    ui.handle.destroy();
  },
);

it('Phase B returns native picker resources to baseline after scrolling, direction changes and late callbacks', async () => {
  const h = await fixture(260);
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
    vi.unstubAllGlobals();
  });
  const resources = recordVirtualSurfaceResources(owner.win);
  Object.defineProperty(owner.win, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  const baseline = resources.counts();
  const open = vi.spyOn(h.search, 'open');
  const release = vi.spyOn(h.search, 'release');
  const ui = h.mount(owner);
  ui.query('Candidate');
  owner.flush();
  await ui.completed();
  const list = expectDefined(
    ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
  );
  for (const offset of [220, 5, 140]) {
    list.scrollTop = offset * 48;
    list.dispatchEvent(new owner.win.Event('scroll'));
    owner.flush();
    await vi.waitFor(() => {
      expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
    });
  }
  for (const direction of ['blocked-by', 'blocks']) {
    expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>(`[data-direction="${direction}"]`),
    ).click();
    owner.flush();
    await ui.completed();
  }
  ui.key('End');
  await vi.waitFor(() => {
    expect(ui.active()?.textContent).toContain('Candidate 259');
  });
  ui.handle.destroy();
  expect(resources.counts()).toEqual(baseline);
  expect(owner.frames.size).toBe(0);
  expect(release).toHaveBeenCalledTimes(open.mock.calls.length);
  for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
  owner.flush();
  expect(resources.counts()).toEqual(baseline);
  expect(owner.frames.size).toBe(0);
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.writes).toEqual([]);
  expect(h.creates).toEqual([]);
});

it.each(['geometry', 'unchanged scroll'] as const)(
  'review I1 resumes the settled window after %s cancels a held movement',
  async (cancel) => {
    const h = await fixture(260);
    const owner = taskViewportOwner();
    cleanup.push(() => {
      owner.destroy();
    });
    const held = deferred<void>();
    let hold = false;
    let heldSignal: AbortSignal | undefined;
    const opened = vi.spyOn(h.search, 'open');
    const replacements = vi.spyOn(RowViewport.prototype, 'replace');
    const open = h.callbacks.provider.open.bind(h.callbacks.provider);
    h.callbacks.provider.open = async (...args) => {
      const session = await open(...args);
      const read = session.readRange.bind(session);
      session.readRange = async (...args) => {
        if (hold && heldSignal === undefined) {
          heldSignal = args[2];
          await held.promise;
        }
        return read(...args);
      };
      return session;
    };

    const ui = h.mount(owner);
    ui.query('Candidate');
    owner.flush();
    await ui.completed();
    const list = expectDefined(
      ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
    );
    const replacementCount = replacements.mock.calls.length;
    const updates = vi.spyOn(TaskListSurface.prototype, 'update');
    hold = true;
    ui.key('End');
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(heldSignal).toBeDefined();
    });
    if (cancel === 'geometry') {
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 0 });
      owner.win.dispatchEvent(new owner.win.Event('resize'));
      expect(heldSignal?.aborted).toBe(true);
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 766 });
      owner.win.dispatchEvent(new owner.win.Event('resize'));
    } else {
      list.dispatchEvent(new owner.win.Event('scroll'));
      expect(heldSignal?.aborted).toBe(true);
    }
    owner.flush();
    held.resolve();
    await flushMicrotasks(50);
    owner.flush();
    await vi.waitFor(() => {
      expect(ui.handle.element.dataset['searchPhase']).toBe('complete');
    });
    ui.key('Home');
    expect(ui.active()?.textContent).toContain('Candidate 0');
    expect(ui.active()?.getAttribute('role')).toBe('option');
    expect(opened).toHaveBeenCalledOnce();
    // Native owner rebinding resets measurements; the controller must not publish an order.
    expect(replacements).toHaveBeenCalledTimes(replacementCount + (cancel === 'geometry' ? 1 : 0));
    expect(updates).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    ui.key('Enter');
    await vi.waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]?.title).toBe('Candidate 0');
  },
);

it('review I1 reprojects ready labels after same-window geometry resume', async () => {
  const h = await fixture(260);
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
  });
  const reads = vi.spyOn(h.index, 'searchEligibility');
  const ui = h.mount(owner);
  ui.query('Candidate');
  owner.flush();
  await ui.completed();
  const list = expectDefined(
    ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
  );
  const readyCount = list.querySelectorAll('[role="option"]').length;
  const readCount = reads.mock.calls.length;
  const updates = vi.spyOn(TaskListSurface.prototype, 'update');
  expect(readyCount).toBeGreaterThan(0);
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 0 });
  owner.win.dispatchEvent(new owner.win.Event('resize'));
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 766 });
  owner.win.dispatchEvent(new owner.win.Event('resize'));
  owner.flush();
  await flushMicrotasks(50);
  owner.flush();
  await vi.waitFor(() => {
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(readyCount);
  });
  for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
    expect(option.inert).toBe(false);
    expect(option.hasAttribute('aria-hidden')).toBe(false);
    expect(option.id).not.toBe('');
  }
  expect(reads).toHaveBeenCalledTimes(readCount);
  expect(updates).not.toHaveBeenCalled();
  ui.key('Home');
  expect(ui.active()?.textContent).toContain('Candidate 0');
});

it('review I2 reuses an omitted suffix proven by keyboard movement in the revealed fill', async () => {
  const h = await demandFixture(49_000, 1_000);
  await h.completed();
  const input = expectDefined(h.handle.element.querySelector<HTMLInputElement>('input'));
  input.dispatchEvent(new h.owner.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await h.completed();
  const active = h.owner.doc.getElementById(input.getAttribute('aria-activedescendant') ?? '');
  expect(active?.textContent).toContain('Candidate 999');
  const omittedVisits = h.visits.filter((offset) => offset >= 1_000);
  expect(omittedVisits).toHaveLength(49_000);
  expect(new Set(omittedVisits).size).toBe(49_000);
  expect(h.session.readRange.mock.calls.every(([, limit]) => limit <= 200)).toBe(true);
  expect(h.replacements).toHaveBeenCalledTimes(3);
  expect(h.orders.mock.calls.slice(1)).toHaveLength(2);
  expect(h.list.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  expect(h.writes).toEqual([]);
  expect(h.creates).toEqual([]);
});

it('review I2 rejects late omission proofs from a cancelled movement read', async () => {
  const h = await demandFixture(49_000, 1_000);
  await h.completed();
  const input = expectDefined(h.handle.element.querySelector<HTMLInputElement>('input'));
  const key = (key: string) =>
    input.dispatchEvent(new h.owner.win.KeyboardEvent('keydown', { key, bubbles: true }));
  const held = deferred<void>();
  let holding = true;
  h.hold(async (offset) => {
    if (holding && offset === 49_800) {
      holding = false;
      await held.promise;
    }
  });
  key('End');
  key('Enter');
  await vi.waitFor(() => {
    expect(h.session.readRange).toHaveBeenCalledTimes(2);
  });
  const signal = expectDefined(h.session.readRange.mock.calls[1]?.[2]);
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  expect(signal.aborted).toBe(true);
  await h.completed();
  const replacementCount = h.replacements.mock.calls.length;
  held.resolve();
  await flushMicrotasks(50);
  h.owner.flush();
  expect(h.replacements).toHaveBeenCalledTimes(replacementCount);
  expect(h.handle.element.dataset['searchPhase']).toBe('complete');
  expect(h.visits.filter((offset) => offset === 49_800)).toHaveLength(1);
  key('End');
  await h.completed();
  const active = h.owner.doc.getElementById(input.getAttribute('aria-activedescendant') ?? '');
  expect(active?.textContent).toContain('Candidate 999');
  // The cancelled response is not proof; the next current movement must read it again.
  expect(h.visits.filter((offset) => offset === 49_800)).toHaveLength(2);
  expect(h.session.readRange.mock.calls.every(([, limit]) => limit <= 200)).toBe(true);
  expect(h.writes).toEqual([]);
  expect(h.creates).toEqual([]);
});

it('review I2 skips existing interior omission proofs in later keyboard intervals', async () => {
  const h = await demandFixture(100, 49_850);
  const list = h.list;
  await h.completed();
  list.scrollTop = 49_860 * 48;
  h.list.dispatchEvent(new h.owner.win.Event('scroll'));
  h.owner.flush();
  await flushMicrotasks(2);
  await h.completed();
  const omittedVisits = () => h.visits.filter((offset) => offset >= 49_850 && offset < 49_950);
  expect(omittedVisits()).toHaveLength(100);
  const input = expectDefined(h.handle.element.querySelector<HTMLInputElement>('input'));
  const key = (key: string) =>
    input.dispatchEvent(new h.owner.win.KeyboardEvent('keydown', { key, bubbles: true }));
  key('Home');
  await h.completed();
  key('End');
  await h.completed();
  const active = h.owner.doc.getElementById(input.getAttribute('aria-activedescendant') ?? '');
  expect(active?.textContent).toContain('Candidate 49999');
  expect(omittedVisits()).toHaveLength(100);
});

// Empty native buttons and hydrated labels do not have the same height. The real
// surface must reconcile their measurements; jsdom supplies only layout and scroll delivery.
async function nativeEndFixture(
  emptyHeight: number,
  lifetime: AbortController,
  runnerSignal: AbortSignal,
) {
  const abort = () => {
    lifetime.abort(runnerSignal.reason);
  };
  runnerSignal.addEventListener('abort', abort, { once: true });
  cleanup.push(() => {
    runnerSignal.removeEventListener('abort', abort);
  });
  if (runnerSignal.aborted) abort();
  lifetime.signal.throwIfAborted();
  const candidates = Array.from(
    { length: 75 },
    (_, i) =>
      `- [ ] NativeResumeCandidate${String(i).padStart(3, '0')} prose 🆔 c${i}${i === 74 ? ' ⛔ current' : ''}`,
  ).join('\n');
  const h = await fixture(
    0,
    'blocked-by',
    {
      'tasks.md': `- [ ] Root 🆔 root\n    - [ ] Current 🆔 current\n${candidates}`,
    },
    lifetime.signal,
  );
  lifetime.signal.throwIfAborted();
  h.setCurrent(
    expectDefined(h.index.listNodes().find((task) => task.node.title === 'Current')).target,
  );
  const owner = taskViewportOwner();
  cleanup.push(() => {
    owner.destroy();
  });
  h.callbacks.position = (element) => {
    positionDemandSurface(element, owner, 288, (row) => {
      if (row.childElementCount === 0) return emptyHeight;
      return row.querySelector('.abyss-dep-search-reason') === null ? 42.515625 : 58.5;
    });
  };
  let holdProjection: ((signal: AbortSignal) => Promise<void>) | undefined;
  const open = h.callbacks.provider.open.bind(h.callbacks.provider);
  h.callbacks.provider.open = async (...args) => {
    const session = await open(...args);
    const options = session.options.bind(session);
    session.options = async (candidates, signal) => {
      const result = await options(candidates, signal);
      if (candidates.some((candidate) => candidate.offset === 73)) await holdProjection?.(signal);
      return result;
    };
    return session;
  };
  const opens = vi.spyOn(h.search, 'open');
  const reads = vi.spyOn(h.search, 'read');
  const ui = h.mount();
  const list = expectDefined(
    ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-results'),
  );
  let top = 0;
  let scrolled = false;
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const extent = Array.from(list.children).reduce(
        (sum, child) =>
          sum +
          (child.classList.contains('abyss-virtual-row-spacer')
            ? Number.parseFloat(
                (child as HTMLElement).style.getPropertyValue('--abyss-virtual-row-height'),
              )
            : child.getBoundingClientRect().height),
        0,
      );
      const next = Math.max(0, Math.min(value, extent - list.clientHeight));
      scrolled ||= next !== top;
      top = next;
    },
  });
  const scheduler = browserScheduler.createBrowserTaskScheduler(owner.win);
  let generation: number | undefined;
  const unsubscribe = h.search.subscribe((state) => {
    generation = state.generation;
  });
  cleanup.push(unsubscribe);
  let stage = 'initial';
  let driving = false;
  let stopped = false;
  const stopCallbacks: Array<() => void> = [];
  const receipt = () => ({
    stage,
    request: ui.handle.element.dataset['searchRequest'],
    expectedGeneration: generation,
    actualGeneration: ui.handle.element.dataset['searchGeneration'],
    phase: ui.handle.element.dataset['searchPhase'],
    frames: owner.frames.size,
    scrolled,
    top,
    active: ui.active()?.getAttribute('aria-posinset') ?? null,
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (driving) console.error('native End driver abort', receipt());
    lifetime.abort();
    for (const callback of stopCallbacks.splice(0)) callback();
  };
  lifetime.signal.addEventListener('abort', stop, { once: true });
  // Last registration runs first, before the fixture's DOM/search teardown.
  cleanup.push(stop);
  const turn = async () => {
    lifetime.signal.throwIfAborted();
    // Native scroll events run before animation-frame callbacks, after the setter's task.
    if (scrolled) {
      scrolled = false;
      list.dispatchEvent(new owner.win.Event('scroll'));
    }
    owner.flush();
    await scheduler.delay(30, lifetime.signal);
    lifetime.signal.throwIfAborted();
  };
  const finishDrive = () => {
    driving = false;
  };
  const driveUntil = async (nextStage: string, ready: () => boolean) => {
    if (driving) throw new Error('Concurrent native End driver');
    stage = nextStage;
    driving = true;
    try {
      for (;;) {
        lifetime.signal.throwIfAborted();
        if (ui.handle.element.dataset['searchPhase'] === 'error')
          throw new Error('Native End picker error');
        await turn();
        lifetime.signal.throwIfAborted();
        if (ui.handle.element.dataset['searchPhase'] === 'error')
          throw new Error('Native End picker error');
        if (ready()) return;
      }
    } catch (error) {
      if (!stopped) console.error('native End driver error', receipt());
      throw error;
    } finally {
      finishDrive();
    }
  };
  const settle = (nextStage: string) =>
    driveUntil(
      nextStage,
      () =>
        ui.handle.element.dataset['searchPhase'] === 'complete' &&
        ui.handle.element.dataset['searchGeneration'] === String(generation) &&
        owner.frames.size === 0 &&
        !scrolled,
    );
  ui.query('NativeResumeCandidate');
  await settle('initial');
  return {
    ...h,
    ui,
    list,
    owner,
    opens,
    reads,
    turn,
    settle,
    driveUntil,
    stop,
    onStop: (callback: () => void) => {
      if (stopped) callback();
      else stopCallbacks.push(callback);
    },
    hold: (callback: (signal: AbortSignal) => Promise<void>) => {
      holdProjection = callback;
    },
  };
}

it.for([10, 25.59375])(
  'native End retains Candidate073 after %ipx holders become measured labels',
  async (emptyHeight, { signal, onTestFinished }) => {
    const lifetime = new AbortController();
    onTestFinished(() => {
      lifetime.abort();
    });
    const h = await nativeEndFixture(emptyHeight, lifetime, signal);
    const { ui, owner, list } = h;
    for (const width of [322, 282]) {
      Object.defineProperty(list, 'clientWidth', { configurable: true, value: width });
      owner.win.dispatchEvent(new owner.win.Event('resize'));
      await h.settle(`resize-${width}`);
    }
    const request = ui.handle.element.dataset['searchRequest'];
    const generation = ui.handle.element.dataset['searchGeneration'];
    // The second End remounts rows whose hydrated heights were measured on the first visit.
    for (let visit = 0; visit < 2; visit++) {
      ui.key('Home');
      await h.settle(`home-${visit + 1}`);
      expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(
        'NativeResumeCandidate000 prose',
      );
      ui.key('End');
      ui.key('Enter');
      ui.handle.refresh();
      await h.settle(`end-${visit + 1}`);
      expect(ui.handle.element.dataset['searchRequest']).toBe(request);
      expect(ui.handle.element.dataset['searchGeneration']).toBe(generation);
      expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(
        'NativeResumeCandidate073 prose',
      );
      const active = expectDefined(ui.active());
      expect(active.getAttribute('aria-posinset')).toBe('74');
      expect(active.getAttribute('aria-disabled')).toBe('false');
      expect(active.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(active.getBoundingClientRect().bottom).toBeLessThanOrEqual(list.clientHeight);
      expect(ui.handle.element.querySelector<HTMLElement>('.abyss-dep-search-error')?.hidden).toBe(
        true,
      );
      expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(25);
    }
    expect(h.opens).toHaveBeenCalledOnce();
    expect(h.reads.mock.calls.every(([, , limit]) => limit <= 200)).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
    ui.key('Enter');
    await h.driveUntil('commit', () => h.writes.length === 1);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.title).toBe('NativeResumeCandidate073 prose');
  },
);

it.for(['scroll', 'query', 'source', 'current'] as const)(
  'native End cancels pinned label publication on %s',
  async (change, { signal: runnerSignal, onTestFinished }) => {
    const lifetime = new AbortController();
    onTestFinished(() => {
      lifetime.abort();
    });
    const h = await nativeEndFixture(10, lifetime, runnerSignal);
    const held = deferred<void>();
    let signal: AbortSignal | undefined;
    h.hold(async (pending) => {
      signal = pending;
      await held.promise;
    });
    h.onStop(() => {
      held.resolve();
    });
    try {
      h.ui.key('End');
      await h.driveUntil('held-labels', () => signal !== undefined);
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      h.ui.key('Enter');
      switch (change) {
        case 'scroll':
          h.list.scrollTop = 0;
          h.list.dispatchEvent(new h.owner.win.Event('scroll'));
          break;
        case 'query':
          h.ui.query('NativeResumeCandidate000');
          break;
        case 'source':
          h.index.installCommittedContent('other.md', '- [ ] Other');
          break;
        case 'current':
          h.setCurrent(
            expectDefined(h.index.listNodes().find((task) => task.node.title === 'Root')).target,
          );
          h.ui.handle.refresh();
          break;
      }
      await h.driveUntil(`cancel-${change}`, () => signal?.aborted === true);
      expect(signal?.aborted).toBe(true);
      held.resolve();
      await h.settle(`after-cancel-${change}`);
      expect(h.writes).toEqual([]);
      expect(h.creates).toEqual([]);
      expect(h.ui.active()).toBeNull();
      if (change === 'scroll') expect(h.list.scrollTop).toBe(0);
      h.ui.key('Home');
      await h.settle('recovery-home');
      expect(h.ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(
        'NativeResumeCandidate000 prose',
      );
    } finally {
      held.resolve();
    }
  },
);

it('native End driver crosses the former cutoff without resubmitting held movement', async ({
  signal,
  onTestFinished,
}) => {
  const lifetime = new AbortController();
  onTestFinished(() => {
    lifetime.abort();
  });
  const h = await nativeEndFixture(10, lifetime, signal);
  const held = deferred<void>();
  let entered = false;
  h.hold(async () => {
    entered = true;
    await held.promise;
  });
  try {
    h.ui.key('End');
    await h.driveUntil('held-labels', () => entered);
    const opens = h.opens.mock.calls.length;
    const request = h.ui.handle.element.dataset['searchRequest'];
    vi.useFakeTimers();
    let completed = false;
    const pending = h.settle('beyond-cutoff').then(() => {
      completed = true;
    });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_050);
    expect(completed).toBe(false);
    held.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(await outcome).toBeUndefined();
    expect(completed).toBe(true);
    expect(h.opens).toHaveBeenCalledTimes(opens);
    expect(h.ui.handle.element.dataset['searchRequest']).toBe(request);
    expect(h.ui.handle.element.dataset['searchPhase']).toBe('complete');
    expect(h.list.querySelectorAll('.abyss-dep-search-title').length).toBeGreaterThan(0);
  } finally {
    held.resolve();
    h.stop();
    vi.useRealTimers();
  }
});

it('native End driver drains queued geometry and refuses a stale complete generation', async ({
  signal,
  onTestFinished,
}) => {
  const lifetime = new AbortController();
  onTestFinished(() => {
    lifetime.abort();
  });
  const h = await nativeEndFixture(10, lifetime, signal);
  const generation = h.ui.handle.element.dataset['searchGeneration'];
  vi.useFakeTimers();
  try {
    const delivered: string[] = [];
    h.owner.win.requestAnimationFrame(() => {
      delivered.push('frame');
      h.owner.win.requestAnimationFrame(() => {
        delivered.push('next-frame');
      });
    });
    let completed = false;
    const pending = h.settle('queued-stale').then(() => {
      completed = true;
    });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(completed).toBe(false);
    expect(h.ui.handle.element.dataset['searchPhase']).toBe('complete');
    h.ui.handle.element.setAttribute('data-search-generation', '-1');
    await vi.advanceTimersByTimeAsync(300);
    expect(delivered).toEqual(['frame', 'next-frame']);
    expect(delivered).toContain('next-frame');
    expect(completed).toBe(false);
    h.ui.handle.element.setAttribute('data-search-generation', expectDefined(generation));
    await vi.advanceTimersByTimeAsync(60);
    expect(await outcome).toBeUndefined();
    expect(completed).toBe(true);
  } finally {
    h.stop();
    vi.useRealTimers();
  }
});

it('native End driver abort cancels its owner timer and prevents post-disposal delivery', async ({
  signal,
  onTestFinished,
}) => {
  const lifetime = new AbortController();
  onTestFinished(() => {
    lifetime.abort();
  });
  const h = await nativeEndFixture(10, lifetime, signal);
  vi.useFakeTimers();
  try {
    const pending = h.driveUntil('cancel-timer', () => false);
    const rejection = expect(pending).rejects.toThrow();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
    const delivered: string[] = [];
    h.list.addEventListener('scroll', () => {
      delivered.push('scroll');
    });
    h.list.scrollTop = 20;
    h.owner.win.requestAnimationFrame(() => {
      delivered.push('frame');
    });
    h.ui.handle.destroy();
    h.owner.destroy();
    h.stop();
    await vi.advanceTimersByTimeAsync(300);
    await rejection;
    expect(delivered).toEqual([]);
  } finally {
    h.stop();
    vi.useRealTimers();
  }
});

it('native End driver rejects explicit failure while held and releases the late gate', async ({
  signal,
  onTestFinished,
}) => {
  const lifetime = new AbortController();
  onTestFinished(() => {
    lifetime.abort();
  });
  const h = await nativeEndFixture(10, lifetime, signal);
  const held = deferred<void>();
  let entered = false;
  let exited = false;
  h.hold(async () => {
    entered = true;
    await held.promise;
    exited = true;
  });
  h.onStop(() => {
    held.resolve();
  });
  try {
    h.ui.key('End');
    await h.driveUntil('held-labels', () => entered);
    h.ui.key('Enter');
    h.ui.handle.element.dataset['searchPhase'] = 'error';
    await expect(h.settle('held-failure')).rejects.toThrow();
  } finally {
    h.stop();
    h.ui.handle.destroy();
  }
  await Promise.resolve();
  expect(h.ui.active()).toBeNull();
  expect(exited).toBe(true);
  expect(h.writes).toEqual([]);
  expect(h.creates).toEqual([]);
});

it('native End setup cancellation closes the late real owner without reacquiring after row cleanup', async () => {
  const acquired = deferred<Awaited<ReturnType<typeof createCanonicalSearchHarness>>>();
  const gate = deferred<void>();
  const real = harnessModule.createCanonicalSearchHarness;
  let setupSignal: AbortSignal | undefined;
  const harness = vi
    .spyOn(harnessModule, 'createCanonicalSearchHarness')
    .mockImplementation(async (...args) => {
      setupSignal = args[6];
      const h = await real(...args);
      acquired.resolve(h);
      await gate.promise;
      return h;
    });
  const runner = new AbortController();
  const lifetime = new AbortController();
  const firstCleanup = cleanup.length;
  const drainRow = () => {
    cleanup
      .splice(firstCleanup)
      .reverse()
      .forEach((close) => {
        close();
      });
  };
  const cancelled = new Error('Controlled setup cancellation');
  const result = nativeEndFixture(10, lifetime, runner.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  let owner: Awaited<ReturnType<typeof createCanonicalSearchHarness>> | undefined;
  try {
    owner = await acquired.promise;
    runner.abort(cancelled);
    drainRow();
    gate.resolve();
    expect(await result).toBe(cancelled);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(activeDocument.querySelectorAll('.abyss-dep-search')).toHaveLength(0);
    expect(cleanup).toHaveLength(firstCleanup);
    expect(setupSignal).toBe(lifetime.signal);
    const snapshot = owner.source.subscribe(() => {});
    try {
      expect(snapshot.state.type).toBe('disposed');
    } finally {
      snapshot.unsubscribe();
    }
    let phase: string | undefined;
    const unsubscribe = owner.search.subscribe((state) => {
      phase = state.phase;
    });
    try {
      expect(phase).toBe('disposed');
    } finally {
      unsubscribe();
    }
  } finally {
    lifetime.abort();
    gate.resolve();
    await result;
    drainRow();
    owner?.close();
    harness.mockRestore();
  }
});

it.each(['blocks', 'blocked-by'] as const)(
  'marks typo and swap matches in %s picker labels while preserving literal paths',
  async (direction) => {
    const h = await fixture(1, direction, {
      'a-current.md': '- [ ] Current 🆔 current',
      'budget_[literal]:note.md': '- [ ] **Budget** [[Target|ledger]] task 1 🆔 candidate',
    });
    const ui = h.mount();
    for (const query of ['budgte', 'budgwt']) {
      ui.query(query);
      await ui.completed();
      const option = expectDefined(ui.handle.element.querySelector('[role="option"]'));
      expect(option.querySelector('.abyss-dep-search-title mark')?.textContent).toBe('Budget');
      expect(option.querySelector('.abyss-dep-search-context mark')?.textContent).toBe('budget_');
      expect(option.querySelector('.abyss-dep-search-context')?.textContent).toBe(
        'budget_[literal]:note.md:1',
      );
    }
    ui.query('taks');
    await ui.completed();
    expect(ui.handle.element.querySelector('.abyss-dep-search-title mark')?.textContent).toBe(
      'task',
    );
    ui.query('1');
    await ui.completed();
    expect(ui.handle.element.querySelector('.abyss-dep-search-title mark')?.textContent).toBe('1');
    expect(ui.handle.element.querySelector('.abyss-dep-search-context mark')).toBeNull();
    ui.query('ledger');
    await ui.completed();
    expect(ui.handle.element.querySelector('.abyss-dep-search-title mark')?.textContent).toBe(
      'ledger',
    );
    expect(ui.handle.element.querySelector('.abyss-dep-search-context mark')).toBeNull();
    ui.query('');
    await ui.completed();
    expect(ui.handle.element.querySelector('mark')).toBeNull();
  },
);
