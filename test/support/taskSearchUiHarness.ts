import { vi } from 'vitest';
import { AppState } from '../../src/app/AppState';
import { BrowserTaskCancelled, type BrowserTaskScheduler } from '../../src/browserTaskScheduler';
import type { TaskSearchOptions } from '../../src/panels/center/TaskSearch';
import { CenterPanel } from '../../src/panels/CenterPanel';
import type { CalendarSettings } from '../../src/settings/types';
import { createSearchWordSegmenter } from '../../src/tasks/infrastructure/search/searchWordSegmenter';
import { createCanonicalSearchHarness } from './taskSearchHarness';

/** Wait for the current surface's owned terminal render receipt, not backend readiness. */
export async function searchUiCompleted(root: HTMLElement): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const win = root.ownerDocument.defaultView;
    if (win === null) {
      reject(new Error('Owner window missing'));
      return;
    }
    let timer = 0;
    const observer = new win.MutationObserver(check);
    function check(): void {
      if (root.dataset['searchPhase'] === 'error') {
        cleanup();
        reject(
          new Error(root.querySelector('.abyss-search-status')?.textContent ?? 'Search failed'),
        );
      } else if (root.dataset['searchPhase'] === 'complete') {
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
  organizationScheduler?: TaskSearchOptions['organizationScheduler'],
) {
  const h = await createCanonicalSearchHarness(files, settings, true, createSearchWordSegmenter());
  const state = new AppState();
  state.set('selectedList', 'inbox');
  state.set('mode', mode);
  const root = document.body.createDiv({ cls: 'abyss-panel-view' });
  const panel = new CenterPanel({
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
  panel.mount(root);
  return {
    ...h,
    state,
    panel,
    root,
    query(text: string) {
      const input = root.querySelector<HTMLInputElement>(
        mode === 'search' ? '.abyss-search-global' : '.abyss-center-search',
      );
      if (input === null) throw new Error('Query input missing');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    completed: () => searchUiCompleted(root),
    dispose() {
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
