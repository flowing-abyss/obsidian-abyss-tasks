import { expect, it, vi } from 'vitest';
import { TaskSearchPages } from '../src/panels/task-list/TaskSearchPages';
import type { TaskSearchOrganization } from '../src/task-lists/taskSearchOrganization';
import type { TaskSearchApi } from '../src/tasks/application/TaskSearchApi';
import type { TaskSearchHit } from '../src/tasks/domain/taskSearchTypes';
import { task } from './helpers';
function pageSearchApi() {
  const calls: Array<readonly TaskSearchHit[]> = [];
  const unexpected = () => {
    throw new Error('Unexpected service call');
  };
  const api: TaskSearchApi = {
    prepare: vi.fn(unexpected),
    open: vi.fn(unexpected),
    read: vi.fn(unexpected),
    release: vi.fn(unexpected),
    subscribe: vi.fn(unexpected),
    resolvePage: vi.fn(async (hits: readonly TaskSearchHit[]) => {
      calls.push(hits);
      return hits.map((hit) => ({
        hit,
        task: {
          root: task(),
          node: task(),
          path: [],
          target: { type: 'task' as const, ref: task().ref },
        },
      }));
    }),
  };
  return { api, calls };
}
function organizationWithOccurrences(
  count: number,
  options: { duplicateFirstRoot?: boolean } = {},
): TaskSearchOrganization {
  return {
    generation: 1,
    rootTotal: count - (options.duplicateFirstRoot === true ? 1 : 0),
    groupCounts: new Map(),
    occurrences: Array.from({ length: count }, (_, i) => ({
      key: String(i),
      score: 1,
      group: null,
      address: {
        epoch: 'test',
        version: 1,
        rootId: options.duplicateFirstRoot === true && i === 1 ? 0 : i,
        childLines: [],
      },
    })),
  };
}
it('hydrates one root for duplicate occurrences and replaces bounded pages', async () => {
  const search = pageSearchApi();
  const pages = new TaskSearchPages(search.api);
  pages.set(organizationWithOccurrences(101, { duplicateFirstRoot: true }));
  const first = await pages.page(0, new AbortController().signal);
  const last = await pages.page(2, new AbortController().signal);
  expect(first.occurrences).toHaveLength(50);
  expect(last.occurrences).toHaveLength(1);
  expect(new Set(search.calls[0]?.map((h) => h.address.rootId)).size).toBe(49);
  expect(last.total).toBe(101);
  expect(last.rootTotal).toBe(100);
  expect(last.pageCount).toBe(3);
  pages.dispose();
  await expect(pages.page(0, new AbortController().signal)).rejects.toThrow();
});
it('rejects late hydration after organization replacement', async () => {
  const search = pageSearchApi();
  let release!: () => void;
  const original = search.api.resolvePage.bind(search.api);
  search.api.resolvePage = async (hits, signal) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return original(hits, signal);
  };
  const pages = new TaskSearchPages(search.api);
  pages.set(organizationWithOccurrences(51));
  const old = pages.page(0, new AbortController().signal);
  const rejected = expect(old).rejects.toThrow();
  pages.set(organizationWithOccurrences(1));
  release();
  await rejected;
  pages.dispose();
});
