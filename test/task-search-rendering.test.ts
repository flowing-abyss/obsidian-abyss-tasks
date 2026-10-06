import { MarkdownRenderer, Menu, type MenuItem } from 'obsidian';
import postcss from 'postcss';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { SubtaskSnapshot, TaskSnapshot } from '../src/tasks';
import * as contextModule from '../src/tasks';
import { clockFrom } from '../src/tasks/domain/clock';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { deferred, expectDefined, loadPluginStyles, useRealMoment } from './helpers';
import { taskCardMountBound } from './support/taskPanelViewport';
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
    expect(card.querySelector('.abyss-task-desc')).not.toBeNull();
    expect(card.querySelector('.abyss-task-title mark')).toBeNull();
    expect(card.textContent).not.toContain('unrelated comment');
    const fields = card.querySelectorAll('.abyss-task-desc, .abyss-subtask-label');
    expect(fields).toHaveLength(2);
    expect(fields[0]?.textContent).toContain('unrelated paragraphsecond budget paragraph');
    expect(
      [...expectDefined(fields[0]).querySelectorAll('mark')].map((m) => m.textContent),
    ).toEqual(['bud', 'get']);
    expect(fields[1]?.textContent).toBe('zebra');
    expect(fields[1]?.querySelector('mark')?.textContent).toBe('zebra');
    expect(card.querySelectorAll('.abyss-search-context-label')).toHaveLength(0);
    expect(
      [...card.querySelectorAll('button')].some((b) => /More|Previous|Next/.test(b.textContent)),
    ).toBe(false);
  } finally {
    h.dispose();
  }
});

