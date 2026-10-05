import { MarkdownRenderer, Notice, Platform, type App } from 'obsidian';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type {
  TaskCommandResult,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
  TaskSnapshot,
} from '../src/tasks';
import { localDate, taskReconciliationKey } from '../src/tasks';
import {
  CreationPresentationController,
  type CreationRevealRequest,
} from '../src/ui/creation/CreationPresentationController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import {
  applyTaskPresentationIdentity,
  renderedTaskElements,
  taskPresentationKey,
} from '../src/ui/taskPresentationIdentity';
import type { CalendarOccurrence } from '../src/views/calendarOccurrences';
import { applyOccurrenceDomState } from '../src/views/timegrid/renderTaskMeta';
import { cssRuleContaining, cssValue } from './cssHelpers';
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  methodOf,
  task,
  taskQueryApi,
  useRealMoment,
} from './helpers';
import { useTaskPanelViewport } from './support/taskPanelViewport';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';

async function loadStylesFixture(): Promise<string> {
  if (!Platform.isDesktop) throw new Error('CSS fixture requires the desktop test runtime');
  const fileSystem = await import('node:fs');
  const nodePath = await import('node:path');
  return fileSystem.readFileSync(nodePath.resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
}

const css = await loadStylesFixture();
useRealMoment();
useTaskPanelViewport();

function exact(taskSnapshot: TaskSnapshot): TaskResolution {
  return { type: 'exact', task: taskSnapshot, basis: { observed: taskSnapshot } };
}

function successfulCreation(taskSnapshot: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: true, outcome: { type: 'task', task: taskSnapshot } };
}

function failedCreation(): TaskCommandResult {
  return {
    type: 'io-error',
    cause: 'test-failure',
    contentState: 'unchanged',
  };
}

