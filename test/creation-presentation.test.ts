import { Notice, Platform, type App } from 'obsidian';
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
import { CreationPresentationController } from '../src/ui/creation/CreationPresentationController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import {
  applyTaskPresentationIdentity,
  renderedTaskElements,
  taskPresentationKey,
} from '../src/ui/taskPresentationIdentity';
import type { CalendarOccurrence } from '../src/views/calendarOccurrences';
import { applyOccurrenceDomState } from '../src/views/timegrid/renderTaskMeta';
import { expectDefined, freshContainer, methodOf, task, useRealMoment } from './helpers';

async function loadStylesFixture(): Promise<string> {
  if (!Platform.isDesktop) throw new Error('CSS fixture requires the desktop test runtime');
  const fileSystem = await import('node:fs');
  const nodePath = await import('node:path');
  return fileSystem.readFileSync(nodePath.resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
}

const css = await loadStylesFixture();
useRealMoment();

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
    queries: {
      list: () => [],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
      resolve: () => resolution,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
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
    const queries: TaskQueryApi = {
      ...queryHarness(exact(snapshot)).queries,
      list: () => [snapshot],
    };
    const state = new AppState();
    state.set('selectedList', 'inbox');
    const panel = new CenterPanel(
      state,
      {} as App,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    );
    const listHost = freshContainer();
    panel.mount(listHost);
    const listCards = freshContainer();
    const projectHost = freshContainer();

    (
      panel as unknown as {
        renderTaskCard_abyssPrivate(host: HTMLElement, taskSnapshot: TaskSnapshot): void;
        renderProjectTasks(host: HTMLElement, path: string): void;
      }
    ).renderTaskCard_abyssPrivate(listCards, snapshot);
    (
      panel as unknown as {
        renderProjectTasks_abyssPrivate(host: HTMLElement, path: string): void;
      }
    ).renderProjectTasks_abyssPrivate(projectHost, 'capture.md');

    expect(
      listCards.querySelector<HTMLElement>('.abyss-task-card')?.dataset['abyssTaskRefKey'],
    ).toBe(taskPresentationKey(snapshot.ref));
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
    const queries: TaskQueryApi = {
      list: () => [],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
      resolve: (ref) => resolutions.get(taskReconciliationKey(ref)) ?? { type: 'not-found', ref },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
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
    const queries: TaskQueryApi = {
      list: () => [],
      forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
      resolve: (ref) => resolutions.get(taskReconciliationKey(ref)) ?? { type: 'not-found', ref },
      subscribe: () => () => {},
    };
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
    const rule = /\.is-just-created\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';

    expect(rule).toMatch(
      /var\(\s*--abyss-tag-color\s*,\s*var\(\s*--task-color\s*,\s*var\(\s*--interactive-accent\s*\)\s*\)\s*\)/u,
    );
    expect(rule).toMatch(/animation\s*:[^;]*1100ms/u);
    expect(rule).toMatch(/outline\s*:/u);
    expect(rule).not.toMatch(/(?:^|;)\s*(?:border|margin|padding|width|height)\s*:/u);
  });

  it('uses a static reduced-motion paint state while the controller owns the 800 ms lifecycle', () => {
    const reduced =
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.is-just-created\s*\{([^}]*)\}/u.exec(
        css,
      )?.[1] ?? '';

    expect(reduced).toMatch(/animation\s*:\s*none/u);
    expect(reduced).toMatch(/outline/u);
  });

  it('keeps the initially empty live host in the accessibility tree', () => {
    const emptyRule = /\.abyss-creation-feedback:empty\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';

    expect(emptyRule).toMatch(/opacity\s*:\s*0/u);
    expect(emptyRule).not.toMatch(/(?:display|visibility|content-visibility)\s*:/u);
  });
});
