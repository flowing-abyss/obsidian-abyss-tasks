import { expectDefined } from './helpers';
// test/tag-manager-settings.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';

function makeManager(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const settings = {
    ...DEFAULT_SETTINGS,
    pinnedTags: [...(overrides.pinnedTags ?? DEFAULT_SETTINGS.pinnedTags)],
    archivedTags: [...(overrides.archivedTags ?? DEFAULT_SETTINGS.archivedTags)],
    ...overrides,
  };
  const save = vi.fn().mockResolvedValue(undefined);
  // App is not needed for settings-only tests; pass null cast
  const tm = new TagManager(null as never, settings, save);
  return { tm, settings, save };
}

describe('TagManager.createManualGroup', () => {
  it('adds a manual group with a normalized tag and saves', async () => {
    const { tm, settings, save } = makeManager({ tagGroups: [] });
    await tm.createManualGroup('Work Stuff');
    expect(settings.tagGroups).toHaveLength(1);
    expect(expectDefined(settings.tagGroups[0]).mode).toBe('manual');
    expect(expectDefined(settings.tagGroups[0]).name).toBe('Work Stuff');
    expect(expectDefined(settings.tagGroups[0]).tags).toEqual(['#work-stuff']);
    expect(save).toHaveBeenCalledOnce();
  });

  it('ignores an empty name', async () => {
    const { tm, settings, save } = makeManager({ tagGroups: [] });
    await tm.createManualGroup('   ');
    expect(settings.tagGroups).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('generates unique ids across calls', async () => {
    const { tm, settings } = makeManager({ tagGroups: [] });
    await tm.createManualGroup('A');
    await tm.createManualGroup('B');
    expect(expectDefined(settings.tagGroups[0]).id).not.toBe(
      expectDefined(settings.tagGroups[1]).id,
    );
  });
});

describe('TagManager.pinTag', () => {
  it('adds tag to pinnedTags and saves', async () => {
    const { tm, settings, save } = makeManager();
    await tm.pinTag('#task/next');
    expect(settings.pinnedTags).toContain('#task/next');
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not duplicate if already pinned', async () => {
    const { tm, settings, save } = makeManager({ pinnedTags: ['#task/next'] });
    await tm.pinTag('#task/next');
    expect(settings.pinnedTags).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('TagManager.unpinTag', () => {
  it('removes tag from pinnedTags and saves', async () => {
    const { tm, settings, save } = makeManager({ pinnedTags: ['#task/next', '#task/wait'] });
    await tm.unpinTag('#task/next');
    expect(settings.pinnedTags).toEqual(['#task/wait']);
    expect(save).toHaveBeenCalledOnce();
  });

  it('no-ops if tag not pinned', async () => {
    const { tm, settings, save } = makeManager();
    await tm.unpinTag('#task/next');
    expect(settings.pinnedTags).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('TagManager.archiveTag', () => {
  it('adds tag to archivedTags, removes from pinnedTags, and saves', async () => {
    const { tm, settings, save } = makeManager({ pinnedTags: ['#task/next'] });
    await tm.archiveTag('#task/next');
    expect(settings.archivedTags).toContain('#task/next');
    expect(settings.pinnedTags).not.toContain('#task/next');
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not duplicate if already archived', async () => {
    const { tm, settings, save } = makeManager({ archivedTags: ['#task/next'] });
    await tm.archiveTag('#task/next');
    expect(settings.archivedTags).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('TagManager.unarchiveTag', () => {
  it('removes tag from archivedTags and saves', async () => {
    const { tm, settings, save } = makeManager({ archivedTags: ['#task/next'] });
    await tm.unarchiveTag('#task/next');
    expect(settings.archivedTags).toEqual([]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('no-ops if tag not archived', async () => {
    const { tm, save } = makeManager();
    await tm.unarchiveTag('#task/next');
    expect(save).not.toHaveBeenCalled();
  });
});
