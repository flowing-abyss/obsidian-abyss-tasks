// test/tag-manager-files.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { transformMarkdownTags } from '../src/tags/markdownTagRename';
import { TagManager } from '../src/tags/TagManager';
import { createAppWithFiles, expectDefined } from './helpers';

async function makeManager(files: Record<string, string> = {}) {
  const settings: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    pinnedTags: [...DEFAULT_SETTINGS.pinnedTags],
    archivedTags: [...DEFAULT_SETTINGS.archivedTags],
    tagGroups: DEFAULT_SETTINGS.tagGroups.map((group) => ({
      ...group,
      ...(group.tags === undefined ? {} : { tags: [...group.tags] }),
    })),
  };
  const save = vi.fn().mockResolvedValue(undefined);
  const app = await createAppWithFiles(files);
  const tm = new TagManager(app, settings, save);
  return { tm, app, settings, save };
}

async function read(app: Awaited<ReturnType<typeof createAppWithFiles>>, path: string) {
  return app.vault.read(app.vault.getAbstractFileByPath(path) as never);
}

function countedString(value: string): {
  readonly source: string;
  readonly indexedReads: () => number;
  readonly nativeSearchWork: () => number;
} {
  let indexedReads = 0;
  let nativeSearchWork = 0;
  const target = Object(value) as object;
  const source = new Proxy(target, {
    get(candidate, property): unknown {
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/u.test(property)) indexedReads++;
      if (property === 'indexOf') {
        return (search: string, position = 0): number => {
          nativeSearchWork += Math.max(0, value.length - Math.max(0, position));
          return String.prototype.indexOf.call(candidate, search, position);
        };
      }
      if (property === 'lastIndexOf') {
        return (search: string, position = value.length): number => {
          nativeSearchWork += Math.min(value.length, Math.max(0, position + 1));
          return String.prototype.lastIndexOf.call(candidate, search, position);
        };
      }
      if (property === 'startsWith') {
        return (search: string, position = 0): boolean => {
          nativeSearchWork += search.length;
          return String.prototype.startsWith.call(candidate, search, position);
        };
      }
      const member = Reflect.get(candidate, property, candidate) as unknown;
      if (typeof member !== 'function') return member;
      return (...args: unknown[]): unknown => Reflect.apply(member, candidate, args) as unknown;
    },
  }) as unknown as string;
  return {
    source,
    indexedReads: () => indexedReads,
    nativeSearchWork: () => nativeSearchWork,
  };
}

