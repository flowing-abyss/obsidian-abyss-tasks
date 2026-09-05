import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTaskDependencyGraph, enumerateTaskNodes } from '../src/tasks/domain/taskDependencies';
import { dependencySearchOptions, mountDependencySearch } from '../src/ui/dependencySearch';
import { canonicalStatusCatalog, expectDefined, flushMicrotasks, task } from './helpers';

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
  it.each([
    ['zero', 'Local', []],
    ['one', 'Distant', ['blocked-by']],
    ['two', 'Local', ['blocked-by', 'blocks']],
  ] as const)(
    'requires an explicit general direction with %s eligible directions',
    async (count, query, wanted) => {
      const writes: string[] = [];
      const handle = mountDependencySearch(activeDocument.body, {
        scope: 'general',
        options: (value) =>
          dependencySearchOptions({
            ...fixture(),
            query: value,
            ...(count === 'zero'
              ? { eligibility: () => ({ type: 'rejected' as const, reason: 'cycle' as const }) }
              : {}),
          }),
        select: async (_option, direction) => {
          writes.push(direction);
          return true;
        },
        onClose: () => {},
      });
      const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(writes).toEqual([]);
      expect(
        [...handle.element.querySelectorAll<HTMLElement>('[data-direction]')].map(
          (element) => element.dataset['direction'],
        ),
      ).toEqual(wanted);
      if (wanted.length > 0) {
        expect(activeDocument.activeElement?.getAttribute('data-direction')).toBe('blocked-by');
        (activeDocument.activeElement as HTMLElement).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await flushMicrotasks();
        expect(writes).toEqual(['blocked-by']);
      }
      handle.destroy();
    },
  );

  it('commits scoped selection but never auto-executes a refreshed general choice', async () => {
    const writes: string[] = [];
    let query = 'Local';
    const general = mountDependencySearch(activeDocument.body, {
      scope: 'general',
      options: () => dependencySearchOptions({ ...fixture(), query }),
      select: async (_option, direction) => {
        writes.push(direction);
        return true;
      },
      onClose: () => {},
    });
    const input = expectDefined(general.element.querySelector<HTMLInputElement>('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    query = 'Distant';
    general.refresh();
    await flushMicrotasks();
    expect(writes).toEqual([]);
    expect(general.element.querySelectorAll('[data-direction]')).toHaveLength(0);
    expect(activeDocument.activeElement).toBe(input);
    general.destroy();
    const scoped = mountDependencySearch(activeDocument.body, {
      scope: 'blocked-by',
      options: () =>
        dependencySearchOptions({ ...fixture(), query: 'Local', direction: 'blocked-by' }),
      select: async (_option, direction) => {
        writes.push(direction);
        return true;
      },
      onClose: () => {},
    });
    expectDefined(scoped.element.querySelector('input')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await flushMicrotasks();
    expect(writes).toEqual(['blocked-by']);
    expect(scoped.element.isConnected).toBe(false);
  });

  it('releases controller ownership and document listeners only once when destroyed repeatedly', () => {
    const release = vi.fn();
    const remove = vi.spyOn(activeDocument, 'removeEventListener');
    const handle = mountDependencySearch(activeDocument.body, {
      scope: 'general',
      options: () => [],
      select: async () => false,
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

  it('drops a stale direction choice on query refresh and returns focus to the preserved query', () => {
    let available = true;
    const handle = mountDependencySearch(activeDocument.body, {
      scope: 'general',
      options: (query) => (available ? dependencySearchOptions({ ...fixture(), query }) : []),
      select: async () => false,
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Local';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(
      handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-option'),
    ).click();
    expect(activeDocument.activeElement?.getAttribute('data-direction')).toBe('blocked-by');
    available = false;
    handle.refresh();
    expect(handle.element.querySelectorAll('[data-direction]')).toHaveLength(0);
    expect(input.value).toBe('Local');
    expect(activeDocument.activeElement).toBe(input);
    handle.destroy();
  });

  it('clears an old direction choice when the user changes the search query', () => {
    const handle = mountDependencySearch(activeDocument.body, {
      scope: 'general',
      options: (query) => dependencySearchOptions({ ...fixture(), query }),
      select: async () => false,
      onClose: () => {},
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'Local';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(
      handle.element.querySelector<HTMLButtonElement>('.abyss-dep-search-option'),
    ).click();
    expect(handle.element.querySelectorAll('[data-direction]')).toHaveLength(2);
    input.focus();
    input.value = 'Other';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(handle.element.querySelectorAll('[data-direction]')).toHaveLength(0);
    expect(handle.element.querySelector('.abyss-dep-search-option')?.textContent).toContain(
      'Other candidate',
    );
    handle.destroy();
  });

  it('chooses a general direction by keyboard, keeps failed input, and closes only after success', async () => {
    const anchor = activeDocument.body.createEl('button', { text: 'Dependencies' });
    const calls: string[] = [];
    const results = [false, true];
    const handle = mountDependencySearch(activeDocument.body, {
      scope: 'general',
      options: (query) => dependencySearchOptions({ ...fixture(), query }),
      select: async (option, direction) => {
        calls.push(`${option.title}:${direction}`);
        return results.shift() ?? false;
      },
      onClose: () => {
        anchor.focus();
      },
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.value = 'candidate';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const direction = expectDefined(
      handle.element.querySelector<HTMLButtonElement>('[data-direction="blocked-by"]'),
    );
    expect(activeDocument.activeElement).toBe(direction);
    direction.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(activeDocument.activeElement?.getAttribute('data-direction')).toBe('blocks');
    (activeDocument.activeElement as HTMLButtonElement).click();
    await flushMicrotasks(10);
    expect(calls).toEqual(['Local candidate:blocks']);
    expect(handle.element.isConnected).toBe(true);
    expect(input.value).toBe('candidate');
    expectDefined(
      handle.element.querySelector<HTMLButtonElement>('[data-direction="blocks"]'),
    ).click();
    await flushMicrotasks(10);
    expect(handle.element.isConnected).toBe(false);
    expect(activeDocument.activeElement).toBe(anchor);
  });

  it('uses ArrowUp and Escape in the same controller for a scoped entry point', () => {
    const anchor = activeDocument.body.createEl('button');
    const handle = mountDependencySearch(activeDocument.body, {
      scope: 'blocked-by',
      options: (query) => dependencySearchOptions({ ...fixture(), direction: 'blocked-by', query }),
      select: async () => false,
      onClose: () => {
        anchor.focus();
      },
    });
    const input = expectDefined(handle.element.querySelector<HTMLInputElement>('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(handle.element.querySelector('[aria-selected="true"]')?.textContent).toContain(
      'Local candidate',
    );
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handle.element.isConnected).toBe(false);
    expect(activeDocument.activeElement).toBe(anchor);
  });
});