function queryHarness(initial: TaskResolution): {
  readonly queries: TaskQueryApi;
  setResolution(next: TaskResolution): void;
  emit(event?: TaskIndexEvent): void;
  listenerCount(): number;
} {
  let resolution = initial;
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  return {
    queries: taskQueryApi({
      list: () => [],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
      resolve: () => resolution,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeReconciled: () => () => {},
    }),
    setResolution: (next) => {
      resolution = next;
    },
    emit: (event = { type: 'changed', files: ['capture.md'] }) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function controllerHarness(
  resolution: TaskResolution,
  options: { readonly reducedMotion?: boolean } = {},
): {
  readonly controller: CreationPresentationController;
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  readonly queries: ReturnType<typeof queryHarness>;
} {
  const host = freshContainer();
  const root = freshContainer();
  activeDocument.body.append(root);
  measurePresentationRoot(root);
  const queries = queryHarness(resolution);
  const controller = new CreationPresentationController({
    host,
    queries: queries.queries,
    reducedMotion: () => options.reducedMotion ?? false,
    now: () => Date.now(),
  });
  return { controller, host, root, queries };
}

function renderIdentity(root: HTMLElement, ref: TaskRef): HTMLElement {
  const element = root.createDiv();
  element.getBoundingClientRect = () => rect(10, 20, 100, 40);
  applyTaskPresentationIdentity(element, ref);
  return element;
}

type ComputedStyleOverride = Readonly<Partial<Record<'display' | 'overflowY', string>>>;

function mockComputedStyles(
  root: HTMLElement,
  overrides: ReadonlyMap<Element, ComputedStyleOverride>,
): MockInstance<Window['getComputedStyle']> {
  const ownerWindow = expectDefined(root.ownerDocument.defaultView);
  const original = ownerWindow.getComputedStyle.bind(ownerWindow);
  return vi.spyOn(ownerWindow, 'getComputedStyle').mockImplementation((element) => {
    const style = original(element);
    const override = overrides.get(element);
    if (override?.display !== undefined) {
      Object.defineProperty(style, 'display', { configurable: true, value: override.display });
    }
    if (override?.overflowY !== undefined) {
      Object.defineProperty(style, 'overflowY', { configurable: true, value: override.overflowY });
    }
    return style;
  });
}

function measurePresentationRoot(root: HTMLElement): void {
  root.getBoundingClientRect = () => rect(0, 0, 1_024, 768);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe('task presentation identity', () => {
  it('delegates the complete TaskRef identity to taskReconciliationKey', () => {
    const ref = {
      filePath: 'folder/odd "] path.md',
      line: 37,
      revision: 'revision:[data-probe="unsafe"]',
    };

    expect(taskPresentationKey(ref)).toBe(taskReconciliationKey(ref));
  });

  it('stores identity as a data value and never interpolates a path into a selector', () => {
    const root = freshContainer();
    const ref = {
      filePath: 'folder/"] :not(*) [data-injected="true"].md',
      line: 4,
      revision: 'revision-with-\\-and-"]',
    };
    const matching = renderIdentity(root, ref);
    const other = renderIdentity(root, { ...ref, revision: 'other' });
    const query = vi.spyOn(root, 'querySelectorAll');

    expect(renderedTaskElements(root, ref)).toEqual([matching]);
    expect(other).not.toBe(matching);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('[data-abyss-task-ref-key]');
    expect(matching.dataset['abyssTaskRefKey']).toBe(taskReconciliationKey(ref));
  });

  it('applies identity only to materialized canonical calendar tasks', () => {
    const snapshot = task({ source: { filePath: 'capture.md', line: 8 } });
    const source = {
      root: snapshot,
      target: { type: 'task' as const, ref: snapshot.ref },
      node: snapshot,
    };
    const materialized: CalendarOccurrence = {
      kind: 'materialized',
      key: 'materialized',
      source,
      planning: snapshot.planning,
      recurring: false,
    };
    const forecast: CalendarOccurrence = {
      kind: 'forecast',
      key: 'forecast',
      source,
      planning: snapshot.planning,
      referenceDate: localDate('2026-08-22'),
      ordinal: 1,
    };
    const materializedElement = freshContainer();
    const forecastElement = freshContainer();

    applyOccurrenceDomState(materializedElement, materialized, 'single', 'body');
    applyOccurrenceDomState(forecastElement, forecast, 'single', 'body');

    expect(materializedElement.dataset['abyssTaskRefKey']).toBe(
      taskReconciliationKey(snapshot.ref),
    );
    expect(forecastElement.hasAttribute('data-abyss-task-ref-key')).toBe(false);
  });

  it('applies the same canonical identity in the shared list and project task-card renderer', () => {
    const snapshot = task({ source: { filePath: 'capture.md', line: 8 } });
    const queries: TaskQueryApi = taskQueryApi({
      resolve: () => exact(snapshot),
      list: () => [snapshot],
    });
    const state = new AppState();
    state.set('selectedList', 'inbox');
    const panel = new CenterPanel({
      state,
      app: {} as App,
      settings: DEFAULT_SETTINGS,
      queries,
      statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    });
    const listHost = freshContainer();
    panel.mount(listHost);
    expect(
      listHost.querySelector<HTMLElement>('.abyss-task-card')?.dataset['abyssTaskRefKey'],
    ).toBe(taskPresentationKey(snapshot.ref));
    const projectHost = listHost.createDiv();

    (
      panel as unknown as {
        renderProjectTasks_abyssPrivate(host: HTMLElement, path: string): void;
      }
    ).renderProjectTasks_abyssPrivate(projectHost, 'capture.md');

    expect(
      projectHost.querySelector<HTMLElement>('.abyss-task-card')?.dataset['abyssTaskRefKey'],
    ).toBe(taskPresentationKey(snapshot.ref));
    panel.destroy();
  });
});

describe('CreationPresentationController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('announces Added immediately and highlights an already-rendered exact task', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const { controller, host, root } = controllerHarness(exact(created));
    const element = renderIdentity(root, created.ref);
    controller.afterRender(root);

    controller.present(result, describeTaskCreationResult(result));

    expect(host.textContent).toBe('Task added to capture.md');
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(element.classList.contains('is-just-created')).toBe(true);
  });

  it('follows an exact reference and a later canonical rebase without guessing', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const current = task({
      ref: { filePath: 'capture.md', line: 5, revision: 'rebased' },
      source: { filePath: 'capture.md', line: 5 },
    });
    const result = successfulCreation(created);
    const harness = controllerHarness({ type: 'not-found', ref: created.ref });
    const staleElement = renderIdentity(harness.root, created.ref);
    const currentElement = renderIdentity(harness.root, current.ref);
    harness.controller.afterRender(harness.root);
    harness.controller.present(result, describeTaskCreationResult(result));

    harness.queries.setResolution({
      type: 'rebased',
      previous: created,
      current,
      evidence: 'authority-transition',
      basis: { observed: created },
    });
    harness.queries.emit();

    expect(staleElement.classList.contains('is-just-created')).toBe(false);
    expect(currentElement.classList.contains('is-just-created')).toBe(true);
  });

  it('does not use visual same-line or title data as creation identity', () => {
    const created = task({ title: 'Repeated title', source: { filePath: 'capture.md', line: 2 } });
    const visual = task({
      title: created.title,
      ref: { filePath: 'capture.md', line: 2, revision: 'different' },
      source: { filePath: 'capture.md', line: 2 },
    });
    const result = successfulCreation(created);
    const harness = controllerHarness({
      type: 'visual',
      stale: created.ref,
      current: visual,
      evidence: 'same-line',
    });
    const guessed = harness.root.createDiv({ text: created.title });
    guessed.dataset['filePath'] = created.source.filePath;
    guessed.dataset['line'] = String(created.source.line);
    applyTaskPresentationIdentity(guessed, visual.ref);
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));
    harness.controller.afterRender(harness.root);

    expect(guessed.classList.contains('is-just-created')).toBe(false);
  });

  it('converges when the index event happens before present and when it happens after present', () => {
    const before = task({ source: { filePath: 'capture.md', line: 1 } });
    const after = task({ source: { filePath: 'capture.md', line: 2 } });
    const beforeHarness = controllerHarness({ type: 'not-found', ref: before.ref });
    const beforeElement = renderIdentity(beforeHarness.root, before.ref);
    beforeHarness.controller.afterRender(beforeHarness.root);
    beforeHarness.queries.setResolution(exact(before));
    beforeHarness.queries.emit();
    const beforeResult = successfulCreation(before);
    beforeHarness.controller.present(beforeResult, describeTaskCreationResult(beforeResult));

    const afterHarness = controllerHarness({ type: 'not-found', ref: after.ref });
    const afterElement = renderIdentity(afterHarness.root, after.ref);
    afterHarness.controller.afterRender(afterHarness.root);
    const afterResult = successfulCreation(after);
    afterHarness.controller.present(afterResult, describeTaskCreationResult(afterResult));
    afterHarness.queries.setResolution(exact(after));
    afterHarness.queries.emit();

    expect(beforeElement.classList.contains('is-just-created')).toBe(true);
    expect(afterElement.classList.contains('is-just-created')).toBe(true);
  });

  it('keeps two unresolved successes queued independently until a render boundary', () => {
    const first = task({ source: { filePath: 'capture.md', line: 1 } });
    const second = task({ source: { filePath: 'capture.md', line: 2 } });
    const resolutions = new Map<string, TaskResolution>();
    const listeners = new Set<(event: TaskIndexEvent) => void>();
    const queries: TaskQueryApi = taskQueryApi({
      list: () => [],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
      resolve: (ref) => resolutions.get(taskReconciliationKey(ref)) ?? { type: 'not-found', ref },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeReconciled: () => () => {},
    });
    const host = freshContainer();
    const root = freshContainer();
    measurePresentationRoot(root);
    const controller = new CreationPresentationController({
      host,
      queries,
      reducedMotion: () => false,
      now: () => Date.now(),
    });
    for (const snapshot of [first, second]) {
      const result = successfulCreation(snapshot);
      controller.present(result, describeTaskCreationResult(result));
      resolutions.set(taskReconciliationKey(snapshot.ref), exact(snapshot));
    }
    const firstElement = renderIdentity(root, first.ref);
    const secondElement = renderIdentity(root, second.ref);

    controller.afterRender(root);

    expect(firstElement.classList.contains('is-just-created')).toBe(true);
    expect(secondElement.classList.contains('is-just-created')).toBe(true);
  });

  it('bounds unresolved successes at 20 by dropping the oldest request', () => {
    const snapshots = Array.from({ length: 21 }, (_, line) =>
      task({ source: { filePath: 'capture.md', line } }),
    );
    const first = expectDefined(snapshots[0]);
    const last = expectDefined(snapshots[20]);
    const resolutions = new Map<string, TaskResolution>();
    const queries: TaskQueryApi = taskQueryApi({
      list: () => [],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
      resolve: (ref) => resolutions.get(taskReconciliationKey(ref)) ?? { type: 'not-found', ref },
      subscribe: () => () => {},
      subscribeReconciled: () => () => {},
    });
    const host = freshContainer();
    const root = freshContainer();
    measurePresentationRoot(root);
    const controller = new CreationPresentationController({
      host,
      queries,
      reducedMotion: () => false,
      now: () => Date.now(),
    });
    for (const snapshot of snapshots) {
      const result = successfulCreation(snapshot);
      controller.present(result, describeTaskCreationResult(result));
    }
    resolutions.set(taskReconciliationKey(first.ref), exact(first));
    resolutions.set(taskReconciliationKey(last.ref), exact(last));
    const firstElement = renderIdentity(root, first.ref);
    const lastElement = renderIdentity(root, last.ref);

    controller.afterRender(root);

    expect(firstElement.classList.contains('is-just-created')).toBe(false);
    expect(lastElement.classList.contains('is-just-created')).toBe(true);
  });

  it('expires unresolved presentation after 3000 ms and ignores a late index event', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness({ type: 'not-found', ref: created.ref });
    const element = renderIdentity(harness.root, created.ref);
    harness.controller.afterRender(harness.root);
    harness.controller.present(result, describeTaskCreationResult(result));

    vi.advanceTimersByTime(3_000);
    harness.queries.setResolution(exact(created));
    harness.queries.emit();
    harness.controller.afterRender(harness.root);

    expect(element.classList.contains('is-just-created')).toBe(false);
  });

  it('chooses the first visible match without scrolling', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const offscreen = renderIdentity(harness.root, created.ref);
    const visible = renderIdentity(harness.root, created.ref);
    offscreen.getBoundingClientRect = () => rect(10, 2_000, 100, 40);
    visible.getBoundingClientRect = () => rect(10, 20, 100, 40);
    const offscreenScroll = vi.fn();
    const visibleScroll = vi.fn();
    offscreen.scrollIntoView = offscreenScroll;
    visible.scrollIntoView = visibleScroll;
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));

    expect(offscreen.classList.contains('is-just-created')).toBe(false);
    expect(visible.classList.contains('is-just-created')).toBe(true);
    expect(offscreenScroll).not.toHaveBeenCalled();
    expect(visibleScroll).not.toHaveBeenCalled();
  });

  it('skips a zero-area first match in favor of a later visible canonical card', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const zeroArea = renderIdentity(harness.root, created.ref);
    const visible = renderIdentity(harness.root, created.ref);
    zeroArea.getBoundingClientRect = () => rect(0, 0, 0, 0);
    const zeroAreaScroll = vi.fn();
    const visibleScroll = vi.fn();
    zeroArea.scrollIntoView = zeroAreaScroll;
    visible.scrollIntoView = visibleScroll;
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));

    expect(zeroArea.classList.contains('is-just-created')).toBe(false);
    expect(visible.classList.contains('is-just-created')).toBe(true);
    expect(zeroAreaScroll).not.toHaveBeenCalled();
    expect(visibleScroll).not.toHaveBeenCalled();
  });

  it('treats a zero-area-only canonical match as offscreen and scrolls it once', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const zeroArea = renderIdentity(harness.root, created.ref);
    zeroArea.getBoundingClientRect = () => rect(0, 0, 0, 0);
    const scroll = vi.fn();
    zeroArea.scrollIntoView = scroll;
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));
    harness.controller.afterRender(harness.root);

    expect(zeroArea.classList.contains('is-just-created')).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  });

  it('does not treat a display-none match as the first visible match', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const hidden = renderIdentity(harness.root, created.ref);
    const visible = renderIdentity(harness.root, created.ref);
    const styleSpy = mockComputedStyles(harness.root, new Map([[hidden, { display: 'none' }]]));
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));

    expect(hidden.classList.contains('is-just-created')).toBe(false);
    expect(visible.classList.contains('is-just-created')).toBe(true);
    styleSpy.mockRestore();
  });

  it('keeps the original deadline when rebinding feedback after a post-success render', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const firstRoot = freshContainer();
    measurePresentationRoot(firstRoot);
    const firstElement = renderIdentity(firstRoot, created.ref);
    harness.controller.afterRender(firstRoot);
    harness.controller.present(result, describeTaskCreationResult(result));
    vi.advanceTimersByTime(400);
    const replacementRoot = freshContainer();
    measurePresentationRoot(replacementRoot);
    const replacement = renderIdentity(replacementRoot, created.ref);

    harness.controller.afterRender(replacementRoot);

    expect(firstElement.classList.contains('is-just-created')).toBe(false);
    expect(replacement.classList.contains('is-just-created')).toBe(true);
    vi.advanceTimersByTime(699);
    expect(replacement.classList.contains('is-just-created')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(replacement.classList.contains('is-just-created')).toBe(false);
  });

  it('chooses a duplicate visible inside its nested scrollport over a clipped first match', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    harness.root.getBoundingClientRect = () => rect(0, 0, 600, 700);
    const clippedScrollport = harness.root.createDiv();
    clippedScrollport.getBoundingClientRect = () => rect(0, 100, 600, 400);
    const clipped = renderIdentity(clippedScrollport, created.ref);
    clipped.getBoundingClientRect = () => rect(10, 20, 100, 40);
    const visibleScrollport = harness.root.createDiv();
    visibleScrollport.getBoundingClientRect = () => rect(0, 100, 600, 400);
    const visible = renderIdentity(visibleScrollport, created.ref);
    visible.getBoundingClientRect = () => rect(10, 120, 100, 40);
    clipped.scrollIntoView = vi.fn();
    visible.scrollIntoView = vi.fn();
    const styleSpy = mockComputedStyles(
      harness.root,
      new Map([
        [clippedScrollport, { overflowY: 'auto' }],
        [visibleScrollport, { overflowY: 'auto' }],
      ]),
    );
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));

    expect(clipped.classList.contains('is-just-created')).toBe(false);
    expect(visible.classList.contains('is-just-created')).toBe(true);
    expect(methodOf(clipped, 'scrollIntoView')).not.toHaveBeenCalled();
    expect(methodOf(visible, 'scrollIntoView')).not.toHaveBeenCalled();
    styleSpy.mockRestore();
  });

  it('scrolls one canonical match clipped by a nested scrollport', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    harness.root.getBoundingClientRect = () => rect(0, 0, 600, 700);
    const scrollport = harness.root.createDiv();
    scrollport.getBoundingClientRect = () => rect(0, 100, 600, 400);
    const clipped = renderIdentity(scrollport, created.ref);
    clipped.getBoundingClientRect = () => rect(10, 20, 100, 40);
    const scroll = vi.fn();
    clipped.scrollIntoView = scroll;
    const styleSpy = mockComputedStyles(
      harness.root,
      new Map([[scrollport, { overflowY: 'auto' }]]),
    );
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));
    harness.controller.afterRender(harness.root);

    expect(clipped.classList.contains('is-just-created')).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
    styleSpy.mockRestore();
  });

  it('scrolls the first offscreen match to the nearest edge and clears normal feedback at 1100 ms', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const element = renderIdentity(harness.root, created.ref);
    element.getBoundingClientRect = () => rect(10, 2_000, 100, 40);
    const scroll = vi.fn();
    element.scrollIntoView = scroll;
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));

    expect(scroll).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
    vi.advanceTimersByTime(1_099);
    expect(element.classList.contains('is-just-created')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.classList.contains('is-just-created')).toBe(false);
  });

  it('uses auto scrolling and an 800 ms static lifecycle under reduced motion', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created), { reducedMotion: true });
    const element = renderIdentity(harness.root, created.ref);
    element.getBoundingClientRect = () => rect(10, 2_000, 100, 40);
    const scroll = vi.fn();
    element.scrollIntoView = scroll;
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));

    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
    vi.advanceTimersByTime(799);
    expect(element.classList.contains('is-just-created')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.classList.contains('is-just-created')).toBe(false);
  });

  it('keeps the mapped success as the filtered-task fallback without changing rendered content', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const existing = harness.root.createDiv({ cls: 'existing-filtered-result' });
    harness.controller.afterRender(harness.root);

    harness.controller.present(result, describeTaskCreationResult(result));
    vi.advanceTimersByTime(3_000);

    expect(harness.host.textContent).toBe('Task added to capture.md');
    expect(Array.from(harness.root.children)).toEqual(expect.arrayContaining([existing]));
    expect(harness.root.querySelectorAll('[data-abyss-task-ref-key]')).toHaveLength(0);
    expect(harness.root.querySelector('.is-just-created')).toBeNull();
  });

  it.each([
    {
      category: 'success',
      result: successfulCreation(task({ source: { filePath: 'capture.md' } })),
      live: 'polite',
    },
    { category: 'failure', result: failedCreation(), live: 'assertive' },
  ] as const)(
    'uses one stable live host and zero Notice instances for $category',
    ({ result, live }) => {
      const ref =
        result.type === 'ok' && result.outcome.type === 'task'
          ? result.outcome.task.ref
          : task().ref;
      const harness = controllerHarness({ type: 'not-found', ref });
      const notice = vi.spyOn(
        Notice.prototype as unknown as {
          constructor__(message: string | DocumentFragment, duration?: number): void;
        },
        'constructor__',
      );

      harness.controller.present(result, describeTaskCreationResult(result));

      expect(harness.host.getAttribute('aria-live')).toBe(live);
      expect(harness.host.querySelector('[aria-live]')).toBeNull();
      expect(notice).not.toHaveBeenCalled();
    },
  );

  it('keeps the status role stable and performs one live/text update per success-to-error result', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const success = successfulCreation(created);
    const error = failedCreation();
    const harness = controllerHarness({ type: 'not-found', ref: created.ref });
    const attributeWrites = vi.spyOn(harness.host, 'setAttribute');
    const observer = new MutationObserver(() => {});
    observer.observe(harness.host, {
      attributes: true,
      attributeFilter: ['aria-live', 'role'],
      childList: true,
    });

    const expectSingleAnnouncementUpdate = (expectedLive: 'polite' | 'assertive'): void => {
      const records = observer.takeRecords();
      expect(harness.host.getAttribute('role')).toBe('status');
      expect(attributeWrites.mock.calls.filter(([name]) => name === 'aria-live')).toEqual([
        ['aria-live', expectedLive],
      ]);
      expect(attributeWrites.mock.calls.filter(([name]) => name === 'role')).toHaveLength(0);
      expect(records.filter((record) => record.attributeName === 'role')).toHaveLength(0);
      expect(records.filter((record) => record.type === 'childList')).toHaveLength(1);
      attributeWrites.mockClear();
    };

    harness.controller.present(success, describeTaskCreationResult(success));
    expectSingleAnnouncementUpdate('polite');

    harness.controller.present(error, describeTaskCreationResult(error));
    expectSingleAnnouncementUpdate('assertive');
    observer.disconnect();
  });

  it.each([
    ['success', successfulCreation(task({ source: { filePath: 'capture.md' } }))],
    ['error', failedCreation()],
  ] as const)('clears %s visual feedback after its bounded display timeout', (_kind, result) => {
    const created = task({ source: { filePath: 'capture.md' } });
    const harness = controllerHarness(exact(created));
    harness.controller.present(result, describeTaskCreationResult(result));

    expect(harness.host.textContent).not.toBe('');
    vi.advanceTimersByTime(3_999);
    expect(harness.host.textContent).not.toBe('');
    vi.advanceTimersByTime(1);

    expect(harness.host.textContent).toBe('');
    expect(harness.host.hasAttribute('data-result-kind')).toBe(false);
    expect(harness.host.hasAttribute('data-requires-recovery')).toBe(false);
    expect(harness.host.getAttribute('role')).toBe('status');
  });

  it('restarts one guarded visual feedback timeout for each newer result', () => {
    const created = task({ source: { filePath: 'capture.md' } });
    const success = successfulCreation(created);
    const error = failedCreation();
    const harness = controllerHarness(exact(created));
    harness.controller.present(success, describeTaskCreationResult(success));
    vi.advanceTimersByTime(3_000);

    harness.controller.present(error, describeTaskCreationResult(error));
    vi.advanceTimersByTime(1_000);
    expect(harness.host.textContent).toBe('Failed to create task. Please try again.');
    vi.advanceTimersByTime(2_999);
    expect(harness.host.textContent).toBe('Failed to create task. Please try again.');
    vi.advanceTimersByTime(1);
    expect(harness.host.textContent).toBe('');
  });

  it('releases queued, highlighted, live-host, and query resources on destroy', () => {
    const created = task({ source: { filePath: 'capture.md', line: 2 } });
    const result = successfulCreation(created);
    const harness = controllerHarness(exact(created));
    const element = renderIdentity(harness.root, created.ref);
    harness.controller.afterRender(harness.root);
    harness.controller.present(result, describeTaskCreationResult(result));
    const queued = task({ source: { filePath: 'capture.md', line: 9 } });
    const queuedResult = successfulCreation(queued);
    harness.queries.setResolution({ type: 'not-found', ref: queued.ref });
    harness.controller.present(queuedResult, describeTaskCreationResult(queuedResult));
    expect(harness.queries.listenerCount()).toBe(1);

    harness.controller.destroy();
    harness.queries.emit();
    harness.controller.present(result, describeTaskCreationResult(result));
    vi.runOnlyPendingTimers();

    expect(element.classList.contains('is-just-created')).toBe(false);
    expect(harness.host.textContent).toBe('');
    expect(harness.queries.listenerCount()).toBe(0);
  });
});

