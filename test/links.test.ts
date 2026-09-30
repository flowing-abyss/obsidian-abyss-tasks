// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildLinkRaw,
  countLinksIn,
  linkValueLabel,
  pairAnchorsToTokens,
  parseLinks,
  type LinkToken,
} from '../src/markdown/links';
import { expectDefined, interleavedRatio } from './helpers';

function insecureUrl(host: string): string {
  return ['http:', '', host].join('/');
}

describe('countLinksIn', () => {
  it('sums wiki + markdown links across all given texts, skipping undefined', () => {
    const count = countLinksIn([
      `title [[Note]] and [ext](${insecureUrl('x')})`, // 2
      undefined,
      'desc [[Other]]', // 1
      'a comment with no links', // 0
      '![[embed.png]] is not a link', // 0 (embeds excluded)
    ]);
    expect(count).toBe(3);
  });
  it('is 0 for empty input', () => {
    expect(countLinksIn([])).toBe(0);
    expect(countLinksIn([undefined, ''])).toBe(0);
  });

  it('counts each outer link once when wiki and Markdown candidates overlap', () => {
    expect(countLinksIn(['[x]([[Doc]])', String.raw`[[Doc|\[x\](u)]]`])).toBe(2);
  });
});

describe('parseLinks', () => {
  it('returns wiki, alias and markdown links in document order', () => {
    const s = 'a [[Note]] b [[Path/Doc|alias]] c [text](https://x.io) d';
    const toks = parseLinks(s);
    expect(toks.map((t) => t.type)).toEqual(['wiki', 'wiki', 'md']);
    expect(toks[0]).toMatchObject({ target: 'Note', display: 'Note' });
    expect(toks[1]).toMatchObject({ target: 'Path/Doc', display: 'alias' });
    expect(toks[2]).toMatchObject({ target: 'https://x.io', display: 'text' });
    expect(expectDefined(toks[0]).index).toBeLessThan(expectDefined(toks[2]).index);
  });

  it('returns [] when there are no links', () => {
    expect(parseLinks('plain text')).toEqual([]);
  });

  it('does not tokenize an image as a markdown link', () => {
    expect(parseLinks('![alt](a.png)')).toEqual([]);
  });

  it('does not tokenize an embed as a wiki link', () => {
    expect(parseLinks('![[Embed]]')).toEqual([]);
  });

  it('tokenizes only the real link when an image precedes it', () => {
    const toks = parseLinks(`text ![i](x.png) and [real](${insecureUrl('y')})`);
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ type: 'md', target: insecureUrl('y'), display: 'real' });
  });

  it('ignores escaped link lookalikes while retaining headings, block refs, and aliases', () => {
    const toks = parseLinks(
      String.raw`\[[escaped]] \[escaped](https://x) [[Doc#Heading|same]] [[Doc^block|same]]`,
    );
    expect(toks).toHaveLength(2);
    expect(toks[0]).toMatchObject({ target: 'Doc#Heading', display: 'same' });
    expect(toks[1]).toMatchObject({ target: 'Doc^block', display: 'same' });
  });

  it('keeps escaped closing delimiters inside Markdown link labels and destinations', () => {
    expect(parseLinks(String.raw`[la\]bel](https://example.test/a\)b)`)).toEqual([
      {
        raw: String.raw`[la\]bel](https://example.test/a\)b)`,
        type: 'md',
        target: String.raw`https://example.test/a\)b`,
        display: String.raw`la\]bel`,
        index: 0,
      },
    ]);
  });

  it.each([
    ['`[[Same]]` [[Same]]', '[[Same]]'],
    ['`[Same](Same)` [Same](Same)', '[Same](Same)'],
    ['``inside `[[Same]]` code`` [[Same]]', '[[Same]]'],
    ['`[[Same]] \\` [[Same]]', '[[Same]]'],
  ])('ignores links inside closed inline code in %j', (source, realRaw) => {
    expect(parseLinks(source)).toEqual([
      expect.objectContaining({ raw: realRaw, index: source.lastIndexOf(realRaw) }),
    ]);
  });

  it.each([
    ['\\`[[First]]` [[Second]]', ['[[First]]', '[[Second]]']],
    ['`[[First]] [[Second]]', ['[[First]]', '[[Second]]']],
  ])('does not hide links behind an escaped or unmatched code opener in %j', (source, raw) => {
    expect(parseLinks(source).map((token) => token.raw)).toEqual(raw);
  });

  it.each([
    ['[before `code` after](https://example.test)', 'md'],
    ['[[Doc|before `code` after]]', 'wiki'],
  ] as const)('keeps a %s link whose label contains inline code', (source, type) => {
    expect(parseLinks(source)).toEqual([expect.objectContaining({ raw: source, type, index: 0 })]);
  });

  it.each([
    ['Markdown link around a wiki-like destination', '[x]([[Doc]])', 'md'],
    ['wiki alias around escaped Markdown-like bytes', String.raw`[[Doc|\[x\](u)]]`, 'wiki'],
  ] as const)('keeps only the outer %s candidate', (_case, source, type) => {
    expect(parseLinks(source)).toEqual([expect.objectContaining({ raw: source, type, index: 0 })]);
  });

  it('retains touching and separated non-overlapping links in source order', () => {
    const source = '[[A]][b](c) gap [d](e)[[F]]';

    expect(parseLinks(source).map(({ raw, index }) => ({ raw, index }))).toEqual([
      { raw: '[[A]]', index: 0 },
      { raw: '[b](c)', index: 5 },
      { raw: '[d](e)', index: 16 },
      { raw: '[[F]]', index: 22 },
    ]);
  });

  it('keeps dense mixed link candidates ordered while excluding closed inline code', () => {
    const segmentCount = 2_048;
    const segments = Array.from(
      { length: segmentCount },
      (_, index) =>
        ` \`[[hidden-${index}]] [hidden-${index}](hidden-${index})\`` +
        ` [[wiki-${index}]] [md-${index}](target-${index})`,
    );
    const tokens = parseLinks(segments.join(''));

    expect(tokens).toHaveLength(segmentCount * 2);
    expect(tokens[0]).toMatchObject({ raw: '[[wiki-0]]', type: 'wiki' });
    expect(tokens[1]).toMatchObject({ raw: '[md-0](target-0)', type: 'md' });
    expect(tokens[tokens.length - 2]).toMatchObject({ raw: '[[wiki-2047]]', type: 'wiki' });
    expect(tokens[tokens.length - 1]).toMatchObject({
      raw: '[md-2047](target-2047)',
      type: 'md',
    });
    for (let index = 1; index < tokens.length; index++) {
      expect(expectDefined(tokens[index]).index).toBeGreaterThan(
        expectDefined(tokens[index - 1]).index,
      );
    }
  });

  it('avoids quadratic growth for dense code/link candidates', () => {
    const denseSource = (count: number): string =>
      Array.from(
        { length: count },
        (_, index) =>
          ` \`[[hidden-${index}]] [hidden-${index}](hidden-${index})\`` +
          ` [[wiki-${index}]] [md-${index}](target-${index})`,
      ).join('');
    const small = denseSource(1_500);
    const large = denseSource(6_000);

    // Four times the candidates cost about 4x; quadratic work costs 16x. The threshold is their
    // geometric mean, and interleaved pairs keep a CPU speed change to the pair it splits.
    expect(
      interleavedRatio({ small: () => parseLinks(small), large: () => parseLinks(large) }),
    ).toBeLessThan(8);
  });
});

