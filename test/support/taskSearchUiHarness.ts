import { vi } from 'vitest';
import { AppState } from '../../src/app/AppState';
import { BrowserTaskCancelled, type BrowserTaskScheduler } from '../../src/browserTaskScheduler';
import type { TaskSearchOptions } from '../../src/panels/center/TaskSearch';
import { CenterPanel } from '../../src/panels/CenterPanel';
import type { CalendarSettings } from '../../src/settings/types';
import type { Clock } from '../../src/tasks/domain/clock';
import { createSearchWordSegmenter } from '../../src/tasks/infrastructure/search/searchWordSegmenter';
import { CreationPresentationController } from '../../src/ui/creation/CreationPresentationController';
import { prepareTaskPanelViewport, taskListRect } from './taskPanelViewport';
import { createCanonicalSearchHarness } from './taskSearchHarness';

export interface SearchUiCompletionLifetime {
  readonly signal: AbortSignal;
  readonly phase: string;
}

// Scalar-only failure receipts survive teardown, including the navigation factory's setup gap.
const cancelledReceipts = new WeakMap<AbortSignal, string>();
export function searchUiCancellationDiagnostic(signal: AbortSignal): string | undefined {
  return cancelledReceipts.get(signal);
}

/** Wait for the current surface's owned terminal render receipt, not backend readiness. */
export async function searchUiCompleted(
  root: HTMLElement,
  generation?: () => number,
  lifetime?: SearchUiCompletionLifetime,
): Promise<void> {
  let request = root.dataset['searchRequest'];
  const input = root.querySelector<HTMLInputElement>('.abyss-search-global, .abyss-center-search');
  const query = input?.value;
  await new Promise<void>((resolve, reject) => {
    const win = root.ownerDocument.defaultView;
    let observer: MutationObserver | undefined;
    let timer: number | undefined;
    let finished = false;
    let listening = false;
    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      if (timer !== undefined) win?.clearTimeout(timer);
      if (listening) lifetime?.signal.removeEventListener('abort', abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    function fail(error: unknown): void {
      if (error instanceof Error) {
        finish(error);
        return;
      }
      const message = typeof error === 'string' ? error : 'Search receipt check failed';
      finish(new Error(message));
    }
    function abort(): void {
      try {
        const diagnostic = JSON.stringify({
          phase: lifetime?.phase,
          expectedQuery: String(query),
          actualQuery: String(input?.value),
          expectedRequest: String(request),
          actualRequest: String(root.dataset['searchRequest']),
          expectedPhase: 'complete',
          actualPhase: String(root.dataset['searchPhase']),
          expectedGeneration: generation === undefined ? 'untracked' : generation(),
          actualGeneration: String(root.dataset['searchGeneration']),
        });
        if (lifetime !== undefined) cancelledReceipts.set(lifetime.signal, diagnostic);
        finish(new Error(`Search receipt cancelled: ${diagnostic}`));
      } catch (error) {
        fail(error);
      }
    }
    function currentGeneration(): boolean {
      return generation === undefined || root.dataset['searchGeneration'] === String(generation());
    }
    function searchError(): Error {
      return new Error(root.querySelector('.abyss-search-status')?.textContent ?? 'Search failed');
    }
    function isAborted(): boolean {
      return lifetime?.signal.aborted === true;
    }
    function check(): void {
      if (finished) return;
      try {
        if (input?.value !== query) return;
        if (root.dataset['searchPhase'] === 'pending') request = root.dataset['searchRequest'];
        if (root.dataset['searchRequest'] !== request) return;
        if (root.dataset['searchPhase'] === 'error') finish(searchError());
        else if (root.dataset['searchPhase'] === 'complete' && currentGeneration()) finish();
      } catch (error) {
        fail(error);
      }
    }
    if (isAborted()) {
      abort();
      return;
    }
    try {
      if (win === null) throw new Error('Owner window missing');
      if (lifetime !== undefined) {
        listening = true;
        lifetime.signal.addEventListener('abort', abort, { once: true });
        if (isAborted()) {
          abort();
          return;
        }
      }
      observer = new win.MutationObserver(check);
      observer.observe(root, { attributes: true, subtree: true, childList: true });
      if (lifetime === undefined)
        timer = win.setTimeout(() => {
          finish(new Error('Search render did not settle'));
        }, 3000);
      check();
    } catch (error) {
      fail(error);
    }
  });
}
export async function mountCanonicalSearchUi(
  files: Record<string, string>,
  settings: CalendarSettings,
  mode: 'search' | 'tasks' = 'search',
  ...presentation: [
    organizationScheduler?: TaskSearchOptions['organizationScheduler'],
    creationPresentation?: boolean,
    clock?: Clock,
    readYield?: (signal: AbortSignal) => Promise<void>,
    lifetimeSignal?: AbortSignal,
  ]
) {
  const [organizationScheduler, creationPresentation = false, clock, readYield, lifetimeSignal] =
    presentation;
  const lifetime = lifetimeSignal === undefined ? undefined : new AbortController();
  const h = await createCanonicalSearchHarness(
    files,
    settings,
    true,
    createSearchWordSegmenter(),
    clock,
    readYield,
    lifetimeSignal,
  );
  let acquiredRoot: HTMLElement | undefined;
  let acquiredStatusHost: HTMLElement | undefined;
  let acquiredCreation: CreationPresentationController | undefined;
  let acquiredPanel: CenterPanel | undefined;
  let disposed = false;
  function cancelReceipts(): void {
    if (lifetime === undefined) return;
    lifetime.abort(lifetimeSignal?.reason ?? new Error('Search UI disposed'));
    const diagnostic = cancelledReceipts.get(lifetime.signal);
    if (diagnostic !== undefined && lifetimeSignal !== undefined)
      cancelledReceipts.set(lifetimeSignal, diagnostic);
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    // Each owner must get its release attempt even if an earlier owner fails.
    for (const release of [
      cancelReceipts,
      () => acquiredCreation?.destroy(),
      () => acquiredStatusHost?.remove(),
      () => acquiredPanel?.destroy(),
      () => acquiredRoot?.remove(),
      h.close,
      () => lifetimeSignal?.removeEventListener('abort', abort),
    ]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
  function abort(): void {
    try {
      dispose();
    } catch (error) {
      // EventTarget cannot propagate to the cancelling caller; the row log guard owns this failure.
      console.error('[abyss-tasks] Search UI cancellation cleanup failed', error);
    }
  }
  function assumeOwnership(): void {
    lifetimeSignal?.addEventListener('abort', abort, { once: true });
    if (lifetimeSignal?.aborted === true) {
      dispose();
      lifetimeSignal.throwIfAborted();
    }
  }
  try {
    assumeOwnership();
    const state = new AppState();
    state.set('selectedList', 'inbox');
    state.set('mode', mode);
    const root = (acquiredRoot = document.body.createDiv({ cls: 'abyss-panel-view' }));
    const statusHost = (acquiredStatusHost = document.body.createDiv());
    const creation = (acquiredCreation = creationPresentation
      ? new CreationPresentationController({
          host: statusHost,
          queries: h.index,
          reducedMotion: () => false,
          now: () => Date.now(),
        })
      : undefined);
    const panel = (acquiredPanel = new CenterPanel({
      captureApplication: creationPresentation ? h.tasks : undefined,
      onCreationResult: (result, description, authority) =>
        creation?.present(result, description, authority),
      onRenderComplete: (root) => creation?.afterRender(root),
      onTaskRowsSettled: (root) => creation?.refreshMounted(root),
      organizationScheduler:
        organizationScheduler ?? (vi.isFakeTimers() ? timerOrganizationScheduler : undefined),
      state,
      app: h.app,
      settings,
      queries: h.index,
      search: h.search,
      statusRegistry: h.statusRegistry,
      tasks: h.tasks,
    }));
    prepareTaskPanelViewport(root, true);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const taskRect = taskListRect(this);
      if (taskRect !== undefined) return taskRect;
      let height = 900;
      if (this.hasClass('abyss-task-card')) height = 64;
      if (this.hasClass('abyss-group-header')) height = 32;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 700,
        bottom: height,
        width: 700,
        height,
        toJSON: () => ({}),
      };
    });
    panel.mount(root);
    return {
      ...h,
      state,
      panel,
      creation,
      root,
      query(text: string) {
        const input = root.querySelector<HTMLInputElement>(
          mode === 'search' ? '.abyss-search-global' : '.abyss-center-search',
        );
        if (input === null) throw new Error('Query input missing');
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      completed: async (phase = 'search') => {
        await searchUiCompleted(
          root,
          () => {
            const current = h.source.subscribe(() => {});
            current.unsubscribe();
            return current.state.generation;
          },
          lifetime === undefined ? undefined : { signal: lifetime.signal, phase },
        );
        const snapshot = h.source.subscribe(() => {});
        const state = snapshot.state;
        snapshot.unsubscribe();
        if (root.dataset['searchGeneration'] !== String(state.generation))
          throw new Error('Search completed for an obsolete source generation');
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Fake-clock tests need owner task turns governed by the same virtual timer queue. */
function timerOrganizationScheduler(owner: Window): Pick<BrowserTaskScheduler, 'now' | 'yield'> {
  return {
    now: () => owner.performance.now(),
    yield: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new BrowserTaskCancelled());
          return;
        }
        const abort = (): void => {
          owner.clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new BrowserTaskCancelled());
        };
        const timer = owner.setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 0);
        signal.addEventListener('abort', abort, { once: true });
      }),
  };
}