it('keeps repeated comments separately rendered and activates an exact repeated grandchild via the shared card', async () => {
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
    const fields = [...h.root.querySelectorAll<HTMLElement>('.abyss-comment-text')];
    expect(fields).toHaveLength(3);
    expect(fields[0]?.textContent).toContain('first needle comment');
    expect(fields[1]?.textContent).toContain('second needle comment');
    expect(fields[2]?.textContent).toBe('zebra needle');
    expect(h.root.textContent).not.toContain('unrelated preview');
    expectDefined(fields[2]).click();
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

it('renders hidden-target owning anchors without diagnostic text or unmatched alias marks', async () => {
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
    expect(h.root.querySelector('.abyss-search-context')?.textContent).toBe('');
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

it('extracts contexts only for the demanded roots and rejects detached context activation', async () => {
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
    const mounted = h.root.querySelectorAll('.abyss-task-card').length;
    expect(context).toHaveBeenCalledTimes(mounted);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
      taskCardMountBound(h.root, 1),
    );
    const old = expectDefined(
      h.root.querySelector<HTMLElement>(
        '.abyss-search-context .abyss-comment-text, .abyss-search-context .abyss-subtask-label, .abyss-search-context .abyss-task-desc',
      ),
    );
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
    scroll.scrollTop = 101 * 64;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect(h.root.textContent).toContain('root 100');
    });
    expect(context.mock.calls.length).toBeGreaterThan(mounted);
    expect(context.mock.calls.length).toBeLessThan(101);
    expect(new Set(context.mock.calls.map((args) => args[0].source.line)).size).toBe(
      context.mock.calls.length,
    );
    const hydration = vi.spyOn(h.search, 'resolveHits');
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
    expect(
      h.root.querySelector('.abyss-task-desc, .abyss-comment-text, .abyss-subtask-label')
        ?.textContent,
    ).toBe(`${prefix}needle tail same`);
    expect(h.root.querySelector('.abyss-search-context mark')?.textContent).toBe('needle');
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
      result.tree.evidence[0]?.matches.map((m) => ({
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
      const fields = [
        ...h.root.querySelectorAll('.abyss-task-desc, .abyss-comment-text, .abyss-subtask-label'),
      ].filter((field) => field.querySelector('a') !== null);
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
        [
          ...h.root.querySelectorAll('.abyss-task-desc, .abyss-comment-text, .abyss-subtask-label'),
        ].find((field) => field.querySelector('a') !== null),
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

it('renders the pruned actual task tree without footer or duplicate labels', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'a.md': [
        '- [ ] root',
        '  - > unrelated description',
        '  - 2026-10-04: first needle',
        '  - [ ] repeated',
        '    - [ ] repeated',
        '      - 2026-10-04: deep needle',
        '  - 2026-10-04: last needle',
        '  - [ ] repeated',
        '    - > fourth needle field',
        '  - [ ] unrelated branch',
      ].join('\n'),
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await h.completed();
    expect(h.root.querySelector('.abyss-search-footer')).toBeNull();
    expect(h.root.querySelector('.abyss-search-count')).toBeNull();
    expect(h.root.querySelector('.abyss-search-context-label')).toBeNull();
    expect(h.root.querySelectorAll('.abyss-task-title')).toHaveLength(1);
    expect(h.root.querySelectorAll('.abyss-subtask-label')).toHaveLength(3);
    expect(h.root.querySelectorAll('.abyss-comment-text')).toHaveLength(3);
    expect(h.root.textContent).not.toContain('unrelated description');
    expect(
      [
        ...h.root.querySelectorAll('.abyss-subtask-label, .abyss-comment-text, .abyss-task-desc'),
      ].map((e) => e.textContent),
    ).toEqual([
      'first needle',
      'repeated',
      'repeated',
      'deep needle',
      'last needle',
      'repeated',
      'fourth needle field',
    ]);
  } finally {
    h.dispose();
  }
});

const tagTree = [
  '- [ ] root #needle-root #unmatched-root',
  '  - [ ] repeated #needle-child',
  '    - [ ] repeated #needle-deep',
  '  - [ ] repeated #unmatched-sibling',
].join('\n');

it('uses shared tag colors and prevents child tag drops from writing the bubbling root', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.tagGroups = [
    {
      id: 'needle',
      name: 'Needle',
      color: '#ff0000',
      mode: 'manual',
      tags: ['#needle-root', '#needle-child', '#needle-deep'],
    },
  ];
  const h = await mountCanonicalSearchUi({ 'a.md': tagTree }, settings);
  try {
    h.query('needle');
    await h.completed();
    const execute = vi.spyOn(h.tasks, 'execute');
    const chips = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-tag')];
    expect(chips.map((e) => e.textContent)).toEqual([
      '#needle-child',
      '#needle-deep',
      '#needle-root',
    ]);
    expect(chips.every((e) => e.hasClass('abyss-task-tag--colored'))).toBe(true);
    expect(chips.every((e) => e.style.getPropertyValue('--abyss-tag-color') === '#ff0000')).toBe(
      true,
    );
    expect(h.root.textContent).not.toContain('unmatched');
    h.state.set('draggingTag', '#replacement');
    for (const chip of chips.filter((e) => e.textContent !== '#needle-root')) {
      const over = new Event('dragover', { bubbles: true, cancelable: true });
      chip.dispatchEvent(over);
      chip.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      expect(over.defaultPrevented).toBe(false);
      expect(chip.hasClass('abyss-drop-target')).toBe(false);
      expect(chip.closest('.abyss-task-card')?.classList.contains('abyss-drop-target')).toBe(false);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await h.app.vault.adapter.read('a.md')).toBe(tagTree);
    const rootChip = expectDefined(chips.find((e) => e.textContent === '#needle-root'));
    rootChip.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await vi.waitFor(async () => {
      expect(await h.app.vault.adapter.read('a.md')).toBe(
        tagTree.replace('#needle-root #unmatched-root', '#unmatched-root #replacement'),
      );
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.state.get('mode')).toBe('search');
  } finally {
    h.dispose();
  }
});

it.each(['#needle-root', '#needle-child', '#needle-deep'])(
  'uses the existing exact filter for %s without navigation or writes',
  async (tag) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const h = await mountCanonicalSearchUi({ 'a.md': tagTree }, settings);
    try {
      h.query('needle');
      await h.completed();
      const execute = vi.spyOn(h.tasks, 'execute');
      expectDefined(
        [...h.root.querySelectorAll<HTMLElement>('.abyss-task-tag')].find(
          (e) => e.textContent === tag,
        ),
      ).click();
      expect(h.panel['searchView_abyssPrivate'].list.filters).toEqual([
        { type: 'tag', value: tag },
      ]);
      expect(h.state.get('mode')).toBe('search');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it.each([
  ['needle-id', '- [ ] root 🆔 needle-id #unmatched', 'dependencyId: needle-id', 'needle-id'],
  [
    'needle-dep',
    '- [ ] root\n  - [ ] child ⛔ needle-dep #unmatched',
    'dependsOn: needle-dep',
    'needle-dep',
  ],
  ['90', '- [ ] root ⏱️ 1h30m #unmatched', 'Duration minutes: 90', '90'],
  ['1h30m', '- [ ] root ⏱️ 1h30m #unmatched', 'duration: 1h30m', '1h30m'],
  ['every day', '- [ ] root 🔁 every day #unmatched', 'recurrence: every day', 'every day'],
  ['tomorrow', '- [ ] root 🔁 tomorrow #unmatched', 'recurrence: tomorrow', 'tomorrow'],
] as const)(
  'renders only contributing scalar %s in its exact header',
  async (query, source, meaning, value) => {
    const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
    try {
      h.query(query);
      await h.completed();
      const group = expectDefined(
        [...h.root.querySelectorAll<HTMLElement>('.abyss-task-meta-right [role="group"]')].find(
          (e) => e.getAttribute('aria-label') === meaning,
        ),
      );
      expect(group.textContent).toBe(value);
      expect(group.querySelectorAll('a, button')).toHaveLength(0);
      expect(
        h.root.querySelectorAll(
          '.abyss-task-tag, .abyss-task-desc, .abyss-comment-text, .abyss-task-source-note',
        ),
      ).toHaveLength(0);
      expect(group.querySelectorAll('mark').length).toBeGreaterThan(0);
      expect(h.root.textContent).not.toContain('unmatched');
      expect(h.root.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(
        query === 'every day' || query === 'tomorrow' ? 1 : 0,
      );
      if (query === 'tomorrow')
        expect(
          group.querySelector('.abyss-recurrence-badge')?.getAttribute('data-recurrence-validity'),
        ).toBe('invalid');
    } finally {
      h.dispose();
    }
  },
);

it('deduplicates equal due/scheduled values with both accessible meanings and no time sidecar', async () => {
  const source = '- [ ] root 📅 2026-11-30 ⏳ 2026-11-30 ⏰ 09:30 🔁 every day #unmatched';
  const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
  try {
    h.query('2026-11-30');
    await h.completed();
    const date = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-task-meta-right [role="group"]'),
    );
    expect(date.getAttribute('aria-label')).toBe('scheduled: 2026-11-30; due: 2026-11-30');
    expect(h.root.querySelectorAll('.abyss-task-date-part')).toHaveLength(1);
    expect(
      h.root.querySelectorAll('.abyss-task-tag, .abyss-recurrence-badge, .abyss-task-time-part'),
    ).toHaveLength(0);
    expect(date.querySelector('mark')).toBeNull();
    const execute = vi.spyOn(h.tasks, 'execute');
    expectDefined(date.querySelector<HTMLElement>('.abyss-task-date-part')).click();
    expect(h.state.get('mode')).toBe('search');
    expect(h.panel['searchView_abyssPrivate'].list.filters).toEqual([
      { type: 'date', value: '2026-11-30' },
    ]);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('renders duplicate semantic text per exact descendant and preserves it across accepted publication', async () => {
  const source =
    '- [ ] root 🆔 needle-root\n  - [ ] repeated ⛔ needle-dep\n  - [ ] repeated ⛔ needle-dep';
  const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
  try {
    h.query('needle');
    await h.completed();
    const check = () => {
      expect(
        [...h.root.querySelectorAll('.abyss-task-meta-right [role="group"]')].map(
          (e) => e.textContent,
        ),
      ).toEqual(['needle-dep', 'needle-dep', 'needle-root']);
      expect(h.root.querySelectorAll('.abyss-subtask-label')).toHaveLength(2);
    };
    check();
    h.index.installCommittedContent('a.md', `${source}\n  - > unrelated`);
    await h.completed();
    check();
  } finally {
    h.dispose();
  }
});

it.each(['toggle', 'status', 'priority'] as const)(
  'executes deepest repeated child %s through the shared commands and preserves all other bytes',
  async (action) => {
    // Negative control: advance the host date without freezing real scheduling.
    const hostNow = Date.now.bind(Date);
    const hostOffset = Date.UTC(2035, 0, 2, 12) - hostNow();
    vi.spyOn(Date, 'now').mockImplementation(() => hostNow() + hostOffset);
    const source = '- [ ] root\n  - [ ] repeated\n    - [ ] needle\n  - [ ] needle';
    const h = await mountCanonicalSearchUi(
      { 'a.md': source },
      structuredClone(DEFAULT_SETTINGS),
      'search',
      undefined,
      false,
      clockFrom(Date.UTC(2026, 9, 5, 12), 0),
    );
    try {
      h.query('needle');
      await h.completed();
      const root = expectDefined(h.index.list()[0]);
      const child = expectDefined(root.subtasks[0]?.subtasks[0]);
      const label = expectDefined(
        [...h.root.querySelectorAll<HTMLElement>('.abyss-subtask-label')].find(
          (e) => e.textContent === 'needle',
        ),
      );
      const row = expectDefined(label.closest('.abyss-subtask-row'));
      const marker = expectDefined(row.querySelector<HTMLElement>('[role="checkbox"]'));
      const execute = vi.spyOn(h.tasks, 'execute');
      if (action === 'toggle') marker.click();
      else {
        marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const popover = expectDefined(document.querySelector('.abyss-status-popover'));
        const choice =
          action === 'priority'
            ? popover.querySelector<HTMLButtonElement>('[data-abyss-priority="A"]')
            : [...popover.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find((e) =>
                e.textContent.includes('In progress'),
              );
        expectDefined(choice).click();
      }
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledTimes(1);
      });
      const target = { type: 'subtask' as const, ref: child.ref };
      const expectedCommands = {
        toggle: { type: 'toggle-completion', target },
        status: { type: 'set-status', target, symbol: '/' },
        priority: { type: 'patch', target, patch: { priority: { type: 'set', value: 'A' } } },
      };
      expect(execute.mock.calls[0]?.[0]).toEqual(expectedCommands[action]);
      const expectedLines = {
        toggle: '    - [x] needle ✅ 2026-10-05',
        status: '    - [/] needle',
        priority: '    - [ ] needle 🔺',
      };
      await vi.waitFor(async () => {
        expect(await h.app.vault.adapter.read('a.md')).toBe(
          source.replace('    - [ ] needle', expectedLines[action]),
        );
      });
      expect(h.state.get('mode')).toBe('search');
    } finally {
      h.dispose();
    }
  },
);

it.each([
  ['created', '➕', '2026-11-30'],
  ['start', '🛫', '2026-11-30'],
  ['completion', '✅', '2026-11-30'],
  ['cancelled', '❌', '2026-11-30'],
  ['scheduled', '⏳', '2026-11-30'],
  ['due', '📅', '2026-11-30'],
  ['time', '⏰', '09:30'],
  ['priority', '⏫', 'B'],
] as const)(
  'renders contributing %s with the existing primitive or literal fallback',
  async (key, marker, value) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const literal = key === 'priority' ? '' : ` ${value}`;
    const source = `- [ ] root ${marker}${literal} #unmatched`;
    const h = await mountCanonicalSearchUi({ 'a.md': source }, settings);
    try {
      h.query(value);
      await h.completed();
      const group = expectDefined(
        h.root.querySelector<HTMLElement>(`.abyss-task-meta-right [aria-label="${key}: ${value}"]`),
      );
      expect(
        h.root.querySelectorAll('.abyss-task-tag, .abyss-comment-text, .abyss-task-desc'),
      ).toHaveLength(0);
      if (key === 'due' || key === 'scheduled') {
        expect(group.querySelector('.abyss-task-date-part')).not.toBeNull();
        expectDefined(group.querySelector<HTMLElement>('.abyss-task-date-part')).click();
        expect(h.panel['searchView_abyssPrivate'].list.filters).toEqual([{ type: 'date', value }]);
      } else if (key === 'time') {
        expect(group.textContent).toBe(value);
        expectDefined(group.querySelector<HTMLElement>('.abyss-task-date')).click();
        expect(h.panel['searchView_abyssPrivate'].list.filters).toEqual([{ type: 'time', value }]);
      } else {
        expect(group.textContent).toBe(value);
        expect(group.querySelector('.abyss-task-date')).toBeNull();
        if (key === 'priority')
          expect(h.root.querySelector('.abyss-status-marker')?.getAttribute('data-priority')).toBe(
            'B',
          );
      }
      expect(h.state.get('mode')).toBe('search');
    } finally {
      h.dispose();
    }
  },
);

it('retains both distinct contributing duration values and whole authored text without semantic replay', async () => {
  const source = '- [ ] root ⏱️ 1h30m\n  - > 90 and 1h30m are the authored estimate';
  const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
  try {
    h.query('90 1h30m');
    await h.completed();
    expect(
      [...h.root.querySelectorAll('.abyss-task-meta-right [role="group"]')].map(
        (e) => e.textContent,
      ),
    ).toEqual(['90', '1h30m']);
    expect(h.root.querySelector('.abyss-task-desc')?.textContent).toBe(
      '90 and 1h30m are the authored estimate',
    );
  } finally {
    h.dispose();
  }
});

it('blocks exact child pointer completion and presents the application refusal for a done menu choice', async () => {
  const source = '- [ ] prerequisite 🆔 prereq\n- [ ] root\n  - [ ] needle ⛔ prereq';
  const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
  try {
    h.query('needle');
    await h.completed();
    const execute = vi.spyOn(h.tasks, 'execute');
    const label = expectDefined(h.root.querySelector('.abyss-subtask-label'));
    const marker = expectDefined(
      label.closest('.abyss-subtask-row')?.querySelector<HTMLElement>('[role="checkbox"]'),
    );
    expect(marker.getAttribute('aria-disabled')).toBe('true');
    marker.click();
    expect(execute).not.toHaveBeenCalled();
    expect(await h.app.vault.adapter.read('a.md')).toBe(source);
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const done = expectDefined(
      [...document.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find((e) =>
        e.textContent.includes('Done'),
      ),
    );
    done.click();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    const result = await (expectDefined(execute.mock.results[0]?.value) as ReturnType<
      typeof h.tasks.execute
    >);
    expect(result.type).toBe('blocked');
    expect(await h.app.vault.adapter.read('a.md')).toBe(source);
    expect(h.state.get('mode')).toBe('search');
  } finally {
    h.dispose();
  }
});

it.each(['cancel', 'confirm', 'teardown'] as const)(
  'keeps child invalid-recurrence completion confirmation under its owner (%s)',
  async (decision) => {
    const source = '- [ ] root\n  - [ ] needle 🔁 tomorrow 🏁 delete\n  - [ ] sibling';
    const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
    try {
      h.query('needle');
      await h.completed();
      const execute = vi.spyOn(h.tasks, 'execute');
      expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-subtask-row [role="checkbox"]'),
      ).click();
      const confirm = expectDefined(document.querySelector('.abyss-recurrence-delete-confirm'));
      expect(execute).not.toHaveBeenCalled();
      if (decision === 'teardown') h.panel.destroy();
      else
        expectDefined(
          confirm.querySelector<HTMLButtonElement>(
            decision === 'confirm' ? '.abyss-recurrence-delete-confirm-button' : 'button',
          ),
        ).click();
      await vi.waitFor(() => {
        expect(confirm.isConnected).toBe(false);
      });
      if (decision === 'confirm') {
        await vi.waitFor(async () => {
          expect(await h.app.vault.adapter.read('a.md')).toBe('- [ ] root\n  - [ ] sibling');
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } else {
        expect(execute).not.toHaveBeenCalled();
        expect(await h.app.vault.adapter.read('a.md')).toBe(source);
      }
    } finally {
      h.dispose();
    }
  },
);

it('renders all four contributing tags once and keeps a same-tag drop a no-op', async () => {
  const source = '- [ ] root #needle-one #needle-two #needle-three #needle-four';
  const h = await mountCanonicalSearchUi({ 'a.md': source }, structuredClone(DEFAULT_SETTINGS));
  try {
    h.query('needle');
    await h.completed();
    const chips = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-tag')];
    expect(chips.map((e) => e.textContent)).toEqual([
      '#needle-one',
      '#needle-two',
      '#needle-three',
      '#needle-four',
    ]);
    const execute = vi.spyOn(h.tasks, 'execute');
    h.state.set('draggingTag', '#needle-one');
    expectDefined(chips[0]).dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(execute).not.toHaveBeenCalled();
    expect(await h.app.vault.adapter.read('a.md')).toBe(source);
  } finally {
    h.dispose();
  }
});

// These assertions catch root-only responsive tracks leaking onto nested child metadata,
// and descriptions mounted beside the row instead of in its shared title column.
it.each(['', ' #needle-child'])(
  'keeps child text and metadata in their own body with metadata %s',
  async (tags) => {
    const h = await mountCanonicalSearchUi(
      {
        'a.md': `- [ ] root #needle-root\n  - [ ] Parent needle layer${tags}\n    - > Full needle description`,
      },
      structuredClone(DEFAULT_SETTINGS),
    );
    try {
      h.query('needle');
      await h.completed();
      const title = expectDefined(h.root.querySelector('.abyss-subtask-label'));
      const row = expectDefined(title.closest('.abyss-subtask-row'));
      const body = expectDefined(row.querySelector(':scope > .abyss-subtask-content'));
      expect(body.querySelector('.abyss-subtask-title-row > .abyss-subtask-label')).toBe(title);
      expect(body.querySelector(':scope > .abyss-task-desc')?.textContent).toBe(
        'Full needle description',
      );
      expect(body.querySelector(':scope > .abyss-task-meta-right')?.textContent).toBe(tags.trim());
      expect(row.querySelector(':scope > .abyss-task-meta-right')).toBeNull();
    } finally {
      h.dispose();
    }
  },
);

it('limits the narrow metadata width track to the root card row', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'a.md': '- [ ] root #needle-root\n  - [ ] Parent needle layer #needle-child',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    h.query('needle');
    await h.completed();
    const rootMeta = expectDefined(
      h.root.querySelector('.abyss-task-card-main-row > .abyss-task-meta-right'),
    );
    const childMeta = expectDefined(
      h.root.querySelector('.abyss-search-context .abyss-task-meta-right'),
    );
    const widthSelectors: string[] = [];
    postcss.parse(await loadPluginStyles()).walkAtRules('container', (container) => {
      if (container.params !== 'abyss-task-list (max-width: 28rem)') return;
      container.walkRules((rule) => {
        if (
          rule.nodes.some(
            (node) => node.type === 'decl' && node.prop === 'width' && node.value === '100%',
          )
        )
          widthSelectors.push(rule.selector);
      });
    });
    expect(widthSelectors.some((selector) => rootMeta.matches(selector))).toBe(true);
    expect(widthSelectors.some((selector) => childMeta.matches(selector))).toBe(false);
  } finally {
    h.dispose();
  }
});

it('marks Tasks filter title, visible description and tags without Search context', async () => {
  const h = await mountCanonicalSearchUi(
    {
      'tasks/active.md':
        '- [ ] budget ledger #budget\n  - > budget first line\n  - > hidden second budget line\n  - [ ] budget hidden child',
    },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    h.state.set('selectedList', { type: 'tag', tag: '#budget' });
    h.panel.refresh();
    h.query('budgte');
    await h.completed();
    const card = expectDefined(h.root.querySelector('.abyss-task-card'));
    expect(card.querySelector('.abyss-task-title mark')?.textContent).toBe('budget');
    expect(card.querySelector('.abyss-task-desc mark')?.textContent).toBe('budget');
    expect(card.querySelector('.abyss-task-tag mark')?.textContent).toBe('budget');
    expect(card.querySelector('.abyss-search-context')).toBeNull();
    expect(card.textContent).not.toContain('hidden second');
    expect(card.textContent).not.toContain('hidden child');
    h.query('ledger');
    await h.completed();
    expect(h.root.querySelector('.abyss-task-title mark')?.textContent).toBe('ledger');
    expect(h.root.querySelector('.abyss-task-desc mark')).toBeNull();
  } finally {
    h.dispose();
  }
});