describe('new-task feedback CSS', () => {
  it('uses task/theme color variables and paint-only properties for the 1100 ms animation', () => {
    const rule = cssRuleContaining(css, [
      ':where(.abyss-panel-view, .abyss-modal) .is-just-created',
    ]);

    expect(cssValue(rule, '--abyss-creation-accent')).toBe(
      'var(--abyss-tag-color, var(--interactive-accent))',
    );
    expect(rule).toMatch(/animation\s*:[^;]*1100ms/u);
    expect(rule).toMatch(/outline\s*:/u);
    expect(rule).not.toMatch(/(?:^|;)\s*(?:border|margin|padding|width|height)\s*:/u);
  });

  it('uses a static reduced-motion paint state while the controller owns the 800 ms lifecycle', () => {
    let reduced = '';
    postcss.parse(css).walkAtRules('media', (rule) => {
      if (rule.params === '(prefers-reduced-motion: reduce)')
        reduced += cssRuleContaining(rule.toString(), [
          ':where(.abyss-panel-view, .abyss-modal) .is-just-created',
        ]);
    });

    expect(reduced).toMatch(/animation\s*:\s*none/u);
    expect(reduced).toMatch(/outline/u);
  });

  it('keeps the initially empty live host in the accessibility tree', () => {
    const emptyRule = cssRuleContaining(css, ['.abyss-creation-feedback:empty']);

    expect(emptyRule).toMatch(/opacity\s*:\s*0/u);
    expect(emptyRule).not.toMatch(/(?:display|visibility|content-visibility)\s*:/u);
  });
});

