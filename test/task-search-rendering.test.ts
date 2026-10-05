import { MarkdownRenderer, Menu, type MenuItem } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { SubtaskSnapshot, TaskSnapshot } from '../src/tasks';
import * as contextModule from '../src/tasks';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { deferred, expectDefined, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

it('renders and marks the complete second paragraph and split child term with no unrelated preview', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe('unrelated paragraph\n\nsecond **bud**get paragraph');
    holder.createEl('p').appendText('unrelated paragraph');
    const p = holder.createEl('p');
    p.appendText('second ');
    p.createEl('strong').appendText('bud');
    p.appendText('get paragraph');
  });
  const h = await mountCanonicalSearchUi(
    {
      'a.md': [
        '- [ ] root',
        '  - > unrelated paragraph',
        '  - > ',
        '  - > second **bud**get paragraph',
        '  - 2026-10-04: unrelated comment',
        '  - [ ] zebra',
      ].join('\n'),
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('budget zebra');
    await h.completed();
    const card = expectDefined(h.root.querySelector('.abyss-task-card'));
    expect(card.querySelector('.abyss-task-desc')).toBeNull();
    expect(card.querySelector('.abyss-task-title mark')).toBeNull();
    expect(card.textContent).not.toContain('unrelated comment');
    const fields = card.querySelectorAll('.abyss-search-context');
    expect(fields).toHaveLength(2);
    expect(fields[0]?.textContent).toContain('unrelated paragraphsecond budget paragraph');
    expect(
      [...expectDefined(fields[0]).querySelectorAll('mark')].map((m) => m.textContent),
    ).toEqual(['bud', 'get']);
    expect(fields[1]?.textContent).toContain('root › zebra');
    expect(fields[1]?.querySelector('mark')?.textContent).toBe('zebra');
    expect(card.querySelectorAll('.abyss-search-context button')).toHaveLength(2);
    expect(
      [...card.querySelectorAll('button')].some((b) => /More|Previous|Next/.test(b.textContent)),
    ).toBe(false);
  } finally {
    h.dispose();
  }
});

it('keeps repeated comments separately labeled and activates an exact repeated grandchild via the shared card', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'a.md': [
        '- [ ] root',
        '  - > unrelated preview',
        '  - 2026-10-04: first needle comment',
        '  - 2026-10-04: second needle comment',
        '  - [ ] repeated',
        '    - [ ] repeated',
        '      - 2026-10-04: zebra needle',
        '  - [ ] repeated',
      ].join('\n'),
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('second needle zebra');
    await h.completed();
    const fields = [...h.root.querySelectorAll<HTMLElement>('.abyss-search-context')];
    expect(fields).toHaveLength(3);
    expect(fields[0]?.textContent).toContain('first needle comment');
    expect(fields[1]?.textContent).toContain('second needle comment');
    expect(fields[0]?.querySelector('button')?.textContent).not.toBe(
      fields[1]?.querySelector('button')?.textContent,
    );
    expect(fields[2]?.textContent).toContain('root › repeated › repeated');
    expect(h.root.textContent).not.toContain('unrelated preview');
    expectDefined(fields[2]?.querySelector('button')).click();
    await vi.waitFor(() => {
      expect(h.state.get('mode')).toBe('tasks');
    });
    await h.completed();
    const path = h.state.get('taskStack');
    expect(path.map((n) => n.title)).toEqual(['root', 'repeated', 'repeated']);
    expect(path.slice(1).map((n) => n.ref)).toMatchObject([
      { relativeLine: 4 },
      { relativeLine: 1 },
    ]);
  } finally {
    h.dispose();
  }
});

