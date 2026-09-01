import { Menu, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectActionBoardColumns,
  type BoardColumn,
  type BoardMutation,
} from '../src/panels/projects/boardProjection';
import {
  renderBoard,
  renderProjectTasksBoard,
  type BoardViewOptions,
} from '../src/panels/projects/ProjectsBoardView';
import type { WorkNoteBoardSession } from '../src/panels/projects/ProjectWorkspaceSession';
import type { ProjectAction } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { createOptimisticOverlayStore } from '../src/ui/interaction/OptimisticOverlayStore';
import { deferred, flushMicrotasks, freshContainer, task } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  activeDocument
    .querySelectorAll('[data-board-roving-test]')
    .forEach((element) => element.remove());
});

interface Item {
  readonly id: string;
  readonly name: string;
}

function column(
  key: string,
  role: BoardColumn<Item>['role'],
  items: readonly Item[] = [],
): BoardColumn<Item> {
  return { key, label: key, role, items };
}

describe('shared board view', () => {
  it('keeps an accepted board move optimistic until a matching source publication settles it', async () => {
    const el = freshContainer();
    const announcements: string[] = [];
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
      announce: (message) => announcements.push(message),
    });
    const render = (items: readonly (typeof todo)[], revision: string): void => {
      el.empty();
      renderBoard(el, {
        columns: [
          {
            key: 'todo',
            label: 'todo',
            role: 'regular',
            items: items.filter(({ status }) => status === 'todo'),
          },
          {
            key: 'doing',
            label: 'doing',
            role: 'regular',
            items: items.filter(({ status }) => status === 'doing'),
          },
        ],
        mutation: { move: vi.fn().mockResolvedValue({ type: 'ok' }), menuItems: () => [] },
        itemKey: ({ id }) => id,
        itemLabel: ({ name }) => name,
        renderItem: (host, current) => host.createEl('button', { text: current.name }),
        interactionController: true,
        announce: (message) => announcements.push(message),
        optimisticOverlay: {
          store: overlays,
          keyOf: ({ id }) => id,
          revision: () => revision,
          columnKey: ({ status }) => status,
        },
      });
    };

    render([todo], 'one');
    const item = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();

    expect(
      el.querySelector('[data-board-column="doing"] [data-board-item-surface]'),
    ).not.toBeNull();
    expect(announcements).not.toContain('Item moved');

    render([{ ...todo, status: 'doing' }], 'two');

    expect(announcements.filter((message) => message === 'Item moved.')).toHaveLength(1);
    expect(announcements).not.toContain('Item moved. Undo available.');
  });

  it('gates native-drag Undo on the matching canonical publication', async () => {
    const el = freshContainer();
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    const render = (items: readonly (typeof todo)[], revision: string, sequence: number): void => {
      el.empty();
      renderBoard(el, {
        columns: [
          {
            key: 'todo',
            label: 'todo',
            role: 'regular',
            items: items.filter(({ status }) => status === 'todo'),
          },
          {
            key: 'doing',
            label: 'doing',
            role: 'regular',
            items: items.filter(({ status }) => status === 'doing'),
          },
        ],
        mutation: { move: vi.fn().mockResolvedValue({ type: 'ok' }), menuItems: () => [] },
        itemKey: ({ id }) => id,
        renderItem: (host, current) => host.createEl('button', { text: current.name }),
        undo: vi.fn().mockResolvedValue({ type: 'ok' }),
        optimisticOverlay: {
          store: overlays,
          keyOf: ({ id }) => id,
          revision: () => revision,
          publicationSequence: sequence,
          columnKey: ({ status }) => status,
        },
      });
    };

    render([todo], 'one', 1);
    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="doing"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(el.querySelector('[data-board-undo]')).toBeNull();
    expect(overlays.active('a')).toBeDefined();

    overlays.observePublication('a', { ...todo, status: 'doing' }, 'two', 2);
    await flushMicrotasks();
    expect(el.querySelector('[data-board-undo]')).not.toBeNull();
  });

  it('keeps native-drag Undo when publication wins the race with command completion', async () => {
    const el = freshContainer();
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const completion = deferred<{ type: 'ok' }>();
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion.promise), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        publicationSequence: 1,
        columnKey: ({ status }) => status,
      },
    });

    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="doing"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    overlays.observePublication('a', { ...todo, status: 'doing' }, 'two', 2);
    completion.resolve({ type: 'ok' });
    await flushMicrotasks();

    expect(el.querySelector('[data-board-undo]')).not.toBeNull();
  });

  it('keeps controller Undo when publication wins the race with command completion', async () => {
    const el = freshContainer();
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const completion = deferred<{ type: 'ok' }>();
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion.promise), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      interactionController: true,
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        publicationSequence: 1,
        columnKey: ({ status }) => status,
      },
    });

    const item = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    overlays.observePublication('a', { ...todo, status: 'doing' }, 'two', 2);
    completion.resolve({ type: 'ok' });
    await flushMicrotasks();

    expect(el.querySelector('[data-board-undo]')).not.toBeNull();
  });

  it('does not announce success or expose Undo when publication precedes a conflict', async () => {
    const el = freshContainer();
    const announcements: string[] = [];
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const completion = deferred<{ type: 'conflict' }>();
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
      announce: (message) => announcements.push(message),
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion.promise), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      interactionController: true,
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
      announce: (message) => announcements.push(message),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        publicationSequence: 1,
        columnKey: ({ status }) => status,
      },
    });

    const item = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    overlays.observeCanonicalBatch(
      [{ key: 'a', snapshot: { ...todo, status: 'doing' }, revision: 'two' }],
      2,
    );
    expect(announcements.filter((message) => message.startsWith('Item moved'))).toHaveLength(0);
    expect(el.querySelector('[data-board-undo]')).toBeNull();

    completion.resolve({ type: 'conflict' });
    await flushMicrotasks();

    expect(announcements.filter((message) => message.startsWith('Item moved'))).toHaveLength(0);
    expect(
      announcements.filter((message) => message === 'Item changed outside the board'),
    ).toHaveLength(1);
    expect(el.querySelector('[data-board-undo]')).toBeNull();
  });

  it('clears pending Undo when publication precedes a rejected command', async () => {
    const el = freshContainer();
    const announcements: string[] = [];
    const todo = { id: 'a', name: 'A', status: 'todo' };
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<{ type: 'ok' }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
      announce: (message) => announcements.push(message),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        publicationSequence: 1,
        columnKey: ({ status }) => status,
      },
    });

    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="doing"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    overlays.observeCanonicalBatch(
      [{ key: 'a', snapshot: { ...todo, status: 'doing' }, revision: 'two' }],
      2,
    );
    rejectCompletion(new Error('disk unavailable'));
    await flushMicrotasks();

    expect(announcements.filter((message) => message === 'Item could not be moved')).toHaveLength(
      1,
    );
    expect(announcements.filter((message) => message.startsWith('Item moved'))).toHaveLength(0);
    expect(el.querySelector('[data-board-undo]')).toBeNull();
  });

  it('clears pending Undo when publication precedes an undefined command result', async () => {
    const el = freshContainer();
    const announcements: string[] = [];
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const completion = deferred<{ type: 'ok' } | undefined>();
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion.promise), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
      announce: (message) => announcements.push(message),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        publicationSequence: 1,
        columnKey: ({ status }) => status,
      },
    });

    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="doing"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    overlays.observeCanonicalBatch(
      [{ key: 'a', snapshot: { ...todo, status: 'doing' }, revision: 'two' }],
      2,
    );
    completion.resolve(undefined);
    await flushMicrotasks();

    expect(announcements.filter((message) => message === 'Item could not be moved')).toHaveLength(
      1,
    );
    expect(announcements.filter((message) => message.startsWith('Item moved'))).toHaveLength(0);
    expect(el.querySelector('[data-board-undo]')).toBeNull();
  });

  it('announces one terminal failure when a second controller move finds an active transaction', async () => {
    const el = freshContainer();
    const announcements: string[] = [];
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const completion = deferred<{ type: 'ok' }>();
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
        { key: 'done', label: 'done', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion.promise), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      interactionController: true,
      announce: (message) => announcements.push(message),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        columnKey: ({ status }) => status,
      },
    });

    const nativeCard = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    nativeCard.dispatchEvent(new Event('dragstart', { bubbles: true }));
    el.querySelector<HTMLElement>('[data-board-column="doing"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    const projected = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    projected.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    projected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    projected.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();

    expect(announcements.filter((message) => message === 'Move is already pending')).toHaveLength(
      1,
    );
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();
    completion.resolve({ type: 'ok' });
  });

  it('finishes a native move after its renderer is replaced by publication', async () => {
    const el = freshContainer();
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const completion = deferred<{ type: 'ok' }>();
    const onMutation = vi.fn();
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
    });
    const board = renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockReturnValue(completion.promise), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      onMutation,
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        publicationSequence: 1,
        columnKey: ({ status }) => status,
      },
    });

    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="doing"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    overlays.observePublication('a', { ...todo, status: 'doing' }, 'two', 2);
    board.destroy();
    completion.resolve({ type: 'ok' });
    await flushMicrotasks();

    expect(onMutation).toHaveBeenCalledOnce();
  });

  it('rolls back an undefined board command once instead of leaving an overlay pending', async () => {
    const el = freshContainer();
    const announcements: string[] = [];
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
      announce: (message) => announcements.push(message),
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockResolvedValue(undefined), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      interactionController: true,
      announce: (message) => announcements.push(message),
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        columnKey: ({ status }) => status,
      },
    });

    const item = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();

    expect(el.querySelector('[data-board-column="todo"] [data-board-item-surface]')).not.toBeNull();
    expect(announcements.filter((message) => message === 'Item could not be moved')).toHaveLength(
      1,
    );
  });

  it('rerenders a mounted board when an unacknowledged overlay times out', async () => {
    vi.useFakeTimers();
    const el = freshContainer();
    const todo = { id: 'a', name: 'A', status: 'todo' };
    const overlays = createOptimisticOverlayStore<typeof todo, string>({
      keyOf: ({ id }) => id,
      apply: (item, status) => ({ ...item, status }),
      matches: (item, status) => item.status === status,
      isSuccess: (result) => result.type === 'ok',
      timeoutMs: 100,
    });
    renderBoard(el, {
      columns: [
        { key: 'todo', label: 'todo', role: 'regular', items: [todo] },
        { key: 'doing', label: 'doing', role: 'regular', items: [] },
      ],
      mutation: { move: vi.fn().mockResolvedValue({ type: 'ok' }), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      renderItem: (host, current) => host.createEl('button', { text: current.name }),
      interactionController: true,
      optimisticOverlay: {
        store: overlays,
        keyOf: ({ id }) => id,
        revision: () => 'one',
        columnKey: ({ status }) => status,
      },
    });

    const item = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    expect(el.querySelector('[data-board-column="todo"] [data-board-item-surface]')).not.toBeNull();
    vi.useRealTimers();
  });

  it('adapts Project Tasks to the shared controller with canonical landing and column footers', async () => {
    const todo = task({
      title: 'Earlier task',
      source: { filePath: 'Projects/A.md', line: 1 },
    });
    const moving = task({
      title: 'Moving task',
      source: { filePath: 'Projects/A.md', line: 2 },
    });
    const done = task({
      title: 'Later task',
      status: 'done',
      statusSymbol: 'x',
      source: { filePath: 'Projects/A.md', line: 3 },
    });
    const actions: ProjectAction[] = [todo, moving, done].map((current) => ({
      task: current,
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/A.md' },
    }));
    const move = vi
      .fn()
      .mockResolvedValue({ type: 'ok', changed: true, outcome: { type: 'task' } });
    const add = vi.fn();
    const el = freshContainer();

    renderProjectTasksBoard(el, {
      actions,
      statuses: [
        { id: 'todo', symbol: ' ', name: 'To-do', type: 'todo', icon: '', core: true },
        { id: 'done', symbol: 'x', name: 'Done', type: 'done', icon: 'check', core: true },
      ],
      onMoveStatus: move,
      renderItem: (host, action) => host.createEl('button', { text: action.task.title }),
      renderColumnAdd: (host, status) => {
        const button = host.createEl('button', { text: 'Add task' });
        button.addEventListener('click', () => add(status.symbol));
      },
    });

    expect(el.querySelectorAll('[data-board-column-add]')).toHaveLength(2);
    el.querySelector<HTMLButtonElement>('[data-board-column-add="done"] button')!.click();
    expect(add).toHaveBeenCalledWith('x');
    const focus = Array.from(el.querySelectorAll<HTMLElement>('[data-board-item-focus]')).find(
      ({ textContent }) => textContent === 'Moving task',
    )!;
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();

    expect(move).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith(moving, 'x');
    expect(
      Array.from(
        el.querySelectorAll<HTMLElement>('[data-board-column="done"] [data-board-item-surface]'),
        ({ textContent }) => textContent,
      ),
    ).toEqual(['Moving task', 'Later task']);
  });

  it('settles a task status overlay when canonical publication only replaces its TaskRef revision', async () => {
    const scope = {};
    const el = freshContainer();
    const announcements: string[] = [];
    const original = task({
      title: 'Revision-stable task',
      source: { filePath: 'Projects/A.md', line: 12 },
    });
    const action = (current: typeof original): ProjectAction => ({
      task: current,
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/A.md' },
    });
    const statuses = [
      { id: 'todo', symbol: ' ', name: 'To-do', type: 'todo' as const, icon: '', core: true },
      { id: 'done', symbol: 'x', name: 'Done', type: 'done' as const, icon: 'check', core: true },
    ];
    const render = (actions: readonly ProjectAction[]) =>
      renderProjectTasksBoard(el, {
        actions,
        statuses,
        onMoveStatus: vi.fn().mockResolvedValue({ type: 'ok', changed: true }),
        renderItem: (host, current) => host.createEl('button', { text: current.task.title }),
        overlayScope: scope,
        announce: (message) => announcements.push(message),
      });

    let board = render([action(original)]);
    const focus = el.querySelector<HTMLElement>('[data-board-item-focus]')!;
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    board.destroy();
    el.empty();

    const published = {
      ...original,
      ref: { ...original.ref, revision: 'revision:2' },
      status: 'done' as const,
      statusSymbol: 'x',
    };
    board = render([action(published)]);

    expect(announcements.filter((message) => message.startsWith('Item moved'))).toHaveLength(1);
    expect(el.querySelector('[data-board-column="done"] [data-board-item-surface]')).not.toBeNull();
    board.destroy();
  });

  it('reconciles a TaskRef successor after a line shift and file rename', async () => {
    const scope = {};
    const el = freshContainer();
    const announcements: string[] = [];
    const original = task({ source: { filePath: 'Projects/A.md', line: 12 } });
    const action = (current: typeof original): ProjectAction => ({
      task: current,
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/A.md' },
    });
    const statuses = [
      { id: 'todo', symbol: ' ', name: 'To-do', type: 'todo' as const, icon: '', core: true },
      { id: 'done', symbol: 'x', name: 'Done', type: 'done' as const, icon: 'check', core: true },
    ];
    let board = renderProjectTasksBoard(el, {
      actions: [action(original)],
      canonicalActions: [action(original)],
      publicationSequence: 1,
      statuses,
      onMoveStatus: vi.fn().mockResolvedValue({ type: 'ok', changed: true }),
      renderItem: (host, current) => host.createEl('button', { text: current.task.title }),
      overlayScope: scope,
      announce: (message) => announcements.push(message),
      taskSuccessor: (_observed, published) => published.ref.revision === 'revision:successor',
    });
    const focus = el.querySelector<HTMLElement>('[data-board-item-focus]')!;
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    board.destroy();

    const successor = {
      ...original,
      ref: {
        ...original.ref,
        filePath: 'Archive/A.md',
        line: 19,
        revision: 'revision:successor',
      },
      source: { ...original.source, filePath: 'Archive/A.md', line: 19 },
      status: 'done' as const,
      statusSymbol: 'x',
    };
    board = renderProjectTasksBoard(el, {
      actions: [action(successor)],
      canonicalActions: [action(successor)],
      publicationSequence: 2,
      statuses,
      onMoveStatus: vi.fn(),
      renderItem: (host, current) => host.createEl('button', { text: current.task.title }),
      overlayScope: scope,
      announce: (message) => announcements.push(message),
      taskSuccessor: (_observed, published) => published.ref.revision === 'revision:successor',
    });

    expect(announcements.filter((message) => message === 'Item moved.')).toHaveLength(1);
    expect(el.querySelector('[data-board-column="done"] [data-board-item-surface]')).not.toBeNull();
    board.destroy();
  });

  it('keeps a filtered task transaction when the complete canonical batch still contains it', async () => {
    const scope = {};
    const el = freshContainer();
    const original = task({ source: { filePath: 'Projects/A.md', line: 12 } });
    const announcements: string[] = [];
    const action: ProjectAction = {
      task: original,
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/A.md' },
    };
    const statuses = [
      { id: 'todo', symbol: ' ', name: 'To-do', type: 'todo' as const, icon: '', core: true },
      { id: 'done', symbol: 'x', name: 'Done', type: 'done' as const, icon: 'check', core: true },
    ];
    const handle = renderProjectTasksBoard(el, {
      actions: [action],
      canonicalActions: [action],
      publicationSequence: 1,
      statuses,
      onMoveStatus: vi.fn().mockResolvedValue({ type: 'ok', changed: true }),
      renderItem: (host, current) => host.createEl('button', { text: current.task.title }),
      overlayScope: scope,
      announce: (message) => announcements.push(message),
    });
    const focus = el.querySelector<HTMLElement>('[data-board-item-focus]')!;
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    handle.destroy();
    el.empty();

    renderProjectTasksBoard(el, {
      actions: [],
      canonicalActions: [action],
      publicationSequence: 2,
      statuses,
      onMoveStatus: vi.fn(),
      renderItem: (host, current) => host.createEl('button', { text: current.task.title }),
      overlayScope: scope,
      announce: (message) => announcements.push(message),
    });

    expect(announcements).not.toContain('Item changed outside the board');
  });

  it('exposes one roving selected tab/tabpanel and reaches both terminal bookends by keyboard', () => {
    const el = freshContainer();
    el.dataset['boardRovingTest'] = '';
    activeDocument.body.appendChild(el);
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [{ id: 'a', name: 'A' }]),
        column('published', 'terminal-right'),
      ],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });

    const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map(({ dataset }) => dataset['boardColumnTab'])).toEqual([
      'dropped',
      'active',
      'published',
    ]);
    expect(tabs.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(el.querySelectorAll('[role="tabpanel"][data-selected-column="true"]')).toHaveLength(1);
    for (const tab of tabs) {
      const key = tab.dataset['boardColumnTab']!;
      const panel = el.querySelector<HTMLElement>(`[role="tabpanel"][data-board-column="${key}"]`)!;
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const published = el.querySelector<HTMLButtonElement>('[data-board-column-tab="published"]')!;
    expect(activeDocument.activeElement).toBe(published);
    expect(published.getAttribute('aria-selected')).toBe('true');
    published.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(activeDocument.activeElement?.getAttribute('data-board-column-tab')).toBe('dropped');
    for (const [key, name] of [
      ['dropped', '0 items in dropped'],
      ['active', '1 item in active'],
      ['published', '0 items in published'],
    ] as const) {
      expect(
        el
          .querySelector(`[data-board-column="${key}"] .abyss-board-column-count`)
          ?.getAttribute('aria-label'),
      ).toBe(name);
    }
  });

  it('excludes hidden columns from restored selection, roving tabs, and active-column fallback', () => {
    const el = freshContainer();
    const session: WorkNoteBoardSession = {
      selectedColumnKey: 'done',
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    };
    renderBoard(el, {
      columns: [
        column('active', 'regular', [{ id: 'a', name: 'A' }]),
        column('done', 'regular'),
        column('published', 'terminal-right'),
      ],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
      session,
      columnPreferences: {
        value: {
          version: 1,
          terminalDefaultsApplied: true,
          columnOrder: ['active', 'done', 'published'],
          collapsedColumnIds: ['published'],
          hiddenColumnIds: ['done'],
        },
        terminalLeftIds: [],
        terminalRightIds: ['published'],
        onChange: vi.fn(),
      },
    });

    expect(session.selectedColumnKey).toBe('active');
    expect(
      Array.from(
        el.querySelectorAll<HTMLElement>('[data-board-column-tab]'),
        ({ dataset }) => dataset['boardColumnTab'],
      ),
    ).toEqual(['active', 'published']);
    expect(
      el.querySelector<HTMLElement>('[data-board-column-tab][aria-selected="true"]')?.dataset[
        'boardColumnTab'
      ],
    ).toBe('active');

    el.querySelector<HTMLButtonElement>('[data-board-hide-column="active"]')!.click();

    expect(session.selectedColumnKey).toBe('published');
    expect(
      el.querySelector<HTMLElement>('[data-board-column-tab][aria-selected="true"]')?.dataset[
        'boardColumnTab'
      ],
    ).toBe('published');
    expect(el.querySelectorAll('[role="tabpanel"][data-selected-column="true"]')).toHaveLength(1);
  });

  it('offers the same status menu through an explicit compact touch affordance', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    const menuItems: Array<{
      title: string;
      icon: string;
      checked: boolean;
      disabled: boolean;
      activate: () => void;
    }> = [];
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
      let title = '';
      let icon = '';
      let checked = false;
      let disabled = false;
      let activate = (): void => undefined;
      const menuItem = {
        setTitle(value: string) {
          title = value;
          return this;
        },
        setIcon(value: string) {
          icon = value;
          return this;
        },
        setChecked(value: boolean) {
          checked = value;
          return this;
        },
        setDisabled(value: boolean) {
          disabled = value;
          return this;
        },
        onClick(callback: () => void) {
          activate = callback;
          menuItems.push({
            get title() {
              return title;
            },
            get icon() {
              return icon;
            },
            get checked() {
              return checked;
            },
            get disabled() {
              return disabled;
            },
            activate: () => activate(),
          });
          return this;
        },
      } as unknown as MenuItem;
      build(menuItem);
      return this;
    });
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: {
        move,
        menuItems: () => [
          {
            columnKey: 'published',
            label: 'Published',
            icon: 'send',
            checked: false,
            disabled: false,
          },
          {
            columnKey: 'active',
            label: 'Active',
            icon: 'circle',
            checked: true,
            disabled: true,
          },
        ],
      },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });

    const affordance = el.querySelector<HTMLButtonElement>('[data-board-status-menu="a"]')!;
    expect(affordance).toBeInstanceOf(HTMLButtonElement);
    expect(affordance.getAttribute('aria-label')).toBe('Change status');
    expect(affordance.getAttribute('title')).toBe('Change status');
    affordance.click();
    expect(show).toHaveBeenCalledOnce();
    expect(
      menuItems.map(({ title, icon, checked, disabled }) => ({ title, icon, checked, disabled })),
    ).toEqual([
      { title: 'Published', icon: 'send', checked: false, disabled: false },
      { title: 'Active', icon: 'circle', checked: true, disabled: true },
    ]);
    const clickModel = menuItems.map(({ title, icon, checked, disabled }) => ({
      title,
      icon,
      checked,
      disabled,
    }));
    menuItems.length = 0;
    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(
      menuItems.map(({ title, icon, checked, disabled }) => ({ title, icon, checked, disabled })),
    ).toEqual(clickModel);
    menuItems[0]!.activate();
    await flushMicrotasks();
    expect(move).toHaveBeenCalledWith(item, 'published');
  });

  it.each(['outside control', 'Board tab'] as const)(
    'does not resurrect a card when an async move settles after focus moved to %s',
    async (destination) => {
      const pending = deferred<{
        type: 'ok';
        previousStatusId: null;
        nextStatusId: string;
      }>();
      const session: WorkNoteBoardSession = {
        selectedColumnKey: null,
        focusedKey: null,
        restoreFocus: false,
        columns: {},
      };
      const root = freshContainer();
      const outside = activeDocument.body.createEl('button');
      activeDocument.body.appendChild(root);
      renderBoard(root, {
        columns: [
          column('active', 'regular', [{ id: 'a', name: 'A' }]),
          column('published', 'terminal-right'),
        ],
        mutation: { move: () => pending.promise, menuItems: () => [] },
        itemKey: ({ id }) => id,
        renderItem: (host, current) => host.createEl('button', { text: current.name }),
        session,
      });
      const card = root.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
      card.focus();
      expect(activeDocument.activeElement).toBe(card);
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      root
        .querySelector<HTMLElement>('[data-board-column="published"]')!
        .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      const target =
        destination === 'Board tab'
          ? root.querySelector<HTMLButtonElement>('[data-board-column-tab="published"]')!
          : outside;
      target.focus();
      await flushMicrotasks();
      pending.resolve({ type: 'ok', previousStatusId: null, nextStatusId: 'published' });
      await flushMicrotasks();

      const replacementTarget =
        destination === 'Board tab'
          ? root.querySelector<HTMLButtonElement>('[data-board-column-tab="published"]')
          : outside;
      expect(activeDocument.activeElement).toBe(replacementTarget);
      root.remove();
      outside.remove();
    },
  );

  it('revokes Board-owned focus after intentional blur and never resurrects the old card', async () => {
    const session: WorkNoteBoardSession = {
      selectedColumnKey: null,
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    };
    const el = freshContainer();
    const outside = activeDocument.createElement('button');
    activeDocument.body.append(el, outside);
    const options = {
      columns: [column('active', 'regular', [{ id: 'a', name: 'A' }])],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }: Item) => id,
      renderItem: (host: HTMLElement, current: Item) => host.createDiv({ text: current.name }),
      session,
    };
    const handle = renderBoard(el, options);
    const cardControl = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    cardControl.focus();
    expect(activeDocument.activeElement).toBe(cardControl);
    outside.focus();
    await flushMicrotasks();

    expect(session.restoreFocus).toBe(false);
    handle.destroy();
    renderBoard(el, options);
    expect(activeDocument.activeElement).toBe(outside);
    el.remove();
    outside.remove();
  });

  it('keeps the dependency projection attached to Project actions through board columns', () => {
    const current = task({ title: 'Blocked project task' });
    const action: ProjectAction = {
      task: current,
      projectPath: 'Projects/A.md',
      dependency: {
        type: 'blocked',
        prerequisites: [{ filePath: 'Projects/A.md', line: 0, revision: 'prep' }],
      },
      owner: { type: 'project', path: 'Projects/A.md' },
    };

    const columns = projectActionBoardColumns(DEFAULT_SETTINGS.taskStatuses, [action]);

    expect(columns.flatMap(({ items }) => items)).toEqual([action]);
    expect(columns.flatMap(({ items }) => items)[0]?.dependency).toEqual(action.dependency);
  });

  it('includes inherited Work Note inline Actions in Project task columns', () => {
    const direct: ProjectAction = {
      task: task({ title: 'Direct action', statusSymbol: ' ' }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/A.md' },
    };
    const inherited: ProjectAction = {
      task: task({
        title: 'Work Note action',
        statusSymbol: '/',
        source: { filePath: 'Work Notes/Research.md', line: 4 },
      }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'work-note', path: 'Work Notes/Research.md' },
    };

    const columns = projectActionBoardColumns(DEFAULT_SETTINGS.taskStatuses, [direct, inherited]);

    expect(columns.flatMap(({ items }) => items)).toEqual([direct, inherited]);
  });

  it('expands a filtered terminal target only while dragging', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [item]),
        column('published', 'terminal-right'),
      ],
      visibleColumnKeys: new Set(['active']),
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const published = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;

    expect(published.classList.contains('is-collapsed')).toBe(true);
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(published.classList.contains('is-collapsed')).toBe(false);
    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(published.classList.contains('is-collapsed')).toBe(true);
  });

  it('makes both filtered terminal bookends simultaneous narrow drag zones without displacing active content', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [item]),
        column('published', 'terminal-right'),
      ],
      visibleColumnKeys: new Set(['active']),
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const dropped = el.querySelector<HTMLElement>('[data-board-column="dropped"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const published = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;

    card.dispatchEvent(new Event('dragstart', { bubbles: true }));

    expect(dropped.dataset['boardTerminalDragZone']).toBe('left');
    expect(published.dataset['boardTerminalDragZone']).toBe('right');
    expect(active.classList.contains('is-active')).toBe(true);
    expect(
      el.querySelectorAll('[data-board-column-tab="dropped"], [data-board-column-tab="published"]'),
    ).toHaveLength(0);

    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(dropped.dataset['boardTerminalDragZone']).toBeUndefined();
    expect(published.dataset['boardTerminalDragZone']).toBeUndefined();
  });

  it('does not label filtered terminal drop zones with tabs that are not rendered', () => {
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [{ id: 'a', name: 'A' }]),
        column('published', 'terminal-right'),
      ],
      visibleColumnKeys: new Set(['active']),
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });

    for (const panel of el.querySelectorAll<HTMLElement>('[data-terminal-filtered="true"]')) {
      const labelledBy = panel.getAttribute('aria-labelledby');
      expect(labelledBy === null || el.querySelector(`#${labelledBy}`) !== null).toBe(true);
    }
  });

  it('keeps a terminal item visible when its filter is enabled and removes it only after a successful filtered write', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    const mutation: BoardMutation<Item> = { move, menuItems: () => [] };

    const visible = freshContainer();
    renderBoard(visible, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      visibleColumnKeys: new Set(['active', 'published']),
      mutation,
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const visibleTarget = visible.querySelector<HTMLElement>('[data-board-column="published"]')!;
    visible
      .querySelector<HTMLElement>('[data-board-item="a"]')!
      .dispatchEvent(new Event('dragstart', { bubbles: true }));
    visibleTarget.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    visibleTarget.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(visible.textContent).toContain('A');

    const filtered = freshContainer();
    renderBoard(filtered, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      visibleColumnKeys: new Set(['active']),
      mutation,
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const filteredTarget = filtered.querySelector<HTMLElement>('[data-board-column="published"]')!;
    filtered
      .querySelector<HTMLElement>('[data-board-item="a"]')!
      .dispatchEvent(new Event('dragstart', { bubbles: true }));
    filteredTarget.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    filteredTarget.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(filtered.textContent).not.toContain('A');
  });

  it('keeps logical keyboard order inside each bounded column', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `item-${String(index)}`,
      name: `Item ${String(index)}`,
    }));
    const el = freshContainer();
    activeDocument.body.append(el);
    renderBoard(el, {
      columns: [column('active', 'regular', items)],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const first = el.querySelector<HTMLElement>('[data-board-item="item-0"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(activeDocument.activeElement?.getAttribute('data-board-item')).toBe('item-1');
    expect(el.querySelectorAll('[data-board-item]').length).toBeLessThan(items.length);
    el.remove();
  });

  it('offers a successful lifecycle move a conditional Undo action', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok', previousStatusId: 'active' });
    const undo = vi.fn().mockResolvedValue({ type: 'ok' });
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
      undo,
    });
    const source = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const target = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    source.dispatchEvent(new Event('dragstart', { bubbles: true }));
    target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    el.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    await flushMicrotasks();
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();

    expect(undo).toHaveBeenCalledWith(item, 'published', {
      type: 'ok',
      previousStatusId: 'active',
    });
    expect(el.textContent).toContain('A');
  });

  it('does not start a second board mutation while the current Undo is in flight', async () => {
    const first = { id: 'a', name: 'A' };
    const second = { id: 'b', name: 'B' };
    const move = vi.fn().mockResolvedValue({ type: 'ok', previousStatusId: 'active' });
    const pendingUndo = deferred<{
      type: 'ok';
      previousStatusId: string;
      nextStatusId: string;
    }>();
    const undo = vi.fn(() => pendingUndo.promise);
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('active', 'regular', [first, second]),
        column('published', 'terminal-right'),
      ],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => {
        const card = host.createDiv();
        card.createEl('button', {
          text: current.name,
          attr: { type: 'button', 'data-project-identity-control': '' },
        });
        card.createEl('button', {
          text: 'Open',
          attr: { type: 'button', 'aria-label': `Open ${current.name}` },
        });
        return card;
      },
      undo,
    });
    const stableStructure = {
      columns: el.querySelectorAll('[data-board-column]').length,
      cards: el.querySelectorAll('[data-board-item][draggable]').length,
    };

    const published = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    published.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    const undoTrigger = el.querySelector<HTMLButtonElement>('[data-board-undo]')!;
    undoTrigger.click();
    await flushMicrotasks();

    const busyRegion = el.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(busyRegion).not.toBeNull();
    expect(busyRegion?.textContent).toContain('Undo');
    expect({
      columns: el.querySelectorAll('[data-board-column]').length,
      cards: el.querySelectorAll('[data-board-item][draggable]').length,
    }).toEqual(stableStructure);
    expect(undoTrigger.disabled || undoTrigger.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-board-status-menu')).every(
        (control) => control.disabled || control.getAttribute('aria-disabled') === 'true',
      ),
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('[data-board-item][draggable]')).every(
        (surface) => surface.closest('[aria-disabled="true"]') === null,
      ),
    ).toBe(true);
    expect(
      Array.from(
        el.querySelectorAll<HTMLButtonElement>(
          '[data-project-identity-control], [aria-label^="Open "]',
        ),
      ).every((control) => !control.disabled && control.getAttribute('aria-disabled') !== 'true'),
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('[data-board-item][draggable]')).every(
        (surface) => surface.getAttribute('draggable') === 'false',
      ),
    ).toBe(true);

    const blockedCard = el.querySelector<HTMLElement>('[data-board-item="b"][draggable]')!;
    blockedCard.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(el.querySelector('.abyss-board-columns')?.classList.contains('is-drag-active')).toBe(
      false,
    );
    expect(el.querySelector('[data-board-terminal-drag-zone]')).toBeNull();
    published.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(move).toHaveBeenCalledOnce();

    pendingUndo.resolve({ type: 'ok', previousStatusId: 'active', nextStatusId: 'published' });
    await flushMicrotasks();
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();
    const settledUndo = el.querySelector<HTMLButtonElement>('[data-board-undo]');
    expect(
      settledUndo === null ||
        (!settledUndo.disabled && settledUndo.getAttribute('aria-disabled') !== 'true'),
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-board-status-menu')).some(
        (control) => !control.disabled && control.getAttribute('aria-disabled') !== 'true',
      ),
    ).toBe(true);

    el.querySelector<HTMLElement>('[data-board-item="b"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="published"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(move).toHaveBeenCalledTimes(2);
  });

  it.each([
    { context: 'a visible destination card', visible: 'all' as const, selected: 'published' },
    { context: 'a filtered terminal destination', visible: 'active' as const, selected: 'active' },
    {
      context: 'a responsive non-active destination',
      visible: 'all' as const,
      selected: 'active',
    },
  ])('focuses the stable busy toolbar for $context', async ({ visible, selected }) => {
    const item = { id: 'a', name: 'A' };
    const pendingUndo = deferred<{ type: 'ok'; previousStatusId: string; nextStatusId: string }>();
    const el = freshContainer();
    activeDocument.body.appendChild(el);
    const session: WorkNoteBoardSession = {
      selectedColumnKey: selected,
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    };
    const handle = renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: {
        move: vi.fn().mockResolvedValue({
          type: 'ok',
          previousStatusId: 'active',
          nextStatusId: 'published',
        }),
        menuItems: () => [],
      },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => {
        const card = host.createDiv();
        card.createEl('button', {
          text: current.name,
          attr: { type: 'button', 'data-project-identity-control': '' },
        });
        return card;
      },
      undo: () => pendingUndo.promise,
      session,
      ...(visible === 'active' ? { visibleColumnKeys: new Set(['active']) } : {}),
    });
    try {
      el.querySelector<HTMLElement>('[data-board-item="a"][draggable]')!.dispatchEvent(
        new Event('dragstart', { bubbles: true }),
      );
      el.querySelector<HTMLElement>('[data-board-column="published"]')!.dispatchEvent(
        new Event('drop', { bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      const undo = el.querySelector<HTMLButtonElement>('[data-board-undo]')!;
      undo.focus();
      undo.click();
      await flushMicrotasks();

      const toolbar = el.querySelector<HTMLElement>('.abyss-board-toolbar')!;
      expect(toolbar.isConnected).toBe(true);
      expect(toolbar.tabIndex).toBe(-1);
      expect(activeDocument.activeElement).toBe(toolbar);
      expect(toolbar.querySelector<HTMLElement>('[role="status"]')?.textContent).toBe(
        'Undoing status change…',
      );
      const currentUndo = toolbar.querySelector<HTMLButtonElement>('[data-board-undo]')!;
      expect(currentUndo.getAttribute('aria-label') ?? currentUndo.textContent).toBe('Undo');
    } finally {
      pendingUndo.resolve({
        type: 'ok',
        previousStatusId: 'active',
        nextStatusId: 'published',
      });
      await flushMicrotasks();
      handle.destroy();
      el.remove();
    }
  });

  it('keeps one compact toolbar host before and after Undo becomes available', async () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: { move: vi.fn().mockResolvedValue({ type: 'ok' }), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
    });
    const initialToolbar = el.querySelector<HTMLElement>('.abyss-board-toolbar')!;
    expect(el.querySelectorAll('.abyss-board-toolbar')).toHaveLength(1);
    const reservedBlockSize = getComputedStyle(initialToolbar).blockSize;

    el.querySelector<HTMLElement>('[data-board-item="a"][draggable]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="published"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    const currentToolbar = el.querySelector<HTMLElement>('.abyss-board-toolbar')!;
    expect(el.querySelectorAll('.abyss-board-toolbar')).toHaveLength(1);
    expect(currentToolbar.querySelector('[data-board-undo]')).not.toBeNull();
    expect(getComputedStyle(currentToolbar).blockSize).toBe(reservedBlockSize);
    expect(
      currentToolbar.compareDocumentPosition(el.querySelector('.abyss-board-columns')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('uses one canonical item order for the landing gap and optimistic destination', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    const onMutation = vi.fn();
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [a!, c!]), column('done', 'regular', [b!, d!])],
      canonicalItems: [a!, b!, c!, d!],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      onMutation,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    } satisfies BoardViewOptions<Item>);
    const card = el.querySelector<HTMLElement>('[data-board-item="c"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 560, 500);
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 160,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 11 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };

    pointer('pointerdown', 40);
    pointer('pointermove', 320);
    const destinationBeforeDrop = Array.from(
      done.querySelectorAll<HTMLElement>('[data-board-item-surface], [data-board-landing-gap]'),
    ).map((node) => node.dataset['boardItemSurface'] ?? 'gap');
    expect(destinationBeforeDrop).toEqual(['b', 'gap', 'd']);
    pointer('pointerup', 320);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(move).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith(c, 'done');
    expect(onMutation).toHaveBeenCalledOnce();
    const renderedDone = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    expect(
      Array.from(renderedDone.querySelectorAll<HTMLElement>('[data-board-item-surface]')).map(
        ({ dataset }) => dataset['boardItemSurface'],
      ),
    ).toEqual(['b', 'c', 'd']);
  });

  it('places a canonical landing gap by item identity inside a scrolled virtual window', () => {
    const targets = Array.from({ length: 40 }, (_, index) => ({
      id: `target-${String(index).padStart(2, '0')}`,
      name: `Target ${String(index)}`,
    }));
    const source = { id: 'source', name: 'Source' };
    const canonicalItems = [...targets.slice(0, 20), source, ...targets.slice(20)];
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [source]), column('done', 'regular', targets)],
      canonicalItems,
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const sourceCard = el.querySelector<HTMLElement>('[data-board-item="source"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const doneScroll = done.querySelector<HTMLElement>('.abyss-board-column-scroll')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    Object.defineProperty(doneScroll, 'clientHeight', { configurable: true, value: 352 });
    doneScroll.scrollTop = 18 * 88;
    doneScroll.dispatchEvent(new Event('scroll'));
    sourceCard.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 560, 500);
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 160,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 21 },
        isPrimary: { value: true },
      });
      sourceCard.dispatchEvent(event);
    };

    pointer('pointerdown', 40);
    pointer('pointermove', 320);

    const mounted = Array.from(
      done.querySelectorAll<HTMLElement>('[data-board-item-surface], [data-board-landing-gap]'),
      (node) => node.dataset['boardItemSurface'] ?? 'gap',
    );
    expect(mounted.indexOf('target-19')).toBeGreaterThanOrEqual(0);
    expect(mounted.slice(mounted.indexOf('target-19'), mounted.indexOf('target-19') + 3)).toEqual([
      'target-19',
      'gap',
      'target-20',
    ]);

    const topEl = freshContainer();
    renderBoard(topEl, {
      columns: [column('active', 'regular', [source]), column('done', 'regular', targets)],
      canonicalItems: [source, ...targets],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const topSource = topEl.querySelector<HTMLElement>('[data-board-item="source"]')!;
    const topActive = topEl.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const topDone = topEl.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const topDoneScroll = topDone.querySelector<HTMLElement>('.abyss-board-column-scroll')!;
    const topScroller = topEl.querySelector<HTMLElement>('.abyss-board-columns')!;
    Object.defineProperty(topDoneScroll, 'clientHeight', { configurable: true, value: 352 });
    topDoneScroll.scrollTop = 18 * 88;
    topDoneScroll.dispatchEvent(new Event('scroll'));
    topSource.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    topActive.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    topDone.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    topScroller.getBoundingClientRect = () => new DOMRect(0, 0, 560, 500);
    const topPointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 160,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 22 },
        isPrimary: { value: true },
      });
      topSource.dispatchEvent(event);
    };

    topPointer('pointerdown', 40);
    topPointer('pointermove', 320);

    expect(topDone.querySelector('[data-board-landing-gap]')).toBeNull();
  });

  it('uses visible compact tabs as pointer destinations when inactive columns have no box', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('done', 'regular')],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const doneTab = el.querySelector<HTMLElement>('[data-board-column-tab="done"]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 80, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    doneTab.getBoundingClientRect = () => new DOMRect(300, 20, 96, 44);
    scroller.getBoundingClientRect = () => new DOMRect(0, 80, 560, 500);
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 12 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };

    pointer('pointerdown', 40, 140);
    pointer('pointermove', 340, 42);
    expect(doneTab.classList.contains('is-board-active-destination')).toBe(true);
    expect(doneTab.querySelector('[data-board-landing-gap]')).not.toBeNull();
    expect(done.classList.contains('is-board-active-destination')).toBe(false);
    pointer('pointerup', 340, 42);
    await flushMicrotasks();

    expect(move).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith(item, 'done');
  });

  it('continues horizontal autoscroll while a picked pointer rests at the edge', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    const view = activeDocument.defaultView!;
    const frames: FrameRequestCallback[] = [];
    const request = vi
      .spyOn(view, 'requestAnimationFrame')
      .mockImplementation((callback) => (frames.push(callback), frames.length));
    vi.spyOn(view, 'cancelAnimationFrame').mockImplementation(() => undefined);
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('done', 'regular')],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 500);
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1200 },
    });
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 160,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 13 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };

    pointer('pointerdown', 40);
    pointer('pointermove', 295);
    const afterPointer = scroller.scrollLeft;
    expect(request).toHaveBeenCalled();
    frames.shift()?.(0);
    frames.shift()?.(16);
    expect(scroller.scrollLeft).toBeGreaterThan(afterPointer);
  });

  it('stops continuous autoscroll when the pointer leaves the board surface', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    const view = activeDocument.defaultView!;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(view, 'requestAnimationFrame').mockImplementation(
      (callback) => (frames.push(callback), frames.length),
    );
    const cancel = vi.spyOn(view, 'cancelAnimationFrame').mockImplementation(() => undefined);
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('done', 'regular')],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 500);
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1200 },
    });
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 160,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 14 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };

    pointer('pointerdown', 40);
    pointer('pointermove', 295);
    const afterPointer = scroller.scrollLeft;
    card.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    expect(cancel).toHaveBeenCalled();
    frames.shift()?.(0);
    expect(scroller.scrollLeft).toBe(afterPointer);
  });

  it('stops continuous autoscroll when the board rerenders', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    const view = activeDocument.defaultView!;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(view, 'requestAnimationFrame').mockImplementation(
      (callback) => (frames.push(callback), frames.length),
    );
    const cancel = vi.spyOn(view, 'cancelAnimationFrame').mockImplementation(() => undefined);
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('done', 'regular')],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 500);
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1200 },
    });
    const event = new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 40,
      clientY: 160,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: 15 },
      isPrimary: { value: true },
    });
    card.dispatchEvent(event);
    const move = new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 295,
      clientY: 160,
      button: 0,
    });
    Object.defineProperties(move, {
      pointerId: { value: 15 },
      isPrimary: { value: true },
    });
    card.dispatchEvent(move);

    el.querySelector<HTMLButtonElement>('[data-board-column-tab="done"]')!.click();

    expect(cancel).toHaveBeenCalled();
  });

  it('stops continuous autoscroll when the document becomes hidden', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    const view = activeDocument.defaultView!;
    vi.spyOn(view, 'requestAnimationFrame').mockImplementation(() => 101);
    const cancel = vi.spyOn(view, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const visibility = vi
      .spyOn(activeDocument, 'visibilityState', 'get')
      .mockReturnValue('visible');
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('done', 'regular')],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ name }) => name,
      interactionController: true,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const done = el.querySelector<HTMLElement>('[data-board-column="done"]')!;
    const scroller = el.querySelector<HTMLElement>('.abyss-board-columns')!;
    card.getBoundingClientRect = () => new DOMRect(20, 120, 220, 72);
    active.getBoundingClientRect = () => new DOMRect(0, 0, 272, 500);
    done.getBoundingClientRect = () => new DOMRect(280, 0, 272, 500);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 500);
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: 160,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: 16 },
        isPrimary: { value: true },
      });
      card.dispatchEvent(event);
    };
    pointer('pointerdown', 40);
    pointer('pointermove', 295);
    visibility.mockReturnValue('hidden');

    activeDocument.dispatchEvent(new Event('visibilitychange'));

    expect(cancel).toHaveBeenCalledWith(101);
  });
});