describe('scoped virtual creation reveal', () => {
  it('retries through the existing pending result and reveals once without recursive render completion', () => {
    const snapshot = task({ source: { filePath: 'capture.md', line: 999 } });
    const h = controllerHarness({ type: 'not-found', ref: snapshot.ref });
    let target: HTMLElement | undefined;
    const reveal = vi.fn(() => {
      h.controller.afterRender(h.root);
      target = renderIdentity(h.root, snapshot.ref);
      target.scrollIntoView = vi.fn();
      return target;
    });
    const result = successfulCreation(snapshot);
    h.controller.afterRender(h.root);
    h.controller.present(result, describeTaskCreationResult(result), {
      isCurrent: () => true,
      reveal,
    });
    expect(reveal).not.toHaveBeenCalled();
    h.queries.setResolution(exact(snapshot));
    h.queries.emit();
    expect(reveal).toHaveBeenCalledExactlyOnceWith(snapshot.ref, expect.anything());
    expect(target?.classList.contains('is-just-created')).toBe(true);
    target?.remove();
    h.controller.afterRender(h.root);
    expect(reveal).toHaveBeenCalledTimes(1);
    const remounted = renderIdentity(h.root, snapshot.ref);
    remounted.getBoundingClientRect = () => rect(10, 2000, 100, 40);
    const scroll = vi.fn();
    remounted.scrollIntoView = scroll;
    h.controller.afterRender(h.root);
    expect(remounted.classList.contains('is-just-created')).toBe(true);
    expect(scroll).not.toHaveBeenCalled();
    h.controller.destroy();
  });
  it('never falls back to legacy scrolling after per-result capture authority is revoked', () => {
    const snapshot = task({ source: { filePath: 'capture.md', line: 999 } });
    const h = controllerHarness({ type: 'not-found', ref: snapshot.ref });
    let valid = true;
    const reveal = vi.fn();
    h.controller.afterRender(h.root);
    const result = successfulCreation(snapshot);
    h.controller.present(result, describeTaskCreationResult(result), {
      isCurrent: () => valid,
      reveal,
    });
    valid = false;
    const target = renderIdentity(h.root, snapshot.ref);
    target.getBoundingClientRect = () => rect(10, 2000, 100, 40);
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    h.queries.setResolution(exact(snapshot));
    h.queries.emit();
    h.controller.afterRender(h.root);
    expect(reveal).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
    h.controller.destroy();
  });
});