it('labels hidden targets separately without marking an unmatched visible alias', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _source, holder) => {
    const a = holder.createEl('a', { text: 'Visible alias', cls: 'internal-link' });
    a.setAttribute('data-href', 'HiddenLedger');
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] [[HiddenLedger|Visible alias]]\n  - > unrelated' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('HiddenLedger');
    await h.completed();
    expect(h.root.querySelector('.abyss-task-title')?.textContent).toBe('Visible alias');
    expect(h.root.querySelector('.abyss-task-title mark')).toBeNull();
    expect(h.root.querySelector('.abyss-search-context')?.textContent).toContain(
      'Title link target',
    );
    expect(h.root.querySelector('.abyss-search-context')?.textContent).toContain('HiddenLedger');
    expect(h.root.querySelector('.abyss-task-desc')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('waits for actual formatting-only Markdown completion and marks before publishing ready', async () => {
  const pending = deferred<void>();
  let holder: HTMLElement | undefined;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, el) => {
    expect(source).toBe('**needle** without links');
    holder = el;
    await pending.promise;
    el.createEl('strong').appendText('needle');
    el.appendText(' without links');
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] root\n  - > **needle** without links' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await vi.waitFor(() => {
      expect(holder).toBeDefined();
    });
    expect(h.root.dataset['searchPhase']).not.toBe('complete');
    pending.resolve();
    await h.completed();
    expect(h.root.querySelector('.abyss-search-context strong mark')?.textContent).toBe('needle');
  } finally {
    pending.resolve();
    h.dispose();
  }
});

it('cancels old matched Markdown when the page is replaced', async () => {
  const pending = deferred<void>();
  let holder: HTMLElement | undefined;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _source, el) => {
    holder = el;
    await pending.promise;
    el.createEl('strong').appendText('needle');
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] root\n  - > **needle**\n- [ ] zebra' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await vi.waitFor(() => {
      expect(holder).toBeDefined();
    });
    const oldHolder = holder;
    h.query('zebra');
    const request = h.root.dataset['searchRequest'];
    pending.resolve();
    await h.completed();
    expect(h.root.dataset['searchRequest']).toBe(request);
    expect(h.root.querySelector<HTMLInputElement>('.abyss-search-global')?.value).toBe('zebra');
    expect(h.root.dataset['searchPhase']).toBe('complete');
    expect(oldHolder?.querySelector('mark')).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(h.root.querySelector('.abyss-task-title')?.textContent).toBe('zebra');
    expect(h.root.textContent).not.toContain('needle');
    expect(holder?.querySelector('mark')).toBeNull();
  } finally {
    pending.resolve();
    h.dispose();
  }
});

const sameLabel = 'same';
const needleLabel = 'needle';
const linkedField = 'prefix [[One|same]] middle [[Two|needle]] suffix';

type MatchedField = 'title' | 'description' | 'comment';
type LinkedKind =
  | 'root-title'
  | 'root-description'
  | 'root-comment'
  | 'child-title'
  | 'child-description'
  | 'child-comment';
function linkedFixture(kind: LinkedKind): {
  markdown: string;
  field: MatchedField;
  child: boolean;
} {
  const child = kind.startsWith('child');
  const indent = child ? '      ' : '  ';
  const lines = kind === 'root-title' ? [`- [ ] ${linkedField}`] : ['- [ ] root'];
  if (child) lines.push('  - [ ] repeated', '    - [ ] repeated');
  if (kind === 'child-title') lines[2] = `    - [ ] ${linkedField}`;
  if (kind.endsWith('description')) lines.push(`${indent}- > ${linkedField}`);
  if (kind === 'root-comment') lines.push(`  - 2026-10-04: ${linkedField}`);
  if (kind.endsWith('comment')) lines.push(`${indent}- 2026-10-04: ${linkedField}`);
  let field: MatchedField = 'title';
  if (kind.endsWith('description')) field = 'description';
  if (kind.endsWith('comment')) field = 'comment';
  return { markdown: lines.join('\n'), field, child };
}
function fieldText(
  node: TaskSnapshot | SubtaskSnapshot | undefined,
  field: MatchedField,
): string | undefined {
  if (field === 'title') return node?.markdownTitle;
  if (field === 'description') return node?.description;
  return node?.comments.slice(-1)[0]?.text;
}

