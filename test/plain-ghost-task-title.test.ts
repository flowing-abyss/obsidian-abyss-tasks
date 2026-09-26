import { describe, expect, it } from 'vitest';
import { plainGhostTaskTitle } from '../src/ui/plainGhostTaskTitle';
import { medianInterleavedRatio, task } from './helpers';

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

describe('plainGhostTaskTitle', () => {
  it.each([
    ['keeps an escaped strong opener as text', '\\**a**', '**a**'],
    ['keeps an escaped underscore opener as text', '\\__a__', '__a__'],
    ['keeps an escaped strike opener as text', '\\~~a~~', '~~a~~'],
    ['keeps an escaped code opener as text', '\\`a`', '`a`'],
    ['does not close a strong pair on an escaped delimiter', '**a\\** b**', 'a** b'],
    [
      'keeps an escaped strong opener and does not close a code pair on an escaped delimiter',
      'a \\**b** **c** `d\\` e`',
      'a **b c** d` e',
    ],
    ['keeps an escaped emphasis opener as text', '\\*a*', '*a*'],
    ['does not close an emphasis pair on an escaped delimiter', '*a\\* b*', '*a* b*'],
    [
      'strips emphasis pairs over repeated passes and keeps escaped delimiters',
      '\\*a* *b\\* c* _d_ **e*',
      '*a b* c d e',
    ],
    ['unescapes a title without pair delimiters', 'a \\\\ b', 'a \\ b'],
    ['strips an underscore pair', '_a_', 'a'],
    ['strips a strike pair', '~~a~~', 'a'],
    ['strips a code pair', '`a`', 'a'],
    ['strips the shortest strong content first', '****a**', 'a**'],
    [
      'keeps a strong pair around a line separator',
      `**${LINE_SEPARATOR}**`,
      `**${LINE_SEPARATOR}**`,
    ],
    [
      'keeps a strong pair around a paragraph separator',
      `**${PARAGRAPH_SEPARATOR}**`,
      `**${PARAGRAPH_SEPARATOR}**`,
    ],
    ['keeps one escaped delimiter at a time', '\\*****', '*'],
    ['does not open emphasis right after an underscore', '_*a*', '_*a*'],
    ['does not open an underscore pair right after an underscore', '__a_', '__a_'],
  ])('%s', (_case, title, expected) => {
    expect(plainGhostTaskTitle(task({ title }))).toBe(expected);
  });

  it.each([
    ['escaped strong openers', '\\** '],
    ['escaped code openers', '\\` '],
  ])('stays linear on many %s', (_case, unit) => {
    const small = task({ title: unit.repeat(1_000) });
    const large = task({ title: unit.repeat(4_000) });

    // Four times the openers cost about 4x; a rescan from every escaped opener costs 16x. The
    // threshold is their geometric mean, and interleaved pairs keep a CPU speed change to the
    // pair it splits.
    expect(
      medianInterleavedRatio({
        small: () => plainGhostTaskTitle(small),
        large: () => plainGhostTaskTitle(large),
      }),
    ).toBeLessThan(8);
  });
});
