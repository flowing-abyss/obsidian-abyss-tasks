import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimedBlockFocusRetention } from '../src/panels/calendar/timedBlockFocusRetention';
import {
  localTime,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskSnapshot,
} from '../src/tasks';
import { CalendarEditQueue } from '../src/ui/calendarEditQueue';
import { applyTaskNodePresentationIdentity } from '../src/ui/taskPresentationIdentity';
import { deferred, expectDefined, task, taskQueryApi } from './helpers';

function okTask(snapshot: TaskSnapshot, changed = true): TaskCommandResult {
  return { type: 'ok', changed, outcome: { type: 'task', task: snapshot } };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

// The attributes `renderTimedBlocks.ts` puts on a timed block; the retention reads only these.
function block(root: HTMLElement, snapshot: TaskSnapshot, segmentDate = '2026-09-23'): HTMLElement {
  const element = root.createDiv({
    cls: 'abyss-tg-block',
    attr: {
      tabindex: '0',
      'data-abyss-task-file': snapshot.source.filePath,
      'data-abyss-task-line': String(snapshot.source.line),
      'data-tg-segment-date': segmentDate,
    },
  });
  applyTaskNodePresentationIdentity(element, { type: 'task', ref: snapshot.ref });
  return element;
}

// A forecast timed block: the same locator attributes, focusable only programmatically.
function forecastBlock(
  root: HTMLElement,
  snapshot: TaskSnapshot,
  segmentDate = '2026-09-23',
): HTMLElement {
  const element = block(root, snapshot, segmentDate);
  element.setAttribute('tabindex', '-1');
  element.setAttribute('data-occurrence-state', 'forecast');
  return element;
}

function harness(
  options: {
    active?: boolean;
    execute?: TaskApplicationApi['execute'];
    shared?: boolean;
    holdPublication?: () => () => void;
  } = {},
): {
  root: HTMLElement;
  retention: TimedBlockFocusRetention;
  follow: ReturnType<typeof vi.fn>;
  execute: TaskApplicationApi['execute'];
  editQueue: CalendarEditQueue | undefined;
  pending(): TimedBlockFocusRetention['pendingFocus_abyssPrivate'];
} {
  const root = document.body.createDiv();
  const follow = vi.fn();
  const execute =
    options.execute ??
    vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      const ref = 'ref' in command ? command.ref : undefined;
      return okTask(task({ source: { filePath: ref?.filePath ?? 'f.md', line: ref?.line ?? 0 } }));
    });
  const tasks: TaskApplicationApi = { queries: taskQueryApi(), execute };
  const editQueue = options.shared === true ? new CalendarEditQueue(tasks) : undefined;
  const retention = new TimedBlockFocusRetention(tasks, {
    ...(editQueue !== undefined && { editQueue }),
    ...(options.holdPublication !== undefined && { holdPublication: options.holdPublication }),
    isCalendarActive: () => options.active ?? true,
    root: () => root,
    follow,
  });
  return {
    root,
    retention,
    follow,
    execute,
    editQueue,
    pending: () => retention['pendingFocus_abyssPrivate'],
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.empty();
});

