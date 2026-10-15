import { MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, flushMicrotasks, methodOf, useRealMoment } from './helpers';
import { mockReadingView } from './support/linkEditHarness';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
it.each(['tasks', 'search'] as const)(
  'refreshes retained root and child date metadata across days in %s',
  async (mode) => {
    mockReadingView();
    let now = new Date(2026, 9, 15, 12).valueOf();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = await mountCanonicalSearchUi(
      {
        'a.md':
          '- [ ] [needle root](https://root.example) 📅 2026-10-16\n  - [ ] [needle child](https://child.example) 📅 2026-10-16',
      },
      structuredClone(DEFAULT_SETTINGS),
      mode,
    );
    try {
      h.query('needle');
      await h.completed();
      const card = expectDefined(h.root.querySelector('.abyss-task-card'));
      const anchors = [...card.querySelectorAll('a')];
      const dates = [...card.querySelectorAll('.abyss-task-date')];
      expect(dates.map((date) => date.textContent)).toEqual(['Tomorrow', 'Tomorrow']);
      expect(dates.every((date) => date.classList.contains('is-tomorrow'))).toBe(true);
      now = new Date(2026, 9, 15, 18).valueOf();
      h.query('needle ');
      await h.completed();
      dates.forEach((date, index) => {
        expect(card.querySelectorAll('.abyss-task-date')[index]).toBe(date);
      });
      now = new Date(2026, 9, 16, 12).valueOf();
      h.query('needle');
      await h.completed();
      expect(
        [...card.querySelectorAll('.abyss-task-date')].map((date) => date.textContent),
      ).toEqual(['Today', 'Today']);
      expect(
        [...card.querySelectorAll('.abyss-task-date')].every((date) =>
          date.classList.contains('is-today'),
        ),
      ).toBe(true);
      now = new Date(2026, 9, 17, 12).valueOf();
      h.panel.refresh();
      await h.completed();
      expect(
        [...card.querySelectorAll('.abyss-task-date')].map((date) => date.textContent),
      ).toEqual(['Fri 16 Oct', 'Fri 16 Oct']);
      expect(
        [...card.querySelectorAll('.abyss-task-date')].every((date) =>
          date.classList.contains('is-overdue'),
        ),
      ).toBe(true);
      expect(h.root.querySelector('.abyss-task-card')).toBe(card);
      anchors.forEach((anchor, index) => {
        expect(card.querySelectorAll('a')[index]).toBe(anchor);
      });
    } finally {
      h.dispose();
    }
  },
);
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

it.each([
  { field: 'comment', source: '- 2026-10-04: bravo', selector: '.abyss-comment-text' },
  { field: 'description', source: '- > bravo', selector: '.abyss-task-desc' },
])(
  'releases each removed $field listener while retaining its entry',
  async ({ source, selector }) => {
    mockReadingView();
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const removals = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const activeFields = () =>
      registrations.mock.calls.flatMap(([type, listener], index) => {
        const element: unknown = registrations.mock.contexts[index];
        if (type !== 'click' || !(element instanceof HTMLElement) || !element.matches(selector))
          return [];
        const removed = removals.mock.calls.some(
          ([removedType, removedListener], removedIndex) =>
            removedType === type &&
            removedListener === listener &&
            removals.mock.contexts[removedIndex] === element,
        );
        return removed ? [] : [element];
      });
    const h = await mountCanonicalSearchUi(
      { 'a.md': `- [ ] Root\n  - [ ] branchlong\n    ${source}` },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      let retainedTitle: Element | undefined;
      const retired: HTMLElement[] = [];
      for (let cycle = 0; cycle < 4; cycle++) {
        h.query('bra');
        await h.completed();
        const title = expectDefined(h.root.querySelector('.abyss-subtask-label'));
        retainedTitle ??= title;
        expect(title).toBe(retainedTitle);
        const field = expectDefined(h.root.querySelector<HTMLElement>(selector));
        expect(activeFields()).toEqual([field]);
        for (const old of retired) old.click();
        await flushMicrotasks(30);
        expect(h.state.get('mode')).toBe('search');
        h.query('bra ');
        await h.completed();
        expect(h.root.querySelector(selector)).toBe(field);
        expect(activeFields()).toEqual([field]);
        h.query('branchlong');
        await h.completed();
        expect(field.isConnected).toBe(false);
        expect(activeFields()).toEqual([]);
        expect(h.root.querySelector('.abyss-subtask-label')).toBe(retainedTitle);
        retired.push(field);
      }
      h.query('bra');
      await h.completed();
      expect(activeFields()).toHaveLength(1);
    } finally {
      h.dispose();
    }
    expect(activeFields()).toEqual([]);
  },
);

