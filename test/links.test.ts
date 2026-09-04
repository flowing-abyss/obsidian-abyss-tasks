import { describe, expect, it } from 'vitest';
import {
  buildLinkRaw,
  countLinksIn,
  pairAnchorsToTokens,
  parseLinks,
  type LinkToken,
} from '../src/markdown/links';
import { expectDefined } from './helpers';

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
    const median = (values: readonly number[]): number => {
      const ordered = [...values].sort((left, right) => left - right);
      return expectDefined(ordered[Math.floor(ordered.length / 2)]);
    };
    const small = denseSource(1_500);
    const large = denseSource(6_000);
    parseLinks(small);
    parseLinks(large);
    const batchDuration = (source: string): number => {
      const startedAt = performance.now();
      for (let iteration = 0; iteration < 20; iteration++) parseLinks(source);
      return performance.now() - startedAt;
    };
    const ratios = Array.from({ length: 7 }, (_, round) => {
      let smallMs: number;
      let largeMs: number;
      if (round % 2 === 0) {
        smallMs = batchDuration(small);
        largeMs = batchDuration(large);
      } else {
        largeMs = batchDuration(large);
        smallMs = batchDuration(small);
      }
      return largeMs / smallMs;
    });

    // A four-times larger dense source should remain far below the ~16x
    // signature of quadratic work. The median paired ratio resists isolated
    // JIT, GC, and full-suite scheduling outliers.
    expect(median(ratios)).toBeLessThan(9);
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
});
