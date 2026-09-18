import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskDiagnosticSink } from '../../src/tasks/application/TaskDependencyService';
import {
  MINIMUM_TRACKED_MS,
  TimeTrackingService,
  type TimeTrackingDependencies,
} from '../../src/tasks/application/TimeTrackingService';
import { clockFrom, systemClock, type Clock } from '../../src/tasks/domain/clock';
import type { TrackedEntry } from '../../src/tasks/domain/timeTracking';
import type { SubtaskSnapshot, TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  queryApiForTasks,
  task,
  taskQueryApi,
  useRealMoment,
} from '../helpers';

useRealMoment();

const OFFSET_MINUTES = 180;
const SECOND = 1000;
const SHORT_SESSION_MS = MINIMUM_TRACKED_MS / 2;
const LONG_SESSION_MS = MINIMUM_TRACKED_MS + SECOND;
/** 2026-09-18T14:05:32+03:00, the instant every fixture below is written against. */
const NOW_MS = Date.UTC(2026, 8, 18, 11, 5, 32);

function atomAt(offsetMs: number): string {
  return clockFrom(NOW_MS + offsetMs, OFFSET_MINUTES).read().atom;
}

const NOW_ATOM = atomAt(0);
const HOUR_AGO_ATOM = '2026-09-18T13:00:00+03:00';
const EARLIER_ATOM = '2026-09-18T12:30:00+03:00';
/** A hand-written entry whose start lies ahead of the clock, so no close can ever write it. */
const FUTURE_ATOM = '2026-09-19T09:00:00+03:00';

interface TestClock extends Clock {
  advance(milliseconds: number): void;
}

/** A clock the test drives, so no assertion depends on the machine's wall time or zone. */
function testClock(): TestClock {
  let nowMs = NOW_MS;
  const clock = systemClock(
    () => nowMs,
    () => OFFSET_MINUTES,
  );
  return {
    read: () => clock.read(),
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

type Stack = ReturnType<typeof configuredTaskApplication> & {
  readonly app: App;
  readonly clock: TestClock;
};

interface StackOptions {
  readonly authority?: boolean;
  readonly diagnostics?: TaskDiagnosticSink;
}

async function stackFor(files: Record<string, string>, options: StackOptions = {}): Promise<Stack> {
  const app = await createAppWithFiles(files);
  const clock = testClock();
  const authority = options.authority ?? true;
  const stack = configuredTaskApplication(app, DEFAULT_SETTINGS, {
    authority,
    clock,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  await stack.index.initialize();
  if (authority) {
    for (const [path, content] of Object.entries(files)) {
      stack.index.installCommittedContent(path, content);
    }
  }
  return { ...stack, app, clock };
}

async function read(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`missing ${path}`);
  return await app.vault.read(file);
}

function rootsIn(stack: Stack, path: string): readonly TaskSnapshot[] {
  return stack.index.list().filter((task) => task.source.filePath === path);
}

function rootIn(stack: Stack, path: string): TaskSnapshot {
  return expectDefined(rootsIn(stack, path)[0], `missing root in ${path}`);
}

function taskNode(root: TaskSnapshot): TaskNodeRef {
  return { type: 'task', ref: root.ref };
}

function subtaskNode(child: SubtaskSnapshot): TaskNodeRef {
  return { type: 'subtask', ref: child.ref };
}

function childOf(root: TaskSnapshot): SubtaskSnapshot {
  return expectDefined(root.subtasks[0]);
}

function active(stack: Stack): readonly TrackedEntry[] {
  return stack.tasks.queries.activeEntries();
}

function activeTitles(stack: Stack): readonly string[] {
  return active(stack).map((entry) => entry.title);
}

/** Rejects the vault write for one path so an orchestration step fails without touching others. */
function failWritesTo(app: App, path: string): void {
  const original = app.vault.process.bind(app.vault);
  vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
    if (file.path === path) throw new Error('disk full');
    return await original(file, fn, options);
  });
}

/** Records the path of every committed vault write, in order, so interleaving is observable. */
function recordWrites(app: App): readonly string[] {
  const written: string[] = [];
  const original = app.vault.process.bind(app.vault);
  vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
    written.push(file.path);
    return await original(file, fn, options);
  });
  return written;
}