it.each([
  'root-title',
  'root-description',
  'root-comment',
  'child-title',
  'child-description',
  'child-comment',
] as const)('preserves full-field second link editing and modifier clicks for %s', async (kind) => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect([linkedField, 'prefix [[One|same]] middle [[Changed|needle]] suffix']).toContain(source);
    holder.appendText('prefix ');
    holder.createEl('a', { cls: 'internal-link', text: sameLabel, attr: { 'data-href': 'One' } });
    holder.appendText(' middle ');
    holder.createEl('a', {
      cls: 'internal-link',
      text: needleLabel,
      attr: { 'data-href': source.includes('[[Changed|') ? 'Changed' : 'Two' },
    });
    holder.appendText(' suffix');
  });
  let edit: (() => void) | undefined;
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    build: (item: MenuItem) => unknown,
  ) {
    build({
      setTitle() {
        return this;
      },
      setIcon() {
        return this;
      },
      onClick(callback: () => void) {
        edit = callback;
        return this;
      },
    } as unknown as MenuItem);
    return this;
  });
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    return this;
  });
  vi.spyOn(LinkEditModal.prototype, 'open').mockImplementation(function (this: LinkEditModal) {
    (this as unknown as { onSave_abyssPrivate: (text: string) => void }).onSave_abyssPrivate(
      '[[Changed|needle]]',
    );
  });
  const fixture = linkedFixture(kind);
  const h = await mountCanonicalSearchUi(
    { 'a.md': fixture.markdown },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const execute = vi.spyOn(h.tasks, 'execute');
    const open = vi.spyOn(h.app.workspace, 'openLinkText').mockResolvedValue(undefined);
    h.query('needle');
    await h.completed();
    const anchors = [...h.root.querySelectorAll<HTMLAnchorElement>('.abyss-task-card a')].filter(
      (a) => a.textContent === 'needle',
    );
    const anchor = expectDefined(anchors[anchors.length - 1]);
    expect(anchor.querySelector('mark')?.textContent).toBe('needle');
    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledWith('Two', 'a.md', 'tab');
    });
    expect(h.state.get('mode')).toBe('search');
    anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expectDefined(edit)();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalled();
    });
    const command = expectDefined(execute.mock.calls[0]?.[0]);
    expect(command).toMatchObject({
      type: 'edit-link',
      occurrence: 1,
      replacement: '[[Changed|needle]]',
    });
    const root = expectDefined(h.index.list()[0]);
    if (command.type !== 'edit-link') throw new Error('Wrong command');
    const field = fixture.field;
    expect(command.target.type).toBe(field);
    if (command.target.type === 'comment')
      expect(command.target.ref.relativeLine).toBe(fixture.child ? 1 : 2);
    const target =
      command.target.type === 'comment' ? command.target.ref.parent : command.target.target;
    if (fixture.child)
      expect(target).toMatchObject({
        type: 'subtask',
        ref: {
          relativeLine: 1,
          parent: {
            type: 'subtask',
            ref: { relativeLine: 1, parent: { type: 'task', ref: { filePath: 'a.md', line: 0 } } },
          },
        },
      });
    else expect(target).toMatchObject({ type: 'task', ref: { filePath: 'a.md', line: 0 } });
    await vi.waitFor(() => {
      const node = fixture.child ? h.index.list()[0]?.subtasks[0]?.subtasks[0] : h.index.list()[0];
      const authored = fieldText(node, field);
      expect(authored).toBe('prefix [[One|same]] middle [[Changed|needle]] suffix');
      if (kind === 'root-comment') expect(node?.comments[0]?.text).toBe(linkedField);
    });
    expect(root.source.filePath).toBe('a.md');
  } finally {
    h.dispose();
  }
});