describe('linkValueLabel', () => {
  it.each([
    ['[[a|b]]', 'b'],
    ['[[Folder/a.md]]', 'a'],
    ['[x](y)', 'x'],
    ['plain text', 'plain text'],
    ['a [[b]]', 'a [[b]]'],
    // Obsidian reads an empty alias, and a label falls back to the note name.
    ['[[a|]]', 'a'],
    ['[[Folder/a.md|]]', 'a'],
    // With no name to show, or only spaces, the label is the link as written.
    [String.raw`[[\]]`, String.raw`[[\]]`],
    [String.raw`[[\|]]`, String.raw`[[\|]]`],
    ['[ ](b)', '[ ](b)'],
    ['[[a/ .md]]', '[[a/ .md]]'],
  ])('labels %s as %s', (value, label) => {
    expect(linkValueLabel(value)).toBe(label);
  });
});

describe('buildLinkRaw', () => {
  it('omits the alias when display equals target basename', () => {
    expect(buildLinkRaw('wiki', 'Note', 'Note')).toBe('[[Note]]');
    expect(buildLinkRaw('wiki', 'Path/Note', 'alias')).toBe('[[Path/Note|alias]]');
    expect(buildLinkRaw('md', 'https://x.io', 'text')).toBe('[text](https://x.io)');
  });
});

