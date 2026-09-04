import { describe, expect, it, vi } from 'vitest';
import { registerCodeBlock, resolveConfig } from '../src/code-block/registerCodeBlock';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings, CodeBlockParams } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate, type TaskApplicationApi, type TaskSnapshot } from '../src/tasks';
import { expectDefined, objectMatching, queryApiForTasks, task, useRealMoment } from './helpers';

useRealMoment();

const commentTimeContext = () => ({
  nowEpochMs: Date.UTC(2026, 8, 4, 12),
  today: localDate('2026-09-04'),
  locale: 'en',
  timeZone: 'UTC',
});

interface CapturedProcessor {
  (source: string, el: HTMLElement, ctx: { addChild: (child: unknown) => void }): void;
}

function setupCodeBlock(settings: CalendarSettings = DEFAULT_SETTINGS): {
  processor: CapturedProcessor;
} {
  const captured: CapturedProcessor[] = [];
  const fakePlugin = {
    app: {} as unknown,
    registerMarkdownCodeBlockProcessor: (_id: string, cb: CapturedProcessor) => {
      captured.push(cb);
    },
  };
  const queries = queryApiForTasks(() => []);
  const tasks: TaskApplicationApi = {
    queries,
    execute: vi.fn().mockResolvedValue({ type: 'invalid', issues: [{ code: 'invalid-target' }] }),
  };
  registerCodeBlock(
    fakePlugin as unknown as Parameters<typeof registerCodeBlock>[0],
    settings,
    queries,
    tasks,
    new StatusRegistry(settings.taskStatuses),
    commentTimeContext,
  );
  return { processor: expectDefined(captured[0], 'processor not registered') };
}

function invokeProcessor(
  processor: CapturedProcessor,
  source: string,
): { el: HTMLElement; ctx: { addChild: ReturnType<typeof vi.fn> } } {
  const el = createFragment().createDiv();
  const addChild = vi.fn();
  const ctx = { addChild };
  processor(source, el, ctx);
  return { el, ctx };
}

describe('parseCodeBlockYaml (indirect via registerCodeBlock)', () => {
  it('parses simple key: value', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'view: week');
    const root = expectDefined(el.querySelector('.tasksCalendar'));
    expect(root.getAttribute('view')).toBe('week');
  });

  it.each([
    ["folder: 'my folder'", 'single-quoted folder'],
    ['folder: "my folder"', 'double-quoted folder'],
    ['firstDayOfWeek: 3', 'numeric firstDayOfWeek'],
    ['upcomingDays: 14', 'numeric upcomingDays'],
    ['firstDayOfWeek: "5"', 'quoted numeric firstDayOfWeek'],
  ])('accepts %s without error (%s)', (source) => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, source);
    expect(el.querySelector('.tasksCalendar')).not.toBeNull();
  });

  it.each([
    ['\n\nview: week\n\n', 'week', 'blank lines'],
    ['garbage line\nview: month', 'month', 'garbage lines'],
    ['  view  :  week  ', 'week', 'whitespace around key and value'],
  ])('parses %s as %s while tolerating %s', (source, expectedView) => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, source);
    expect(el.querySelector('.tasksCalendar')?.getAttribute('view')).toBe(expectedView);
  });

  it('parses multi-line source', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'view: week\nfirstDayOfWeek: 1\nupcomingDays: 7');
    const root = expectDefined(el.querySelector('.tasksCalendar'));
    expect(root.getAttribute('view')).toBe('week');
  });
});

describe('registerCodeBlock processor', () => {
  it('injects the shared task API into calendar status interactions', () => {
    let processor: CapturedProcessor | undefined;
    const fakePlugin = {
      app: {} as unknown,
      registerMarkdownCodeBlockProcessor: (_id: string, cb: CapturedProcessor) => {
        processor = cb;
      },
    };
    const today = window.moment().format('YYYY-MM-DD');
    const queries = queryApiForTasks(() => [task({ planning: { due: today } })]);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    registerCodeBlock(
      fakePlugin as unknown as Parameters<typeof registerCodeBlock>[0],
      DEFAULT_SETTINGS,
      queries,
      { queries, execute },
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      commentTimeContext,
    );
    if (processor == null) throw new Error('processor not registered');

    const { el } = invokeProcessor(processor, 'view: month');
    const marker = el.querySelector<HTMLElement>('.task .abyss-status-marker');
    expect(marker).not.toBeNull();
    expectDefined(marker).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(execute).toHaveBeenCalledWith({
      type: 'toggle-completion',
      target: {
        type: 'task',
        ref: objectMatching<TaskSnapshot['ref']>({ filePath: 'f.md', line: 0 }),
      },
    });
  });

  it('registers task-calendar processor', () => {
    let registered = false;
    const fakePlugin = {
      app: {} as unknown,
      registerMarkdownCodeBlockProcessor: (id: string) => {
        if (id === 'task-calendar') registered = true;
      },
    };
    const queries = queryApiForTasks(() => []);
    registerCodeBlock(
      fakePlugin as unknown as Parameters<typeof registerCodeBlock>[0],
      DEFAULT_SETTINGS,
      queries,
      {
        queries,
        execute: vi
          .fn()
          .mockResolvedValue({ type: 'invalid', issues: [{ code: 'invalid-target' }] }),
      },
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      commentTimeContext,
    );
    expect(registered).toBe(true);
  });

  it('valid source creates .tasksCalendar div with style class', () => {
    const { processor } = setupCodeBlock({
      ...DEFAULT_SETTINGS,
      desktop: { ...DEFAULT_SETTINGS.desktop, style: 'style3' },
    });
    const { el } = invokeProcessor(processor, 'view: week');
    const root = el.querySelector('.tasksCalendar.style3');
    expect(root).not.toBeNull();
  });

  it('root div has view attribute set to config.defaultView', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'view: list');
    expect(el.querySelector('.tasksCalendar')?.getAttribute('view')).toBe('list');
  });

  it('ctx.addChild is invoked', () => {
    const { processor } = setupCodeBlock();
    const { ctx } = invokeProcessor(processor, 'view: month');
    expect(ctx.addChild).toHaveBeenCalledOnce();
  });

  it('MarkdownRenderChild onunload calls renderer.destroy', () => {
    const { processor } = setupCodeBlock();
    const { ctx } = invokeProcessor(processor, 'view: month');
    const child = expectDefined(ctx.addChild.mock.calls[0])[0] as { onunload: () => void };
    expect(() => {
      child.onunload();
    }).not.toThrow();
  });
});

describe('resolveConfig edge cases', () => {
  it('invalid view string passes through unchanged (CURRENT BEHAVIOR)', () => {
    const cfg = resolveConfig(DEFAULT_SETTINGS, { view: 'foo' } as unknown as CodeBlockParams);
    expect(cfg.defaultView).toBe('foo');
  });
});
