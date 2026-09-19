import { expectDefined } from './helpers';
// test/tag-manager-settings.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { resolveEffectiveTagGroups } from '../src/tags/effectiveTagGroups';
import { TagManager } from '../src/tags/TagManager';

function makeManager(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const settings = {
    ...DEFAULT_SETTINGS,
    pinnedTags: [...(overrides.pinnedTags ?? DEFAULT_SETTINGS.pinnedTags)],
    archivedTags: [...(overrides.archivedTags ?? DEFAULT_SETTINGS.archivedTags)],
    archivedTagPrefixes: [
      ...(overrides.archivedTagPrefixes ?? DEFAULT_SETTINGS.archivedTagPrefixes),
    ],
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

describe('TagManager effective group archives', () => {
  it('archives a discovered prefix durably without materializing the group', async () => {
    const { tm, settings, save } = makeManager({ tagGroups: [], pinnedTags: ['#work/pinned'] });

    await tm.archiveGroup({
      id: 'discovered:prefix:work',
      name: 'work',
      mode: 'prefix',
      prefix: 'work',
      origin: 'discovered',
      archived: false,
    });

    expect(settings.archivedTagPrefixes).toEqual(['work']);
    expect(settings.tagGroups).toEqual([]);
    expect(settings.pinnedTags).toEqual(['#work/pinned']);
    expect(save).toHaveBeenCalledOnce();
  });

  it('archives and restores a configured manual group without losing its metadata', async () => {
    const group = {
      id: 'manual',
      name: 'Manual',
      color: '#ff0000',
      mode: 'manual' as const,
      tags: ['#only', '#shared'],
    };
    const { tm, settings } = makeManager({ tagGroups: [group] });

    await tm.archiveGroup({ ...group, origin: 'configured', archived: false });
    expect(settings.tagGroups[0]).toEqual({ ...group, archived: true });
    await tm.unarchiveGroup('manual');
    expect(settings.tagGroups[0]).toEqual({ ...group, archived: false });
  });

  it('rolls back only its archive mutation when saving fails and preserves a newer edit', async () => {
    let rejectSave!: (error: Error) => void;
    const failed = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const { tm, settings, save } = makeManager();
    save.mockReturnValueOnce(failed).mockResolvedValueOnce(undefined);

    const archive = tm.archiveTag('#first');
    await tm.pinTag('#newer');
    rejectSave(new Error('storage unavailable'));
    await expect(archive).rejects.toThrow('storage unavailable');

    expect(settings.archivedTags).toEqual(['#first']);
    expect(settings.pinnedTags).toEqual(['#newer']);
  });

  it('rolls back an archive mutation when its save is still the latest revision', async () => {
    const { tm, settings, save } = makeManager();
    save.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(tm.archiveTag('#first')).rejects.toThrow('storage unavailable');

    expect(settings.archivedTags).toEqual([]);
  });

  it('restores a hash-prefixed archived branch without requiring canonical stored spelling', async () => {
    const { tm, settings } = makeManager({ archivedTagPrefixes: ['#work'] });

    await tm.unarchiveGroup('discovered:prefix:work');

    expect(settings.archivedTagPrefixes).toEqual([]);
  });

  it('archives a reused old prefix without targeting the renamed promoted group', async () => {
    const promoted = {
      id: 'discovered:prefix:work',
      name: 'Focused work',
      mode: 'prefix' as const,
      prefix: 'focus',
    };
    const { tm, settings } = makeManager({ tagGroups: [promoted] });
    const groups = resolveEffectiveTagGroups(settings, ['#focus/client', '#work/new']);
    const reused = expectDefined(
      groups.find((group) => group.origin === 'discovered' && group.prefix === 'work'),
    );

    await tm.archiveGroup(reused);

    expect(settings.tagGroups).toEqual([promoted]);
    expect(settings.archivedTagPrefixes).toEqual(['work']);
  });
});

describe('TagManager effective group ordering', () => {
  it('preserves preceding discovered groups when one is moved before another', async () => {
    const { tm, settings } = makeManager({ tagGroups: [] });
    const effective = resolveEffectiveTagGroups(settings, ['#a', '#b', '#c']);
    const ids = effective.map((group) => group.id);

    await tm.reorderGroups(expectDefined(ids[2]), expectDefined(ids[1]), effective);

    expect(
      resolveEffectiveTagGroups(settings, ['#a', '#b', '#c']).map((group) => group.name),
    ).toEqual(['a', 'c', 'b']);
  });
});

describe('TagManager configured group mutations', () => {
  const first = { id: 'first', name: 'First', mode: 'prefix' as const, prefix: 'first' };
  const second = { id: 'second', name: 'Second', mode: 'prefix' as const, prefix: 'second' };

  it('rolls back latest failed additions and deletions', async () => {
    const add = makeManager({ tagGroups: [] });
    add.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(add.tm.addGroup(first)).rejects.toThrow('storage unavailable');
    expect(add.settings.tagGroups).toEqual([]);

    const remove = makeManager({ tagGroups: [first] });
    remove.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(remove.tm.deleteGroup(first.id)).rejects.toThrow('storage unavailable');
    expect(remove.settings.tagGroups).toEqual([first]);
  });

  it('preserves newer configured-group edits when an older save fails', async () => {
    let rejectAdd!: (error: Error) => void;
    const pendingAdd = new Promise<void>((_resolve, reject) => {
      rejectAdd = reject;
    });
    const add = makeManager({ tagGroups: [] });
    add.save.mockReturnValueOnce(pendingAdd).mockResolvedValueOnce(undefined);
    const olderAdd = add.tm.addGroup(first);
    await add.tm.addGroup(second);
    rejectAdd(new Error('older save failed'));
    await expect(olderAdd).rejects.toThrow('older save failed');
    expect(add.settings.tagGroups).toEqual([first, second]);

    let rejectDelete!: (error: Error) => void;
    const pendingDelete = new Promise<void>((_resolve, reject) => {
      rejectDelete = reject;
    });
    const remove = makeManager({ tagGroups: [first] });
    remove.save.mockReturnValueOnce(pendingDelete).mockResolvedValueOnce(undefined);
    const olderDelete = remove.tm.deleteGroup(first.id);
    await remove.tm.addGroup(second);
    rejectDelete(new Error('older save failed'));
    await expect(olderDelete).rejects.toThrow('older save failed');
    expect(remove.settings.tagGroups).toEqual([second]);
  });
});