it.each([128, 256])(
  'retains %i sibling nodes and focus with linear membership work',
  async (count) => {
    mockReadingView();
    const h = await mountCanonicalSearchUi(
      {
        'a.md': [
          '- [ ] Root',
          ...Array.from(
            { length: count },
            (_, index) => `  - [ ] [needle ${index}](https://example.com/${index})`,
          ),
        ].join('\n'),
      },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      h.query('needle');
      await h.completed();
      const rows = [...h.root.querySelectorAll<HTMLElement>('.abyss-subtask-row')];
      expect(rows).toHaveLength(count);
      const anchor = expectDefined(rows[Math.floor(count / 2)]?.querySelector('a'));
      anchor.focus();
      const siblings = new WeakSet(rows.map((row) => expectDefined(row.parentElement)));
      let membershipWork = 0;
      const includes = Array.prototype.includes;
      const has = methodOf(Set.prototype, 'has');
      const arrayProbe = vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
        this: unknown[],
        value: unknown,
        from?: number,
      ) {
        if (!(value instanceof HTMLElement) || !siblings.has(value))
          return includes.call(this, value, from);
        // Count the element reads performed by the real membership scan, not elapsed time.
        return includes.call(
          new Proxy(this, {
            get: (target, key, receiver): unknown => {
              if (typeof key === 'string' && /^\d+$/u.test(key)) membershipWork++;
              return Reflect.get(target, key, receiver);
            },
          }),
          value,
          from,
        );
      });
      const setProbe = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
        this: Set<unknown>,
        value: unknown,
      ) {
        if (value instanceof HTMLElement && siblings.has(value)) membershipWork++;
        return has.call(this, value);
      });
      try {
        h.query('needle ');
        await h.completed();
      } finally {
        arrayProbe.mockRestore();
        setProbe.mockRestore();
      }
      const retained = h.root.querySelectorAll('.abyss-subtask-row');
      expect(retained).toHaveLength(count);
      rows.forEach((row, index) => {
        expect(retained[index]).toBe(row);
      });
      expect(document.activeElement).toBe(anchor);
      expect(membershipWork).toBeLessThanOrEqual(count * 4);
    } finally {
      h.dispose();
    }
  },
);

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

