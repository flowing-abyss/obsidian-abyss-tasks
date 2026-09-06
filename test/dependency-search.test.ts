import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTaskDependencyGraph, enumerateTaskNodes } from '../src/tasks/domain/taskDependencies';
import { dependencySearchOptions, mountDependencySearch } from '../src/ui/dependencySearch';
import { canonicalStatusCatalog, deferred, expectDefined, flushMicrotasks, task } from './helpers';

afterEach(() => {
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

function fixture() {
  const current = task({
    title: 'Current',
    dependencyId: 'current',
    dependsOn: ['previous'],
    source: { filePath: 'Project.md', line: 3 },
  });
  const roots = [
    current,
    task({
      title: 'Previous',
      dependencyId: 'previous',
      dependsOn: ['distant'],
      source: { filePath: 'A.md' },
    }),
    task({ title: 'Distant', dependencyId: 'distant', source: { filePath: 'B.md' } }),
    task({
      title: 'Local candidate',
      description: 'Do not search this description',
      source: { filePath: 'Project.md', line: 7 },
    }),
    task({ title: 'Other candidate', source: { filePath: 'C.md' } }),
  ];
  const tasks = enumerateTaskNodes(roots);
  const graph = buildTaskDependencyGraph(tasks, (symbol) =>
    canonicalStatusCatalog().statusForSymbol(symbol),
  );
  return {
    current: { type: 'task' as const, ref: current.ref },
    tasks,
    eligibility: graph.eligibility.bind(graph),
  };
}

describe('dependency search options', () => {
  it('distinguishes equal titles in the same note using existing source line context', () => {
    const { current } = fixture();
    const tasks = enumerateTaskNodes([
      task({ title: 'Repeated', source: { filePath: 'Project.md', line: 0 } }),
      task({ title: 'Repeated', source: { filePath: 'Project.md', line: 8 } }),
    ]);
    const options = dependencySearchOptions({
      current,
      tasks,
      query: 'Repeated',
      eligibility: () => ({ type: 'allowed' }),
    });
    expect(options.map(({ context }) => context)).toEqual(['Project.md:1', 'Project.md:9']);
  });

  it('ranks same-file nodes first and otherwise retains canonical order with both eligible directions', () => {
    const options = dependencySearchOptions({ ...fixture(), query: 'candidate' });
    expect(
      options.map(({ title, context, directions }) => ({ title, context, directions })),
    ).toEqual([
      { title: 'Local candidate', context: 'Project.md', directions: ['blocked-by', 'blocks'] },
      { title: 'Other candidate', context: 'C.md', directions: ['blocked-by', 'blocks'] },
    ]);
  });

  it('excludes self and direct duplicate/inverse pairs and disables a cycle in scoped results', () => {
    const options = dependencySearchOptions({ ...fixture(), query: '', direction: 'blocks' });
    expect(options.some(({ title }) => title === 'Current' || title === 'Previous')).toBe(false);
    expect(options.find(({ title }) => title === 'Distant')).toMatchObject({
      directions: [],
      disabledReason: 'Would create a cycle',
    });
    expect(options.find(({ title }) => title === 'Local candidate')?.directions).toEqual([
      'blocks',
    ]);
  });

  it('matches note context and title, never descriptions', () => {
    expect(
      dependencySearchOptions({ ...fixture(), query: 'project.md' }).map(({ title }) => title),
    ).toEqual(['Local candidate']);
    expect(dependencySearchOptions({ ...fixture(), query: 'Do not search' })).toEqual([]);
  });

  it.each([
    ['ambiguous', 'Multiple tasks use this ID'],
    ['unavailable', 'Task unavailable'],
    ['stale', 'Task changed'],
  ] as const)('disables %s candidates with a concise reason', (reason, disabledReason) => {
    const options = dependencySearchOptions({
      ...fixture(),
      query: 'Local',
      eligibility: () => ({ type: 'rejected', reason }),
    });
    expect(options[0]).toMatchObject({ directions: [], disabledReason });
  });
});

describe('dependency search keyboard controller', () => {
  it('shows the general direction before submission and recomputes options when it changes', () => {
    const seenDirections: string[] = [];
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (_query, direction) => {
        seenDirections.push(direction);
        return dependencySearchOptions({ ...fixture(), query: 'Distant', direction });
      },
      selectExisting: async () => ({ type: 'failed' }),
      createNew: async () => ({ type: 'failed' }),
      onClose: () => {},
    });

    const directions = handle.element.querySelectorAll<HTMLButtonElement>('[data-direction]');
    expect([...directions].map((button) => button.dataset['direction'])).toEqual([
      'blocked-by',
      'blocks',
    ]);
    expect(directions[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(directions[1]?.getAttribute('aria-pressed')).toBe('false');
    expect(seenDirections).toEqual(['blocked-by']);
    expect(handle.element.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(
      false,
    );

    directions[1]?.click();

    expect(directions[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(directions[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(seenDirections).toEqual(['blocked-by', 'blocks']);
    const option = expectDefined(
      handle.element.querySelector<HTMLButtonElement>('[role="option"]'),
    );
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain('Would create a cycle');
    handle.destroy();
  });

  it('fixes a section picker direction and omits the direction selector', async () => {
    const writes: string[] = [];
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocks',
      canChangeDirection: false,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async (option, direction) => {
        writes.push(`${option.title}:${direction}`);
        return { type: 'committed' };
      },
      createNew: async () => ({ type: 'failed' }),
      onClose: () => {},
    });
    expect(handle.element.querySelector('[aria-label="Dependency direction"]')).toBeNull();
    expect(handle.element.getAttribute('aria-label')).toBe('Add dependency: Blocks');
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Local';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(writes).toEqual(['Local candidate:blocks']);
    expect(handle.element.isConnected).toBe(false);
  });

  it('releases controller ownership and document listeners only once when destroyed repeatedly', () => {
    const release = vi.fn();
    const remove = vi.spyOn(activeDocument, 'removeEventListener');
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: () => [],
      selectExisting: async () => ({ type: 'failed' }),
      createNew: async () => ({ type: 'failed' }),
      onClose: () => {},
      ownership: { acquire: () => ({ release }) },
    });
    handle.destroy();
    handle.destroy();
    handle.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.filter(([type]) => type === 'focusin')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(1);
  });

  it('clears explicit result selection when the user types and keeps no implicit active option', () => {
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async () => ({ type: 'failed' }),
      createNew: async () => ({ type: 'failed' }),
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(input.getAttribute('aria-activedescendant')).not.toBeNull();
    input.value = 'Local';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(handle.element.querySelector('[aria-selected="true"]')).toBeNull();
    handle.destroy();
  });

  it('does not transfer explicit selection to another task after a reactive refresh', async () => {
    const submissions: string[] = [];
    let hideLocal = false;
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => {
        const options = dependencySearchOptions({ ...fixture(), query, direction });
        return hideLocal ? options.filter(({ title }) => title !== 'Local candidate') : options;
      },
      selectExisting: async (option) => {
        submissions.push(`existing:${option.title}`);
        return { type: 'committed' };
      },
      createNew: async (text) => {
        submissions.push(`new:${text}`);
        return { type: 'committed' };
      },
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'candidate';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(handle.element.querySelector('[aria-selected="true"]')?.textContent).toContain(
      'Local candidate',
    );

    hideLocal = true;
    handle.refresh();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(submissions).toEqual([]);
    expect(
      handle.element.querySelector('.abyss-dep-search-error[role="status"]')?.textContent,
    ).toMatch(/changed|select/iu);
    handle.destroy();
  });

  it.each(['unchanged', 'reordered', 'disabled'] as const)(
    'retains existing-task intent when refreshed options are %s',
    async (change) => {
      const submissions: string[] = [];
      let refreshed = false;
      const handle = mountDependencySearch(activeDocument.body, {
        direction: 'blocked-by',
        canChangeDirection: true,
        options: (query, direction) => {
          const values = dependencySearchOptions({ ...fixture(), query, direction });
          if (!refreshed || change === 'unchanged') return values;
          if (change === 'reordered') return [...values].reverse();
          return values.map((option) =>
            option.title === 'Local candidate' ? { ...option, directions: [] } : option,
          );
        },
        selectExisting: async (option) => {
          submissions.push(option.title);
          return { type: 'committed' };
        },
        createNew: async () => {
          submissions.push('created');
          return { type: 'committed' };
        },
        onClose: () => {},
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      input.value = 'candidate';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      refreshed = true;
      handle.refresh();
      const activeId = input.getAttribute('aria-activedescendant');
      if (change === 'disabled') expect(activeId).toBeNull();
      else
        expect(activeDocument.getElementById(expectDefined(activeId))?.textContent).toContain(
          'Local candidate',
        );
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(submissions).toEqual(change === 'disabled' ? [] : ['Local candidate']);
      handle.destroy();
    },
  );

  it.each(['input', 'direction', 'arrow', 'create'] as const)(
    '%s replaces stale existing-task intent explicitly',
    async (intent) => {
      const submissions: string[] = [];
      let stale = false;
      const handle = mountDependencySearch(activeDocument.body, {
        direction: 'blocked-by',
        canChangeDirection: true,
        options: (query, direction) =>
          dependencySearchOptions({ ...fixture(), query, direction }).filter(
            (option) => !stale || option.title !== 'Local candidate',
          ),
        selectExisting: async (option) => {
          submissions.push(option.title);
          return { type: 'committed' };
        },
        createNew: async (text, direction) => {
          submissions.push(`${text}:${direction}`);
          return { type: 'committed' };
        },
        onClose: () => {},
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      input.value = 'candidate';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      stale = true;
      handle.refresh();
      if (intent === 'input') input.dispatchEvent(new Event('input', { bubbles: true }));
      if (intent === 'direction')
        expectDefined(
          handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
        ).click();
      if (intent === 'arrow')
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      if (intent === 'create')
        expectDefined(
          handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
        ).click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      const created = `candidate:${intent === 'direction' ? 'blocks' : 'blocked-by'}`;
      expect(submissions).toEqual([intent === 'arrow' ? 'Other candidate' : created]);
      handle.destroy();
    },
  );

  it.each([true, false])(
    'offers a native Create action with the same busy and error path (general: %s)',
    async (general) => {
      const pending = deferred<{ type: 'validation-error'; message: string }>();
      const submissions: string[] = [];
      const handle = mountDependencySearch(activeDocument.body, {
        direction: general ? 'blocked-by' : 'blocks',
        canChangeDirection: general,
        options: () => [],
        selectExisting: async () => ({ type: 'failed' }),
        createNew: (text, direction) => {
          submissions.push(`${text}:${direction}`);
          return pending.promise;
        },
        onClose: () => {},
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      input.value = '  New linked task  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const create = expectDefined(
        handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
      );
      expect(create.tagName).toBe('BUTTON');
      expect(create.type).toBe('button');
      expect(create.tabIndex).toBe(0);
      expect(create.getAttribute('role')).not.toBe('option');
      expect(create.textContent).toContain('New linked task');
      expect(create.closest('[role="listbox"]')).toBeNull();
      create.focus();
      create.click();
      create.click();
      expect(submissions).toEqual([`New linked task:${general ? 'blocked-by' : 'blocks'}`]);
      expect(create.disabled).toBe(true);
      pending.resolve({ type: 'validation-error', message: 'Choose a valid task title' });
      await flushMicrotasks();
      expect(create.disabled).toBe(false);
      expect(handle.element.querySelector('[role="status"]')?.textContent).toBe(
        'Choose a valid task title',
      );
      expect(input.value).toBe('  New linked task  ');
      expect(activeDocument.activeElement).toBe(input);
      handle.destroy();
    },
  );

  it.each([false, true])(
    'retries explicit Create after validation without reviving prior selection (stale: %s)',
    async (stale) => {
      const submissions: string[] = [];
      let refresh = false;
      const handle = mountDependencySearch(activeDocument.body, {
        direction: 'blocked-by',
        canChangeDirection: true,
        options: (query, direction) =>
          dependencySearchOptions({ ...fixture(), query, direction }).filter(
            (option) => !stale || !refresh || option.title !== 'Local candidate',
          ),
        selectExisting: async () => {
          submissions.push('existing');
          return { type: 'committed' };
        },
        createNew: async (text) => {
          submissions.push(`new:${text}`);
          return submissions.length === 1
            ? { type: 'validation-error', message: 'Try another task title' }
            : { type: 'committed' };
        },
        onClose: () => {},
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      input.value = 'candidate';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      refresh = true;
      handle.refresh();
      expectDefined(
        handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-create'),
      ).click();
      await flushMicrotasks();
      expect(input.getAttribute('aria-activedescendant')).toBeNull();
      expect(activeDocument.activeElement).toBe(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(submissions).toEqual(['new:candidate', 'new:candidate']);
      handle.destroy();
    },
  );

  it.each([
    ['ArrowDown', 'Local candidate'],
    ['ArrowUp', 'Other candidate'],
  ] as const)(
    '%s explicitly chooses an eligible result before Enter submits it',
    async (key, title) => {
      const writes: string[] = [];
      const handle = mountDependencySearch(activeDocument.body, {
        direction: 'blocked-by',
        canChangeDirection: true,
        options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
        selectExisting: async (option, direction) => {
          writes.push(`${option.title}:${direction}`);
          return { type: 'committed' };
        },
        createNew: async () => ({ type: 'failed' }),
        onClose: () => {},
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      input.value = 'candidate';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      expect(handle.element.querySelector('[aria-selected="true"]')?.textContent).toContain(title);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(writes).toEqual([`${title}:blocked-by`]);
      expect(handle.element.isConnected).toBe(false);
    },
  );

  it('a mouse click immediately submits the existing result in the chosen direction', async () => {
    const writes: string[] = [];
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocks',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async (option, direction) => {
        writes.push(`${option.title}:${direction}`);
        return { type: 'committed' };
      },
      createNew: async () => ({ type: 'failed' }),
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Local';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(handle.element.querySelector<HTMLButtonElement>('[role="option"]')).click();
    await flushMicrotasks();
    expect(writes).toEqual(['Local candidate:blocks']);
  });

  it('plain Enter creates from typed text even when an existing title exactly matches', async () => {
    const created: string[] = [];
    const selected: string[] = [];
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async (option) => {
        selected.push(option.title);
        return { type: 'committed' };
      },
      createNew: async (text, direction) => {
        created.push(`${text}:${direction}`);
        return { type: 'committed' };
      },
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Local candidate';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const affordance = expectDefined(
      handle.element.querySelector<HTMLElement>('.abyss-dep-search-create'),
    );
    expect(affordance.textContent).toBe('Create “Local candidate” as sub-task');
    expect(handle.element.querySelector('[role="listbox"]')?.contains(affordance)).toBe(false);
    expect(affordance.getAttribute('role')).not.toBe('option');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(created).toEqual(['Local candidate:blocked-by']);
    expect(selected).toEqual([]);
  });

  it('ignores whitespace Enter and IME Enter', async () => {
    const submissions: string[] = [];
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async () => {
        submissions.push('existing');
        return { type: 'committed' };
      },
      createNew: async () => {
        submissions.push('new');
        return { type: 'committed' };
      },
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.value = 'Candidate';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await flushMicrotasks();
    expect(submissions).toEqual([]);
    expect(handle.element.isConnected).toBe(true);
    handle.destroy();
  });

  it('prevents duplicate submission while a commit is busy', async () => {
    let finish: ((result: { readonly type: 'failed' }) => void) | undefined;
    const calls: string[] = [];
    const pending = new Promise<{ readonly type: 'failed' }>((resolve) => {
      finish = resolve;
    });
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async () => ({ type: 'failed' }),
      createNew: (text) => {
        calls.push(text);
        return pending;
      },
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'New task';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls).toEqual(['New task']);
    expect(handle.element.getAttribute('aria-busy')).toBe('true');
    finish?.({ type: 'failed' });
    await flushMicrotasks();
    expect(handle.element.getAttribute('aria-busy')).toBe('false');
    handle.destroy();
  });

  it('shows validation errors inline, preserves the draft and restores input focus', async () => {
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async () => ({ type: 'failed' }),
      createNew: async () => ({ type: 'validation-error', message: 'Choose another title' }),
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Repeated';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(handle.element.querySelector('[role="status"]')?.textContent).toBe(
      'Choose another title',
    );
    expect(input.value).toBe('Repeated');
    expect(activeDocument.activeElement).toBe(input);
    expect(handle.element.isConnected).toBe(true);
    handle.destroy();
  });

  it('clears an earlier validation error when a different submission begins', async () => {
    const handle = mountDependencySearch(activeDocument.body, {
      direction: 'blocked-by',
      canChangeDirection: true,
      options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
      selectExisting: async () => ({ type: 'failed' }),
      createNew: async () => ({ type: 'validation-error', message: 'Choose another title' }),
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Local';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    const error = expectDefined(
      handle.element.querySelector<HTMLElement>('.abyss-dep-search-error'),
    );
    expect(error.textContent).toBe('Choose another title');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe('');
    await flushMicrotasks();
    handle.destroy();
  });

  it.each(['Escape', 'success'] as const)(
    '%s restores invoking focus and releases ownership',
    async (mode) => {
      const anchor = activeDocument.body.createEl('button');
      anchor.focus();
      const release = vi.fn();
      const closeArguments: boolean[] = [];
      const handle = mountDependencySearch(activeDocument.body, {
        direction: 'blocked-by',
        canChangeDirection: true,
        options: (query, direction) => dependencySearchOptions({ ...fixture(), query, direction }),
        selectExisting: async () => ({ type: 'committed' }),
        createNew: async () => ({ type: 'committed' }),
        onClose: (restoreFocus) => {
          closeArguments.push(restoreFocus);
          if (restoreFocus) anchor.focus();
        },
        ownership: { acquire: () => ({ release }) },
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      if (mode === 'Escape') {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        input.value = 'New task';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushMicrotasks();
      }
      expect(closeArguments).toEqual([true]);
      expect(release).toHaveBeenCalledOnce();
      expect(activeDocument.activeElement).toBe(anchor);
    },
  );
});