function mkWiki(target: string, display: string): LinkToken {
  return { raw: `[[${target}]]`, type: 'wiki', target, display, index: 0 };
}

function mkMd(target: string, display: string): LinkToken {
  return { raw: `[${display}](${target})`, type: 'md', target, display, index: 0 };
}

describe('pairAnchorsToTokens', () => {
  it('pairs two anchors to two tokens in order', () => {
    const tokens = [mkWiki('A', 'A'), mkWiki('B', 'B')];
    const anchors = [
      { text: 'A', href: 'A' },
      { text: 'B', href: 'B' },
    ];
    expect(pairAnchorsToTokens(anchors, tokens)).toEqual([0, 1]);
  });

  it('skips a code-span token that has no matching anchor', () => {
    const tokens = [mkWiki('NotALink', 'NotALink'), mkWiki('Real', 'Real')];
    const anchors = [{ text: 'Real', href: 'Real' }];
    expect(pairAnchorsToTokens(anchors, tokens)).toEqual([1]);
  });

  it('does not let a bare-URL anchor consume the real link token', () => {
    const tokens = [mkMd(insecureUrl('y'), 'real')];
    const anchors = [
      { text: 'https://bare', href: 'https://bare' },
      { text: 'real', href: insecureUrl('y') },
    ];
    expect(pairAnchorsToTokens(anchors, tokens)).toEqual([-1, 0]);
  });

  it('pairs duplicate display text anchors to distinct token occurrences', () => {
    const tokens = [mkMd('x', 'a'), mkMd('y', 'a')];
    const anchors = [
      { text: 'a', href: 'x' },
      { text: 'a', href: 'y' },
    ];
    expect(pairAnchorsToTokens(anchors, tokens)).toEqual([0, 1]);
  });

  it('matches a wiki alias anchor by href against the token target', () => {
    const tokens = [mkWiki('Sources', 'secondary sources')];
    const anchors = [{ text: 'secondary sources', href: 'Sources' }];
    expect(pairAnchorsToTokens(anchors, tokens)).toEqual([0]);
  });

  it('matches a wiki anchor whose href leaves out the folder and extension', () => {
    const tokens = [mkWiki('Folder/Note.md', 'Alias')];
    const anchors = [{ text: 'Note', href: 'Note' }];
    expect(pairAnchorsToTokens(anchors, tokens)).toEqual([0]);
  });
});

describe('image and embed openers', () => {
  it('skips a wiki embed and keeps the link after it', () => {
    expect(parseLinks('![[img.png]] [[Note|Alias]]')).toEqual([
      { raw: '[[Note|Alias]]', type: 'wiki', target: 'Note', display: 'Alias', index: 13 },
    ]);
  });

  it('skips a Markdown image and keeps the link after it', () => {
    expect(parseLinks('![alt](a.png) [site](https://x.y)')).toEqual([
      { raw: '[site](https://x.y)', type: 'md', target: 'https://x.y', display: 'site', index: 14 },
    ]);
  });

  it('skips only the image opener before a Markdown link', () => {
    expect(parseLinks('![[a](b)')).toEqual([
      { raw: '[a](b)', type: 'md', target: 'b', display: 'a', index: 2 },
    ]);
  });

  it('counts links but not embeds or images', () => {
    expect(countLinksIn(['![[a]] [[b]] ![c](d) [e](f)'])).toBe(2);
  });

  it('stays linear on many unclosed images', () => {
    const small = '![a](b '.repeat(1_000);
    const large = '![a](b '.repeat(4_000);

    // Four times the openers cost about 4x; a scan from every image opener costs 16x. The
    // threshold is their geometric mean, and interleaved pairs keep a CPU speed change to the
    // pair it splits.
    expect(
      interleavedRatio({ small: () => parseLinks(small), large: () => parseLinks(large) }),
    ).toBeLessThan(8);
  });
});

function wikiToken(raw: string, target: string, display: string, index = 0): LinkToken {
  return { raw, type: 'wiki', target, display, index };
}