describe('TimedBlockFocusRetention intents', () => {
  it.each([false, true])(
    'restores submitted pointer focus before the next native key (after settled key: %s)',
    async (afterKey) => {
      const original = task({ planning: { due: '2026-09-23', time: '09:00' } });
      const keyed: TaskSnapshot = {
        ...original,
        ref: { ...original.ref, revision: 'keyed' },
        planning: { ...original.planning, time: localTime('09:05') },
      };
      const h = harness({
        execute: vi.fn<TaskApplicationApi['execute']>().mockResolvedValue(okTask(keyed)),
      });
      block(h.root, original).focus();
      if (afterKey) {
        h.retention.handleIntent(original, { type: 'move-time', deltaMinutes: 5 });
        await settle();
        h.retention.beforeViewUpdate();
        const generation = h.retention.beginRender();
        h.root.empty();
        const replacement = block(h.root, keyed);
        h.retention.deferFocus(h.root, generation);
        expect(document.activeElement).toBe(replacement);
        expect(h.retention.hasPending()).toBe(false);
      }
      const current = afterKey ? keyed : original;
      await h.retention.settlePointerTask(current, '2026-09-24');
      h.retention.captureActiveFocus(h.root);
      h.retention.beforeViewUpdate(false);
      const generation = h.retention.beginRender();
      h.root.empty();
      const submitted = block(h.root, current, '2026-09-24');
      h.retention.deferFocus(h.root, generation);
      expect(document.activeElement).toBe(submitted);
    },
  );

  it('restores the exact canonical source when a valid shared no-op releases publication', async () => {
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    let replacement: HTMLElement | undefined;
    const release = vi.fn(() => {
      h.retention.beforeViewUpdate();
      const generation = h.retention.beginRender();
      h.root.empty();
      replacement = block(h.root, snapshot);
      h.retention.deferFocus(h.root, generation);
    });
    const h = harness({ shared: true, holdPublication: () => release });
    h.root.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement) h.retention.retain(event.target);
    });
    block(h.root, snapshot).focus();
    h.retention.handleIntent(snapshot, { type: 'extend-due', days: -1 });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(replacement);
    expect(h.retention.hasPending()).toBe(false);
  });

  it('keeps a settled no-op target until another hold permits canonical publication', async () => {
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const release = vi.fn();
    const h = harness({ shared: true, holdPublication: () => release });
    block(h.root, snapshot).focus();
    h.retention.handleIntent(snapshot, { type: 'extend-due', days: -1 });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
    });
    expect(h.retention.hasPending()).toBe(true);
    h.retention.beforeViewUpdate();
    const generation = h.retention.beginRender();
    h.root.empty();
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).toBe(replacement);
    expect(h.retention.hasPending()).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('keeps projected no-op focus on its origin before publishing the exact canonical successor', async () => {
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const successor: TaskSnapshot = {
      ...snapshot,
      ref: { ...snapshot.ref, line: 1, revision: 'canonical' },
      source: { ...snapshot.source, line: 1 },
      planning: { ...snapshot.planning, time: localTime('09:15') },
    };
    const gate = deferred<TaskCommandResult>();
    const release = vi.fn();
    const h = harness({
      shared: true,
      execute: vi.fn<TaskApplicationApi['execute']>().mockReturnValue(gate.promise),
      holdPublication: () => release,
    });
    h.root.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement) h.retention.retain(event.target);
    });
    block(h.root, snapshot).focus();
    const pointer = expectDefined(h.editQueue).execute(snapshot, (current) => ({
      type: 'patch',
      target: { type: 'task', ref: current.ref },
      patch: { time: { type: 'set', value: localTime('09:15') } },
    }));
    h.retention.handleIntent(snapshot, { type: 'extend-due', days: -1 });
    gate.resolve(okTask(successor));
    await pointer;
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
    });
    h.retention.beforeViewUpdate(false);
    let generation = h.retention.beginRender();
    h.root.empty();
    const submitted = block(h.root, snapshot);
    block(h.root, { ...successor, ref: { ...successor.ref, revision: 'neighbor' } });
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).toBe(submitted);
    expect(h.retention.hasPending()).toBe(true);
    h.retention.beforeViewUpdate();
    generation = h.retention.beginRender();
    h.root.empty();
    const canonical = block(h.root, successor);
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).toBe(canonical);
    expect(h.retention.hasPending()).toBe(false);
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'does not restore a no-op onto a foreign replacement at the same file and line (missing ref: %s)',
    async (missingRef) => {
      const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
      const release = vi.fn();
      const h = harness({ shared: true, holdPublication: () => release });
      block(h.root, snapshot).focus();
      h.retention.handleIntent(snapshot, { type: 'extend-due', days: -1 });
      await vi.waitFor(() => {
        expect(release).toHaveBeenCalledOnce();
      });
      expect(h.retention.hasPending()).toBe(true);
      h.retention.beforeViewUpdate();
      const generation = h.retention.beginRender();
      h.root.empty();
      const replacement = block(h.root, {
        ...snapshot,
        ref: { ...snapshot.ref, revision: 'foreign' },
      });
      if (missingRef) replacement.removeAttribute('data-abyss-task-node-ref-key');
      h.retention.deferFocus(h.root, generation);
      expect(document.activeElement).not.toBe(replacement);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it('supersedes a no-op target when a later intent in the same sequence commits', async () => {
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const updated: TaskSnapshot = {
      ...snapshot,
      ref: { ...snapshot.ref, revision: 'committed' },
      planning: { ...snapshot.planning, time: localTime('09:05') },
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue(okTask(updated));
    const h = harness({ shared: true, execute });
    block(h.root, snapshot).focus();
    h.retention.handleIntent(snapshot, { type: 'extend-due', days: -1 });
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 5 });
    await vi.waitFor(() => {
      expect(h.retention['settledSequences_abyssPrivate'].size).toBe(1);
    });
    h.retention.beforeViewUpdate();
    const generation = h.retention.beginRender();
    h.root.empty();
    const replacement = block(h.root, updated);
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).toBe(replacement);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.retention.hasPending()).toBe(false);
  });

  it.each([0, 1])(
    'does not restore an absent submitted source onto another root at line %s',
    async (line) => {
      const gate = deferred<TaskCommandResult>();
      const original = task({
        ref: { filePath: 'focus.md', line: 0, revision: 'original' },
        source: { filePath: 'focus.md', line: 0 },
        planning: { due: '2026-09-23', time: '09:00' },
      });
      const moved: TaskSnapshot = {
        ...original,
        ref: { ...original.ref, line: 1, revision: 'moved' },
        source: { ...original.source, line: 1 },
        planning: { ...original.planning, time: localTime('09:05') },
      };
      const h = harness({
        execute: vi.fn<TaskApplicationApi['execute']>().mockReturnValue(gate.promise),
      });
      const origin = block(h.root, original);
      applyTaskNodePresentationIdentity(origin, { type: 'task', ref: original.ref });
      origin.focus();
      h.retention.handleIntent(original, { type: 'move-time', deltaMinutes: 5 });
      const settlement = h.retention.settlePointerTask(original);
      gate.resolve(okTask(moved));
      await settlement;
      await settle();
      h.retention.beforeViewUpdate(false);
      const generation = h.retention.beginRender();
      origin.remove();
      const other = task({
        ref: { filePath: 'focus.md', line, revision: 'replacement' },
        source: { filePath: 'focus.md', line },
      });
      const replacement = block(h.root, other);
      applyTaskNodePresentationIdentity(replacement, { type: 'task', ref: other.ref });
      h.retention.deferFocus(h.root, generation);
      expect(document.activeElement).not.toBe(replacement);
    },
  );

  it('does nothing without an application or a mounted root', () => {
    const root = document.body.createDiv();
    const orphan = new TimedBlockFocusRetention(undefined, {
      isCalendarActive: () => true,
      root: () => root,
      follow: vi.fn(),
    });
    orphan.handleIntent(task(), { type: 'move-time', deltaMinutes: 5 });
    expect(orphan.hasPending()).toBe(false);
    const unmounted = new TimedBlockFocusRetention(
      { queries: taskQueryApi(), execute: vi.fn() },
      { isCalendarActive: () => true, root: () => null, follow: vi.fn() },
    );
    unmounted.handleIntent(task(), { type: 'move-time', deltaMinutes: 5 });
    expect(unmounted.hasPending()).toBe(false);
  });

  it('accepts an intent from a focused block, executes it, and keeps the focus pending', async () => {
    const h = harness();
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 5 });
    expect(h.retention.hasPending()).toBe(true);
    expect(h.pending()?.queueSequence).toBe(1);
    await settle();
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it('restores focus onto the re-rendered block after a commit', async () => {
    vi.useFakeTimers();
    const h = harness();
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 5 });
    await settle();
    // A committed query patch replaces and focuses the block before another native key can land.
    h.retention.beforeViewUpdate();
    const generation = h.retention.beginRender();
    origin.remove();
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).toBe(replacement);
    expect(replacement.classList.contains('is-selected')).toBe(true);
  });

  it('follows a schedule shift with the shifted segment date', async () => {
    const h = harness();
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    block(h.root, snapshot, '2026-09-23').focus();
    h.retention.handleIntent(snapshot, { type: 'shift-schedule', days: 1 });
    await settle();
    expect(h.follow).toHaveBeenCalledOnce();
    expect(h.follow.mock.calls[0]?.[1]).toBe('2026-09-24');
  });

  it.each([
    ['2026-09-25', '2026-09-24'],
    ['2026-09-23', '2026-09-23'],
  ])(
    'keeps focus from %s on surviving segment %s after shortening',
    async (originDate, expectedDate) => {
      const original = task({
        planning: { start: '2026-09-22', due: '2026-09-25', time: '09:00' },
      });
      const updated = task({ planning: { start: '2026-09-22', due: '2026-09-24', time: '09:00' } });
      const h = harness({
        execute: vi.fn<TaskApplicationApi['execute']>().mockResolvedValue(okTask(updated)),
      });
      const origin = block(h.root, original, originDate);
      origin.focus();
      h.retention.handleIntent(original, { type: 'extend-due', days: -1 });
      await settle();
      h.retention.beforeViewUpdate();
      const generation = h.retention.beginRender();
      origin.remove();
      const replacement = block(h.root, updated, expectedDate);
      h.retention.deferFocus(h.root, generation);
      expect(document.activeElement).toBe(replacement);
      if (originDate !== expectedDate)
        expect(h.follow).toHaveBeenCalledWith(expect.anything(), expectedDate);
      else expect(h.follow).not.toHaveBeenCalled();
    },
  );

  it('clears the pending focus when a sequence settles without changes', async () => {
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      const ref = 'ref' in command ? command.ref : undefined;
      return okTask(
        task({ source: { filePath: ref?.filePath ?? 'f.md', line: ref?.line ?? 0 } }),
        false,
      );
    });
    const h = harness({ execute });
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    block(h.root, snapshot).focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 5 });
    await settle();
    expect(h.retention.hasPending()).toBe(false);
  });

  it('clears the pending focus when the command fails', async () => {
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const h = harness({ execute });
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    block(h.root, snapshot).focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 5 });
    await settle();
    expect(h.retention.hasPending()).toBe(false);
  });
});

