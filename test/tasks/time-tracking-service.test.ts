import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskCommandResult } from '../../src/tasks';
import type { TaskDiagnosticSink } from '../../src/tasks/application/TaskDependencyService';
import type { TaskEditCommand } from '../../src/tasks/application/TaskRepository';
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
  subtask,
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

  it('starts from a stale root the index rebases and writes under that task', async () => {
    const committed = '# Heading\n- [ ] Alpha\n- [ ] Bravo\n';
    const stack = await stackFor({ 'a.md': committed });
    try {
      // An earlier generation of the same file, so the ref a caller kept points at a root the
      // index has since relocated byte for byte under the authority.
      stack.index.installCommittedContent('a.md', '- [ ] Alpha\n- [ ] Bravo\n');
      const stale = rootIn(stack, 'a.md');
      stack.index.installCommittedContent('a.md', committed);
      expect(stack.tasks.queries.resolve(stale.ref)).toMatchObject({
        type: 'rebased',
        evidence: 'byte-identical-relocation',
      });

      const result = await stack.tasks.execute({
        type: 'start-tracking',
        parent: taskNode(stale),
      });

      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await read(stack.app, 'a.md')).toBe(
        `# Heading\n- [ ] Alpha\n  - ${NOW_ATOM} →\n- [ ] Bravo\n`,
      );
      expect(activeTitles(stack)).toEqual(['Alpha']);
    } finally {
      stack.index.destroy();
    }
  });

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

  it('closes a short session that carries a tail rather than dropping the note on it', async () => {
    const tailed = `  - ${atomAt(-SHORT_SESSION_MS)} \u2192 what I was doing`;
    const stack = await stackFor({ 'a.md': `- [ ] Alpha\n${tailed}\n` });
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [ ] Alpha\n  - ${atomAt(-SHORT_SESSION_MS)} \u2192 ${NOW_ATOM} what I was doing\n`,
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

  it('says so when completing a task drops the session it was running', async () => {
    const stack = await stackFor({
      'a.md': `- [ ] Alpha\n  - ${atomAt(-SHORT_SESSION_MS)} \u2192\n`,
    });
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({
        type: 'ok',
        outcome: { type: 'task', discardedShortEntry: true },
      });
      expect(await read(stack.app, 'a.md')).toBe('- [x] Alpha \u2705 2026-09-18\n');
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('keeps a completion silent when the session it closed was worth recording', async () => {
    const stack = await stackFor({ 'a.md': `- [ ] Alpha\n  - ${HOUR_AGO_ATOM} \u2192\n` });
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(result).not.toMatchObject({ outcome: { discardedShortEntry: true } });
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

  it('closes the timers it can when a completed subtree holds one it cannot', async () => {
    const diagnostics = vi.fn();
    const stack = await stackFor(
      {
        'a.md': `- [ ] Alpha\n  - [ ] Foreign\n    - ${FUTURE_ATOM} →\n  - [ ] Mine\n    - ${HOUR_AGO_ATOM} →\n`,
      },
      { diagnostics },
    );
    try {
      const result = await stack.tasks.execute({
        type: 'toggle-completion',
        target: taskNode(rootIn(stack, 'a.md')),
      });

      expect(result).toMatchObject({ type: 'ok', outcome: { type: 'task' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `- [x] Alpha ✅ 2026-09-18\n  - [ ] Foreign\n    - ${FUTURE_ATOM} →\n  - [ ] Mine\n    - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(activeTitles(stack)).toEqual(['Foreign']);
      expect(diagnostics.mock.calls).toEqual([
        [{ operation: 'close-time-entry', phase: 'close-others', cause: 'conflict' }],
      ]);
    } finally {
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

/** The running entry a close rewrites, and the text that entry leaves behind once it is closed. */
const KEPT_OPEN = `  - ${HOUR_AGO_ATOM} →\n`;
const KEPT_CLOSED = `  - ${HOUR_AGO_ATOM} → ${NOW_ATOM}\n`;
/** A session under a minute, so closing it removes the line and shifts everything below it up. */
const SHORT_OPEN = `  - ${atomAt(-SHORT_SESSION_MS)} →\n`;
/** The mock metadata parser reads a root list that begins on line zero as its own child. */
const LEAD = '\n';

/**
 * A write to one root shifts the revision of every root below it in the same file, because a root
 * is anchored on its predecessor. These cover the target the tracking service has to find again
 * after its own close pass moved it, which is the ordinary case inside one project note.
 */
describe.each([
  { label: 'a kept session', open: KEPT_OPEN, left: KEPT_CLOSED, discarded: false },
  { label: 'a discarded session', open: SHORT_OPEN, left: '', discarded: true },
])('starting in a file its own close pass rewrote, with $label', ({ open, left, discarded }) => {
  const outcome = discarded ? { type: 'task', discardedShortEntry: true } : { type: 'task' };

  it.each([false, true])(
    'starts the root below the running one with authority %s',
    async (authority) => {
      const stack = await stackFor(
        { 'a.md': `${LEAD}- [ ] Above\n${open}- [ ] Below\n` },
        { authority },
      );
      try {
        const result = await stack.tasks.execute({
          type: 'start-tracking',
          parent: taskNode(expectDefined(rootsIn(stack, 'a.md')[1], 'missing Below')),
        });

        expect(result).toMatchObject({ type: 'ok', changed: true, outcome });
        expect(await read(stack.app, 'a.md')).toBe(
          `${LEAD}- [ ] Above\n${left}- [ ] Below\n  - ${NOW_ATOM} →\n`,
        );
        expect(activeTitles(stack)).toEqual(['Below']);
      } finally {
        stack.index.destroy();
      }
    },
  );

  it.each([false, true])(
    'starts the root above the running one with authority %s',
    async (authority) => {
      const stack = await stackFor(
        { 'a.md': `${LEAD}- [ ] Above\n- [ ] Below\n${open}` },
        { authority },
      );
      try {
        const result = await stack.tasks.execute({
          type: 'start-tracking',
          parent: taskNode(expectDefined(rootsIn(stack, 'a.md')[0], 'missing Above')),
        });

        expect(result).toMatchObject({ type: 'ok', changed: true, outcome });
        expect(await read(stack.app, 'a.md')).toBe(
          `${LEAD}- [ ] Above\n  - ${NOW_ATOM} →\n- [ ] Below\n${left}`,
        );
        expect(activeTitles(stack)).toEqual(['Above']);
      } finally {
        stack.index.destroy();
      }
    },
  );

  it.each([false, true])(
    'starts a subtask under a lower root with authority %s',
    async (authority) => {
      const stack = await stackFor(
        { 'a.md': `${LEAD}- [ ] Above\n${open}- [ ] Below\n  - [ ] Child\n` },
        { authority },
      );
      try {
        const below = expectDefined(rootsIn(stack, 'a.md')[1], 'missing Below');
        const result = await stack.tasks.execute({
          type: 'start-tracking',
          parent: subtaskNode(childOf(below)),
        });

        expect(result).toMatchObject({ type: 'ok', changed: true, outcome });
        expect(await read(stack.app, 'a.md')).toBe(
          `${LEAD}- [ ] Above\n${left}- [ ] Below\n  - [ ] Child\n    - ${NOW_ATOM} →\n`,
        );
        expect(activeTitles(stack)).toEqual(['Child']);
      } finally {
        stack.index.destroy();
      }
    },
  );
});

/** Stops have to close every root of one file, whichever order the entries arrive in. */
describe('stopping several running roots of one file', () => {
  it.each([false, true])('closes both roots with authority %s', async (authority) => {
    const stack = await stackFor(
      { 'a.md': `${LEAD}- [ ] One\n${KEPT_OPEN}- [ ] Two\n  - ${EARLIER_ATOM} →\n` },
      { authority },
    );
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `${LEAD}- [ ] One\n${KEPT_CLOSED}- [ ] Two\n  - ${EARLIER_ATOM} → ${NOW_ATOM}\n`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('closes three roots of one file', async () => {
    const stack = await stackFor({
      'a.md': `${LEAD}- [ ] One\n${KEPT_OPEN}- [ ] Two\n${KEPT_OPEN}- [ ] Three\n${KEPT_OPEN}`,
    });
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `${LEAD}- [ ] One\n${KEPT_CLOSED}- [ ] Two\n${KEPT_CLOSED}- [ ] Three\n${KEPT_CLOSED}`,
      );
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('discards the short roots of one file together', async () => {
    const stack = await stackFor({
      'a.md': `${LEAD}- [ ] One\n${SHORT_OPEN}- [ ] Two\n${SHORT_OPEN}`,
    });
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({
        type: 'ok',
        changed: true,
        outcome: { type: 'stopped', discardedShortEntry: true },
      });
      expect(await read(stack.app, 'a.md')).toBe(`${LEAD}- [ ] One\n- [ ] Two\n`);
      expect(active(stack)).toEqual([]);
    } finally {
      stack.index.destroy();
    }
  });

  it('closes the writable roots of one file around an entry it cannot write', async () => {
    const diagnostics = vi.fn();
    const stack = await stackFor(
      {
        'a.md': `${LEAD}- [ ] One\n${KEPT_OPEN}- [ ] Foreign\n  - ${FUTURE_ATOM} →\n- [ ] Three\n${KEPT_OPEN}`,
      },
      { diagnostics },
    );
    try {
      const result = await stack.tasks.execute({ type: 'stop-tracking' });

      expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
      expect(await read(stack.app, 'a.md')).toBe(
        `${LEAD}- [ ] One\n${KEPT_CLOSED}- [ ] Foreign\n  - ${FUTURE_ATOM} →\n- [ ] Three\n${KEPT_CLOSED}`,
      );
      expect(activeTitles(stack)).toEqual(['Foreign']);
      expect(diagnostics.mock.calls).toEqual([
        [{ operation: 'close-time-entry', phase: 'close-others', cause: 'conflict' }],
      ]);
    } finally {
      stack.index.destroy();
    }
  });
});

/** A sub-task of a root that holds none, so every lookup for it comes back empty. */
function childRef(root: TaskSnapshot): TaskNodeRef {
  return {
    type: 'subtask',
    ref: {
      parent: { type: 'task', ref: root.ref },
      relativeLine: 1,
      originalBlock: '  - [ ] Child',
    },
  };
}

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

  it('offers the candidates instead of guessing when the root is ambiguous', async () => {
    const first = task({
      title: 'Alpha',
      source: { line: 0 },
      ref: { line: 0, revision: 'first' },
    });
    const second = task({
      title: 'Alpha',
      source: { line: 9 },
      ref: { line: 9, revision: 'second' },
    });
    const edit = vi.fn();
    const service = trackingService({
      edit,
      resolveRoot: () => ({
        type: 'ambiguous',
        candidates: [
          { root: first, target: { type: 'task', ref: first.ref } },
          { root: second, target: { type: 'task', ref: second.ref } },
        ],
      }),
    });

    const result = await service.start(childRef(first), clockFrom(NOW_MS, OFFSET_MINUTES).read());

    // Each candidate carries the sub-task the caller asked for, rebased onto that candidate's root,
    // so picking one in the prompt names a node that can actually be written.
    expect(result).toEqual({
      type: 'ambiguous',
      candidates: [
        { root: first, target: childRef(first) },
        { root: second, target: childRef(second) },
      ],
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it('reports a start whose root the index cannot place at all', async () => {
    const gone = task({ title: 'Alpha' });
    const parent: TaskNodeRef = { type: 'task', ref: gone.ref };
    const edit = vi.fn();
    const service = trackingService({
      edit,
      resolveRoot: () => ({ type: 'uncertain', ref: gone.ref }),
    });

    const result = await service.start(parent, clockFrom(NOW_MS, OFFSET_MINUTES).read());

    expect(result).toEqual({ type: 'not-found', target: parent });
    expect(edit).not.toHaveBeenCalled();
  });

  it('reports a conflict when the sub-task a start names is gone from its root', async () => {
    const root = task({ title: 'Alpha' });
    const edit = vi.fn();
    const service = trackingService({ edit, queries: queryApiForTasks(() => [root]) });

    const result = await service.start(childRef(root), clockFrom(NOW_MS, OFFSET_MINUTES).read());

    expect(result).toEqual({ type: 'conflict', current: root });
    expect(edit).not.toHaveBeenCalled();
  });

  it('reports a conflict when closing the other timers loses the node to start on', async () => {
    const child = subtask({ title: 'Child', ref: { relativeLine: 1 } });
    const root = task({
      title: 'Alpha',
      subtasks: [child],
      timeEntries: trackedRoot(' ').timeEntries,
    });
    // The close committed a root the sub-task is no longer part of, so the start has nothing to
    // write to and says so rather than writing under whatever now sits at that index.
    const shrunk = task({ title: 'Alpha' });
    const edit = vi
      .fn()
      .mockResolvedValue({ type: 'ok', changed: true, outcome: { type: 'task', task: shrunk } });
    const service = trackingService({
      edit,
      queries: queryApiForTasks(() => [root]),
      resolveRoot: () => ({ type: 'exact', task: root, basis: { observed: root } }),
    });

    const result = await service.start(
      { type: 'subtask', ref: child.ref },
      clockFrom(NOW_MS, OFFSET_MINUTES).read(),
    );

    expect(result).toEqual({ type: 'conflict', current: shrunk });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toMatchObject({ type: 'close-time-entry' });
  });

  it('keeps a failed start as the answer even when a short session was discarded', async () => {
    const other = trackedRoot(' ');
    const target = task({
      title: 'Bravo',
      source: { filePath: 'b.md' },
      ref: { filePath: 'b.md' },
    });
    const failure: TaskCommandResult = {
      type: 'io-error',
      cause: 'disk full',
      path: 'b.md',
      contentState: 'unknown',
    };
    const discarded: TaskCommandResult = {
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: task({ title: 'Alpha' }), discardedShortEntry: true },
    };
    const edit: TimeTrackingDependencies['edit'] = async (command: TaskEditCommand) =>
      await Promise.resolve(command.type === 'close-time-entry' ? discarded : failure);
    const service = trackingService({ edit, queries: queryApiForTasks(() => [other, target]) });

    const result = await service.start(
      { type: 'task', ref: target.ref },
      clockFrom(NOW_MS, OFFSET_MINUTES).read(),
    );

    expect(result).toEqual(failure);
  });

  it('closes nothing when the completed node is gone from the root it was read from', async () => {
    const edit = vi.fn();
    const done = trackedRoot('x');

    await trackingService({ edit }).closeAfterCompletion(
      done,
      childRef(done),
      clockFrom(NOW_MS, OFFSET_MINUTES).read(),
    );

    expect(edit).not.toHaveBeenCalled();
  });

  it('closes the completed sub-task and leaves its root and its sibling running', async () => {
    const open = trackedRoot(' ').timeEntries;
    const child = subtask({
      title: 'Child',
      statusSymbol: 'x',
      status: 'done',
      ref: { relativeLine: 1 },
      timeEntries: open,
    });
    const sibling = subtask({ title: 'Sibling', ref: { relativeLine: 2 }, timeEntries: open });
    const root = task({ title: 'Alpha', subtasks: [child, sibling], timeEntries: open });
    const settled = task({
      title: 'Alpha',
      subtasks: [subtask({ title: 'Child', ref: { relativeLine: 1 } }), sibling],
      timeEntries: open,
    });
    const edit = vi
      .fn()
      .mockResolvedValue({ type: 'ok', changed: true, outcome: { type: 'task', task: settled } });

    await trackingService({ edit }).closeAfterCompletion(
      root,
      { type: 'subtask', ref: child.ref },
      clockFrom(NOW_MS, OFFSET_MINUTES).read(),
    );

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toMatchObject({
      type: 'close-time-entry',
      entry: { parent: { type: 'subtask', ref: { relativeLine: 1 } } },
    });
  });

  it('reports a follow-up close that threw instead of letting it escape', async () => {
    const diagnostics = vi.fn();
    const edit = vi.fn().mockRejectedValue(new Error('disk full'));
    const done = trackedRoot('x');

    await trackingService({ edit, diagnostics }).closeAfterCompletion(
      done,
      { type: 'task', ref: done.ref },
      clockFrom(NOW_MS, OFFSET_MINUTES).read(),
    );

    expect(diagnostics.mock.calls).toEqual([
      [
        { operation: 'close-time-entry', phase: 'completion-follow-up', cause: 'repository-error' },
        new Error('disk full'),
      ],
    ]);
  });

  it('sets aside a running entry whose root the index can no longer address', async () => {
    const diagnostics = vi.fn();
    const stranded = trackedRoot(' ');
    const edit = vi.fn();
    const service = trackingService({
      edit,
      diagnostics,
      queries: queryApiForTasks(() => [stranded]),
      resolveRoot: () => ({ type: 'uncertain', ref: stranded.ref }),
    });

    const result = await service.stopAll(clockFrom(NOW_MS, OFFSET_MINUTES).read());

    expect(result).toEqual({ type: 'ok', changed: false, outcome: { type: 'stopped' } });
    expect(edit).not.toHaveBeenCalled();
    expect(diagnostics.mock.calls).toEqual([
      [{ operation: 'close-time-entry', phase: 'close-others', cause: 'not-found' }],
    ]);
  });

  it('closes through the root a rebased resolution returns', async () => {
    const previous = trackedRoot(' ');
    const current = task({
      title: 'Alpha',
      source: { line: 4 },
      ref: { line: 4, revision: 'relocated' },
      timeEntries: previous.timeEntries,
    });
    const edit = vi.fn().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: task({ title: 'Alpha', ref: { line: 4 } }) },
    });
    const service = trackingService({
      edit,
      queries: queryApiForTasks(() => [previous]),
      resolveRoot: () => ({
        type: 'rebased',
        previous,
        current,
        evidence: 'byte-identical-relocation',
        basis: { observed: previous },
      }),
    });

    const result = await service.stopAll(clockFrom(NOW_MS, OFFSET_MINUTES).read());

    expect(result).toEqual({ type: 'ok', changed: true, outcome: { type: 'stopped' } });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toMatchObject({
      type: 'close-time-entry',
      entry: { parent: { type: 'task', ref: current.ref } },
    });
  });
});