function markdownToken(raw: string, target: string, display: string, index = 0): LinkToken {
  return { raw, type: 'md', target, display, index };
}

const BACKSLASH = '\\';
const LATEX_ALPHA = String.raw`\alpha`;
const LATEX_BRACKETS = String.raw`\[x\] `;
const escapes = (count: number, escaped: string): string => (BACKSLASH + escaped).repeat(count);
const latexCommands = (count: number): string =>
  Array.from({ length: count }, () => LATEX_ALPHA).join(' + ');

describe('parseLinks reads wiki links as Obsidian does', () => {
  // Obsidian 1.13.7 metadataCache readings from the SP1m probes (W: probe 1, V: probe 2, P3:
  // probe 3). A wiki link runs to the first `]]` after non-empty content and holds no `[[` or line
  // break. The display is the alias, or the target's basename when there is no alias. Each comment
  // names the wrong reading the row catches.
  it.each([
    // W1: today an escaped `|` does not split (target and display `a\|b`).
    [String.raw`[[a\|b]]`, [wikiToken(String.raw`[[a\|b]]`, 'a', 'b')]],
    // W2: today the target keeps its trailing backslash (`a\\`).
    [String.raw`[[a\\|b]]`, [wikiToken(String.raw`[[a\\|b]]`, 'a\\', 'b')]],
    // W3: today the second `|` splits (target `a\|`, display `b`).
    [String.raw`[[a\||b]]`, [wikiToken(String.raw`[[a\||b]]`, 'a', '|b')]],
    // W4: today the target is `a\`; CommonMark escapes find no link.
    [String.raw`[[a\]]`, [wikiToken(String.raw`[[a\]]`, 'a', 'a')]],
    // W5: CommonMark escapes find no link; dropping the backslash from the alias gives `b`.
    [String.raw`[[a|b\]]`, [wikiToken(String.raw`[[a|b\]]`, 'a', 'b\\')]],
    // W6: today an empty alias does not split (target `a\\|`).
    [String.raw`[[a\\|]]`, [wikiToken(String.raw`[[a\\|]]`, 'a\\', '')]],
    // W7: CommonMark escapes stop at the single `[` and find no link.
    [
      String.raw`[[a\\[b]]`,
      [wikiToken(String.raw`[[a\\[b]]`, String.raw`a\\[b`, String.raw`a\\[b`)],
    ],
    // W8: treating any backslash before `[[` as an escape finds no link.
    [String.raw`\\[[x]]`, [wikiToken('[[x]]', 'x', 'x', 2)]],
    // W9: not passing over the escaped `[` finds `[[x]]` at 1.
    [String.raw`\[[x]]`, []],
    // W10, W11: unescaping the content gives `x]y` and `a[b`.
    [String.raw`[[x\]y]]`, [wikiToken(String.raw`[[x\]y]]`, String.raw`x\]y`, String.raw`x\]y`)]],
    [String.raw`[[a\[b]]`, [wikiToken(String.raw`[[a\[b]]`, String.raw`a\[b`, String.raw`a\[b`)]],
    // W12, V4: splitting at the last `|` gives the display `c`.
    [String.raw`[[a|b\|c]]`, [wikiToken(String.raw`[[a|b\|c]]`, 'a', String.raw`b\|c`)]],
    ['[[a|b|c]]', [wikiToken('[[a|b|c]]', 'a', 'b|c')]],
    // V1, V2: today a single `]` or `[` stops the scan and finds no link.
    ['[[a]b]]', [wikiToken('[[a]b]]', 'a]b', 'a]b')]],
    ['[[a[b]]', [wikiToken('[[a[b]]', 'a[b', 'a[b')]],
    // V3: letting the content hold `[[` reads `[[a [[b]]`.
    ['[[a [[b]] c]]', [wikiToken('[[b]]', 'b', 'b', 4)]],
    // V5: allowing empty content reads a link to nothing.
    ['[[]]', []],
    // V6: today nothing before the first `|` finds no link; splitting there gives target ``.
    ['[[|b]]', [wikiToken('[[|b]]', '|b', '|b')]],
    // V7: today an empty alias finds no link.
    ['[[a|]]', [wikiToken('[[a|]]', 'a', '')]],
    // V8: dropping every backslash gives `ab`.
    [String.raw`[[a\b]]`, [wikiToken(String.raw`[[a\b]]`, String.raw`a\b`, String.raw`a\b`)]],
    // V9: today an escaped `|` does not split (target `a\\\|b`).
    [String.raw`[[a\\\|b]]`, [wikiToken(String.raw`[[a\\\|b]]`, String.raw`a\\`, 'b')]],
    // V10: today the target keeps its trailing backslash (`a\\`).
    [String.raw`[[a\\]]`, [wikiToken(String.raw`[[a\\]]`, 'a\\', 'a\\')]],
    // V11: dropping every trailing backslash gives `a`; CommonMark escapes find no link.
    [String.raw`[[a\\\]]`, [wikiToken(String.raw`[[a\\\]]`, String.raw`a\\`, String.raw`a\\`)]],
    // V12, V38: a greedy scan runs to a later `]]`.
    ['[[a]]]', [wikiToken('[[a]]', 'a', 'a')]],
    ['[[a]]]]', [wikiToken('[[a]]', 'a', 'a')]],
    // V13, V39: today the link starts at the last `[[` (`[[a]]`).
    ['[[[a]]', [wikiToken('[[[a]]', '[a', '[a')]],
    ['[[[[a]]]]', [wikiToken('[[[a]]', '[a', '[a', 1)]],
    // V14: a greedy scan that may hold `[[` reads one link to `a]] [[b`.
    ['[[a]] [[b]]', [wikiToken('[[a]]', 'a', 'a'), wikiToken('[[b]]', 'b', 'b', 6)]],
    // V15, V40: a greedy scan runs to the last `]]` (display `b]]c`, `b]] `).
    ['[[a|b]]c]]', [wikiToken('[[a|b]]', 'a', 'b')]],
    ['[[a|b]] ]]', [wikiToken('[[a|b]]', 'a', 'b')]],
    // V16: today an escaped `|` does not split (target `a\|b\|c`).
    [String.raw`[[a\|b\|c]]`, [wikiToken(String.raw`[[a\|b\|c]]`, 'a', String.raw`b\|c`)]],
    // V17: cutting the heading gives the target `a`.
    ['[[a#h|b]]', [wikiToken('[[a#h|b]]', 'a#h', 'b')]],
    // V18: today an escaped `|` does not split (target `a\|`).
    [String.raw`[[a\|]]`, [wikiToken(String.raw`[[a\|]]`, 'a', '')]],
    // V19, P3: today nothing is trimmed (target ` a `, display ` a`).
    ['[[ a ]]', [wikiToken('[[ a ]]', 'a', 'a')]],
    [String.raw`[[\.| a]]`, [wikiToken(String.raw`[[\.| a]]`, String.raw`\.`, 'a')]],
    // V20: dropping the alias's trailing backslash too gives `b\`.
    [String.raw`[[a\\|b\\]]`, [wikiToken(String.raw`[[a\\|b\\]]`, 'a\\', String.raw`b\\`)]],
    // V21 to V23: today a single bracket in the alias finds no link.
    ['[[a|[b]]', [wikiToken('[[a|[b]]', 'a', '[b')]],
    ['[[a|b]c]]', [wikiToken('[[a|b]c]]', 'a', 'b]c')]],
    ['[[a|b[c]]', [wikiToken('[[a|b[c]]', 'a', 'b[c')]],
    // V24: dropping the backslash before testing for a blank target keeps `\|b` whole.
    [String.raw`[[\|b]]`, [wikiToken(String.raw`[[\|b]]`, '', 'b')]],
    // V25: today the target keeps its trailing backslash (`a\\\\`).
    [String.raw`[[a\\\\|b]]`, [wikiToken(String.raw`[[a\\\\|b]]`, 'a\\\\\\', 'b')]],
    // V26, V27: an escaped `]` does not close today, so the link runs on or is not found.
    [String.raw`[[a]\]]`, [wikiToken(String.raw`[[a]\]]`, 'a]', 'a]')]],
    [String.raw`[[a\]\]]]`, [wikiToken(String.raw`[[a\]\]]`, String.raw`a\]`, String.raw`a\]`)]],
    // V28: preferring the wiki link reads `[[a]]` at 4.
    ['[x]([[a]])', [markdownToken('[x]([[a]])', '[[a]]', 'x')]],
    // V29: reading the Markdown form first loses the wiki link.
    ['[[a]](b)', [wikiToken('[[a]]', 'a', 'a')]],
    // V30: letting inline code hide the first `]]` reads `[[a \`]]\` b]]`.
    ['[[a `]]` b]]', [wikiToken('[[a `]]', 'a `', 'a `')]],
    // V31, V33, V35: unescaping the alias gives `b ] c`, `b[c`, and `b|`.
    [String.raw`[[a|b \] c]]`, [wikiToken(String.raw`[[a|b \] c]]`, 'a', String.raw`b \] c`)]],
    [String.raw`[[a|b\[c]]`, [wikiToken(String.raw`[[a|b\[c]]`, 'a', String.raw`b\[c`)]],
    [String.raw`[[a|b\|]]`, [wikiToken(String.raw`[[a|b\|]]`, 'a', String.raw`b\|`)]],
    // V32: unescaping gives `a[`.
    [String.raw`[[a\[]]`, [wikiToken(String.raw`[[a\[]]`, String.raw`a\[`, String.raw`a\[`)]],
    // V34: today the second `|` splits (target `a\|b`, display `c`).
    [String.raw`[[a\|b|c]]`, [wikiToken(String.raw`[[a\|b|c]]`, 'a', 'b|c')]],
    // V36, V37: unescaping gives `a.md` and `a#h`.
    [String.raw`[[a\.md]]`, [wikiToken(String.raw`[[a\.md]]`, String.raw`a\.md`, 'a\\')]],
    [String.raw`[[a\#h]]`, [wikiToken(String.raw`[[a\#h]]`, String.raw`a\#h`, String.raw`a\#h`)]],
    // V41: today the link runs over the line break.
    ['[[a\nb]]', []],
    // P3: the content holds single brackets; today no link is read.
    ['[[[( ]()]]', [wikiToken('[[[( ]()]]', '[( ]()', '[( ]()')]],
    // P3: the first `]]` closes; today the link runs to `[[\]]]`.
    [String.raw`[[\]]]`, [wikiToken(String.raw`[[\]]`, '', '')]],
    // P3: the target is trimmed again after the backslash drop; without that it is `a `.
    [String.raw`[[a \| /]]`, [wikiToken(String.raw`[[a \| /]]`, 'a', '/')]],
    // P3: the target is trimmed before the drop; without that it is `a! `.
    ['[[a! |]]', [wikiToken('[[a! |]]', 'a!', '')]],
    // P3: the `|` is found after trimming; finding it before splits at 1 and empties the target.
    ['[[ |[]]', [wikiToken('[[ |[]]', '|[', '|[')]],
    // Unprobed: the content refuses a carriage return as well as a line feed; master reads a link.
    ['[[a\rb]]', []],
  ])('reads %j', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });
});

