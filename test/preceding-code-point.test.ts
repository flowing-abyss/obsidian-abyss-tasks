import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  matchesUnlessPreceded as markdownMatchesUnlessPreceded,
  replaceUnlessPreceded,
} from '../src/markdown/precedingCodePoint';
import { matchesUnlessPreceded as domainMatchesUnlessPreceded } from '../src/tasks/domain/precedingCodePoint';

type Refusal = (previous: string) => boolean;
type MatchesUnlessPreceded = typeof markdownMatchesUnlessPreceded;

interface FoundMatch {
  readonly index: number;
  readonly text: string;
  readonly groups: ReadonlyArray<string | undefined>;
}

const MATH_BOLD_A = String.fromCodePoint(0x1d400);
const PARTY_POPPER = String.fromCodePoint(0x1f389);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);
const ALPHABET = [
  'a',
  'b',
  String.fromCodePoint(0xe9),
  '#',
  '!',
  '[',
  ']',
  '\\',
  '*',
  '_',
  ' ',
  MATH_BOLD_A,
  PARTY_POPPER,
  String.fromCodePoint(0x200d),
  String.fromCodePoint(0xfe0f),
  LONE_HIGH,
  LONE_LOW,
];
const PATTERNS: readonly RegExp[] = [/#[a-z]+/gu, /\[[^[\]]*\]/gu, /[*_][^*_]+[*_]/gu, /./gu];
const REFUSALS: ReadonlyArray<readonly [string, Refusal]> = [
  ['a hash mark', (previous) => previous === '#'],
  ['an exclamation mark', (previous) => previous === '!'],
  ['a letter', (previous) => /^\p{L}$/u.test(previous)],
  ['an astral code point', (previous) => (previous.codePointAt(0) ?? 0) > 0xffff],
  ['nothing', () => false],
];
const ORACLE_CASES = PATTERNS.flatMap((pattern) =>
  REFUSALS.map(([refusal, refuses]) => [String(pattern), refusal, pattern, refuses] as const),
);
const SEED = 20_260_926;
const isHashMark: Refusal = (previous) => previous === '#';
const refusesNothing: Refusal = () => false;
const bracket = (match: RegExpExecArray): string => `<${match[0]}>`;

/** Park and Miller's minimal standard generator, so every run checks the same texts. */
function seededTexts(count: number): string[] {
  let state = SEED;
  const next = (bound: number): number => {
    state = (state * 48_271) % 2_147_483_647;
    return state % bound;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: next(13) }, () => ALPHABET[next(ALPHABET.length)] ?? '').join(''),
  );
}

/**
 * Each call stands for one match, and every match moves the search forward, so a helper that
 * stops moving throws here instead of hanging the run.
 */
function bounded<Args extends readonly unknown[], Result>(
  text: string,
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  let calls = 0;
  return (...args) => {
    calls++;
    if (calls > text.length + 1) throw new Error('The search stopped moving forward.');
    return callback(...args);
  };
}

function found(match: RegExpExecArray): FoundMatch {
  return { index: match.index, text: match[0], groups: match.slice(1) };
}

/**
 * The matches of the lookbehind form, found without the helper: a sticky copy of the pattern is
 * tried at every code point start whose previous code point is not refused, and the search goes
 * on after each accepted match.
 */
function oracleMatches(pattern: RegExp, text: string, refuses: Refusal): FoundMatch[] {
  const sticky = new RegExp(pattern.source, 'uy');
  const matches: FoundMatch[] = [];
  let index = 0;
  let previous = '';
  let resumeAt = 0;
  for (const codePoint of [...text, '']) {
    sticky.lastIndex = index;
    const match = index >= resumeAt && !refuses(previous) ? sticky.exec(text) : null;
    if (match !== null) {
      matches.push(found(match));
      resumeAt = index + Math.max(match[0].length, 1);
    }
    index += codePoint.length;
    previous = codePoint;
  }
  return matches;
}

function oracleReplace(pattern: RegExp, text: string, refuses: Refusal): string {
  let output = '';
  let copiedTo = 0;
  for (const match of oracleMatches(pattern, text, refuses)) {
    output += `${text.slice(copiedTo, match.index)}<${match.text}>`;
    copiedTo = match.index + match.text.length;
  }
  return output + text.slice(copiedTo);
}

function helperMatches(
  matchesUnlessPreceded: MatchesUnlessPreceded,
  pattern: RegExp,
  text: string,
  refuses: Refusal,
): FoundMatch[] {
  const regex = new RegExp(pattern.source, 'gu');
  return matchesUnlessPreceded(regex, text, bounded(text, refuses)).map(found);
}

function sourceText(path: string): string {
  return ts.sys.readFile(ts.sys.resolvePath(`${import.meta.dirname}/../${path}`)) ?? '';
}

