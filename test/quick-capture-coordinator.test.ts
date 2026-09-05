import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ShortcutActionId } from '../src/settings/shortcuts';
import {
  localDate,
  type TaskCaptureApplicationApi,
  type TaskCommandResult,
  type TaskCreateSession,
} from '../src/tasks';
import type { InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import type { CaptureContext, CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { CaptureTargetResolver } from '../src/ui/taskCapture/CaptureTargetResolver';
import {
  QuickCaptureCoordinator,
  type QuickCapturePhase,
} from '../src/ui/taskCapture/QuickCaptureCoordinator';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import {
  cssRuleParts,
  deferred,
  expectDefined,
  flushMicrotasks,
  stripCssComments,
  task,
} from './helpers';

async function loadStylesFixture(): Promise<string> {
  if (!Platform.isDesktop) throw new Error('CSS fixture requires the desktop test runtime');
  const fileSystem = await import('node:fs');
  const nodePath = await import('node:path');
  return fileSystem.readFileSync(nodePath.resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
}

const css = await loadStylesFixture();

function declarationsFor(selector: string): string {
  const matches = cssRuleParts(stripCssComments(css)).filter((rule) => rule.selector === selector);
  return matches[matches.length - 1]?.declarations ?? '';
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
  const host = createDiv();
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
  return expectDefined(h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input'));
}

function phase(h: Harness): QuickCapturePhase {
  return h.coordinator.phase;
}

describe('QuickCaptureCoordinator', () => {
  it('keeps the compact inspector header below its existing pane-controls strip', () => {
    expect(declarationsFor('.abyss-layout')).toContain('--abyss-compact-controls-height: 44px');
    expect(declarationsFor('.abyss-compact-pane-controls')).toContain(
      'flex: 0 0 var(--abyss-compact-controls-height)',
    );
    expect(declarationsFor('.abyss-layout--tasks > .abyss-right.is-compact-open')).toContain(
      'inset-block: var(--abyss-compact-controls-height) 0',
    );
    expect(declarationsFor('.abyss-layout--tasks > .abyss-center-shell')).toContain(
      '--abyss-shell-top-inset: var(--abyss-compact-controls-height)',
    );
    expect(declarationsFor('.abyss-layout--tasks > .abyss-left.is-compact-open')).toContain(
      'inset-block: 0',
    );
  });

  it('keeps the stable host out of flow and width-clamped with theme-token styling', () => {
    const layoutRules = declarationsFor('.abyss-layout');
    const shellRules = declarationsFor('.abyss-center-shell');
    const hostRules = declarationsFor('.abyss-quick-capture-host');
    const activeRules = declarationsFor('.abyss-quick-capture-host:not(:empty)');
    const surfaceRules = declarationsFor('.abyss-quick-capture-host > .abyss-capture-surface');

    expect(layoutRules).toMatch(/container-type:\s*inline-size/u);
    expect(layoutRules).toMatch(/container-name:\s*abyss-panel-layout/u);
    expect(shellRules).toMatch(/position:\s*relative/u);
    expect(shellRules).toMatch(/display:\s*flex/u);
    expect(shellRules).toMatch(/min-inline-size:\s*0/u);
    expect(hostRules).toMatch(/position:\s*absolute/u);
    expect(hostRules).toMatch(/inset-inline:\s*var\(--abyss-quick-capture-edge\)/u);
    expect(hostRules).toMatch(/inline-size:\s*auto/u);
    expect(hostRules).toMatch(/max-inline-size:\s*36rem/u);
    expect(hostRules).toMatch(/margin-inline:\s*auto/u);
    expect(hostRules).not.toMatch(/translateX/u);
    expect(hostRules).toMatch(/pointer-events:\s*none/u);
    expect(activeRules).toMatch(/pointer-events:\s*auto/u);
    expect(surfaceRules).toContain('var(--background-primary)');
    expect(surfaceRules).toContain('var(--background-modifier-border)');
    expect(surfaceRules).not.toMatch(/#[\da-f]{3,8}|(?:rgb|hsl)a?\(/iu);
    expect(css).toMatch(
      /@container\s+abyss-panel-layout\s*\(max-width:\s*58rem\)[\s\S]*?\.abyss-layout--tasks\s*>\s*\.abyss-right:not\(\.is-compact-open\)\s*\{[\s\S]*?display:\s*none/u,
    );
    expect(css).toMatch(
      /@container\s+abyss-panel-layout\s*\(max-width:\s*38rem\)[\s\S]*?\.abyss-layout--tasks\s*>\s*\.abyss-left:not\(\.is-compact-open\)\s*\{[\s\S]*?display:\s*none/u,
    );
    expect(css).toMatch(
      /\.abyss-layout--tasks\s*>\s*\.abyss-(?:left|right)\.is-compact-open\s*\{[\s\S]*?position:\s*absolute[\s\S]*?z-index:/u,
    );
    expect(css).toMatch(
      /@container\s+abyss-panel-layout\s*\(max-width:\s*58rem\)[\s\S]*?\.abyss-compact-pane-controls\s*\{[\s\S]*?display:\s*flex/u,
    );
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

  it('cancels a resolving generation on an outside pointer and ignores its late target', async () => {
    const pending = deferred<CaptureTarget>();
    const h = harness(() => pending.promise);
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);
    h.coordinator.openOrFocus();

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    pending.resolve(target({ type: 'list', selection: 'today' }));
    await flushMicrotasks(0);

    expect(phase(h)).toBe('closed');
    expect(h.host.childElementCount).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('makes repeated Q idempotent while resolving and refocuses without resolving again when open', async () => {
    const pending = deferred<CaptureTarget>();
    const h = harness(() => pending.promise);
    const external = document.body.appendChild(createDiv());
    external.tabIndex = 0;
    mounted.push(external);

    h.coordinator.openOrFocus();
    h.coordinator.openOrFocus();

    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.acquire).toHaveBeenCalledOnce();
    pending.resolve(target({ type: 'list', selection: 'today' }));
    await flushMicrotasks(0);
    const input = expectDefined(
      h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
    );
    external.focus();

    h.coordinator.openOrFocus();

    expect(document.activeElement).toBe(input);
    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.host.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
  });

  it('closes an empty capture only for an outside pointer and releases its owner once', async () => {
    const h = harness();
    await open(h);
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);
    const pointer = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });

    outside.dispatchEvent(pointer);

    expect(pointer.defaultPrevented).toBe(false);
    expect(phase(h)).toBe('closed');
    expect(h.host.childElementCount).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('keeps an empty programmatic blur open so repeated Q can refocus the same surface', async () => {
    const h = harness();
    const input = await open(h);
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);

    input.blur();
    expect(phase(h)).toBe('open');
    expect(h.release).not.toHaveBeenCalled();

    outside.focus();
    h.coordinator.openOrFocus();

    expect(document.activeElement).toBe(input);
    expect(h.resolveTarget).toHaveBeenCalledOnce();
    expect(h.host.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
  });

  it('submits one frozen draft on non-empty outside blur and closes without focus theft', async () => {
    const execute = vi.fn<TaskCreateSession['execute']>(async () => success());
    const h = harness(async (context) => target(context, 'Frozen blur target', execute));
    const input = await open(h);
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);
    input.value = '  pointer blur draft  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    outside.focus();
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ markdownBody: 'pointer blur draft' });
    expect(phase(h)).toBe('closed');
    expect(document.activeElement).toBe(outside);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('preserves the exact draft and error after one failed outside-blur submission', async () => {
    const execute = vi.fn<TaskCreateSession['execute']>(async () => ({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    }));
    const h = harness(async (context) => target(context, 'Failed blur target', execute));
    const input = await open(h);
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);
    input.value = '  exact failed draft  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    outside.focus();
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(phase(h)).toBe('open');
    expect(input.value).toBe('  exact failed draft  ');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(outside);
    expect(h.release).not.toHaveBeenCalled();

    const laterOutside = document.body.appendChild(createEl('button'));
    mounted.push(laterOutside);
    laterOutside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    laterOutside.focus();
    await flushMicrotasks(0);
    expect(execute).toHaveBeenCalledOnce();

    h.coordinator.openOrFocus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('treats an outside pointer during Enter submission as blur intent without duplicating', async () => {
    const pending = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskCreateSession['execute']>(() => pending.promise);
    const h = harness(async (context) => target(context, 'Pending pointer target', execute));
    const input = await open(h);
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);
    input.value = 'pending once';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    outside.focus();
    pending.resolve(success());
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(phase(h)).toBe('closed');
    expect(document.activeElement).toBe(outside);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('removes the outside-pointer policy from closed, stale, and destroyed generations', async () => {
    const firstExecute = vi.fn<TaskCreateSession['execute']>(async () => success());
    const secondExecute = vi.fn<TaskCreateSession['execute']>(async () => success());
    let request = 0;
    const h = harness(async (context) =>
      target(
        context,
        request++ === 0 ? 'First' : 'Second',
        request === 1 ? firstExecute : secondExecute,
      ),
    );
    const first = await open(h);
    first.value = 'stale draft';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    h.coordinator.close();
    const second = await open(h);
    second.value = 'winning draft';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    const outside = document.body.appendChild(createEl('button'));
    mounted.push(outside);

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    outside.focus();
    await flushMicrotasks(0);

    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledTimes(2);

    h.coordinator.destroy();
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(secondExecute).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledTimes(2);
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
    let today = localDate('2026-08-24');
    const resolver = new CaptureTargetResolver(application, settings, () => today);
    const h = harness((context) => resolver.resolve(context));
    h.setContext({ type: 'default', source: 'calendar' });

    h.coordinator.openOrFocus();
    settings.taskPrefix = '#changed-prefix';
    today = localDate('2026-08-25');
    h.setContext({ type: 'list', selection: 'inbox' });
    planned.resolve(readySession(execute));
    await flushMicrotasks(0);
    const input = expectDefined(
      h.host.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
    );
    input.value = 'draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledWith({
      markdownBody: '#frozen-prefix draft',
      initial: { due: { type: 'set', value: localDate('2026-08-24') } },
    });
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

  it.each(['task card', 'rail control'] as const)(
    'restores the connected %s origin after Escape dismissal',
    async (kind) => {
      const origin = document.body.appendChild(createEl('button'));
      origin.className = kind === 'task card' ? 'abyss-task-card' : 'abyss-rail-btn';
      mounted.push(origin);
      origin.focus();
      const h = harness();
      const input = await open(h);

      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

      expect(phase(h)).toBe('closed');
      expect(document.activeElement).toBe(origin);
    },
  );

  it('does not restore a disconnected origin after Escape dismissal', async () => {
    const origin = document.body.appendChild(createEl('button'));
    origin.focus();
    const h = harness();
    const input = await open(h);
    origin.remove();

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(phase(h)).toBe('closed');
    expect(document.activeElement).not.toBe(origin);
  });

  it('restores the origin when Escape requests close during a successful pending submit', async () => {
    const pending = deferred<TaskCommandResult>();
    const origin = document.body.appendChild(createEl('button'));
    mounted.push(origin);
    origin.focus();
    const h = harness(async (context) => target(context, 'Pending target', () => pending.promise));
    const input = await open(h);
    input.value = 'pending capture';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(phase(h)).toBe('open');
    pending.resolve(success());
    await flushMicrotasks(0);

    expect(phase(h)).toBe('closed');
    expect(document.activeElement).toBe(origin);
  });

  it('does not steal focus back when the user moves elsewhere after pending Escape', async () => {
    const pending = deferred<TaskCommandResult>();
    const origin = document.body.appendChild(createEl('button'));
    const elsewhere = document.body.appendChild(createEl('button'));
    mounted.push(origin, elsewhere);
    origin.focus();
    const h = harness(async (context) => target(context, 'Pending target', () => pending.promise));
    const input = await open(h);
    input.value = 'pending capture';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    elsewhere.focus();

    pending.resolve(success());
    await flushMicrotasks(0);

    expect(phase(h)).toBe('closed');
    expect(document.activeElement).toBe(elsewhere);
  });

  it('does not restore focus during destroy teardown', async () => {
    const origin = document.body.appendChild(createEl('button'));
    const elsewhere = document.body.appendChild(createEl('button'));
    mounted.push(origin, elsewhere);
    origin.focus();
    const h = harness();
    await open(h);
    elsewhere.focus();

    h.coordinator.destroy();

    expect(document.activeElement).toBe(elsewhere);
  });
});