it.each([
  { kind: 'comments', count: 128 },
  { kind: 'comments', count: 256 },
  { kind: 'descriptions', count: 128 },
  { kind: 'descriptions', count: 256 },
])(
  'removes $count $kind with linear membership work after focus leaves',
  async ({ kind, count }) => {
    mockReadingView();
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const removals = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const source = [
      '- [ ] branchlong',
      ...Array.from({ length: count }, (_, index) =>
        kind === 'comments'
          ? `  - 2026-10-04: [bravo ${index}](https://example.com/${index})`
          : `  - [ ] branchlong ${index}\n    - > [bravo ${index}](https://example.com/${index})`,
      ),
    ].join('\n');
    const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
    try {
      h.query('bra');
      await h.completed();
      const card = expectDefined(h.root.querySelector('.abyss-task-card'));
      const titles = [...card.querySelectorAll('.abyss-task-title, .abyss-subtask-label')];
      const selector = kind === 'comments' ? '.abyss-comment-text' : '.abyss-task-desc';
      const fields = [...card.querySelectorAll<HTMLElement>(selector)];
      expect(fields).toHaveLength(count);
      const originalFields = new WeakSet(fields);
      const isField = (value: unknown): boolean =>
        typeof value === 'object' &&
        value !== null &&
        'element' in value &&
        value.element instanceof HTMLElement &&
        originalFields.has(value.element);
      const anchor = expectDefined(fields[0]?.querySelector('a'));
      anchor.focus();
      let membershipWork = 0;
      const includes = Array.prototype.includes;
      const has = methodOf(Set.prototype, 'has');
      const arrayProbe = vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
        this: unknown[],
        value: unknown,
        from?: number,
      ) {
        if (!isField(value)) return includes.call(this, value, from);
        return includes.call(
          new Proxy(this, {
            get: (target, key, receiver): unknown => {
              if (typeof key === 'string' && /^\d+$/u.test(key)) membershipWork++;
              return Reflect.get(target, key, receiver);
            },
          }),
          value,
          from,
        );
      });
      const setProbe = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
        this: Set<unknown>,
        value: unknown,
      ) {
        if (isField(value)) membershipWork++;
        return has.call(this, value);
      });
      try {
        const publications = vi.spyOn(h.panel, 'mountSearchRows_abyssPrivate');
        h.query('branchlong');
        await vi.waitFor(() => {
          expect(publications).toHaveBeenCalled();
        });
        await flushMicrotasks(30);
        expect(h.root.dataset['searchPhase']).toBe('pending');
        expect(fields.every((field) => field.isConnected)).toBe(true);
        expect(document.activeElement).toBe(anchor);
        anchor.blur();
        await h.completed();
      } finally {
        arrayProbe.mockRestore();
        setProbe.mockRestore();
      }
      expect(card.querySelectorAll(selector)).toHaveLength(0);
      expect(h.root.querySelector('.abyss-task-card')).toBe(card);
      titles.forEach((title, index) => {
        expect(card.querySelectorAll('.abyss-task-title, .abyss-subtask-label')[index]).toBe(title);
      });
      for (const field of fields) {
        const index = registrations.mock.calls.findIndex(
          ([type], index) => type === 'click' && registrations.mock.contexts[index] === field,
        );
        const listener = expectDefined(registrations.mock.calls[index]?.[1]);
        expect(
          removals.mock.calls.some(
            ([type, removed], index) =>
              type === 'click' && removed === listener && removals.mock.contexts[index] === field,
          ),
        ).toBe(true);
      }
      expect(membershipWork).toBeLessThanOrEqual(count * 4);
    } finally {
      h.dispose();
    }
  },
);

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

it.each([
  {
    field: 'comment',
    source: '- 2026-10-04: [bravo](https://example.com)',
    selector: '.abyss-comment-text',
  },
  {
    field: 'description',
    source: '- > [bravo](https://example.com)',
    selector: '.abyss-task-desc',
  },
])(
  'does not give a removed focused $field the next query activation callback',
  async ({ source, selector }) => {
    mockReadingView();
    const h = await mountCanonicalSearchUi(
      { 'a.md': `- [ ] Root\n  - [ ] branchlong\n    ${source}` },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      h.query('bra');
      await h.completed();
      const field = expectDefined(h.root.querySelector<HTMLElement>(selector));
      const anchor = expectDefined(field.querySelector('a'));
      anchor.focus();
      const publications = vi.spyOn(h.panel, 'mountSearchRows_abyssPrivate');
      h.query('branchlong');
      await vi.waitFor(() => {
        expect(publications).toHaveBeenCalled();
      });
      expect(field.isConnected).toBe(true);
      field.click();
      await flushMicrotasks(30);
      expect(h.state.get('mode')).toBe('search');
      expect(h.root.dataset['searchPhase']).toBe('pending');
      expect(document.activeElement).toBe(anchor);
      anchor.blur();
      await h.completed();
      expect(field.isConnected).toBe(false);
      expect(h.root.dataset['searchPhase']).toBe('complete');
    } finally {
      h.dispose();
    }
  },
);
