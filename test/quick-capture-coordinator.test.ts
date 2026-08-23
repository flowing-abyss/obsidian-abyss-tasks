import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ShortcutActionId } from '../src/settings/shortcuts';
import type { TaskCaptureApplicationApi, TaskCommandResult, TaskCreateSession } from '../src/tasks';
import type { InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import type { CaptureContext, CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { CaptureTargetResolver } from '../src/ui/taskCapture/CaptureTargetResolver';
import {
  QuickCaptureCoordinator,
  type QuickCapturePhase,
} from '../src/ui/taskCapture/QuickCaptureCoordinator';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { deferred, flushMicrotasks, task } from './helpers';

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const uncommentedCss = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const matches = [...uncommentedCss.matchAll(/([^{}]+)\{([^}]*)\}/gu)].filter(
    (match) => match[1]?.trim() === selector,
  );
  return matches[matches.length - 1]?.[2] ?? '';
}

const success = (): TaskCommandResult => ({
  type: 'ok',
  changed: true,
  outcome: {
    type: 'task',
    task: task({ title: 'Captured', source: { filePath: 'Inbox.md', line: 2 } }),
  },
});

function readySession(
  execute: TaskCreateSession['execute'] = async () => success(),
): TaskCreateSession {
  return {
    type: 'ready',
    destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
    execute,
  };
}

function target(
  context: CaptureContext,
  label = 'Frozen target',
  execute: TaskCreateSession['execute'] = async () => success(),
): CaptureTarget {
  return {
    label,
    context,
    session: readySession(execute),
    markdownPrefix: '',
    markdownSuffixes: [],
  };
}

interface Harness {
  readonly coordinator: QuickCaptureCoordinator;
  readonly host: HTMLElement;
  readonly resolveTarget: ReturnType<
    typeof vi.fn<(context: CaptureContext) => Promise<CaptureTarget>>
  >;
  readonly acquire: ReturnType<typeof vi.fn<InteractionOwnershipPort<ShortcutActionId>['acquire']>>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly onResult: ReturnType<typeof vi.fn>;
  setContext(context: CaptureContext): void;
}

const mounted: HTMLElement[] = [];
const coordinators: QuickCaptureCoordinator[] = [];

function harness(
  resolution: (context: CaptureContext) => Promise<CaptureTarget> = async (context) =>
    target(context),
): Harness {
  const host = document.createElement('div');
  host.className = 'abyss-quick-capture-host';
  document.body.appendChild(host);
  mounted.push(host);
  let context: CaptureContext = { type: 'list', selection: 'today' };
  const resolveTarget = vi.fn(resolution);
  const release = vi.fn();
  const acquire = vi.fn(() => ({ release }));
  const onResult = vi.fn();
  const coordinator = new QuickCaptureCoordinator({
    host,
    context: () => context,
    resolveTarget,
    interactionOwnership: { acquire },
    onResult,
  });
  coordinators.push(coordinator);
  return {
    coordinator,
    host,
    resolveTarget,
    acquire,
    release,
    onResult,
    setContext: (next) => {
      context = next;
    },
  };
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.destroy();
  for (const element of mounted.splice(0)) element.remove();
  vi.restoreAllMocks();
});

async function open(h: Harness): Promise<HTMLInputElement> {
  h.coordinator.openOrFocus();
  await flushMicrotasks(0);
  return h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
}

function phase(h: Harness): QuickCapturePhase {
  return h.coordinator.phase;
}

