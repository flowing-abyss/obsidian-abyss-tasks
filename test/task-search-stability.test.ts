import { MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { mockReadingView } from './support/linkEditHarness';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
it.each(['tasks', 'search'] as const)(
  'retains complete source DOM across query updates in %s',
  async (mode) => {
    mockReadingView();
    const render = vi.spyOn(MarkdownRenderer, 'render');
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] [needle](https://example.com)\n  - [ ] child needle' },
      structuredClone(DEFAULT_SETTINGS),
      mode,
    );
    try {
      h.query('need');
      await h.completed();
      const card = expectDefined(h.root.querySelector('.abyss-task-card'));
      const anchor = expectDefined(card.querySelector('a'));
      const child = expectDefined(card.querySelector<HTMLElement>('.abyss-subtask-row'));
      const calls = render.mock.calls.length;
      h.query('needle');
      await h.completed();
      expect(h.root.querySelector('.abyss-task-card')).toBe(card);
      expect(card.querySelector('a')).toBe(anchor);
      expect(render.mock.calls).toHaveLength(calls);
      expect(card.querySelector('mark')?.textContent).toBe('needle');
      h.query('needle ');
      await h.completed();
      expect(card.querySelector('a')).toBe(anchor);
      expect(card.querySelector('.abyss-subtask-row')).toBe(child);
      expect(render.mock.calls).toHaveLength(calls);
      child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => {
        expect(h.state.get('taskStack')[h.state.get('taskStack').length - 1]?.title).toBe(
          'child needle',
        );
      });
    } finally {
      h.dispose();
    }
  },
);

it('keeps a focused descendant anchor and current activation when an earlier sibling leaves', async () => {
  mockReadingView();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] root\n  - [ ] bravo only\n  - [ ] [branchlong](https://example.com)' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('bra');
    await h.completed();
    const anchor = expectDefined(h.root.querySelector<HTMLAnchorElement>('.abyss-subtask-label a'));
    anchor.focus();
    expect(document.activeElement).toBe(anchor);
    h.query('branchlong');
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-subtask-row')).toHaveLength(1);
    expect(h.root.querySelector('.abyss-subtask-label a')).toBe(anchor);
    expect(document.activeElement).toBe(anchor);
    expectDefined(anchor.closest('.abyss-subtask-row')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(h.state.get('taskStack')[1]?.markdownTitle).toBe('[branchlong](https://example.com)');
    });
  } finally {
    h.dispose();
  }
});

it('preserves a focused child title when its contributing comment disappears', async () => {
  mockReadingView();
  const h = await mountCanonicalSearchUi(
    {
      'a.md':
        '- [ ] Root\n  - [ ] [branchlong](https://example.com)\n    - 2026-10-04: bravo comment',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('bra');
    await h.completed();
    const anchor = expectDefined(h.root.querySelector<HTMLAnchorElement>('.abyss-subtask-label a'));
    anchor.focus();
    expect(h.root.querySelector('.abyss-comment-text')).not.toBeNull();
    h.query('branchlong');
    await h.completed();
    expect(h.root.querySelector('.abyss-comment-text')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(h.root.querySelector('.abyss-subtask-label a')).toBe(anchor);
  } finally {
    h.dispose();
  }
});

it('refreshes descendant status semantics without replacing its complete text', async () => {
  mockReadingView();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] Root\n  - [x] [needle](https://example.com)' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await h.completed();
    const anchor = expectDefined(h.root.querySelector('.abyss-subtask-label a'));
    h.statusCatalog.replace(
      h.statusCatalog
        .all()
        .map((rule) =>
          rule.symbol === 'x' ? { ...rule, type: 'todo', defaultForType: false } : rule,
        ),
    );
    h.index.setStatusCatalog(h.statusCatalog);
    await h.completed();
    expect(h.root.querySelector('.abyss-subtask-label a')).toBe(anchor);
    expect(h.root.querySelector('.abyss-subtask-label')?.classList.contains('is-done')).toBe(false);
    expect(h.root.querySelectorAll('.abyss-subtask-row .abyss-status-marker')).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it('does not give a removed focused comment the next query activation callback', async () => {
  mockReadingView();
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] Root\n  - [ ] branchlong\n    - 2026-10-04: [bravo](https://example.com)' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('bra');
    await h.completed();
    const comment = expectDefined(h.root.querySelector<HTMLElement>('.abyss-comment-text'));
    const anchor = expectDefined(comment.querySelector('a'));
    anchor.focus();
    const publications = vi.spyOn(h.panel, 'mountSearchRows_abyssPrivate');
    h.query('branchlong');
    await vi.waitFor(() => {
      expect(publications).toHaveBeenCalled();
    });
    expect(comment.isConnected).toBe(true);
    comment.click();
    await flushMicrotasks(30);
    expect(h.state.get('mode')).toBe('search');
    anchor.blur();
    await h.completed();
    expect(comment.isConnected).toBe(false);
  } finally {
    h.dispose();
  }
});