it('extracts contexts only for the mounted 50 roots and rejects detached context activation', async () => {
  const context = vi.spyOn(contextModule, 'taskSearchContext');
  const h = await mountCanonicalSearchUi(
    {
      'a.md': Array.from({ length: 101 }, (_, i) => `- [ ] root ${i}\n  - > needle ${i}`).join(
        '\n',
      ),
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    expect(context).not.toHaveBeenCalled();
    h.query('needle');
    await h.completed();
    expect(context).toHaveBeenCalledTimes(50);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThan(50);
    const old = expectDefined(
      h.root.querySelector<HTMLButtonElement>('.abyss-search-context button'),
    );
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Next page"]')).click();
    await h.completed();
    expect(context).toHaveBeenCalledTimes(100);
    expect(new Set(context.mock.calls.map((args) => args[0].source.line)).size).toBe(100);
    const hydration = vi.spyOn(h.search, 'resolvePage');
    old.click();
    expect(hydration).not.toHaveBeenCalled();
    expect(h.state.get('mode')).toBe('search');
  } finally {
    h.dispose();
  }
});

it('marks canonical split title, escaped punctuation and inline code from complete authored fields', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    if (source === '**bud**get [[HiddenLedger|Visible alias]]') {
      holder.createEl('strong').appendText('bud');
      holder.appendText('get ');
      holder.createEl('a', {
        text: 'Visible alias',
        cls: 'internal-link',
        attr: { 'data-href': 'HiddenLedger' },
      });
    } else {
      expect(source).toBe('escaped \\*budget\\* and `budget`');
      holder.appendText('escaped *budget* and ');
      holder.createEl('code').appendText('budget');
    }
  });
  const h = await mountCanonicalSearchUi(
    {
      'a.md':
        '- [ ] **bud**get [[HiddenLedger|Visible alias]]\n  - > escaped \\*budget\\* and `budget`',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('budget');
    await h.completed();
    expect(
      [...h.root.querySelectorAll('.abyss-task-title mark')].map((m) => m.textContent),
    ).toEqual(['bud', 'get']);
    expect(
      [...h.root.querySelectorAll('.abyss-search-context mark')].map((m) => m.textContent),
    ).toEqual(['budget', 'budget']);
    expect(h.root.querySelector('.abyss-search-context code mark')?.textContent).toBe('budget');
    expect(h.root.querySelector('a mark')).toBeNull();
  } finally {
    h.dispose();
  }
});

it.each([
  {
    source: '😀 **Cafe\u0301** 𐐀𐐁',
    query: 'Café 𐐀𐐁',
    leading: '😀 ',
    bold: 'Cafe\u0301',
    suffix: ' 𐐀𐐁',
    marks: ['Cafe\u0301', '𐐀𐐁'],
  },
  {
    source: '**budjet**',
    query: 'budget',
    leading: '',
    bold: 'budjet',
    suffix: '',
    marks: ['budjet'],
  },
])('marks normalized and fuzzy full canonical title tokens for $query', async (fixture) => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe(fixture.source);
    holder.appendText(fixture.leading);
    holder.createEl('strong').appendText(fixture.bold);
    holder.appendText(fixture.suffix);
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': `- [ ] ${fixture.source}` },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query(fixture.query);
    await h.completed();
    expect(
      [...h.root.querySelectorAll('.abyss-task-title mark')].map((m) => m.textContent),
    ).toEqual(fixture.marks);
  } finally {
    h.dispose();
  }
});

