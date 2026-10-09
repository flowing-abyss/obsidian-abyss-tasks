// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeTagFilters, upsertTagFilter } from '../src/settings/tagFilters';
import type { PropertyFilter } from '../src/settings/types';

describe('tag filter identity', () => {
  it('replaces polarity in its original identity slot and keeps exact nested tags', () => {
    expect(
      upsertTagFilter(
        [
          { type: 'tag', value: '#Work' },
          { type: 'priority', value: 'A' },
        ],
        { type: 'tag-exclude', value: '#work' },
      ),
    ).toEqual([
      { type: 'tag-exclude', value: '#work' },
      { type: 'priority', value: 'A' },
    ]);
    expect(
      normalizeTagFilters([
        { type: 'tag', value: '#Work' },
        { type: 'tag', value: '#work/deep' },
        { type: 'tag-exclude', value: '#WORK' },
      ]),
    ).toEqual([
      { type: 'tag-exclude', value: '#WORK' },
      { type: 'tag', value: '#work/deep' },
    ]);
  });
  it('keeps display spelling on no-op and merges extensions at the first identity slot', () => {
    const first = { type: 'tag' as const, value: '#Work', first: 1, shared: 'first' };
    const filters: PropertyFilter[] = [first, { type: 'priority', value: 'A' }];
    expect(upsertTagFilter(filters, { type: 'tag', value: '#WORK' })).toEqual(filters);
    expect(upsertTagFilter(filters, { type: 'tag-exclude', value: '#WORK' })).toEqual([
      { ...first, type: 'tag-exclude', value: '#WORK' },
      filters[1],
    ]);
    const last = { type: 'tag-exclude' as const, value: '#WORK', last: 2, shared: 'last' };
    expect(normalizeTagFilters([...filters, last])).toEqual([{ ...first, ...last }, filters[1]]);
    expect(filters).toEqual([first, { type: 'priority', value: 'A' }]);
    expect(upsertTagFilter(filters, { type: 'tag-exclude', value: '#other' })).toEqual([
      ...filters,
      { type: 'tag-exclude', value: '#other' },
    ]);
  });
});
