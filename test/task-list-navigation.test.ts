import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  navigateTaskListTarget,
  resolveTaskListRef,
} from '../src/panels/center/TaskListNavigation';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { taskNodeRef } from '../src/ui/taskSelection';
import { PanelNavigator } from '../src/views/panelNavigation';
import { expectDefined, useRealMoment } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const h = await createCanonicalSearchHarness(
    {
      'a.md': '- [ ] repeated\n  - [ ] repeated\n    - [ ] repeated\n- [ ] repeated',
      'b.md': '- [ ] repeated',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const signal = new AbortController().signal;
  await h.search.prepare(signal);
  const cursor = await h.search.open({ kind: 'roots', query: 'repeated' }, signal);
  const page = await h.search.read(cursor, 0, 10, signal);
  h.search.release(cursor);
  const address = expectDefined(page.hits[0]).address;
  const hit = expectDefined((await h.search.resolveHits([{ address, score: 0 }], signal))[0]);
  const child = expectDefined(expectDefined(hit.task.root.subtasks[0]).subtasks[0]);
  return {
    ...h,
    signal,
    generation: cursor.generation,
    address,
    target: taskNodeRef(child),
    root: hit.task.root,
  };
}

it('resolves an exact deep ref through note-local organization without full hydrated-list reads', async () => {
  const h = await fixture();
  try {
    const list = vi.spyOn(h.index, 'list');
    const nodes = vi.spyOn(h.index, 'listNodes');
    const organization = vi.spyOn(h.index, 'organization');
    const result = await resolveTaskListRef({
      reads: h.index,
      search: h.search,
      target: h.target,
      generation: h.generation,
      request: { signal: h.signal, isCurrent: () => true },
    });
    expect(result?.address).toEqual({ ...h.address, childLines: [1, 1] });
    expect(result?.path.map((node) => node.title)).toEqual(['repeated', 'repeated', 'repeated']);
    expect(organization).toHaveBeenCalledWith(
      { expectedGeneration: h.generation, filePath: 'a.md' },
      h.signal,
    );
    expect(list).not.toHaveBeenCalled();
    expect(nodes).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

it('rejects a same-line target with different original bytes', async () => {
  const h = await fixture();
  try {
    if (h.target.type !== 'subtask') throw new Error('Expected child');
    await expect(
      resolveTaskListRef({
        reads: h.index,
        search: h.search,
        target: { type: 'subtask', ref: { ...h.target.ref, originalBlock: 'changed' } },
        generation: h.generation,
        request: { signal: h.signal, isCurrent: () => true },
      }),
    ).rejects.toMatchObject({ code: 'stale' });
  } finally {
    h.close();
  }
});

it.each([false, true])(
  'retains a delayed real project-editor guard; cancelled=%s',
  async (cancelled) => {
    const h = await fixture();
    try {
      const state = new AppState();
      state.set('mode', 'projects');
      let accept: (() => void) | undefined;
      let current = true;
      let installed = false;
      let committed = false;
      let handedOff = false;
      const navigation = new PanelNavigator(state, structuredClone(DEFAULT_SETTINGS), {
        calendarView: () => 'month',
        setCalendarView: () => {},
        openQuickCapture: () => {},
        finishProjectTableEditorBefore: (action) => {
          accept = action;
        },
      });
      const publications: boolean[] = [];
      state.onCommit(() => {
        publications.push(installed && committed && state.get('taskStack').length === 3);
      });
      await navigateTaskListTarget(
        { type: 'address', address: { ...h.address, childLines: [1, 1] } },
        {
          search: h.search,
          state,
          navigation,
          request: { signal: h.signal, isCurrent: () => current },
          destination: () => 'inbox',
          installReveal: () => {
            installed = true;
          },
          onCommitted: () => {
            committed = true;
            current = false; // Acceptance retires source subscriptions before publication.
          },
          afterCommit: () => {
            expect(state.get('mode')).toBe('tasks');
            expect(publications).toEqual([true]);
            handedOff = true;
          },
        },
      );
      expect(state.get('mode')).toBe('projects');
      expect(installed).toBe(false);
      if (cancelled) current = false;
      expectDefined(accept)();
      expect(state.get('mode')).toBe(cancelled ? 'projects' : 'tasks');
      expect(state.get('taskStack')).toHaveLength(cancelled ? 0 : 3);
      expect(installed).toBe(!cancelled);
      expect(handedOff).toBe(!cancelled);
      expect(publications).toEqual(cancelled ? [] : [true]);
    } finally {
      h.close();
    }
  },
);

it.each(['cancelled', 'changed-generation'] as const)(
  'closes note-local organization and suppresses hydration on %s',
  async (reason) => {
    const h = await fixture();
    try {
      const controller = new AbortController();
      const organization = h.index.organization.bind(h.index);
      const hydrated = vi.spyOn(h.search, 'resolveHits');
      let closed = false;
      const reads = {
        observedTags: h.index.observedTags.bind(h.index),
        matchesSearchAddress: h.index.matchesSearchAddress.bind(h.index),
        resolveSearchHits: h.index.resolveSearchHits.bind(h.index),
        async *organization(request: Parameters<typeof organization>[0], signal: AbortSignal) {
          try {
            for await (const batch of organization(request, signal)) {
              if (reason === 'cancelled') controller.abort();
              yield reason === 'changed-generation'
                ? { ...batch, generation: batch.generation + 1 }
                : batch;
            }
          } finally {
            closed = true;
          }
        },
      };
      const result = resolveTaskListRef({
        reads,
        search: h.search,
        target: h.target,
        generation: h.generation,
        request: { signal: controller.signal, isCurrent: () => true },
      });
      if (reason === 'cancelled') expect(await result).toBeUndefined();
      else await expect(result).rejects.toMatchObject({ code: 'stale' });
      expect(closed).toBe(true);
      expect(hydrated).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  },
);