it('uses shared Markdown for an ordinary card description without a search query', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe('**description**');
    holder.createEl('strong').appendText('description');
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] root\n  - > **description**' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    await vi.waitFor(() => {
      expect(h.root.querySelector('.abyss-task-desc strong')?.textContent).toBe('description');
    });
    expect(h.root.querySelector('.abyss-search-context')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('keeps authored embed aliases inert and omits marks when the rendered preview text cannot be proved', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe('📎 Visible alias needle');
    holder.appendText('📎 Visible alias needle');
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] ![[HiddenLedger|Visible alias]] needle' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('alias');
    await h.completed();
    expect(h.root.querySelector('.abyss-task-title')?.textContent).toBe('📎 Visible alias needle');
    expect(h.root.querySelector('.abyss-task-title a')).toBeNull();
    expect(h.root.querySelector('.abyss-task-title mark')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('renders the full long authored field past the former clipping point', async () => {
  const prefix = 'padding '.repeat(40);
  const source = `${prefix}**needle** tail [[One|same]]`;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, authored, holder) => {
    expect(authored).toBe(source);
    holder.appendText(prefix);
    holder.createEl('strong').appendText('needle');
    holder.appendText(' tail ');
    holder.createEl('a', { text: sameLabel, cls: 'internal-link', attr: { 'data-href': 'One' } });
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': `- [ ] root\n  - > ${source}` },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await h.completed();
    expect(h.root.querySelector('.abyss-search-context-text')?.textContent).toBe(
      `${prefix}needle tail same`,
    );
    expect(h.root.querySelector('.abyss-search-context-text mark')?.textContent).toBe('needle');
  } finally {
    h.dispose();
  }
});

it('uses the production Intl CJK word boundary for retrieved field evidence and rendered marks', async () => {
  const context = vi.spyOn(contextModule, 'taskSearchContext');
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe('**東京**');
    holder.createEl('strong').appendText('東京');
  });
  const h = await mountCanonicalSearchUi(
    { 'a.md': '- [ ] root\n  - > **東京**' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('東京');
    await h.completed();
    const result = expectDefined(
      context.mock.results[0]?.value as
        ReturnType<typeof contextModule.taskSearchContext> | undefined,
    );
    expect(
      result.excerpts[0]?.matches.map((m) => ({
        start: m.start,
        end: m.end,
        queryToken: m.queryToken,
      })),
    ).toEqual([{ start: 0, end: 2, queryToken: 0 }]);
    expect(h.root.querySelector('.abyss-search-context mark')?.textContent).toBe('東京');
    h.query('京');
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

it('uses the shared fallback for retrieved CJK fields when Intl segmentation is unavailable', async () => {
  vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe('**東京**');
    holder.createEl('strong').appendText('東京');
  });
  try {
    const h = await mountCanonicalSearchUi(
      { 'a.md': '- [ ] root\n  - > **東京**' },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      h.query('京');
      await h.completed();
      expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
      expect(h.root.querySelector('.abyss-search-context mark')?.textContent).toBe('京');
    } finally {
      h.dispose();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['root-description', 'root-comment', 'child-description', 'child-comment'] as const)(
  'keeps generated colliding anchors out of exact %s edit authority',
  async (kind) => {
    const source =
      'https://one.example [https://one.example](https://one.example) [https://one.example](https://two.example)';
    const replacement = '[changed](https://three.example)';
    const updated = `https://one.example [https://one.example](https://one.example) ${replacement}`;
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, authored, holder) => {
      expect([source, updated]).toContain(authored);
      for (const [index, href] of [
        'https://one.example',
        'https://one.example',
        authored === source ? 'https://two.example' : 'https://three.example',
      ].entries()) {
        if (index > 0) holder.appendText(' ');
        holder.createEl('a', {
          text: index === 2 && authored === updated ? 'changed' : 'https://one.example',
          attr: { href },
        });
      }
    });
    let edit: (() => void) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      build: (item: MenuItem) => unknown,
    ) {
      let title = '';
      build({
        setTitle(value: string) {
          title = value;
          return this;
        },
        setIcon() {
          return this;
        },
        onClick(callback: () => void) {
          if (title === 'Edit link…') edit = callback;
          return this;
        },
      } as unknown as MenuItem);
      return this;
    });
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });
    vi.spyOn(LinkEditModal.prototype, 'open').mockImplementation(function (this: LinkEditModal) {
      (this as unknown as { onSave_abyssPrivate: (text: string) => void }).onSave_abyssPrivate(
        replacement,
      );
    });
    const fixture = linkedFixture(kind);
    const h = await mountCanonicalSearchUi(
      {
        'a.md': (kind === 'root-comment'
          ? fixture.markdown.replace(linkedField, 'earlier comment')
          : fixture.markdown
        ).replaceAll(linkedField, source),
      },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      const execute = vi.spyOn(h.tasks, 'execute');
      h.query('https');
      await h.completed();
      const fields = [...h.root.querySelectorAll('.abyss-search-context-text')].filter(
        (field) => field.querySelector('a') !== null,
      );
      const field = expectDefined(fields[fields.length - 1]);
      // Observe link wiring without opening the unrelated enclosing card menu.
      field.addEventListener('contextmenu', (event) => {
        event.stopPropagation();
      });
      const anchors = [...field.querySelectorAll('a')];
      expect(anchors).toHaveLength(3);
      for (const anchor of anchors.slice(0, 2)) {
        expect(anchor.querySelector('mark')).not.toBeNull();
        anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(edit).toBeUndefined();
      }
      expect(execute).not.toHaveBeenCalled();
      expectDefined(anchors[2]).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      expectDefined(edit)();
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalled();
      });
      const command = expectDefined(execute.mock.calls[0]?.[0]);
      expect(command).toMatchObject({ type: 'edit-link', occurrence: 1, replacement });
      if (command.type !== 'edit-link') throw new Error('Wrong command');
      expect(command.target.type).toBe(fixture.field);
      if (command.target.type === 'comment')
        expect(command.target.ref.relativeLine).toBe(fixture.child ? 1 : 2);
      const target =
        command.target.type === 'comment' ? command.target.ref.parent : command.target.target;
      if (fixture.child)
        expect(target).toMatchObject({
          type: 'subtask',
          ref: {
            relativeLine: 1,
            parent: {
              type: 'subtask',
              ref: {
                relativeLine: 1,
                parent: { type: 'task', ref: { filePath: 'a.md', line: 0 } },
              },
            },
          },
        });
      else expect(target).toMatchObject({ type: 'task', ref: { filePath: 'a.md', line: 0 } });
      await vi.waitFor(() => {
        const root = h.index.list()[0];
        const node = fixture.child ? root?.subtasks[0]?.subtasks[0] : root;
        expect(fieldText(node, fixture.field)).toBe(updated);
        if (kind === 'root-comment') expect(node?.comments[0]?.text).toBe('earlier comment');
      });
    } finally {
      h.dispose();
    }
  },
);

