import { Notice } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { BrowserTaskCancelled, createBrowserTaskScheduler } from '../src/browserTaskScheduler';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
useRealMoment();
it('reports a live raw AbortError once as unavailable with sanitized diagnostics and ordinary-input recovery', async () => {
  const sentinel = 'PRIVATE task query settings exception';
  const notice = vi
    .spyOn(Notice.prototype as unknown as { constructor__(s: string): void }, 'constructor__')
    .mockImplementation(() => {});
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail = true;
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
    (owner) => {
      if (fail) throw new DOMException(sentinel, 'AbortError');
      return createBrowserTaskScheduler(owner);
    },
  );
  try {
    await h.search.prepare(new AbortController().signal);
    const documents = vi.spyOn(h.source, 'documents');
    h.query('needle');
    await expect(h.completed()).rejects.toThrow();
    h.query('needle second');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      phase: 'scheduler',
      category: 'construction',
      cleanupFailed: false,
    });
    fail = false;
    h.query('needle');
    await vi.waitFor(() => {
      expect(h.root.dataset['searchPhase']).toBe('complete');
    });
    expect(documents).not.toHaveBeenCalled();
    fail = true;
    h.query('needle third');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
    vi.restoreAllMocks();
  }
});
it('cancels an admitted old request before the next immediate cursor read and retains the survivor', async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let yields = 0;
  const h = await mountCanonicalSearchUi(
    { 'a.md': Array.from({ length: 401 }, (_, i) => `- [ ] needle ${i}`).join('\n') },
    structuredClone(DEFAULT_SETTINGS),
    'search',
    (owner) => {
      const scheduler = createBrowserTaskScheduler(owner);
      return {
        now: () => scheduler.now(),
        yield: (signal) => {
          yields++;
          if (yields !== 2) return scheduler.yield(signal);
          enter();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new BrowserTaskCancelled());
              },
              { once: true },
            );
          });
        },
      };
    },
  );
  try {
    const read = vi.spyOn(h.search, 'read'),
      release = vi.spyOn(h.search, 'release'),
      hydrate = vi.spyOn(h.search, 'resolvePage');
    h.query('needle');
    await entered;
    expect(read).toHaveBeenCalledTimes(1);
    expect(hydrate).not.toHaveBeenCalled();
    h.query('notpresent');
    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe('0');
    expect(new Set(release.mock.calls.map(([cursor]) => cursor.id)).size).toBe(2);
    expect(release).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
    vi.restoreAllMocks();
  }
});
it('captures minimal settings before admission and refreshes same-generation membership with a new request', async () => {
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let paused = false;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.inbox = { ...settings.inbox, mode: 'untagged' };
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle\n- [ ] needle #work' },
    settings,
    'tasks',
    (owner) => {
      const scheduler = createBrowserTaskScheduler(owner);
      return {
        now: () => scheduler.now(),
        yield: (signal) => {
          if (paused) return scheduler.yield(signal);
          paused = true;
          enter();
          return new Promise<void>((resolve) => {
            resume = resolve;
          });
        },
      };
    },
  );
  try {
    h.query('needle');
    await entered;
    settings.inbox.mode = 'tag';
    settings.inbox.tag = '#work';
    resume();
    await h.completed();
    expect(h.root.querySelector('.abyss-task-tag')).toBeNull();
    const request = h.root.dataset['searchRequest'],
      generation = h.root.dataset['searchGeneration'];
    h.panel.refresh();
    await h.completed();
    expect(h.root.dataset['searchRequest']).not.toBe(request);
    expect(h.root.dataset['searchGeneration']).toBe(generation);
    expect(h.root.querySelector('.abyss-task-tag')?.textContent).toContain('work');
  } finally {
    h.dispose();
    vi.restoreAllMocks();
  }
});
