import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimedBlockFocusRetention } from '../src/panels/calendar/timedBlockFocusRetention';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import { task, taskQueryApi } from './helpers';

function okTask(snapshot: TaskSnapshot, changed = true): TaskCommandResult {
  return { type: 'ok', changed, outcome: { type: 'task', task: snapshot } };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

// The attributes `renderTimedBlocks.ts` puts on a timed block; the retention reads only these.
function block(root: HTMLElement, snapshot: TaskSnapshot, segmentDate = '2026-09-23'): HTMLElement {
  return root.createDiv({
    cls: 'abyss-tg-block',
    attr: {
      tabindex: '0',
      'data-abyss-task-file': snapshot.source.filePath,
      'data-abyss-task-line': String(snapshot.source.line),
      'data-tg-segment-date': segmentDate,
    },
  });
}

interface PendingFocus {
  readonly filePath: string;
  readonly line: number;
  readonly queueSequence?: number;
}

/** The restorations the retention has reserved but not yet run. */
function restorations(retention: TimedBlockFocusRetention): ReadonlyMap<number, unknown> {
  return (retention as unknown as { pendingRestorations_abyssPrivate: Map<number, unknown> })
    .pendingRestorations_abyssPrivate;
}

function harness(options: { active?: boolean; execute?: TaskApplicationApi['execute'] } = {}): {
  root: HTMLElement;
  retention: TimedBlockFocusRetention;
  follow: ReturnType<typeof vi.fn>;
  execute: TaskApplicationApi['execute'];
  pending(): PendingFocus | undefined;
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
  const retention = new TimedBlockFocusRetention(tasks, {
    isCalendarActive: () => options.active ?? true,
    root: () => root,
    follow,
  });
  return {
    root,
    retention,
    follow,
    execute,
    pending: () =>
      (retention as unknown as { pendingFocus_abyssPrivate?: PendingFocus })
        .pendingFocus_abyssPrivate,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.empty();
});

describe('TimedBlockFocusRetention intents', () => {
  it('does nothing without an application or a mounted root', () => {
    const root = document.body.createDiv();
    const orphan = new TimedBlockFocusRetention(undefined, {
      isCalendarActive: () => true,
      root: () => root,
      follow: vi.fn(),
    });
    orphan.handleIntent(task(), { type: 'move-time', deltaMinutes: 15 });
    expect(orphan.hasPending()).toBe(false);
    const unmounted = new TimedBlockFocusRetention(
      { queries: taskQueryApi(), execute: vi.fn() },
      { isCalendarActive: () => true, root: () => null, follow: vi.fn() },
    );
    unmounted.handleIntent(task(), { type: 'move-time', deltaMinutes: 15 });
    expect(unmounted.hasPending()).toBe(false);
  });

  it('accepts an intent from a focused block, executes it, and keeps the focus pending', async () => {
    const h = harness();
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 15 });
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
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 15 });
    await settle();
    // The query patch replaces the block: prepare, render, defer, then the timer restores focus.
    h.retention.beforeViewUpdate();
    const generation = h.retention.beginRender();
    origin.remove();
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    expect(document.activeElement).not.toBe(replacement);
    vi.runOnlyPendingTimers();
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
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 15 });
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
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 15 });
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
    h.retention.handleIntent(first, { type: 'move-time', deltaMinutes: 15 });
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

  it('reserves nothing when the container has no owning window', async () => {
    vi.useFakeTimers();
    const h = harness();
    const snapshot = task({ planning: { due: '2026-09-23', time: '09:00' } });
    const origin = block(h.root, snapshot);
    origin.focus();
    h.retention.handleIntent(snapshot, { type: 'move-time', deltaMinutes: 15 });
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
    expect(restorations(h.retention).size).toBe(0);
    // The same pending focus against a container with a window does reserve and schedule.
    const replacement = block(h.root, snapshot);
    h.retention.deferFocus(h.root, generation);
    expect(restorations(h.retention).size).toBe(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(replacement);
  });
});