describe.each<readonly [string, MatchesUnlessPreceded]>([
  ['markdown', markdownMatchesUnlessPreceded],
  ['task domain', domainMatchesUnlessPreceded],
])('matchesUnlessPreceded in the %s copy', (_copy, matchesUnlessPreceded) => {
  it.each(ORACLE_CASES)(
    'finds the matches of the lookbehind form for %s refusing %s',
    (_pattern, _refusal, pattern, refuses) => {
      const texts = seededTexts(2_000);

      expect(
        texts.map((text) => helperMatches(matchesUnlessPreceded, pattern, text, refuses)),
      ).toEqual(texts.map((text) => oracleMatches(pattern, text, refuses)));
    },
  );

  it('skips a match right after a refused code point and keeps the others', () => {
    const isLetter: Refusal = (previous) => /^\p{L}$/u.test(previous);

    expect(helperMatches(matchesUnlessPreceded, /#[a-z]+/gu, '##a', isHashMark)).toEqual([]);
    expect(helperMatches(matchesUnlessPreceded, /#[a-z]+/gu, '#a#b', isLetter)).toEqual([
      { index: 0, text: '#a', groups: [] },
    ]);
  });

  it('retries a refused match from its next code point, not from its end', () => {
    const isBang: Refusal = (previous) => previous === '!';

    expect(helperMatches(matchesUnlessPreceded, /[a-z]+/gu, '!abc', isBang)).toEqual([
      { index: 2, text: 'bc', groups: [] },
    ]);
  });

  it('steps over a refused match that starts with a surrogate pair', () => {
    expect(
      helperMatches(
        matchesUnlessPreceded,
        /\p{Extended_Pictographic}/gu,
        `#${PARTY_POPPER}${PARTY_POPPER}`,
        isHashMark,
      ),
    ).toEqual([{ index: 3, text: PARTY_POPPER, groups: [] }]);
  });

  it('gives the refusal whole code points, lone surrogates, and an empty text start', () => {
    const seen: string[] = [];
    const record: Refusal = (previous) => {
      seen.push(previous);
      return false;
    };

    for (const text of [`${PARTY_POPPER}#x`, `a${LONE_LOW}#x`, `${LONE_HIGH}#x`, '#x']) {
      matchesUnlessPreceded(/#[a-z]+/gu, text, record);
    }

    expect(seen).toEqual([PARTY_POPPER, LONE_LOW, LONE_HIGH, '']);
  });

  it('steps past an empty match one code point at a time, as matchAll does', () => {
    const text = `a${PARTY_POPPER}b`;

    expect(helperMatches(matchesUnlessPreceded, /x*/gu, text, refusesNothing)).toEqual(
      [...text.matchAll(/x*/gu)].map(found),
    );
  });

  it('starts from the beginning whatever the regex last matched', () => {
    const pattern = /#[a-z]+/gu;
    pattern.lastIndex = 3;

    expect(matchesUnlessPreceded(pattern, '#a #b', refusesNothing).map(found)).toEqual([
      { index: 0, text: '#a', groups: [] },
      { index: 3, text: '#b', groups: [] },
    ]);
  });

  it.each([
    ['not global', /a/u],
    ['not unicode', /a/g],
    ['sticky and not global', /a/uy],
  ])('rejects a regex that is %s', (_flaw, pattern) => {
    expect(() => matchesUnlessPreceded(pattern, 'a', bounded('a', refusesNothing))).toThrow(
      TypeError,
    );
  });
});

describe('replaceUnlessPreceded', () => {
  it.each([
    [/#[a-z]+/gu, '#a b#c ##d'],
    [/x*/gu, 'abc'],
    [/x*/gu, `a${PARTY_POPPER}b`],
  ])('equals String.prototype.replace for %s on %j when nothing is refused', (pattern, text) => {
    expect(replaceUnlessPreceded(pattern, text, bounded(text, refusesNothing), bracket)).toBe(
      text.replace(new RegExp(pattern.source, 'gu'), (matched) => `<${matched}>`),
    );
  });

  it.each(PATTERNS.map((pattern) => [String(pattern), pattern] as const))(
    'replaces the matches of the lookbehind form for %s on seeded text',
    (_pattern, pattern) => {
      const texts = seededTexts(2_000);
      const refuses: Refusal = (previous) => previous === '#' || /^\p{L}$/u.test(previous);
      const replaced = (text: string): string =>
        replaceUnlessPreceded(
          new RegExp(pattern.source, 'gu'),
          text,
          bounded(text, refuses),
          bracket,
        );

      expect(texts.map(replaced)).toEqual(
        texts.map((text) => oracleReplace(pattern, text, refuses)),
      );
    },
  );

  it('keeps a refused match and replaces the others', () => {
    expect(replaceUnlessPreceded(/#[a-z]+/gu, '##a #b', isHashMark, bracket)).toBe('##a <#b>');
  });

  it('inserts the replacement literally', () => {
    expect(replaceUnlessPreceded(/b/gu, 'abc', refusesNothing, () => '$&$1')).toBe('a$&$1c');
  });
});

describe('precedingCodePoint copies', () => {
  it('keeps the task domain copy identical to the start of the markdown module', () => {
    const markdown = sourceText('src/markdown/precedingCodePoint.ts');
    const domain = sourceText('src/tasks/domain/precedingCodePoint.ts');

    expect(domain).toContain('export function matchesUnlessPreceded(');
    expect(markdown.slice(0, domain.length)).toBe(domain);
    expect(markdown.slice(domain.length)).toContain('export function replaceUnlessPreceded(');
  });
});
