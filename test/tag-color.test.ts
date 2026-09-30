// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TagGroup } from '../src/settings/types';
import { colorForTag, tagColorFor } from '../src/tags/tagColor';

describe('tagColorFor', () => {
  const groups: TagGroup[] = [
    { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    { id: '2', name: 'Personal', mode: 'manual', tags: ['#personal'], color: '#2ecc71' },
  ];

  it('matches a prefix-mode group, including sub-tags', () => {
    expect(tagColorFor(['#work/dev'], groups)).toBe('#3498db');
    expect(tagColorFor(['#work'], groups)).toBe('#3498db');
  });

  it('matches a manual-mode group', () => {
    expect(tagColorFor(['#personal'], groups)).toBe('#2ecc71');
  });

  it('returns undefined when no tag is present', () => {
    expect(tagColorFor([], groups)).toBeUndefined();
  });

  it('returns undefined when the tag matches no group', () => {
    expect(tagColorFor(['#other'], groups)).toBeUndefined();
  });

  it('uses the first tag when a line has multiple', () => {
    expect(tagColorFor(['#work', '#personal'], groups)).toBe('#3498db');
  });
});

describe('colorForTag', () => {
  const groups: TagGroup[] = [
    { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    { id: '2', name: 'Personal', mode: 'manual', tags: ['#personal'], color: '#2ecc71' },
  ];

  it('matches a prefix-mode group by exact prefix or sub-tag', () => {
    expect(colorForTag('#work', groups)).toBe('#3498db');
    expect(colorForTag('#work/deep', groups)).toBe('#3498db');
  });

  it('matches a manual-mode group', () => {
    expect(colorForTag('#personal', groups)).toBe('#2ecc71');
  });

  it('returns undefined when no group matches', () => {
    expect(colorForTag('#other', groups)).toBeUndefined();
  });
});
