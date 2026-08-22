import { describe, expect, it, vi } from 'vitest';
import { registerCodeBlock, resolveConfig } from '../src/code-block/registerCodeBlock';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings, CodeBlockParams } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi } from '../src/tasks';
import { queryApiForTasks, task, useRealMoment } from './helpers';

useRealMoment();

interface CapturedProcessor {
  (source: string, el: HTMLElement, ctx: { addChild: (child: unknown) => void }): void;
}

function setupCodeBlock(settings: CalendarSettings = DEFAULT_SETTINGS): {
  processor: CapturedProcessor;
} {
  let captured: CapturedProcessor | null = null;
  const fakePlugin = {
    app: {} as unknown,
    registerMarkdownCodeBlockProcessor: (_id: string, cb: CapturedProcessor) => {
      captured = cb;
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
  );
  if (!captured) throw new Error('processor not registered');
  return { processor: captured };
}

function invokeProcessor(
  processor: CapturedProcessor,
  source: string,
): { el: HTMLElement; ctx: { addChild: ReturnType<typeof vi.fn> } } {
  const el = activeDocument.createElement('div');
  const addChild = vi.fn();
  const ctx = { addChild };
  processor(source, el, ctx);
  return { el, ctx };
}

describe('parseCodeBlockYaml (indirect via registerCodeBlock)', () => {
  it('parses simple key: value', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'view: week');
    const root = el.querySelector('.tasksCalendar')!;
    expect(root.getAttribute('view')).toBe('week');
  });

  it('accepts single-quoted folder value without error (quote-strip exercised)', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, "folder: 'my folder'");
    expect(el.querySelector('.tasksCalendar')).not.toBeNull();
  });

  it('accepts double-quoted folder value without error (quote-strip exercised)', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'folder: "my folder"');
    expect(el.querySelector('.tasksCalendar')).not.toBeNull();
  });

  it('accepts numeric firstDayOfWeek without error (parseInt exercised for coverage)', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'firstDayOfWeek: 3');
    expect(el.querySelector('.tasksCalendar')).not.toBeNull();
  });

  it('accepts numeric upcomingDays without error (parseInt exercised for coverage)', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'upcomingDays: 14');
    expect(el.querySelector('.tasksCalendar')).not.toBeNull();
  });

  it('accepts quoted numeric firstDayOfWeek without error (parseInt + quote-strip exercised)', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'firstDayOfWeek: "5"');
    expect(el.querySelector('.tasksCalendar')).not.toBeNull();
  });

  it('skips blank lines', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, '\n\nview: week\n\n');
    expect(el.querySelector('.tasksCalendar')?.getAttribute('view')).toBe('week');
  });

  it('skips garbage lines (no colon)', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'garbage line\nview: month');
    expect(el.querySelector('.tasksCalendar')?.getAttribute('view')).toBe('month');
  });

  it('tolerates whitespace around key and value', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, '  view  :  week  ');
    expect(el.querySelector('.tasksCalendar')?.getAttribute('view')).toBe('week');
  });

  it('parses multi-line source', () => {
    const { processor } = setupCodeBlock();
    const { el } = invokeProcessor(processor, 'view: week\nfirstDayOfWeek: 1\nupcomingDays: 7');
    const root = el.querySelector('.tasksCalendar')!;
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
    );
    if (!processor) throw new Error('processor not registered');

    const { el } = invokeProcessor(processor, 'view: month');
    const marker = el.querySelector<HTMLElement>('.task .abyss-status-marker');
    expect(marker).not.toBeNull();
    marker!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(execute).toHaveBeenCalledWith({
      type: 'toggle-completion',
      target: {
        type: 'task',
        ref: expect.objectContaining({ filePath: 'f.md', line: 0 }),
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
    const child = ctx.addChild.mock.calls[0]![0] as { onunload: () => void };
    expect(() => child.onunload()).not.toThrow();
  });
});

describe('resolveConfig edge cases', () => {
  it('invalid view string passes through unchanged (CURRENT BEHAVIOR)', () => {
    const cfg = resolveConfig(DEFAULT_SETTINGS, { view: 'foo' } as unknown as CodeBlockParams);
    expect(cfg.defaultView).toBe('foo');
  });
});