describe('TagManager exact and prefix vault rename', () => {
  it('exact rename changes complete tokens but leaves descendants and lookalikes byte-identical', async () => {
    const original =
      'front #work; child #work/dev; lookalike #workplace; hyphen #work-place\n#work\n';
    const { tm, app } = await makeManager({ 'notes/tasks.md': original });

    const result = await tm.renameTagExact('work', 'focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe(
      'front #focus; child #work/dev; lookalike #workplace; hyphen #work-place\n#focus\n',
    );
  });

  it('prefix rename changes the root and descendants but not adjacent tag names', async () => {
    const original = '- [ ] #work #work/dev #work/dev/api #workplace #work-place\n';
    const { tm, app } = await makeManager({
      'notes/tasks.md': original,
      'notes/untouched.md': '- [ ] #personal\n',
    });

    const result = await tm.renameTagPrefix('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe(
      '- [ ] #focus #focus/dev #focus/dev/api #workplace #work-place\n',
    );
    expect(await read(app, 'notes/untouched.md')).toBe('- [ ] #personal\n');
  });

  it('renames Unicode and emoji tags without matching adjacent Unicode or emoji tags', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#работа #работа/срочно #работает\n#work #work/dev #worké #work🚀\n',
    });

    const exact = await tm.renameTagExact('#работа', '#фокус');
    const prefix = await tm.renameTagPrefix('#work', '#focus');

    expect(exact).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(prefix).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe(
      '#фокус #работа/срочно #работает\n#focus #focus/dev #worké #work🚀\n',
    );
  });

  it('accepts emoji inside old and new tag names', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#work🚀 #work🚀/next #work🚀er\n',
    });

    const result = await tm.renameTagPrefix('#work🚀', '#фокус✨');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe('#фокус✨ #фокус✨/next #work🚀er\n');
  });

  it('accepts flag-only tags and exact rename leaves a flag-suffixed adjacent tag untouched', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#🇺🇸 #travel #travel/dev #travel🇺🇸\n',
    });

    const flag = await tm.renameTagExact('#🇺🇸', '#🇨🇦');
    const exact = await tm.renameTagExact('#travel', '#trip');

    expect(flag).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(exact).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe('#🇨🇦 #trip #travel/dev #travel🇺🇸\n');
  });

  it('prefix rename leaves a flag-suffixed adjacent tag untouched', async () => {
    const { tm, app } = await makeManager({
      'notes/tasks.md': '#travel #travel/dev #travel🇺🇸\n',
    });

    const result = await tm.renameTagPrefix('#travel', '#trip');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/tasks.md'] });
    expect(await read(app, 'notes/tasks.md')).toBe('#trip #trip/dev #travel🇺🇸\n');
  });

  it('exact rename updates semantic body and frontmatter tags while preserving literal examples', async () => {
    const original = [
      '---',
      'title: "#work remains literal"',
      'tags:',
      '  - work',
      '  - work/dev',
      '  - "work"',
      '  - other',
      'aliases: [work]',
      '---',
      'Prose #work and descendant #work/dev.',
      'Inline `#work` and escaped \\#work remain literal.',
      '```md',
      '#work',
      '```',
      '~~~',
      '#work',
      '~~~',
      '',
    ].join('\n');
    const expected = original
      .replace('  - work\n', '  - focus\n')
      .replace('  - "work"\n', '  - "focus"\n')
      .replace('Prose #work and descendant', 'Prose #focus and descendant');
    const { tm, app } = await makeManager({ 'notes/block.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/block.md'] });
    expect(await read(app, 'notes/block.md')).toBe(expected);
  });

  it('prefix rename updates block and flow frontmatter tag subtrees without touching other YAML', async () => {
    const blockOriginal = [
      '---',
      'tags:',
      '  - work',
      '  - work/dev',
      '  - workplace',
      'category: work',
      '---',
      'Non-task prose: #work #work/dev #workplace.',
      '',
    ].join('\n');
    const flowOriginal = [
      '---',
      'tags: [work, work/dev, "work/ops", workplace, other] # keep spacing',
      'aliases: [work/dev]',
      '---',
      'Text `#work/dev` and #work/dev.',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({
      'notes/block.md': blockOriginal,
      'notes/flow.md': flowOriginal,
    });

    const result = await tm.renameTagPrefix('work', 'focus');

    expect(result).toEqual({
      type: 'ok',
      changedFiles: ['notes/block.md', 'notes/flow.md'],
    });
    expect(await read(app, 'notes/block.md')).toBe(
      blockOriginal
        .replace('  - work\n', '  - focus\n')
        .replace('  - work/dev\n', '  - focus/dev\n')
        .replace('#work #work/dev #workplace', '#focus #focus/dev #workplace'),
    );
    expect(await read(app, 'notes/flow.md')).toBe(
      flowOriginal
        .replace(
          '[work, work/dev, "work/ops", workplace, other]',
          '[focus, focus/dev, "focus/ops", workplace, other]',
        )
        .replace('and #work/dev.', 'and #focus/dev.'),
    );
  });

  it.each([
    {
      scope: 'exact',
      expected: [
        '---',
        'tags: [focus, work/dev]',
        '---',
        'Visible #focus and #work/dev.',
        '[visible #focus](https://host/#work), ![alt](image#work), <https://host/#work>, and <user#work@example.com>.',
        '[escaped \\] label #focus](https://host/#work) and [nested [label] #focus](https://host/#work).',
        'Wiki [[Note#work|visible #focus]] and target-only [[Note#work]].',
        '<span data-tag="#work" title="#work">Visible #focus</span> <meta data-tag="#work" />',
        '<!-- #work and #work/dev stay comments -->',
        'Reference [docs][work-ref].',
        '[work-ref]: https://host/page#work "literal #work"',
        'Inline `#work` and math $#work + 1$ stay literal.',
        '$$',
        '#work/dev',
        '$$',
        'Obsidian comment %% #work and #work/dev %%.',
        '```md',
        '#work #work/dev',
        '```',
        '',
      ].join('\n'),
    },
    {
      scope: 'prefix',
      expected: [
        '---',
        'tags: [focus, focus/dev]',
        '---',
        'Visible #focus and #focus/dev.',
        '[visible #focus](https://host/#work), ![alt](image#work), <https://host/#work>, and <user#work@example.com>.',
        '[escaped \\] label #focus](https://host/#work) and [nested [label] #focus](https://host/#work).',
        'Wiki [[Note#work|visible #focus]] and target-only [[Note#work]].',
        '<span data-tag="#work" title="#work">Visible #focus</span> <meta data-tag="#work" />',
        '<!-- #work and #work/dev stay comments -->',
        'Reference [docs][work-ref].',
        '[work-ref]: https://host/page#work "literal #work"',
        'Inline `#work` and math $#work + 1$ stay literal.',
        '$$',
        '#work/dev',
        '$$',
        'Obsidian comment %% #work and #work/dev %%.',
        '```md',
        '#work #work/dev',
        '```',
        '',
      ].join('\n'),
    },
  ] as const)(
    '$scope rename changes visible prose/frontmatter while preserving semantic literal ranges',
    async ({ scope, expected }) => {
      const original = [
        '---',
        'tags: [work, work/dev]',
        '---',
        'Visible #work and #work/dev.',
        '[visible #work](https://host/#work), ![alt](image#work), <https://host/#work>, and <user#work@example.com>.',
        '[escaped \\] label #work](https://host/#work) and [nested [label] #work](https://host/#work).',
        'Wiki [[Note#work|visible #work]] and target-only [[Note#work]].',
        '<span data-tag="#work" title="#work">Visible #work</span> <meta data-tag="#work" />',
        '<!-- #work and #work/dev stay comments -->',
        'Reference [docs][work-ref].',
        '[work-ref]: https://host/page#work "literal #work"',
        'Inline `#work` and math $#work + 1$ stay literal.',
        '$$',
        '#work/dev',
        '$$',
        'Obsidian comment %% #work and #work/dev %%.',
        '```md',
        '#work #work/dev',
        '```',
        '',
      ].join('\n');
      const { tm, app } = await makeManager({ 'notes/semantic-ranges.md': original });

      const result =
        scope === 'exact'
          ? await tm.renameTagExact('#work', '#focus')
          : await tm.renameTagPrefix('#work', '#focus');

      expect(result).toEqual({ type: 'ok', changedFiles: ['notes/semantic-ranges.md'] });
      expect(await read(app, 'notes/semantic-ranges.md')).toBe(expected);
    },
  );

  it.each([
    {
      name: 'an unmatched Markdown destination delimiter',
      original: 'Delimiter-shaped prose ](#work) remains visible.\n',
      expected: 'Delimiter-shaped prose ](#focus) remains visible.\n',
    },
    {
      name: 'an escaped Markdown label opener',
      original: 'Escaped opener \\[label](#work) remains visible.\n',
      expected: 'Escaped opener \\[label](#focus) remains visible.\n',
    },
    {
      name: 'comparison operators',
      original: 'Comparison prose 1 < 2 #work > 0 remains visible.\n',
      expected: 'Comparison prose 1 < 2 #focus > 0 remains visible.\n',
    },
    {
      name: 'malformed HTML-like markup',
      original: 'Malformed markup <span #work> remains visible.\n',
      expected: 'Malformed markup <span #focus> remains visible.\n',
    },
  ])('exact rename changes visible tags inside $name', async ({ original, expected }) => {
    const { tm, app } = await makeManager({ 'notes/delimiter-prose.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/delimiter-prose.md'] });
    expect(await read(app, 'notes/delimiter-prose.md')).toBe(expected);
  });

  it('preserves nested semantic targets while renaming visible content inside link labels', async () => {
    const original = [
      '[![alt](image#work)](outer#work) outside #work',
      '[wiki [[Note#work|visible #work]]](outer#work) outside #work',
      '[html <span data-tag="#work">visible #work</span>](outer#work) outside #work',
      '[comment <!-- #work --> visible #work](dest#work) outside #work',
      '[math $#work$ visible #work](dest#work) outside #work',
      '',
    ].join('\n');
    const expected = [
      '[![alt](image#work)](outer#work) outside #focus',
      '[wiki [[Note#work|visible #focus]]](outer#work) outside #focus',
      '[html <span data-tag="#work">visible #focus</span>](outer#work) outside #focus',
      '[comment <!-- #work --> visible #focus](dest#work) outside #focus',
      '[math $#work$ visible #focus](dest#work) outside #focus',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/nested-labels.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/nested-labels.md'] });
    expect(await read(app, 'notes/nested-labels.md')).toBe(expected);
  });

  it('recovers from an unmatched wiki opener before a later valid wiki link', async () => {
    const original = 'Unmatched [[ prose #work\nLater [[Note#work|visible #work]] outside #work\n';
    const { tm, app } = await makeManager({ 'notes/wiki-recovery.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/wiki-recovery.md'] });
    expect(await read(app, 'notes/wiki-recovery.md')).toBe(
      'Unmatched [[ prose #focus\nLater [[Note#work|visible #focus]] outside #focus\n',
    );
  });

  it('keeps an NBSP inside a valid bare link destination byte-identical', async () => {
    const original = '[label](url\u00a0#work) outside #work\n';
    const { tm, app } = await makeManager({ 'notes/nbsp-destination.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/nbsp-destination.md'] });
    expect(await read(app, 'notes/nbsp-destination.md')).toBe(
      '[label](url\u00a0#work) outside #focus\n',
    );
  });

  it.each([
    {
      name: 'a forbidden nested link',
      original: '[outer [inner](url) text](#work)\n',
      expected: '[outer [inner](url) text](#focus)\n',
    },
    {
      name: 'spaces in a bare destination',
      original: '[label](/my #work)\n',
      expected: '[label](/my #focus)\n',
    },
    {
      name: 'a blank line crossing the label',
      original: 'Opening [ prose\n\nclosing ](#work)\n',
      expected: 'Opening [ prose\n\nclosing ](#focus)\n',
    },
    {
      name: 'a blank line inside a quoted title',
      original: '[label](url "title\n\n#work") outside #work\n',
      expected: '[label](url "title\n\n#focus") outside #focus\n',
    },
    {
      name: 'a backslash before a blank line inside a quoted title',
      original: '[label](url "title\\\n\n#work") outside #work\n',
      expected: '[label](url "title\\\n\n#focus") outside #focus\n',
    },
    {
      name: 'an unescaped opening parenthesis inside a parenthesized title',
      original: '[label](url (title ( #work)) outside #work\n',
      expected: '[label](url (title ( #focus)) outside #focus\n',
    },
  ])('renames visible destination-shaped prose after $name', async ({ original, expected }) => {
    const { tm, app } = await makeManager({ 'notes/invalid-links.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/invalid-links.md'] });
    expect(await read(app, 'notes/invalid-links.md')).toBe(expected);
  });

  it('keeps comments and math semantic after an unmatched wiki opener', async () => {
    const original = [
      'Unmatched [[ prose <!-- #work --> outside #work',
      'Unmatched [[ prose $#work$ outside #work',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/wiki-literals.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/wiki-literals.md'] });
    expect(await read(app, 'notes/wiki-literals.md')).toBe(
      [
        'Unmatched [[ prose <!-- #work --> outside #focus',
        'Unmatched [[ prose $#work$ outside #focus',
        '',
      ].join('\n'),
    );
  });

  it('keeps unmatched label scanning within a linear indexed-read budget', () => {
    const readsFor = (
      bracketCount: number,
    ): { readonly reads: number; readonly length: number } => {
      const original = `${'['.repeat(bracketCount)} visible #work`;
      const counted = countedString(original);
      expect(transformMarkdownTags(counted.source, '#work', '#focus', 'exact')).toBe(
        `${'['.repeat(bracketCount)} visible #focus`,
      );
      return { reads: counted.indexedReads(), length: original.length };
    };

    const small = readsFor(1_000);
    const large = readsFor(2_000);

    expect(large.reads).toBeLessThanOrEqual(large.length * 20);
    expect(large.reads).toBeLessThanOrEqual(small.reads * 3);
  });

  it('applies CommonMark comment endings and raw-tag line-ending limits', async () => {
    const original = [
      '<!--> outside #work',
      '<!---> outside #work',
      '\\<!-- #work --> outside #work',
      '<span',
      ' data-tag="#work"> outside #work',
      '<span',
      '',
      ' data-tag="#work"> outside #work',
      '',
    ].join('\n');
    const expected = [
      '<!--> outside #focus',
      '<!---> outside #focus',
      '\\<!-- #focus --> outside #focus',
      '<span',
      ' data-tag="#work"> outside #focus',
      '<span',
      '',
      ' data-tag="#focus"> outside #focus',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/raw-html.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/raw-html.md'] });
    expect(await read(app, 'notes/raw-html.md')).toBe(expected);
  });

  it('keeps an unterminated block HTML comment opaque through end of file', () => {
    const original = '<!--\n#work\noutside #work\n';

    expect(transformMarkdownTags(original, '#work', '#focus', 'exact')).toBe(original);
  });

  it('recognizes a block HTML comment after a failed inline comment candidate', () => {
    const original = 'Inline malformed <!-- visible #work\n<!--\nblock #work\n';

    expect(transformMarkdownTags(original, '#work', '#focus', 'exact')).toBe(
      'Inline malformed <!-- visible #focus\n<!--\nblock #work\n',
    );
  });

  it.each(['<?', '<!--'])(
    'keeps repeated malformed %s scanning within deterministic native-search bounds',
    (candidate) => {
      const scan = (
        count: number,
      ): { readonly searchWork: number; readonly length: number; readonly elapsedMs: number } => {
        const original = `${candidate.repeat(count)} trailing #work`;
        const counted = countedString(original);
        const started = activeWindow.performance.now();
        const transformed = transformMarkdownTags(counted.source, '#work', '#focus', 'exact');
        const elapsedMs = activeWindow.performance.now() - started;
        const expected =
          candidate === '<!--' ? original : `${candidate.repeat(count)} trailing #focus`;
        expect(transformed).toBe(expected);
        return {
          searchWork: counted.nativeSearchWork(),
          length: original.length,
          elapsedMs,
        };
      };

      const small = scan(1_000);
      const large = scan(2_000);

      expect(large.searchWork).toBeLessThanOrEqual(large.length * 20);
      expect(large.searchWork).toBeLessThanOrEqual(small.searchWork * 3);
      expect(large.elapsedMs).toBeLessThan(1_000);
    },
  );

  it('exact rename handles indentless and commented block tags while preserving quoted fences', async () => {
    const original = [
      '---',
      'title: "keep every unrelated byte"',
      'tags:',
      '- work',
      '- work/dev',
      '- "work" # keep quoted comment',
      '- work   # keep spaced comment',
      '- workplace',
      'aliases: [work]',
      '---',
      '> ```md',
      '> #work',
      '> ```',
      'Outside #work and #work/dev.',
      '',
    ].join('\n');
    const expected = [
      '---',
      'title: "keep every unrelated byte"',
      'tags:',
      '- focus',
      '- work/dev',
      '- "focus" # keep quoted comment',
      '- focus   # keep spaced comment',
      '- workplace',
      'aliases: [work]',
      '---',
      '> ```md',
      '> #work',
      '> ```',
      'Outside #focus and #work/dev.',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/exact.md': original });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/exact.md'] });
    expect(await read(app, 'notes/exact.md')).toBe(expected);
  });

  it('prefix rename handles multiline flow tags while preserving blockquote fenced literals', async () => {
    const original = [
      '---',
      'tags: [',
      '  work,',
      '  "work/dev",',
      '  workplace,',
      '  other',
      '] # keep flow layout',
      'category: work',
      '---',
      '> ~~~md',
      '> #work/dev',
      '> ~~~',
      'Outside #work/dev and #workplace.',
      '',
    ].join('\n');
    const expected = [
      '---',
      'tags: [',
      '  focus,',
      '  "focus/dev",',
      '  workplace,',
      '  other',
      '] # keep flow layout',
      'category: work',
      '---',
      '> ~~~md',
      '> #work/dev',
      '> ~~~',
      'Outside #focus/dev and #workplace.',
      '',
    ].join('\n');
    const { tm, app } = await makeManager({ 'notes/prefix.md': original });

    const result = await tm.renameTagPrefix('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: ['notes/prefix.md'] });
    expect(await read(app, 'notes/prefix.md')).toBe(expected);
  });

  it.each([
    {
      scope: 'exact',
      expectedOutside: 'Outside #focus and #work/dev.',
    },
    {
      scope: 'prefix',
      expectedOutside: 'Outside #focus and #focus/dev.',
    },
  ] as const)(
    '$scope rename exits an unclosed blockquote fence before transforming outside prose',
    async ({ scope, expectedOutside }) => {
      const original = ['> ```md', '> #work', '', 'Outside #work and #work/dev.', ''].join('\n');
      const expected = ['> ```md', '> #work', '', expectedOutside, ''].join('\n');
      const { tm, app } = await makeManager({ 'notes/unclosed-quote.md': original });

      const result =
        scope === 'exact'
          ? await tm.renameTagExact('#work', '#focus')
          : await tm.renameTagPrefix('#work', '#focus');

      expect(result).toEqual({ type: 'ok', changedFiles: ['notes/unclosed-quote.md'] });
      expect(await read(app, 'notes/unclosed-quote.md')).toBe(expected);
    },
  );

  it.each([
    {
      scope: 'exact',
      target: '  work,',
      expectedTarget: '  focus,',
      following: '  work/dev,',
    },
    {
      scope: 'prefix',
      target: '  work/dev,',
      expectedTarget: '  focus/dev,',
      following: '  workplace,',
    },
  ] as const)(
    '$scope rename handles an element after a comment-only multiline flow line',
    async ({ scope, target, expectedTarget, following }) => {
      const original = [
        '---',
        'title: "preserve"',
        'tags: [',
        '  # keep this comment-only line',
        target,
        following,
        '  other',
        '] # preserve closing bytes',
        'aliases: [work]',
        '---',
        '',
      ].join('\n');
      const expected = [
        '---',
        'title: "preserve"',
        'tags: [',
        '  # keep this comment-only line',
        expectedTarget,
        following,
        '  other',
        '] # preserve closing bytes',
        'aliases: [work]',
        '---',
        '',
      ].join('\n');
      const { tm, app } = await makeManager({ 'notes/commented-flow.md': original });

      const result =
        scope === 'exact'
          ? await tm.renameTagExact('#work', '#focus')
          : await tm.renameTagPrefix('#work', '#focus');

      expect(result).toEqual({ type: 'ok', changedFiles: ['notes/commented-flow.md'] });
      expect(await read(app, 'notes/commented-flow.md')).toBe(expected);
    },
  );

  it.each([
    ['', '#new'],
    ['#', '#new'],
    ['#1984', '#new'],
    ['#work', '#1984'],
    ['#work/', '#new'],
    ['#work//dev', '#new'],
    ['#work dev', '#new'],
    ['#work', '#new/'],
  ])('rejects invalid values without file or settings writes: %s → %s', async (oldTag, newTag) => {
    const { tm, app, save } = await makeManager({ 'notes/tasks.md': '- [ ] #work\n' });
    const process = vi.spyOn(app.vault, 'process');

    const exact = await tm.renameTagExact(oldTag, newTag);
    const prefix = await tm.renameTagPrefix(oldTag, newTag);

    expect(exact).toEqual({ type: 'invalid', reason: 'invalid-tag' });
    expect(prefix).toEqual({ type: 'invalid', reason: 'invalid-tag' });
    expect(process).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects normalized no-ops without file or settings writes', async () => {
    const { tm, app, save } = await makeManager({ 'notes/tasks.md': '- [ ] #work\n' });
    const process = vi.spyOn(app.vault, 'process');

    expect(await tm.renameTagExact('work', '#work')).toEqual({
      type: 'invalid',
      reason: 'same-tag',
    });
    expect(await tm.renameTagPrefix('#work', 'work')).toEqual({
      type: 'invalid',
      reason: 'same-tag',
    });
    expect(process).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('exact rename replaces every settings reference and deduplicates in stable order', async () => {
    const { tm, settings, save } = await makeManager();
    settings.pinnedTags.push('#work', '#keep', '#work', '#focus');
    settings.archivedTags.push('#work', '#focus', '#archive', '#work');
    settings.tagGroups.push({
      id: 'g1',
      name: 'Manual',
      mode: 'manual',
      tags: ['#work', '#other', '#work', '#focus'],
    });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({ type: 'ok', changedFiles: [] });
    expect(settings.pinnedTags).toEqual(['#focus', '#keep']);
    expect(settings.archivedTags).toEqual(['#focus', '#archive']);
    expect(settings.tagGroups[0]?.tags).toEqual(['#focus', '#other']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('prefix rename updates subtree settings references and the owning prefix selector', async () => {
    const { tm, settings } = await makeManager();
    settings.pinnedTags.push('#work', '#work/dev', '#workplace', '#focus/dev');
    settings.archivedTags.push('#work/ops', '#focus/ops');
    settings.tagGroups.push(
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      {
        id: 'manual',
        name: 'Manual',
        mode: 'manual',
        tags: ['#work', '#work/dev', '#workplace', '#focus/dev'],
      },
    );

    await tm.renameTagPrefix('work', 'focus');

    expect(settings.pinnedTags).toEqual(['#focus', '#focus/dev', '#workplace']);
    expect(settings.archivedTags).toEqual(['#focus/ops']);
    expect(settings.tagGroups[0]?.prefix).toBe('focus');
    expect(settings.tagGroups[1]?.tags).toEqual(['#focus', '#focus/dev', '#workplace']);
  });

  it('returns a settings failure and rolls back in-memory references when persistence rejects', async () => {
    const { tm, app, settings, save } = await makeManager({
      'tasks.md': '- [ ] #work\n',
    });
    settings.pinnedTags = ['#work'];
    settings.archivedTags = ['#work/dev'];
    settings.tagGroups = [
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      { id: 'manual', name: 'Manual', mode: 'manual', tags: ['#work', '#work/dev'] },
    ];
    save.mockRejectedValueOnce(new Error('settings storage unavailable'));

    const result = await tm.renameTagPrefix('#work', '#focus');

    expect(result).toEqual({
      type: 'settings-error',
      changedFiles: ['tasks.md'],
      failedFiles: [],
    });
    expect(await read(app, 'tasks.md')).toBe('- [ ] #focus\n');
    expect(settings.pinnedTags).toEqual(['#work']);
    expect(settings.archivedTags).toEqual(['#work/dev']);
    expect(settings.tagGroups).toEqual([
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      { id: 'manual', name: 'Manual', mode: 'manual', tags: ['#work', '#work/dev'] },
    ]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not let an older rejected rename save clobber newer successfully saved settings', async () => {
    const { tm, settings, save } = await makeManager();
    settings.pinnedTags = ['#work'];
    settings.tagGroups = [{ id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' }];
    let rejectFirst!: (error: Error) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    save
      .mockImplementationOnce(() => {
        markFirstStarted();
        return firstSave;
      })
      .mockResolvedValueOnce(undefined);

    const rename = tm.renameTagPrefix('#work', '#focus');
    await firstStarted;
    expectDefined(settings.tagGroups[0]).name = 'Newer name';
    await tm.pinTag('#later');
    rejectFirst(new Error('older save rejected'));

    await expect(rename).resolves.toEqual({
      type: 'settings-error',
      changedFiles: [],
      failedFiles: [],
    });
    expect(settings.pinnedTags).toEqual(['#focus', '#later']);
    expect(settings.tagGroups).toEqual([
      { id: 'prefix', name: 'Newer name', mode: 'prefix', prefix: 'focus' },
    ]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('prepares every changed file before performing sequential writes', async () => {
    const { tm, app } = await makeManager({
      'a.md': '- [ ] #work\n',
      'b.md': '- [ ] #work/dev\n',
    });
    const events: string[] = [];
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'cachedRead').mockImplementation(async (file) => {
      events.push(`read:${file.path}`);
      return cachedRead(file);
    });
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback) => {
      events.push(`write:${file.path}`);
      return process(file, callback);
    });

    await tm.renameTagPrefix('#work', '#focus');

    // The mock vault's process() performs its own internal read after each write begins.
    expect(events.slice(0, 3)).toEqual(['read:a.md', 'read:b.md', 'write:a.md']);
    expect(events.filter((event) => event.startsWith('write:'))).toEqual([
      'write:a.md',
      'write:b.md',
    ]);
  });

  it('applies a prepared rename to the latest content without losing unrelated edits', async () => {
    const { tm, app } = await makeManager({ 'a.md': '- [ ] #work\n' });
    vi.spyOn(app.vault, 'cachedRead').mockResolvedValue('- [ ] #work\n');
    let written = '';
    vi.spyOn(app.vault, 'process').mockImplementation(async (_file, callback) => {
      written = callback('unrelated edit\n- [ ] #work\n');
      return written;
    });

    await tm.renameTagExact('#work', '#focus');

    expect(written).toBe('unrelated edit\n- [ ] #focus\n');
  });

  it('serializes concurrent rename requests for the same vault', async () => {
    const { tm, app } = await makeManager({ 'a.md': '#one #two\n' });
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let readCount = 0;
    vi.spyOn(app.vault, 'cachedRead').mockImplementation(async (file) => {
      readCount++;
      if (readCount === 1) await firstRead;
      return cachedRead(file);
    });

    const first = tm.renameTagExact('#one', '#first');
    const second = tm.renameTagExact('#two', '#second');
    await Promise.resolve();
    await Promise.resolve();

    expect(readCount).toBe(1);
    releaseFirst();
    await expect(first).resolves.toEqual({ type: 'ok', changedFiles: ['a.md'] });
    await expect(second).resolves.toEqual({ type: 'ok', changedFiles: ['a.md'] });
    expect(await read(app, 'a.md')).toBe('#first #second\n');
  });

  it('releases the rename queue after an unexpected operation error', async () => {
    const { tm, app } = await makeManager({ 'a.md': '#two\n' });
    const getMarkdownFiles = app.vault.getMarkdownFiles.bind(app.vault);
    vi.spyOn(app.vault, 'getMarkdownFiles')
      .mockImplementationOnce(() => {
        throw new Error('vault unavailable');
      })
      .mockImplementation(() => getMarkdownFiles());

    const first = tm.renameTagExact('#one', '#first');
    const second = tm.renameTagExact('#two', '#second');

    await expect(first).rejects.toThrow('vault unavailable');
    await expect(second).resolves.toEqual({ type: 'ok', changedFiles: ['a.md'] });
    expect(await read(app, 'a.md')).toBe('#second\n');
  });

  it('returns partial and continues sequentially when a later file write fails', async () => {
    const { tm, app } = await makeManager({
      'a.md': '- [ ] #work\n',
      'b.md': '- [ ] #work\n',
      'c.md': '- [ ] #work\n',
    });
    const writes: string[] = [];
    const process = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback) => {
      writes.push(file.path);
      if (file.path === 'b.md') throw new Error('disk full');
      return process(file, callback);
    });

    const result = await tm.renameTagExact('#work', '#focus');

    expect(result).toEqual({
      type: 'partial',
      changedFiles: ['a.md', 'c.md'],
      failedFiles: ['b.md'],
    });
    expect(writes).toEqual(['a.md', 'b.md', 'c.md']);
    expect(await read(app, 'a.md')).toBe('- [ ] #focus\n');
    expect(await read(app, 'b.md')).toBe('- [ ] #work\n');
    expect(await read(app, 'c.md')).toBe('- [ ] #focus\n');
  });
});
