import { Notice } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TaskSearchError } from '../src/tasks';
import { useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
function notices() {
  return vi
    .spyOn(Notice.prototype as unknown as { constructor__(message: string): void }, 'constructor__')
    .mockImplementation(() => {});
}
it('keeps one Tasks-filter Notice through repeated failed queries in the same episode', async () => {
  const notice = notices();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    const subscribe = vi.spyOn(h.search, 'subscribe');
    const open = vi
      .spyOn(h.search, 'open')
      .mockRejectedValue(new TaskSearchError('unavailable', 'failed episode'));
    h.query('needle');
    await expect(h.completed()).rejects.toThrow();
    const status = h.root.querySelector('.abyss-search-status');
    h.query('needle second');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(h.root.querySelector('.abyss-search-status')).toBe(status);
    expect(subscribe).toHaveBeenCalledTimes(1);
    open.mockRestore();
    h.query('needle');
    await h.completed();
    vi.spyOn(h.search, 'open').mockRejectedValue(
      new TaskSearchError('unavailable', 'next episode'),
    );
    h.query('needle next');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
  }
});
it('keeps input and offers no Retry control after an operational failure', async () => {
  const notice = notices();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const open = vi
      .spyOn(h.search, 'open')
      .mockRejectedValue(new TaskSearchError('unavailable', 'failed'));
    h.query('needle');
    await expect(h.completed()).rejects.toThrow();
    expect(h.state.get('searchQuery')).toBe('needle');
    expect(h.root.querySelector<HTMLInputElement>('.abyss-search-global')?.value).toBe('needle');
    expect(
      [...h.root.querySelectorAll('button')].some((button) => button.textContent === 'Retry'),
    ).toBe(false);
    open.mockRestore();
    h.query('needle second');
    await h.completed();
    expect(notice).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

it('passive preparation failure stays quiet in empty Search', async () => {
  const notice = notices();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    await h.completed();
    const options = (h.search as unknown as { options: { createBackend: () => Promise<unknown> } })
      .options;
    vi.spyOn(options, 'createBackend').mockRejectedValue(new Error('startup failed'));
    await expect(h.search.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(notice).not.toHaveBeenCalled();
    h.query('needle');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

it('empty and invalid input do not reset or duplicate an unresolved failure Notice', async () => {
  const notice = notices();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const options = (h.search as unknown as { options: { createBackend: () => Promise<unknown> } })
      .options;
    vi.spyOn(options, 'createBackend').mockRejectedValue(new Error('unavailable'));
    h.query('needle');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(1);
    h.query('');
    await h.completed();
    h.query('x'.repeat(2049));
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(1);
    h.query('needle again');
    await expect(h.completed()).rejects.toThrow();
    expect(notice).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

it('a passive failed service does not toast when the first active input is invalid', async () => {
  const notice = notices();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    const options = (h.search as unknown as { options: { createBackend: () => Promise<unknown> } })
      .options;
    vi.spyOn(options, 'createBackend').mockRejectedValue(new Error('unavailable'));
    await expect(h.search.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable',
    });
    h.query('x'.repeat(2049));
    await expect(h.completed()).rejects.toThrow();
    expect(h.root.querySelector('.abyss-search-status')?.textContent).toContain('2,048');
    expect(notice).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('whitespace input settles as empty Search without preparation or a Notice', async () => {
  const notice = notices();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const prepare = vi.spyOn(h.search, 'prepare');
    h.query('   ');
    await h.completed();
    expect(h.root.dataset['searchLogicalResults']).toBe('0');
    expect(h.root.getAttribute('aria-busy')).toBe('false');
    expect(prepare).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