/** Rejects every vault write after the first, so a follow-up write fails on its own. */
function failWritesAfterFirst(app: App): void {
  const original = app.vault.process.bind(app.vault);
  let writes = 0;
  vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
    writes += 1;
    if (writes > 1) throw new Error('disk full');
    return await original(file, fn, options);
  });
}

describe('time tracking orchestration', () => {
  it('writes the canonical open entry under an idle task', async () => {
    expect(NOW_ATOM).toBe('2026-09-18T14:05:32+03:00');
    const stack = await stackFor({ 'a.md': '- [ ] Alpha\n' });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await read(stack.app, 'a.md')).toBe(`- [ ] Alpha\n  - ${NOW_ATOM} →\n`);
      expect(activeTitles(stack)).toEqual(['Alpha']);
    } finally {
      stack.index.destroy();
    }
  });

  it('closes a timer in another file before opening the new one', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n`,
      'b.md': '- [ ] Bravo\n',
    });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'b.md')),
      });

      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(await read(stack.app, 'b.md')).toBe(`- [ ] Bravo\n  - ${NOW_ATOM} →\n`);
      expect(activeTitles(stack)).toEqual(['Bravo']);
    } finally {
      stack.index.destroy();
    }
  });

  it('rebases the second write when both nodes share one root block', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Bravo\n  - [ ] Alpha\n    - ${HOUR_AGO_ATOM} →\n`,
    });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Bravo\n  - [ ] Alpha\n    - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n  - ${NOW_ATOM} →\n`,
      );
      expect(activeTitles(stack)).toEqual(['Bravo']);
    } finally {
      stack.index.destroy();
    }
  });

  it('leaves a node that is already tracking untouched', async () => {
    const source = `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n`;
    const stack = await stackFor({ 'a.md': source });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', changed: false });
      expect(await read(stack.app, 'a.md')).toBe(source);
      expect(activeTitles(stack)).toEqual(['Alpha']);
    } finally {
      stack.index.destroy();
    }
  });

  it('reports a discarded session when the target is already tracking', async () => {
    const target = `- [ ] Target\n  - ${HOUR_AGO_ATOM} →\n`;
    const stack = await stackFor({
      'a.md': target,
      'b.md': `- [ ] Other\n  - ${atomAt(-SHORT_SESSION_MS)} →\n`,
    });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', discardedShortEntry: true },
      });
      expect(await read(stack.app, 'a.md')).toBe(target);
      expect(await read(stack.app, 'b.md')).toBe('- [ ] Other\n');
      expect(activeTitles(stack)).toEqual(['Target']);
    } finally {
      stack.index.destroy();
    }
  });

  it.each([false, true])(
    'starts from the root a previous command returned with authority %s',
    async (authority) => {
      const stack = await stackFor({ 'a.md': '- [ ] Alpha\n' }, { authority });
      try {
        const commented = await stack.tasks.execute({
          type: 'add-comment',
          parent: taskNode(rootIn(stack, 'a.md')),
          text: 'note',
        });
        if (commented.type !== 'ok' || commented.outcome.type !== 'task') {
          throw new Error(`expected a committed comment, saw ${commented.type}`);
        }

        const result = await stack.tasks.execute({
          type: 'start-tracking',
          parent: taskNode(commented.outcome.task),
        });

        expect(result).toMatchObject({ type: 'ok', changed: true });
        expect(await read(stack.app, 'a.md')).toBe(
          `- [ ] Alpha\n  - ${NOW_ATOM}: note\n  - ${NOW_ATOM} →\n`,
        );
        expect(activeTitles(stack)).toEqual(['Alpha']);
      } finally {
        stack.index.destroy();
      }
    },
  );

  it('skips a foreign entry it cannot close and still starts', async () => {
    const diagnostics = vi.fn();
    const foreign = `- [ ] Foreign\n  - ${FUTURE_ATOM} →\n`;
    const stack = await stackFor(
      {
        'a.md': foreign,
        'b.md': `- [ ] Other\n  - ${HOUR_AGO_ATOM} →\n`,
        'c.md': '- [ ] Alpha\n',
      },
      { diagnostics },
    );
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'c.md')),
      });

      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await read(stack.app, 'a.md')).toBe(foreign);
      expect(await read(stack.app, 'b.md')).toBe(
        `- [ ] Other\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(await read(stack.app, 'c.md')).toBe(`- [ ] Alpha\n  - ${NOW_ATOM} →\n`);
      expect([...activeTitles(stack)].sort((left, right) => left.localeCompare(right))).toEqual([
        'Alpha',
        'Foreign',
      ]);
      expect(diagnostics.mock.calls).toEqual([
        [{ operation: 'close-time-entry', phase: 'close-others', cause: 'conflict' }],
      ]);
    } finally {
      stack.index.destroy();
    }
  });

  it('skips a foreign entry it cannot close and still stops the rest', async () => {
    const diagnostics = vi.fn();
    const foreign = `- [ ] Foreign\n  - ${FUTURE_ATOM} →\n`;
    const stack = await stackFor(
      { 'a.md': foreign, 'b.md': `- [ ] Other\n  - ${HOUR_AGO_ATOM} →\n` },
      { diagnostics },
    );
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(foreign);
      expect(await read(stack.app, 'b.md')).toBe(
        `- [ ] Other\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(activeTitles(stack)).toEqual(['Foreign']);
      expect(diagnostics.mock.calls).toEqual([
        [{ operation: 'close-time-entry', phase: 'close-others', cause: 'conflict' }],
      ]);
    } finally {
      stack.index.destroy();
    }
  });

  it('aborts the start when closing another timer cannot be written', async () => {
    const stack = await stackFor({
      'b.md': `- [ ] Other\n  - ${HOUR_AGO_ATOM} →\n`,
      'c.md': '- [ ] Alpha\n',
    });
    failWritesTo(stack.app, 'b.md');
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'c.md')),
      });

      expect(result).toMatchObject({ type: 'io-error', path: 'b.md', contentState: 'unknown' });
      expect(await read(stack.app, 'c.md')).toBe('- [ ] Alpha\n');
      expect(activeTitles(stack)).toEqual(['Other']);
    } finally {
      vi.restoreAllMocks();
      stack.index.destroy();
    }
  });

  it('serializes tracking behind a dependency command on the shared queue', async () => {
    const stack = await stackFor({
      'a.md': '- [ ] Alpha\n',
      'b.md': `- [ ] Bravo\n  - ${HOUR_AGO_ATOM} →\n- [ ] Charlie\n`,
    });
    const writes = recordWrites(stack.app);
    try {
      const blocker = taskNode(rootIn(stack, 'b.md'));
      const dependent = taskNode(expectDefined(rootsIn(stack, 'b.md')[1]));
      const results = await Promise.all([
        stack.tasks.execute({ type: 'add-dependency', blocker, dependent }),
        stack.tasks.execute({ type: 'start-tracking', parent: taskNode(rootIn(stack, 'a.md')) }),
      ]);

      expect(results.map((result) => result.type)).toEqual(['ok', 'ok']);
      // The dependency batch commits before tracking reads, so closing Bravo's timer still matches
      // the line the dependency edit rewrote, and no write of either operation interleaves.
      expect(writes).toEqual(['b.md', 'b.md', 'a.md']);
      expect(await read(stack.app, 'b.md')).toBe(
        `- [ ] Bravo 🆔 00000000\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n- [ ] Charlie ⛔ 00000000\n`,
      );
      expect(await read(stack.app, 'a.md')).toBe(`- [ ] Alpha\n  - ${NOW_ATOM} →\n`);
      expect(activeTitles(stack)).toEqual(['Alpha']);
    } finally {
      vi.restoreAllMocks();
      stack.index.destroy();
    }
  });

  it('refuses to track a completed task', async () => {
    const source = '- [x] Alpha ✅ 2026-09-17\n';
    const stack = await stackFor({ 'a.md': source });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'time-entry' }],
      });
      expect(await read(stack.app, 'a.md')).toBe(source);
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('keeps one timer when two starts race', async () => {
    const stack = await stackFor({ 'a.md': '- [ ] Alpha\n', 'b.md': '- [ ] Bravo\n' });
    try {
      const results = await Promise.all([
        stack.tasks.execute({
          type: 'start-tracking',
          parent: taskNode(rootIn(stack, 'a.md')),
        }),
        stack.tasks.execute({
          type: 'start-tracking',
          parent: taskNode(rootIn(stack, 'b.md')),
        }),
      ]);

      expect(results.map((result) => result.type)).toEqual(['ok', 'ok']);
      const running = active(stack);
      expect(running).toHaveLength(1);
      const tracked = expectDefined(running[0]);
      const idle = tracked.filePath === 'a.md' ? 'b.md' : 'a.md';
      expect(await read(stack.app, tracked.filePath)).toContain(` - ${NOW_ATOM} →\n`);
      // The losing session lasted no time at all, so its line leaves no trace.
      expect(await read(stack.app, idle)).not.toContain('→');
    } finally {
      stack.index.destroy();
    }
  });

  it('discards a session under a minute and keeps a longer one', async () => {
    const stack = await stackFor({ 'a.md': '- [ ] Alpha\n' });
    try {
      await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });
      stack.clock.advance(SHORT_SESSION_MS);
      const discarded = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(discarded).toEqual({
        type: 'ok',
        changed: true,
        outcome: { type: 'stopped', discardedShortEntry: true },
      });
      expect(await read(stack.app, 'a.md')).toBe('- [ ] Alpha\n');
      expect(active(stack)).toEqual([]);

      await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'a.md')),
      });
      stack.clock.advance(LONG_SESSION_MS);
      const kept = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(kept).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Alpha\n  - ${atomAt(SHORT_SESSION_MS)} → ${atomAt(SHORT_SESSION_MS + LONG_SESSION_MS)}\n`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('closes every hand-written open entry on one stop', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Alpha\n  - ${EARLIER_ATOM} →\n  - ${HOUR_AGO_ATOM} →\n`,
    });
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Alpha\n  - ${EARLIER_ATOM} → ${NOW_ATOM}\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('reports nothing to stop without writing', async () => {
    const stack = await stackFor({ 'a.md': '- [ ] Alpha\n' });
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: false, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe('- [ ] Alpha\n');
    } finally {
      stack.index.destroy();
    }
  });

  it('stops after a failed start and reports the failure', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n`,
      'b.md': '- [ ] Bravo\n',
    });
    failWritesTo(stack.app, 'b.md');
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(rootIn(stack, 'b.md')),
      });

      expect(result).toMatchObject({ type: 'io-error', path: 'b.md', contentState: 'unknown' });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(await read(stack.app, 'b.md')).toBe('- [ ] Bravo\n');
      expect(active(stack)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      stack.index.destroy();
    }
  });

  it('closes a running entry when the task is completed', async () => {
    const stack = await stackFor({ 'a.md': `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n` });
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [x] Alpha ✅ 2026-09-18\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('closes a running entry when the task is cancelled', async () => {
    const stack = await stackFor({ 'a.md': `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n` });
    try {
      const result = await stack.tasks.execute({
        type: 'set-status',
        target: taskNode(rootIn(stack, 'a.md')),
        symbol: '-',
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [-] Alpha ❌ 2026-09-18\n  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('keeps the timer running when a status change is not a completion', async () => {
    const source = `- [x] Alpha ✅ 2026-09-17\n  - ${HOUR_AGO_ATOM} →\n`;
    const stack = await stackFor({ 'a.md': source });
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(await read(stack.app, 'a.md')).toBe(`- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n`);
      expect(activeTitles(stack)).toEqual(['Alpha']);
    } finally {
      stack.index.destroy();
    }
  });

  it('closes a subtask entry when its parent is completed', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Alpha\n  - [ ] Child\n    - ${HOUR_AGO_ATOM} →\n`,
    });
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [x] Alpha ✅ 2026-09-18\n  - [ ] Child\n    - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('leaves the next recurrence occurrence without any entries', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Repeat 🔁 every day 📅 2026-09-18\n  - ${HOUR_AGO_ATOM} →\n`,
    });
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'recurrence' } });
      const [next, completed] = rootsIn(stack, 'a.md');
      expect(expectDefined(next).status).toBe('open');
      expect(expectDefined(next).timeEntries).toEqual([]);
      expect(expectDefined(completed).status).toBe('done');
      expect(expectDefined(completed).timeEntries).toMatchObject([{ state: 'closed' }]);
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('keeps a completed status when its tracking follow-up fails', async () => {
    const diagnostics = vi.fn();
    const stack = await stackFor(
      { 'a.md': `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} →\n` },
      { diagnostics },
    );
    failWritesAfterFirst(stack.app);
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [x] Alpha ✅ 2026-09-18\n  - ${HOUR_AGO_ATOM} →\n`,
      );
      expect(diagnostics.mock.calls).toEqual([
        [{ operation: 'close-time-entry', phase: 'completion-follow-up', cause: 'io-error' }],
      ]);
      expect(activeTitles(stack)).toEqual(['Alpha']);
    } finally {
      vi.restoreAllMocks();
      stack.index.destroy();
    }
  });

  it('starts on a subtask that a sibling timer does not own', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Alpha\n  - [ ] One\n    - ${HOUR_AGO_ATOM} →\n  - [ ] Two\n`,
    });
    try {
      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: subtaskNode(expectDefined(rootIn(stack, 'a.md').subtasks[1])),
      });

      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Alpha\n  - [ ] One\n    - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n  - [ ] Two\n    - ${NOW_ATOM} →\n`,
      );
      expect(activeTitles(stack)).toEqual(['Two']);
      expect(childOf(rootIn(stack, 'a.md')).timeEntries).toMatchObject([{ state: 'closed' }]);
    } finally {
      stack.index.destroy();
    }
  });
});

/** A root whose only entry is still running, built without touching the vault. */
function trackedRoot(statusSymbol: string): TaskSnapshot {
  return task({
    title: 'Alpha',
    statusSymbol,
    status: statusSymbol === 'x' ? 'done' : 'open',
    timeEntries: [
      {
        relativeLine: 1,
        originalMarkdown: `  - ${HOUR_AGO_ATOM} →`,
        state: 'running',
        startMs: NOW_MS - 3600 * SECOND,
      },
    ],
  });
}

function trackingService(
  overrides: Partial<TimeTrackingDependencies> & Pick<TimeTrackingDependencies, 'edit'>,
): TimeTrackingService {
  const queries = overrides.queries ?? taskQueryApi();
  return new TimeTrackingService({
    queries,
    resolveRoot: (ref) => queries.resolve(ref),
    statusOf: (symbol) => (symbol === 'x' ? 'done' : 'open'),
    serialize: async (operation) => await operation(),
    diagnostics: () => {},
    ...overrides,
  });
}

describe('time tracking service guards', () => {
  it('starts against the root a rebased resolution returns', async () => {
    const previous = task({ title: 'Alpha' });
    const current = task({
      title: 'Alpha',
      source: { line: 4 },
      ref: { line: 4, revision: 'relocated' },
    });
    const edit = vi
      .fn()
      .mockResolvedValue({ type: 'ok', changed: true, outcome: { type: 'task', task: current } });
    const service = trackingService({
      edit,
      resolveRoot: () => ({
        type: 'rebased',
        previous,
        current,
        evidence: 'byte-identical-relocation',
        basis: { observed: previous },
      }),
    });

    const result = await service.start(
      { type: 'task', ref: previous.ref },
      clockFrom(NOW_MS, OFFSET_MINUTES).read(),
    );

    expect(result).toMatchObject({ type: 'ok', changed: true });
    expect(edit).toHaveBeenCalledWith({
      type: 'add-time-entry',
      parent: { type: 'task', ref: current.ref },
      stamp: NOW_ATOM,
    });
  });

  it('closes nothing when the committed node does not read as completed', async () => {
    const edit = vi.fn();
    const reading = clockFrom(NOW_MS, OFFSET_MINUTES).read();
    const open = trackedRoot(' ');

    await trackingService({ edit }).closeAfterCompletion(
      open,
      { type: 'task', ref: open.ref },
      reading,
    );

    expect(edit).not.toHaveBeenCalled();
  });

  it('closes the subtree when the committed node does read as completed', async () => {
    const edit = vi.fn().mockResolvedValue({ type: 'conflict', current: trackedRoot('x') });
    const reading = clockFrom(NOW_MS, OFFSET_MINUTES).read();
    const done = trackedRoot('x');

    await trackingService({ edit }).closeAfterCompletion(
      done,
      { type: 'task', ref: done.ref },
      reading,
    );

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toMatchObject({ type: 'close-time-entry' });
  });

  it('surfaces a committed close whose outcome carries no root', async () => {
    const running = trackedRoot(' ');
    const surprising = { type: 'ok', changed: true, outcome: { type: 'stopped' } } as const;
    const edit = vi.fn().mockResolvedValue(surprising);
    const service = trackingService({ edit, queries: queryApiForTasks(() => [running]) });

    const result = await service.stopAll(clockFrom(NOW_MS, OFFSET_MINUTES).read());

    expect(result).toEqual(surprising);
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
