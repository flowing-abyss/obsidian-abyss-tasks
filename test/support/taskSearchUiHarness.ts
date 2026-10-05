import { vi } from 'vitest';
import { AppState } from '../../src/app/AppState';
import { BrowserTaskCancelled, type BrowserTaskScheduler } from '../../src/browserTaskScheduler';
import type { TaskSearchOptions } from '../../src/panels/center/TaskSearch';
import { CenterPanel } from '../../src/panels/CenterPanel';
import type { CalendarSettings } from '../../src/settings/types';
import { createSearchWordSegmenter } from '../../src/tasks/infrastructure/search/searchWordSegmenter';
import { CreationPresentationController } from '../../src/ui/creation/CreationPresentationController';
import { prepareTaskPanelViewport } from './taskPanelViewport';
import { createCanonicalSearchHarness } from './taskSearchHarness';

/** Wait for the current surface's owned terminal render receipt, not backend readiness. */
export async function searchUiCompleted(
  root: HTMLElement,
  generation?: () => number,
): Promise<void> {
  let request = root.dataset['searchRequest'];
  const input = root.querySelector<HTMLInputElement>('.abyss-search-global, .abyss-center-search');
  const query = input?.value;
  await new Promise<void>((resolve, reject) => {
    const win = root.ownerDocument.defaultView;
    if (win === null) {
      reject(new Error('Owner window missing'));
      return;
    }
    let timer = 0;
    const observer = new win.MutationObserver(check);
    function currentQuery(): boolean {
      return input?.value === query;
    }
    function check(): void {
      if (!currentQuery()) return;
      if (root.dataset['searchPhase'] === 'pending') request = root.dataset['searchRequest'];
      if (root.dataset['searchRequest'] !== request) return;
      if (root.dataset['searchPhase'] === 'error') {
        cleanup();
        reject(
          new Error(root.querySelector('.abyss-search-status')?.textContent ?? 'Search failed'),
        );
      } else if (
        root.dataset['searchPhase'] === 'complete' &&
        (generation === undefined || root.dataset['searchGeneration'] === String(generation()))
      ) {
        cleanup();
        resolve();
      }
    }
    function cleanup(): void {
      observer.disconnect();
      win?.clearTimeout(timer);
    }
    observer.observe(root, { attributes: true, subtree: true, childList: true });
    timer = win.setTimeout(() => {
      cleanup();
      reject(new Error('Search render did not settle'));
    }, 3000);
    check();
  });
}
export async function mountCanonicalSearchUi(
  files: Record<string, string>,
  settings: CalendarSettings,
  mode: 'search' | 'tasks' = 'search',
  ...presentation: [
    organizationScheduler?: TaskSearchOptions['organizationScheduler'],
    creationPresentation?: boolean,
  ]
) {
  const [organizationScheduler, creationPresentation = false] = presentation;
  const h = await createCanonicalSearchHarness(files, settings, true, createSearchWordSegmenter());
  const state = new AppState();
  state.set('selectedList', 'inbox');
  state.set('mode', mode);
  const root = document.body.createDiv({ cls: 'abyss-panel-view' });
  const statusHost = document.body.createDiv();
  const creation = creationPresentation
    ? new CreationPresentationController({
        host: statusHost,
        queries: h.index,
        reducedMotion: () => false,
        now: () => Date.now(),
      })
    : undefined;
  const panel = new CenterPanel({
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
  });
  prepareTaskPanelViewport(root);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
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
    completed: async () => {
      await searchUiCompleted(root, () => {
        const current = h.source.subscribe(() => {});
        current.unsubscribe();
        return current.state.generation;
      });
      const snapshot = h.source.subscribe(() => {});
      const state = snapshot.state;
      snapshot.unsubscribe();
      if (root.dataset['searchGeneration'] !== String(state.generation))
        throw new Error('Search completed for an obsolete source generation');
    },
    dispose() {
      creation?.destroy();
      statusHost.remove();
      panel.destroy();
      root.remove();
      h.close();
    },
  };
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