describe('TimedBlockFocusRetention focus capture', () => {
  it('captures the focused block and restores it after a rebuild, then forgets it', () => {
    vi.useFakeTimers();
    const h = harness();
    const snapshot = task();
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.captureActiveFocus(h.root);
    expect(h.retention.hasPending()).toBe(true);
    expect(h.pending()?.queueSequence).toBeUndefined();
    const generation = h.retention.beginRender();
    origin.remove();
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(replacement);
    expect(replacement.classList.contains('is-selected')).toBe(true);
    expect(h.retention.hasPending()).toBe(false);
  });

  it('restores focus onto a rebuilt forecast block without selecting it', () => {
    vi.useFakeTimers();
    const h = harness();
    const snapshot = task();
    const origin = forecastBlock(h.root, snapshot);
    origin.focus();
    h.retention.captureActiveFocus(h.root);
    expect(h.retention.hasPending()).toBe(true);
    const generation = h.retention.beginRender();
    origin.remove();
    const replacement = forecastBlock(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(replacement);
    expect(replacement.classList.contains('is-selected')).toBe(false);
    expect(h.retention.hasPending()).toBe(false);
  });

  it('ignores focus outside a timed block and outside the root', () => {
    const h = harness();
    const outside = document.body.createDiv({ attr: { tabindex: '0' } });
    outside.focus();
    h.retention.captureActiveFocus(h.root);
    expect(h.retention.hasPending()).toBe(false);
    const plain = h.root.createDiv({ attr: { tabindex: '0' } });
    plain.focus();
    h.retention.captureActiveFocus(h.root);
    expect(h.retention.hasPending()).toBe(false);
  });

  it('retains a different block before the commit and replaces the origin', async () => {
    const first = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const second = task({
      planning: { due: '2026-09-23', time: '10:00' },
      source: { filePath: 'g.md', line: 4 },
    });
    let release: (() => void) | undefined;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((resolve) => {
          release = () => {
            resolve(okTask(first));
          };
        }),
    );
    const h = harness({ execute });
    block(h.root, first).focus();
    h.retention.handleIntent(first, { type: 'move-time', deltaMinutes: 5 });
    const other = block(h.root, second);
    h.retention.retain(other);
    expect(h.pending()?.filePath).toBe('g.md');
    expect(h.pending()?.line).toBe(4);
    expect(h.pending()?.queueSequence).toBeUndefined();
    release?.();
    await settle();
    expect(h.pending()?.filePath).toBe('g.md');
  });

  it('cancel forgets the pending focus and invalidates scheduled restorations', () => {
    vi.useFakeTimers();
    const h = harness();
    const snapshot = task();
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.captureActiveFocus(h.root);
    const generation = h.retention.beginRender();
    origin.remove();
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    h.retention.cancel();
    expect(h.retention.hasPending()).toBe(false);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).not.toBe(replacement);
  });

  it('skips the restoration when the calendar is no longer active or the generation moved on', () => {
    vi.useFakeTimers();
    const inactive = harness({ active: false });
    const snapshot = task();
    const origin = block(inactive.root, snapshot);
    origin.focus();
    inactive.retention.captureActiveFocus(inactive.root);
    const generation = inactive.retention.beginRender();
    origin.remove();
    const replacement = block(inactive.root, snapshot);
    inactive.retention.deferFocus(inactive.root, generation);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).not.toBe(replacement);

    const stale = harness();
    const staleOrigin = block(stale.root, snapshot);
    staleOrigin.focus();
    stale.retention.captureActiveFocus(stale.root);
    const staleGeneration = stale.retention.beginRender();
    staleOrigin.remove();
    const staleReplacement = block(stale.root, snapshot);
    stale.retention.deferFocus(stale.root, staleGeneration);
    stale.retention.beginRender();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).not.toBe(staleReplacement);
  });

  it('waits for an owning window before restoring committed focus', async () => {
    vi.useFakeTimers();
    const h = harness();
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 5 });
    await settle();
    // A document created through the DOM API has no window, so its elements have no timers.
    const foreign = document.implementation.createHTMLDocument();
    expect(foreign.defaultView).toBeNull();
    const container = document.body.createDiv();
    block(container, snapshot);
    foreign.body.append(foreign.adoptNode(container));
    expect(container.ownerDocument).toBe(foreign);
    h.retention.beforeViewUpdate();
    const generation = h.retention.beginRender();
    origin.remove();
    const scheduled = vi.getTimerCount();
    h.retention.deferFocus(container, generation);
    expect(vi.getTimerCount()).toBe(scheduled);
    expect(h.retention.hasPending()).toBe(true);
    // A committed replacement in the owning window is focused within the publication turn.
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).toBe(replacement);
  });
});