describe('parseLinks reads embeds as Obsidian does', () => {
  it.each([
    // W13: reading an embed as a link gives target `a`.
    [String.raw`![[a\|b]]`, []],
    // P3 `![[[)aa]]`: today skipping only `![` reads `[[a]]` at 2.
    ['![[[a]]', []],
    // P3 `[[![[b]]`: letting the content hold `[[` reads `[[![[b]]`.
    ['[[![[b]]', []],
    // P18: an escaped `!` opens no embed (probe 1 M7 for Markdown); today the `![` skip hides the
    // link.
    [String.raw`\![[a]]`, [wikiToken('[[a]]', 'a', 'a', 2)]],
    // P19: a backslash pair before `!` leaves the embed; skipping only `\!` reads `[[a]]` at 3.
    [String.raw`\\![[a]]`, []],
    // P20: an escaped `[` opens nothing; not passing over it reads `[[a]]` at 2.
    [String.raw`!\[[a]]`, []],
    // SP1k's hand-over: the code span ends where the link starts, so the link is read, and the
    // `![` inside the span opens nothing.
    ['`![`[[a]]', [wikiToken('[[a]]', 'a', 'a', 4)]],
  ])('reads %j', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });

  it('counts wiki links that single brackets and empty aliases no longer hide', () => {
    expect(countLinksIn(['[[a]b]] [[a|]] ![[c]] [[d\nd]]'])).toBe(2);
  });
});

