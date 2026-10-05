import { Notice, Scope } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TaskSearchError, type DependencyDirection, type TaskNodeRef } from '../src/tasks';
import {
  mountDependencySearch,
  rejectionLabel,
  type DependencyPickerCommitResult,
} from '../src/ui/dependencySearch';
import { createTaskDependencySearchProvider } from '../src/ui/TaskDependencySearchProvider';
import { deferred, dispatchImeKey, expectDefined, flushMicrotasks } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';

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
) {
  const candidates = Array.from({ length: count }, (_, i) => `- [ ] Candidate ${i} 🆔 c${i}`).join(
    '\n',
  );
  const h = await createCanonicalSearchHarness(
    files ?? {
      'tasks.md': `- [ ] Current 🆔 current\n${candidates}`,
    },
    DEFAULT_SETTINGS,
  );
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
  const mount = () => {
    const handle = mountDependencySearch(activeDocument.body, callbacks);
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
      return id === null ? null : activeDocument.getElementById(id);
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
it('paints and focuses the shell before a held real page and never creates while pending', async () => {
  const h = await fixture();
  const held = deferred<void>();
  const original = h.callbacks.provider.open.bind(h.callbacks.provider);
  h.callbacks.provider.open = async (...args) => {
    const session = await original(...args);
    const page = session.page.bind(session);
    session.page = async (...read) => {
      await held.promise;
      return page(...read);
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
  expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(30);
});
it('bounds mounted options, crosses Arrow boundaries and returns from the final page on one cursor', async () => {
  const h = await fixture();
  const open = vi.spyOn(h.search, 'open');
  const ui = h.mount();
  ui.query('Candidate');
  await ui.completed();
  ui.key('End');
  expect(ui.active()?.textContent).toContain('Candidate 29');
  expect(ui.active()?.getAttribute('aria-posinset')).toBe('30');
  expect(ui.active()?.getAttribute('aria-setsize')).toBe('65');
  ui.key('ArrowDown');
  expect(ui.active()).toBeNull();
  await ui.completed();
  expect(ui.active()?.textContent).toContain('Candidate 30');
  ui.key('ArrowUp');
  await ui.completed();
  expect(ui.active()?.textContent).toContain('Candidate 29');
  ui.key('ArrowDown');
  await ui.completed();
  ui.key('End');
  ui.key('ArrowDown');
  await ui.completed();
  expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(5);
  ui.key('End');
  expect(ui.active()?.textContent).toContain('Candidate 64');
  expectDefined(
    ui.handle.element.querySelector<HTMLButtonElement>('[aria-label="Previous page"]'),
  ).click();
  await ui.completed();
  expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(30);
  ui.key('Home');
  expect(ui.active()?.textContent).toContain('Candidate 30');
  expect(open).toHaveBeenCalledTimes(1);
});
it.each([
  ['Next', 'pager'],
  ['Previous', 'pager'],
  ['Next', 'direction'],
  ['Previous', 'direction'],
] as const)('preserves focus while replacing a %s page (focus=%s)', async (label, focus) => {
  const h = await fixture();
  const held = deferred<void>();
  let hold = false;
  const original = h.callbacks.provider.open.bind(h.callbacks.provider);
  h.callbacks.provider.open = async (...args) => {
    const session = await original(...args);
    const page = session.page.bind(session);
    session.page = async (...args) => {
      if (hold) await held.promise;
      return page(...args);
    };
    return session;
  };
  const ui = h.mount();
  try {
    ui.query('  Candidate  ');
    await ui.completed();
    const pager = (name: string) =>
      expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>(`[aria-label="${name} page"]`),
      );
    if (label === 'Previous') {
      pager('Next').click();
      await ui.completed();
    }
    ui.key('Home');
    const selected = ui.active()?.textContent;
    const control = pager(label);
    const focused =
      focus === 'pager'
        ? control
        : expectDefined(
            ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
          );
    focused.focus();
    expect(activeDocument.activeElement).toBe(focused);
    hold = true;
    control.click();
    const retained = focus === 'pager' ? ui.input : focused;
    expect(control.isConnected).toBe(false);
    expect(retained.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(retained);
    expect(ui.input.value).toBe('  Candidate  ');
    expect(ui.active()).toBeNull();
    expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(0);
    held.resolve();
    await ui.completed();
    expect(activeDocument.activeElement).toBe(retained);
    expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(30);
    expect(pager('Previous').disabled).toBe(label === 'Previous');
    expect(pager('Next').disabled).toBe(false);
    expect(ui.active()).toBeNull();
    pager(label === 'Next' ? 'Previous' : 'Next').click();
    await ui.completed();
    expect(ui.active()?.textContent).toBe(selected);
    expect(h.writes).toEqual([]);
    expect(h.creates).toEqual([]);
  } finally {
    held.resolve();
  }
});

it.each(['pager', 'direction', 'outside'] as const)(
  'preserves focus across source publication (focus=%s)',
  async (focus) => {
    const h = await fixture();
    const ui = h.mount();
    ui.query('  Candidate  ');
    await ui.completed();
    const pager = expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('[aria-label="Next page"]'),
    );
    let focused: HTMLElement = pager;
    if (focus === 'direction')
      focused = expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
      );
    else if (focus === 'outside') focused = activeDocument.body.createEl('input');
    focused.focus();
    expect(activeDocument.activeElement).toBe(focused);
    h.index.installCommittedContent('other.md', '- [ ] Other');
    const retained = focus === 'pager' ? ui.input : focused;
    expect(retained.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(retained);
    expect(pager.isConnected).toBe(false);
    if (focus === 'outside') {
      await flushMicrotasks(30);
      expect(ui.handle.element.isConnected).toBe(false);
    } else {
      await ui.completed();
      expect(ui.input.value).toBe('  Candidate  ');
      expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(30);
    }
    expect(activeDocument.activeElement).toBe(retained);
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
    // The first hydration after Enter is the exact fresh selection; success also opens a new browse page.
    expect(resolve.mock.calls[0]?.[0]).toHaveLength(1);
    expect(resolve.mock.calls[0]?.[0]).toHaveLength(1);
    expect(h.creates).toEqual([]);
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
  expect(ui.active()?.textContent).toContain('Candidate 29');
  expect(h.creates).toEqual([]);
});
it('browses compact source readiness without a backend and uses raw positions after omitted self', async () => {
  const h = await fixture(35);
  const ui = h.mount();
  await ui.completed();
  expect(h.backends).toHaveLength(0);
  expect(ui.handle.element.querySelectorAll('[role="option"]')).toHaveLength(30);
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
    const lost = ['disabled', 'disappeared'].includes(change);
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
  ui.query('owned');
  await ui.completed();
  expect(ui.handle.element.querySelector('[role="option"]')?.textContent).toContain('Candidate');
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

it.each([
  ['disabled', 'ArrowDown', 'blocks'],
  ['disabled', 'ArrowUp', 'blocks'],
  ['omitted', 'ArrowDown', 'blocks'],
  ['omitted', 'ArrowUp', 'blocks'],
  ['disabled', 'ArrowDown', 'blocked-by'],
  ['disabled', 'ArrowUp', 'blocked-by'],
  ['omitted', 'ArrowDown', 'blocked-by'],
  ['omitted', 'ArrowUp', 'blocked-by'],
] as const)('preserves selected intent on a %s page via %s (%s)', async (kind, key, direction) => {
  const h = await fixture(0, direction, gapFiles(kind, direction));
  const ui = h.mount();
  const enterGap = async () => {
    const writeCount = h.writes.length;
    ui.query('  Candidate  ');
    await ui.completed();
    if (key === 'ArrowUp') {
      for (let page = 0; page < 2; page++) {
        expectDefined(
          ui.handle.element.querySelector<HTMLButtonElement>('[aria-label="Next page"]'),
        ).click();
        await ui.completed();
      }
    }
    ui.key(key === 'ArrowDown' ? 'End' : 'Home');
    expect(ui.active()).not.toBeNull();
    ui.key(key);
    expect(ui.active()).toBeNull();
    await ui.completed();
    const options = ui.handle.element.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(options).toHaveLength(kind === 'disabled' ? 30 : 0);
    for (const option of options) {
      expect(option.disabled).toBe(true);
      expect(option.getAttribute('aria-disabled')).toBe('true');
      expect(option.textContent).toContain('Would create a cycle');
    }
    if (kind === 'omitted')
      expect(ui.handle.element.textContent).toContain('More matches available');
    expect(ui.active()).toBeNull();
    ui.key('Enter');
    await flushMicrotasks(30);
    expect(h.creates).toEqual([]);
    expect(h.writes).toHaveLength(writeCount);
    expect(ui.handle.element.textContent).toContain('Task changed');
  };
  await enterGap();
  ui.key(key);
  await ui.completed();
  const afterGap = kind === 'disabled' ? 'Candidate 060' : 'Candidate 120';
  const title = key === 'ArrowUp' ? 'Candidate 029' : afterGap;
  expect(ui.active()?.querySelector('.abyss-dep-search-title')?.textContent).toBe(title);
  ui.key('Enter');
  await vi.waitFor(() => {
    expect(h.writes).toHaveLength(1);
  });
  expect(h.writes[0]).toEqual({
    title,
    direction,
    target: expectDefined(h.index.listNodes().find(({ node }) => node.title === title)).target,
  });
  expect(h.creates).toEqual([]);
  await ui.completed();
  await enterGap();
  expectDefined(
    ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
  ).click();
  await vi.waitFor(() => {
    expect(h.creates).toEqual([['  Candidate  ', direction]]);
  });
  expect(h.writes).toHaveLength(1);
});

it.each([false, true])(
  'keeps pager bounds through command busy and replacement (replace=%s)',
  async (replace) => {
    const h = await fixture(31);
    const command = deferred<DependencyPickerCommitResult>();
    h.callbacks.createNew = () => command.promise;
    const ui = h.mount();
    ui.query('Candidate');
    await ui.completed();
    const pager = (label: string) =>
      expectDefined(
        ui.handle.element.querySelector<HTMLButtonElement>(`[aria-label="${label} page"]`),
      );
    const bounds = (previous: boolean, next: boolean) => {
      expect(pager('Previous').disabled).toBe(previous);
      expect(pager('Next').disabled).toBe(next);
      expect(pager('Previous').getAttribute('aria-disabled')).toBe(String(previous));
      expect(pager('Next').getAttribute('aria-disabled')).toBe(String(next));
    };
    bounds(true, false);
    pager('Next').click();
    await ui.completed();
    bounds(false, true);
    expectDefined(
      ui.handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
    ).click();
    expect(pager('Previous').disabled).toBe(true);
    expect(pager('Next').disabled).toBe(true);
    if (replace) {
      h.index.installCommittedContent('other.md', '- [ ] Other');
      await ui.completed();
      expect(pager('Previous').disabled).toBe(true);
      expect(pager('Next').disabled).toBe(true);
    }
    command.resolve({ type: 'validation-error', message: 'Keep draft' });
    await vi.waitFor(() => {
      expect(ui.input.readOnly).toBe(false);
    });
    bounds(replace, !replace);
    pager(replace ? 'Next' : 'Previous').click();
    await ui.completed();
    bounds(!replace, replace);
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
  const event = () => new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
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
  handle.element.focus();
  const nextEscape = expectDefined(register.mock.calls[register.mock.calls.length - 1])[2];
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
    new KeyboardEvent('keydown', { code: 'KeyF', key: 'а', ctrlKey: true, cancelable: true });
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
