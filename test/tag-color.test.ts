// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TagGroup } from '../src/settings/types';
import { resolveEffectiveTagGroups } from '../src/tags/effectiveTagGroups';
import { colorForTag, tagColorFor, tagColorForGroups } from '../src/tags/tagColor';

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

it('keeps configured-only colors equal to catalog colors under normalization and ordering', () => {
  const groups: TagGroup[] = [
    { id: 'manual', name: 'Manual', mode: 'manual', tags: ['MANUAL'], color: '#112233' },
    { id: 'parent', name: 'Parent', mode: 'prefix', prefix: 'WORK', color: '#445566' },
    { id: 'nested', name: 'Nested', mode: 'prefix', prefix: 'work/deep', color: '#778899' },
    { id: 'plain', name: 'Plain', mode: 'manual', tags: ['#plain'] },
    { id: 'later', name: 'Later', mode: 'manual', tags: ['#plain'], color: '#abcdef' },
  ];
  const settings = { ...DEFAULT_SETTINGS, tagGroups: groups };
  const effective = resolveEffectiveTagGroups(settings, [
    '#manual',
    '#work/deep/client',
    '#plain',
    '#free',
  ]);
  for (const [tag, want] of [
    ['#manual', '#112233'],
    ['#WORK/deep/client', '#445566'],
    ['#plain', undefined],
    ['#free', undefined],
  ] as const) {
    expect(colorForTag(tag, groups)).toBe(want);
    expect(tagColorForGroups(tag, effective)).toBe(want);
  }
});