describe('asynchronous creation receipts', () => {
  it('holds one attempt across reentrant renders and presents directly on settlement', async () => {
    const snapshot = task();
    const h = controllerHarness(exact(snapshot));
    const held = deferred<HTMLElement | undefined>();
    let request: CreationRevealRequest | undefined;
    const reveal = vi.fn((_ref: TaskRef, next: CreationRevealRequest) => {
      request = next;
      h.controller.afterRender(h.root);
      return held.promise;
    });
    h.controller.afterRender(h.root);
    const result = successfulCreation(snapshot);
    h.controller.present(result, describeTaskCreationResult(result), {
      isCurrent: () => true,
      reveal,
    });
    h.controller.afterRender(h.root);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(request?.isCurrent()).toBe(true);
    const target = renderIdentity(h.root, snapshot.ref);
    held.resolve(target);
    await held.promise;
    await Promise.resolve();
    expect(target.classList.contains('is-just-created')).toBe(true);
    h.controller.destroy();
  });
  it.each(['source', 'ref', 'expiry', 'destroy', 'root'] as const)(
    'aborts a held attempt on %s',
    async (cause) => {
      const snapshot = task();
      const h = controllerHarness(exact(snapshot));
      const held = deferred<HTMLElement | undefined>();
      let request: CreationRevealRequest | undefined;
      h.controller.afterRender(h.root);
      const result = successfulCreation(snapshot);
      h.controller.present(result, describeTaskCreationResult(result), {
        isCurrent: () => true,
        reveal: (_ref, next) => {
          request = next;
          return held.promise;
        },
      });
      if (cause === 'source') h.queries.emit({ type: 'changed', files: ['unrelated.md'] });
      if (cause === 'ref') {
        h.queries.setResolution(
          exact({ ...snapshot, ref: { ...snapshot.ref, revision: 'replaced' } }),
        );
        h.controller.afterRender(h.root);
      }
      if (cause === 'expiry') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3001);
        h.controller.afterRender(h.root);
      }
      if (cause === 'destroy') h.controller.destroy();
      if (cause === 'root') h.controller.afterRender(freshContainer());
      expect(request?.signal.aborted).toBe(true);
      const target = renderIdentity(h.root, snapshot.ref);
      held.resolve(target);
      await held.promise;
      await Promise.resolve();
      expect(target.classList.contains('is-just-created')).toBe(false);
      h.controller.destroy();
      vi.restoreAllMocks();
    },
  );
  it('repaints only remaining highlight duration without revealing again', () => {
    const snapshot = task();
    const h = controllerHarness(exact(snapshot));
    const target = renderIdentity(h.root, snapshot.ref);
    const reveal = vi.fn(() => target);
    const result = successfulCreation(snapshot);
    h.controller.afterRender(h.root);
    h.controller.present(result, describeTaskCreationResult(result), {
      isCurrent: () => true,
      reveal,
    });
    expect(target.classList.contains('is-just-created')).toBe(true);
    const start = Date.now();
    target.remove();
    vi.spyOn(Date, 'now').mockReturnValue(start + 700);
    const next = renderIdentity(h.root, snapshot.ref);
    h.controller.refreshMounted(h.root);
    expect(next.classList.contains('is-just-created')).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(start + 1101);
    h.controller.refreshMounted(h.root);
    expect(next.classList.contains('is-just-created')).toBe(false);
    h.controller.destroy();
    vi.restoreAllMocks();
  });
});

