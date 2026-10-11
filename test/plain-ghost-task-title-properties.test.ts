// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { plainGhostTaskTitle } from '../src/ui/plainGhostTaskTitle';
import { task } from './helpers';

const parameters = { seed: 20261011, numRuns: 300 };
const safeText = fc
  .array(fc.constantFrom('a', 'Z', 'я', '😀', 'é'), { minLength: 1, maxLength: 6 })
  .map((parts) => parts.join(''));
const delimiter = fc.constantFrom('**', '__', '~~', '`', '``', '```');

// These expectations come from the input grammar, never another stripping implementation.
describe('independent ghost-title grammar', () => {
  it('strips paired delimiters around known safe content', () => {
    fc.assert(
      fc.property(safeText, delimiter, (content, pair) => {
        expect(plainGhostTaskTitle(task({ title: pair + content + pair }))).toBe(content);
      }),
      parameters,
    );
  });

  it('strips nested strong, strike and code over repeated passes', () => {
    fc.assert(
      fc.property(
        safeText,
        fc.shuffledSubarray(['**', '~~', '``'], { minLength: 3, maxLength: 3 }),
        (content, pairs) => {
          const title = pairs.reduce((inner, pair) => pair + inner + pair, content);
          expect(plainGhostTaskTitle(task({ title }))).toBe(content);
        },
      ),
      parameters,
    );
  });

  it('removes decreasing-width nested code over the full fixed point', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (depth) => {
        let title = 'z';
        for (let width = 1; width <= depth; width++) {
          const ticks = '`'.repeat(width);
          title = `${ticks}a${title}b${ticks}`;
        }
        expect(plainGhostTaskTitle(task({ title }))).toBe(
          `${'a'.repeat(depth)}z${'b'.repeat(depth)}`,
        );
      }),
      parameters,
    );
  });

  it('retains escaped fragments beside independently stripped plain fragments', () => {
    fc.assert(
      fc.property(
        safeText,
        safeText,
        fc.constantFrom('*', '_', '~', '`'),
        (left, right, escaped) => {
          const title = `\\${escaped}${left} | **${right}**`;
          expect(plainGhostTaskTitle(task({ title }))).toBe(`${escaped}${left} | ${right}`);
        },
      ),
      parameters,
    );
  });

  it('retains the unmatched tick in odd runs including neighboring text', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), safeText, (width, suffix) => {
        expect(plainGhostTaskTitle(task({ title: '`'.repeat(width) + suffix }))).toBe(
          (width % 2 === 1 ? '`' : '') + suffix,
        );
      }),
      parameters,
    );
  });
});
