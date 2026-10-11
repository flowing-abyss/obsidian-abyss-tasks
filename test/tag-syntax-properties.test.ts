// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeTag, sameTag, tagComparisonKey } from '../src/markdown/tagSyntax';
import { validTagArbitrary, validTagChunks } from './support/taskSyntaxArbitraries';

const parameters = { seed: 20261011, numRuns: 200 };
const numericSegment = fc
  .array(fc.constantFrom('0', '9', '١', 'Ⅷ', '２'), {
    minLength: 1,
    maxLength: 6,
  })
  .map((parts) => parts.join(''));

describe('independent tag grammar', () => {
  it('accepts Unicode hierarchical spelling without rewriting it', () => {
    fc.assert(
      fc.property(validTagArbitrary(), (tag) => {
        expect(normalizeTag(tag)).toBe(tag);
        expect(normalizeTag(` \t${tag.slice(1)}\r\n`)).toBe(tag);
        expect(normalizeTag(normalizeTag(tag) ?? '')).toBe(tag);
      }),
      parameters,
    );
  });

  it.each(validTagChunks)('accepts the valid chunk %j beside a known non-number', (chunk) => {
    expect(normalizeTag(`#a${chunk}/Я`)).toBe(`#a${chunk}/Я`);
  });

  it('rejects numeric-only tags even across slash segments', () => {
    fc.assert(
      fc.property(fc.array(numericSegment, { minLength: 1, maxLength: 4 }), (parts) => {
        expect(normalizeTag(`#${parts.join('/')}`)).toBeNull();
      }),
      parameters,
    );
  });

  it('rejects empty segments and forbidden interior delimiters', () => {
    fc.assert(
      fc.property(
        validTagArbitrary(),
        fc.constantFrom('', '/', '//', ' ', '.', '#', '[', ']'),
        (tag, delimiter) => {
          let invalid = '#';
          if (delimiter.length > 0) {
            invalid = delimiter.startsWith('/') ? `${tag}${delimiter}` : `${tag}${delimiter}a`;
          }
          expect(normalizeTag(invalid)).toBeNull();
          expect(normalizeTag(`#/${tag.slice(1)}`)).toBeNull();
          expect(normalizeTag(`${tag}//a`)).toBeNull();
        },
      ),
      parameters,
    );
  });

  it('rejects lone UTF-16 surrogate code units inside tags', () => {
    fc.assert(
      fc.property(validTagArbitrary(), fc.integer({ min: 0xd800, max: 0xdfff }), (tag, unit) => {
        expect(normalizeTag(`${tag}/${String.fromCharCode(unit)}a`)).toBeNull();
      }),
      parameters,
    );
  });

  it('keeps authored case and normalization while deriving case identity', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          { authored: '#Я/A', alias: '#я/a', key: '#я/a' },
          { authored: '#CAFÉ', alias: '#café', key: '#café' },
          { authored: '#E\u0301', alias: '#e\u0301', key: '#e\u0301' },
        ),
        (value) => {
          expect(normalizeTag(value.authored)).toBe(value.authored);
          expect(tagComparisonKey(value.authored)).toBe(value.key);
          expect(sameTag(value.authored, value.alias)).toBe(true);
          expect(sameTag('#é', '#e\u0301')).toBe(false);
        },
      ),
      parameters,
    );
  });
});