describe('parseLinks reads Markdown links as Obsidian does', () => {
  // Probe 1 (M): Markdown links follow CommonMark backslash escapes.
  it.each([
    // M1: today an escaped `]` closes the text (text `a\`).
    [String.raw`[a\](b)`, []],
    // M2: today an escaped `)` closes the destination (target `b\`).
    [String.raw`[a](b\)`, []],
    // M4: ignoring the parity of a backslash run finds no link.
    [String.raw`[a\\](b)`, [markdownToken(String.raw`[a\\](b)`, 'b', String.raw`a\\`)]],
    // M5: today the escaped lookalike `\[x](...)` hides the link.
    [String.raw`\[x](a [y](b) c)`, [markdownToken('[y](b)', 'b', 'y', 7)]],
    // M6: today one link runs to the destination `y [z](w`.
    [String.raw`[x\](y [z](w)`, [markdownToken('[z](w)', 'w', 'z', 7)]],
    // M7, P21: today the `![` skip ignores the escaped `!`.
    [String.raw`\![a](b)`, [markdownToken('[a](b)', 'b', 'a', 2)]],
    // M9: today an escaped `)` closes the destination (target `u\\\`).
    [String.raw`[t](u\\\)`, []],
    // M10: today the text crosses an unescaped `]` (text `a\\]x`).
    [String.raw`[a\\]x](b)`, []],
    // Unprobed: a backslash pair escapes nothing after it; skipping only `\[` reads nothing.
    [String.raw`\\[a](b)`, [markdownToken('[a](b)', 'b', 'a', 2)]],
    // P22: a backslash pair before `!` leaves the image; skipping only `\!` reads `[a](b)` at 3.
    [String.raw`\\![a](b)`, []],
    // An image is never a link; reading its opener as a skip finds `[b](c)` in the destination.
    // SP1q: CommonMark needs balanced parentheses in the destination, so this is no image there
    // (the probe 4 P12 class).
    ['![a]([b](c)', []],
  ])('reads %j', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });

  // Obsidian reads these destinations differently (M3 and M8 hold a space; M11 and M12 decode to
  // `b c`). The plugin keeps its destination grammar until SP1q, so a change here must be
  // deliberate.
  it.each([
    [String.raw`[a](b\) c)`, [markdownToken(String.raw`[a](b\) c)`, String.raw`b\) c`, 'a')]],
    ['[a](b c)', [markdownToken('[a](b c)', 'b c', 'a')]],
    ['[a](<b c>)', [markdownToken('[a](<b c>)', '<b c>', 'a')]],
    ['[a](b%20c)', [markdownToken('[a](b%20c)', 'b%20c', 'a')]],
  ])('keeps the destination grammar of %j', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });

  // Obsidian reads a link with empty text, and CommonMark also one with an empty destination.
  // The plugin reads neither until SP1q, which owns the Markdown link grammar.
  it.each(['[](b)', '[a]()'])('reads no link in %j until SP1q', (source) => {
    expect(parseLinks(source)).toEqual([]);
  });
});