it('waits for real compact creation hydration and Markdown, then repaints only remaining pulse on remount', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.taskFilePath = 'created.md';
  const h = await mountCanonicalSearchUi(
    {
      'many.md': Array.from({ length: 1200 }, (_, n) => `- [ ] needle ${n}`).join('\n'),
      'created.md': '',
    },
    settings,
    'tasks',
    undefined,
    true,
  );
  const hydration = deferred<void>(),
    markdown = deferred<void>();
  try {
    h.query('needle');
    await h.completed();
    const complete = vi.spyOn(h.panel, 'completeTaskCardRender_abyssPrivate');
    const actual = h.index.resolveSearchHits.bind(h.index);
    const entered = deferred<void>();
    vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
      if (
        hits.some((hit) => {
          const file = h.source.files().find((file) => file.path === 'created.md');
          return (
            file !== undefined &&
            [...h.source.nodes(file)].some((node) => node.rootId === hit.address.rootId)
          );
        })
      ) {
        entered.resolve();
        await hydration.promise;
      }
      return actual(hits, signal);
    });
    const rendered = deferred<void>();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
      holder.createEl('strong', { text });
      if (text.includes('created needle')) {
        rendered.resolve();
        await markdown.promise;
      }
    });
    expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')).click();
    await flushMicrotasks();
    const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-capture-input'));
    input.value = '**created needle**';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await entered.promise;
    await h.completed();
    const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
    const reveal = vi.spyOn(surface, 'reveal');
    expect(h.root.querySelector('.is-just-created')).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
    const completions = complete.mock.calls.length;
    hydration.resolve();
    await rendered.promise;
    expect(h.root.querySelector('.is-just-created')).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
    markdown.resolve();
    await vi.waitFor(() => {
      expect(h.root.querySelector('.is-just-created')).not.toBeNull();
    });
    const created = expectDefined(h.index.list({ filePath: 'created.md' })[0]);
    const card = expectDefined(h.root.querySelector<HTMLElement>('.is-just-created'));
    expect(renderedTaskElements(h.root, created.ref)).toContain(card);
    expect(document.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(completions);
    const deadline = Date.now() + 1100;
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(card.isConnected).toBe(false);
    });
    scroll.scrollTop = 1200 * 64;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(h.root.querySelector('.is-just-created')).not.toBeNull();
    });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(completions);
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    h.creation?.refreshMounted(h.root);
    expect(h.root.querySelector('.is-just-created')).toBeNull();
  } finally {
    hydration.resolve();
    markdown.resolve();
    h.dispose();
  }
});