it.each(['authored', 'https://one.example'])(
  'withholds matched-field edit authority when raw HTML hides an authored token labeled %s',
  async (label) => {
    const url = 'https://one.example';
    const source = `<div>\n[${label}](${url})\n</div>\n\n${url}`;
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      expect(markdown).toBe(source);
      holder.createDiv().appendText(`\n[${label}](${url})\n`);
      holder.createEl('p').createEl('a', { text: url, attr: { href: url } });
    });
    const h = await mountCanonicalSearchUi(
      {
        'a.md': `- [ ] root\n${source
          .split('\n')
          .map((line) => `  - > ${line}`)
          .join('\n')}`,
      },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      const execute = vi.spyOn(h.tasks, 'execute');
      const menu = vi.spyOn(Menu.prototype, 'addItem');
      h.query('https');
      await h.completed();
      const field = expectDefined(
        [...h.root.querySelectorAll('.abyss-search-context-text')].find(
          (field) => field.querySelector('a') !== null,
        ),
      );
      field.addEventListener('contextmenu', (event) => {
        event.stopPropagation();
      });
      expectDefined(field.querySelector('a')).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      expect(menu).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(field.textContent).toContain(`[${label}](${url})`);
      expect(field.querySelector('mark')).toBeNull();
    } finally {
      h.dispose();
    }
  },
);