describe('parseLinks reads no link inside an embed or image', () => {
  // Obsidian 1.13.7 readings from probe 4.
  it.each([
    // P11: an image's destination holds no link; master reads `[t](u)` at 6.
    ['![a](x[t](u)y)', []],
    // P14: master reads `[[b]]` at 5.
    ['![a]([[b]])', []],
    // P15: an embed holds no link; master reads `[a](b)` at 5.
    ['![[x [a](b) y]]', []],
    // P16, P17: a link after an image, whose alt text can be empty. An image read as a link gives
    // P16 an extra token for `![a](b)`, and a Markdown scope that stops before the last `)` makes
    // both rows read no link.
    ['![a](b) [c](d)', [markdownToken('[c](d)', 'd', 'c', 8)]],
    ['![](a.png) [c](d)', [markdownToken('[c](d)', 'd', 'c', 11)]],
  ])('reads %j', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });

  it.each([
    // P12: Obsidian reads no image, because the destination's `(` is unbalanced, and so reads
    // `[t](u)` at 6.
    [String.raw`![\[]([t](u)`, []],
    // P13: Obsidian reads an image whose alt text holds brackets, and so no link.
    ['![a [b](c) d](e.png)', [markdownToken('[b](c)', 'c', 'b', 4)]],
  ])('reads %j as it is until SP1q', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });
});

