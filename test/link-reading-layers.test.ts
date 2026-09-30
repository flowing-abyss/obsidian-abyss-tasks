import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { inlineCodeRanges as markdownInlineCodeRanges } from '../src/markdown/inlineCode';
import { parseLinks } from '../src/markdown/links';
import {
  inlineCodeRanges as domainInlineCodeRanges,
  parseLinkRanges,
} from '../src/tasks/domain/taskLineAtomicRanges';
import { seededRandom } from './support/seededRandom';

// Links are read in two layers, because neither may import the other: the shared Markdown helper
// returns link tokens, and the task domain keeps links, embeds, and images as ranges that no task
// field may start inside. This suite holds the two readings equal. It checks that the domain's
// copied text is the same, and it compares both readings on texts built from link syntax, because
// short text cannot hold a Markdown link, an embed, or an image, and random text rarely holds any.
const SEED = 20_260_926;
const ALPHABET = ['\\', '[', ']', '(', ')', '|', '!', 'a', ' ', '`'];
const SKELETONS = [
  '[[a]]',
  '![[a]]',
  '[a](b)',
  '![a](b)',
  '[[a]b]]',
  '[[a\r]]',
  '[[a\n]]',
  '[a](b\n)',
  '[a\\](b)',
  '[a](b\\))',
  '[[a[[b]]',
  '[a]([[b)[c](d)]]',
  '[[a[b](c]][[d]])',
  '`a`',
  '``a``',
];
const FRAGMENTS = [
  '[[a]]',
  '[[a|b]]',
  '![[',
  '[[',
  ']]',
  '[a](b)',
  '![a](',
  '![a]',
  '](',
  '[',
  ']',
  '(',
  ')',
  '\\',
  '`',
  ' ',
  'a',
  '|',
  '!',
  '\r',
  '\n',
];
// Escape-heavy fragments: backslash runs before every closer, escaped openers,
// LaTeX-like commands, table pipes, and line terminators.
const ESCAPE_FRAGMENTS = [
  '\\',
  '\\\\',
  '\\\\\\',
  '\\]',
  '\\\\]',
  '\\\\\\]',
  '\\[',
  '\\\\[',
  '\\)',
  '\\\\)',
  '\\\\\\)',
  '\\|',
  '\\\\|',
  '\\(',
  '\\a',
  '\\alpha',
  '\\n',
  '\\\n',
  '\\\r',
  '\\ ',
  `\\${String.fromCodePoint(0x1f600)}`,
  '[[',
  ']]',
  '[',
  ']',
  '](',
  '(',
  ')',
  '|',
  '!',
  '![',
  '![[',
  'a',
  'b',
  ' ',
  '\t',
  '\r\n',
  '`',
  '[[Note]]',
  '[[a|b]]',
  '[t](u)',
  '[[Note\\|Alias]]',
  '$[0, 1)$',
  '\\{',
  '#tag',
  '📅 2026-09-26',
];
const BACKTICK_PARTS = ['`', '``', '```', 'a', '\\', ' '];

function* exhaustive(alphabet: readonly string[], length: number, prefix = ''): Generator<string> {
  yield prefix;
  if (length === 0) return;
  for (const part of alphabet) yield* exhaustive(alphabet, length - 1, prefix + part);
}

/** Each skeleton inside short contexts, and each pair side by side, nested, and after code. */
function skeletonTexts(): string[] {
  const before = [...exhaustive(['\\', '`', '!', '[', 'a'], 2)];
  const after = [...exhaustive([')', ']', '`', 'a'], 2)];
  const single = SKELETONS.flatMap((skeleton) =>
    before.flatMap((left) => after.map((right) => left + skeleton + right)),
  );
  const pairs = SKELETONS.flatMap((outer) =>
    SKELETONS.flatMap((inner) => {
      const cut = Math.max(1, outer.length - 2);
      return [
        outer + inner,
        outer.slice(0, cut) + inner + outer.slice(cut),
        `\`${outer}\`${inner}`,
      ];
    }),
  );
  return [...single, ...pairs];
}

/** 2,000 texts of 1 to `maxParts` seeded parts, the same on every run. */
function seededTexts(parts: readonly string[], maxParts: number): string[] {
  const next = seededRandom(SEED);
  return Array.from({ length: 2_000 }, () =>
    Array.from({ length: 1 + next(maxParts) }, () => parts[next(parts.length)] ?? '').join(''),
  );
}

const TEXTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['every short text', [...exhaustive(ALPHABET, 5)]],
  ['link-shaped text in context', skeletonTexts()],
  ['seeded fragment text', seededTexts(FRAGMENTS, 12)],
  ['seeded escape text', seededTexts(ESCAPE_FRAGMENTS, 18)],
];
const BACKTICK_RUNS = ['backtick runs', [...exhaustive(BACKTICK_PARTS, 5)]] as const;

const links = (text: string): string =>
  JSON.stringify(parseLinks(text).map(({ index, raw }) => [index, raw]));
const domainLinks = (text: string): string =>
  JSON.stringify(
    parseLinkRanges(text)
      .filter(({ raw }) => !raw.startsWith('!'))
      .map(({ index, raw }) => [index, raw]),
  );
const code = (text: string): string => JSON.stringify(markdownInlineCodeRanges(text));
const domainCode = (text: string): string => JSON.stringify(domainInlineCodeRanges(text));

function sourceText(path: string): string {
  return ts.sys.readFile(ts.sys.resolvePath(`${import.meta.dirname}/../${path}`)) ?? '';
}

function regexLiterals(path: string): string[] {
  const source = ts.createSourceFile(path, sourceText(path), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('link reading in both layers', () => {
  it('starts the task domain module with the text of the shared inline code scan', () => {
    const markdown = sourceText('src/markdown/inlineCode.ts');
    const domain = sourceText('src/tasks/domain/taskLineAtomicRanges.ts');

    expect(markdown).toContain('export function inlineCodeRanges(');
    expect(domain.slice(0, markdown.length)).toBe(markdown);
  });

  it('uses the shared link patterns in the task domain', () => {
    const domain = regexLiterals('src/tasks/domain/taskLineAtomicRanges.ts');

    expect(domain).toHaveLength(2);
    expect(regexLiterals('src/markdown/links.ts')).toEqual(expect.arrayContaining(domain));
  });

  it.each(TEXTS)('reads the same links on %s', (_set, texts) => {
    const found = texts.find((text) => links(text) !== domainLinks(text));

    expect(found, JSON.stringify(found)).toBeUndefined();
  });

  it.each([...TEXTS, BACKTICK_RUNS])('finds the same inline code on %s', (_set, texts) => {
    const found = texts.find((text) => code(text) !== domainCode(text));

    expect(found, JSON.stringify(found)).toBeUndefined();
  });
});