it.each(['hydration', 'markdown'] as const)(
  'revokes the real compact creation %s wait on later capture, source and window intent',
  async (stage) => {
    for (const reason of [
      'input',
      'blur',
      'filter',
      'navigation',
      'source',
      'hidden',
      'migration',
    ] as const) {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.taskFilePath = 'created.md';
      const h = await mountCanonicalSearchUi(
        {
          'many.md': Array.from({ length: 1200 }, (_, n) => `- [ ] needle ${n}`).join('\n'),
          'created.md': '',
        },
        settings,
        'tasks',
        undefined,
        true,
      );
      const hydration = deferred<void>(),
        markdown = deferred<void>();
      const entered = deferred<void>(),
        rendered = deferred<void>();
      let request: CreationRevealRequest | undefined;
      let migrated: ReturnType<typeof taskViewportOwner> | undefined;
      try {
        h.query('needle');
        await h.completed();
        const presentation = expectDefined(h.creation);
        const present = presentation.present.bind(presentation);
        vi.spyOn(presentation, 'present').mockImplementation((result, description, authority) => {
          if (authority !== undefined) {
            const reveal = authority.reveal.bind(authority);
            vi.spyOn(authority, 'reveal').mockImplementation((ref, current) => {
              request = current;
              return reveal(ref, current);
            });
          }
          present(result, description, authority);
        });
        const actual = h.index.resolveSearchHits.bind(h.index);
        vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
          const created = h.source.files().find((file) => file.path === 'created.md');
          if (
            created !== undefined &&
            hits.some((hit) =>
              [...h.source.nodes(created)].some((node) => node.rootId === hit.address.rootId),
            )
          ) {
            entered.resolve();
            await hydration.promise;
          }
          return actual(hits, signal);
        });
        vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
          holder.createEl('strong', { text });
          if (text.includes('created needle')) {
            rendered.resolve();
            await markdown.promise;
          }
        });
        expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')).click();
        await flushMicrotasks();
        const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-capture-input'));
        input.value = '**created needle**';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await entered.promise;
        await h.completed();
        const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
        const reveal = vi.spyOn(surface, 'reveal');
        await settleCreationStage(stage, hydration, rendered);
        expect(request).toBeDefined();
        if (reason === 'input') {
          input.value = 'new draft';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (reason === 'blur') {
          const outside = document.body.createEl('input');
          outside.focus();
          outside.remove();
        }
        if (reason === 'filter') h.query('different');
        if (reason === 'navigation') h.panel['navigation_abyssPrivate'].openList('upcoming');
        if (reason === 'source')
          h.index.installCommittedContent('created.md', '- [ ] replacement needle');
        if (reason === 'hidden') {
          h.root.hide();
          h.root.ownerDocument.dispatchEvent(new Event('visibilitychange'));
        }
        if (reason === 'migration') {
          migrated = taskViewportOwner();
          migrated.doc.body.append(h.root);
          h.panel.onWindowMigrated();
        }
        await vi.waitFor(() => {
          expect(request?.signal.aborted).toBe(true);
        });
        hydration.resolve();
        markdown.resolve();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(reveal).not.toHaveBeenCalled();
        expect(h.root.querySelector('.is-just-created')).toBeNull();
        expect(h.panel['creationAttempts_abyssPrivate'].size).toBe(0);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThan(1200);
      } finally {
        hydration.resolve();
        markdown.resolve();
        h.dispose();
        migrated?.destroy();
        vi.restoreAllMocks();
      }
    }
  },
);

async function settleCreationStage(
  stage: 'hydration' | 'markdown',
  hydration: ReturnType<typeof deferred<void>>,
  rendered: ReturnType<typeof deferred<void>>,
): Promise<void> {
  if (stage === 'markdown') {
    hydration.resolve();
    await rendered.promise;
  }
}