describe('parseLinks keeps each match that does not start inside an earlier kept match', () => {
  // In each row the first link is kept, the match that starts inside it is dropped, and the
  // second link starts inside the dropped match but after the kept one, so it is kept.
  it.each([
    // Unprobed: skipping a match that starts inside the dropped wiki match loses `[c](d)`.
    [
      '[a]([[b) [c](d)]]',
      [markdownToken('[a]([[b)', '[[b', 'a'), markdownToken('[c](d)', 'd', 'c', 9)],
    ],
    // Unprobed: skipping a match that starts inside the dropped Markdown match loses `[[d]]`.
    [
      '[[a[b](c]] [[d]])',
      [wikiToken('[[a[b](c]]', 'a[b](c', 'a[b](c'), wikiToken('[[d]]', 'd', 'd', 11)],
    ],
  ])('reads %j', (source, expected) => {
    expect(parseLinks(source)).toEqual(expected);
  });
});

describe('pairAnchorsToTokens with Obsidian anchors', () => {
  // Anchor text and data-href as Obsidian renders each probe case; today none of them pairs.
  it.each([
    [String.raw`[[a\|b]]`, { text: 'b', href: 'a' }],
    [String.raw`[[a\||b]]`, { text: '|b', href: 'a' }],
    ['[[ a ]]', { text: 'a', href: 'a' }],
    ['[[[a]]', { text: '[a', href: '[a' }],
    [String.raw`\![a](b)`, { text: 'a', href: 'b' }],
  ])('pairs the anchor of %j to its token', (source, anchor) => {
    expect(pairAnchorsToTokens([anchor], parseLinks(source))).toEqual([0]);
  });
});

describe('parseLinks growth', () => {
  it.each([
    ['wiki target', (count: number) => `[[${escapes(count, 'a')}`],
    ['wiki alias', (count: number) => `[[a|${escapes(count, 'a')}`],
    ['Markdown text', (count: number) => `[${escapes(count, 'a')}`],
    ['Markdown destination', (count: number) => `[a](${escapes(count, 'a')}`],
    ['wiki pipe', (count: number) => `[[a${escapes(count, '|b')}`],
    ['Markdown closer', (count: number) => `[a${escapes(count, '](b')}`],
    ['interval', (count: number) => `Prove it on $[0, 1)$ with ${latexCommands(count)}`],
  ] as const)('keeps escapes after an unclosed %s linear', (_case, source) => {
    // Each further escape doubled the old work, so a regression fails within a few seconds.
    const small = source(6);
    const large = source(14);

    expect(
      interleavedRatio({
        small: () => countLinksIn([small]),
        large: () => countLinksIn([large]),
      }),
    ).toBeLessThan(8);
  });

  it.each([
    ['unclosed Markdown links', (count: number) => '[a](b '.repeat(count)],
    [
      'unclosed links before an escaped parenthesis',
      (count: number) => `${'[a](b '.repeat(count)}${BACKSLASH})`,
    ],
    // The closing parenthesis keeps the escaped openers inside the searched text.
    ['escaped openers', (count: number) => `[${escapes(count, '[')})`],
    ['LaTeX brackets', (count: number) => `[${LATEX_BRACKETS.repeat(count)})`],
    // A wiki scan stops at the next `[[` and at a line break, so each start scans a short way.
    ['unclosed wiki links', (count: number) => '[[a'.repeat(count)],
    ['unclosed embeds', (count: number) => '![['.repeat(count)],
    ['unclosed wiki links on separate lines', (count: number) => '[[a]\n'.repeat(count)],
    ['escaped brackets in a wiki link', (count: number) => `[[${escapes(count, '[')}`],
    // Guards against a future rescan from the opener at each `]`; today's pattern scans once.
    ['single closers in a wiki link', (count: number) => `[[${'a]'.repeat(count)}]`],
    // Probe 4 P15: every link inside an embed is found and then dropped.
    ['embeds that hold a link', (count: number) => '![[x [a](b) y]] '.repeat(count)],
  ] as const)('avoids quadratic growth for repeated %s', (_case, source) => {
    const small = source(500);
    const large = source(2_000);

    // Four times the text costs about 4x; quadratic work costs 16x.
    expect(
      interleavedRatio({ small: () => parseLinks(small), large: () => parseLinks(large) }),
    ).toBeLessThan(8);
  });
});
