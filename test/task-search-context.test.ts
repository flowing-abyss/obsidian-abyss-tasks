import { expect, it } from 'vitest';
import { taskSearchDestination } from '../src/panels/center/taskSearchDestination';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { localDate } from '../src/tasks';
import { expectDefined } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

it('prefers current project membership, then visible configured tree tags in sidebar order', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const h = await createCanonicalSearchHarness(
    { 'a.md': '- [ ] root\n  - [ ] child #Work/One #Other' },
    settings,
  );
  try {
    const root = expectDefined(h.index.list()[0]);
    const input = {
      root,
      settings,
      today: localDate('2026-10-04'),
      projectPaths: new Set(['a.md']),
      configuredTags: ['#OTHER', '#work'],
    };
    expect(taskSearchDestination(input)).toEqual({ type: 'project', path: 'a.md' });
    expect(taskSearchDestination({ ...input, projectPaths: new Set() })).toEqual({
      type: 'tag',
      tag: '#OTHER',
    });
    expect(
      taskSearchDestination({ ...input, projectPaths: new Set(), configuredTags: ['#work/one'] }),
    ).toEqual({ type: 'tag', tag: '#work/one' });
  } finally {
    h.close();
  }
});

it.each([
  ['- [ ] overdue 📅 2026-10-03', 'today'],
  ['- [ ] scheduled ⏳ 2026-10-04 📅 2026-10-10', 'today'],
  ['- [ ] future 📅 2026-10-10', 'upcoming'],
  ['- [x] tagged #hidden', 'inbox'],
])('uses ordinary date policy without assuming fallback membership: %s', async (markdown, want) => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const h = await createCanonicalSearchHarness({ 'a.md': markdown }, settings);
  try {
    expect(
      taskSearchDestination({
        root: expectDefined(h.index.list()[0]),
        settings,
        today: localDate('2026-10-04'),
        projectPaths: new Set(),
        configuredTags: [],
      }),
    ).toBe(want);
  } finally {
    h.close();
  }
});