describe('QuickCaptureCoordinator', () => {
  it('keeps the stable host out of flow and width-clamped with theme-token styling', () => {
    const hostRules = declarationsFor('.abyss-quick-capture-host');
    const activeRules = declarationsFor('.abyss-quick-capture-host:not(:empty)');
    const surfaceRules = declarationsFor('.abyss-quick-capture-host > .abyss-capture-surface');

    expect(hostRules).toMatch(/position:\s*absolute/u);
    expect(hostRules).toMatch(/inline-size:\s*min\(/u);
    expect(hostRules).toMatch(/calc\(100%/u);
    expect(hostRules).toMatch(/pointer-events:\s*none/u);
    expect(activeRules).toMatch(/pointer-events:\s*auto/u);
    expect(surfaceRules).toContain('var(--background-primary)');
    expect(surfaceRules).toContain('var(--background-modifier-border)');
    expect(surfaceRules).not.toMatch(/#[\da-f]{3,8}|(?:rgb|hsl)a?\(/iu);
  });

  it('owns one closed → resolving → open transition and focuses the mounted surface', async () => {
    const pending = deferred<CaptureTarget>();
    const h = harness(() => pending.promise);

    h.coordinator.openOrFocus();

    expect(phase(h)).toBe('resolving');
    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.acquire).toHaveBeenCalledWith({
      blocksShortcuts: true,
      allowActions: ['openQuickCapture'],
    });
    pending.resolve(target({ type: 'list', selection: 'today' }));
    await flushMicrotasks(0);

    const input = h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input');
    expect(phase(h)).toBe('open');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(h.host.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
  });

  it('makes repeated Q idempotent while resolving and refocuses without resolving again when open', async () => {
    const pending = deferred<CaptureTarget>();
    const h = harness(() => pending.promise);
    const external = document.body.appendChild(document.createElement('div'));
    external.tabIndex = 0;
    mounted.push(external);

    h.coordinator.openOrFocus();
    h.coordinator.openOrFocus();

    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.acquire).toHaveBeenCalledOnce();
    pending.resolve(target({ type: 'list', selection: 'today' }));
    await flushMicrotasks(0);
    const input = h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
    external.focus();

    h.coordinator.openOrFocus();

    expect(document.activeElement).toBe(input);
    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.host.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
  });

  it('freezes a mutable navigation context before target resolution awaits', async () => {
    const pending = deferred<CaptureTarget>();
    const selection = { type: 'tag', tag: '#frozen' } as const;
    const h = harness(() => pending.promise);
    h.setContext({ type: 'list', selection });

    h.coordinator.openOrFocus();
    (selection as { tag: string }).tag = '#changed';
    h.setContext({ type: 'default', source: 'search' });

    expect(h.resolveTarget).toHaveBeenCalledWith({
      type: 'list',
      selection: { type: 'tag', tag: '#frozen' },
    });
    pending.resolve(target({ type: 'list', selection: { type: 'tag', tag: '#frozen' } }));
    await flushMicrotasks(0);
    expect(h.host.querySelector('.abyss-capture-destination')?.textContent).toBe('Frozen target');
  });

  it('keeps resolver settings and the Calendar context frozen across a deferred plan', async () => {
    const planned = deferred<TaskCreateSession>();
    const execute = vi.fn<TaskCreateSession['execute']>(async () => success());
    const application: TaskCaptureApplicationApi = {
      planCreate: vi.fn(() => planned.promise),
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.taskPrefix = '#frozen-prefix';
    const resolver = new CaptureTargetResolver(application, settings);
    const h = harness((context) => resolver.resolve(context));
    h.setContext({ type: 'default', source: 'calendar' });

    h.coordinator.openOrFocus();
    settings.taskPrefix = '#changed-prefix';
    h.setContext({ type: 'list', selection: 'inbox' });
    planned.resolve(readySession(execute));
    await flushMicrotasks(0);
    const input = h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
    input.value = 'draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledWith({ markdownBody: '#frozen-prefix draft' });
    expect(h.resolveTarget).toHaveBeenCalledWith({ type: 'default', source: 'calendar' });
  });

  it('ignores a resolution after close or destroy and releases its resolving token once', async () => {
    const closePending = deferred<CaptureTarget>();
    const closed = harness(() => closePending.promise);
    closed.coordinator.openOrFocus();
    closed.coordinator.close();
    closed.coordinator.close();
    closePending.resolve(target({ type: 'list', selection: 'today' }));

    const destroyPending = deferred<CaptureTarget>();
    const destroyed = harness(() => destroyPending.promise);
    destroyed.coordinator.openOrFocus();
    destroyed.coordinator.destroy();
    destroyed.coordinator.destroy();
    destroyPending.resolve(target({ type: 'list', selection: 'today' }));
    await flushMicrotasks(0);

    expect(phase(closed)).toBe('closed');
    expect(phase(destroyed)).toBe('closed');
    expect(closed.host.children).toHaveLength(0);
    expect(destroyed.host.children).toHaveLength(0);
    expect(closed.release).toHaveBeenCalledOnce();
    expect(destroyed.release).toHaveBeenCalledOnce();
  });

  it('lets only the newest generation mount when an older resolution arrives late', async () => {
    const first = deferred<CaptureTarget>();
    const second = deferred<CaptureTarget>();
    let request = 0;
    const h = harness(() => (++request === 1 ? first.promise : second.promise));

    h.coordinator.openOrFocus();
    h.coordinator.close();
    h.coordinator.openOrFocus();
    second.resolve(target({ type: 'default', source: 'search' }, 'Winning target'));
    await flushMicrotasks(0);
    first.resolve(target({ type: 'list', selection: 'today' }, 'Stale target'));
    await flushMicrotasks(0);

    expect(phase(h)).toBe('open');
    expect(h.resolveTarget).toHaveBeenCalledTimes(2);
    expect(h.host.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
    expect(h.host.querySelector('.abyss-capture-destination')?.textContent).toBe('Winning target');
  });

  it('destroys the winning controller and surface and releases ownership exactly once', async () => {
    const surfaceDestroy = vi.spyOn(CaptureSurface.prototype, 'destroy');
    const controllerDestroy = vi.spyOn(TaskCaptureController.prototype, 'destroy');
    const h = harness();
    await open(h);

    h.coordinator.close();
    h.coordinator.close();
    h.coordinator.destroy();

    expect(surfaceDestroy).toHaveBeenCalledOnce();
    expect(controllerDestroy).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.host.children).toHaveLength(0);
    expect(phase(h)).toBe('closed');
  });

  it('contains a rejected target resolution and returns to closed ownership', async () => {
    const h = harness(async () => await Promise.reject(new Error('target failed')));

    h.coordinator.openOrFocus();
    await flushMicrotasks(0);

    expect(phase(h)).toBe('closed');
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.host.children).toHaveLength(0);
  });

  it('keeps Enter and Escape owned by the capture surface', async () => {
    const execute = vi.fn<TaskCreateSession['execute']>(async () => success());
    const h = harness(async (context) => target(context, 'Surface target', execute));
    const input = await open(h);
    input.value = 'captured';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(enter);
    await flushMicrotasks(0);

    expect(enter.defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(phase(h)).toBe('closed');
  });
});
