import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings, TagGroup } from '../src/settings/types';
import {
  discoveredPrefixGroupId,
  discoveredTagGroupId,
  resolveEffectiveTagGroups,
  tagMatchesGroup,
} from '../src/tags/effectiveTagGroups';
import { expectDefined } from './helpers';

function settings(overrides: Partial<CalendarSettings> = {}): CalendarSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

function summary(group: ReturnType<typeof resolveEffectiveTagGroups>[number]) {
  return {
    id: group.id,
    name: group.name,
    mode: group.mode,
    prefix: group.prefix,
    tags: group.tags,
    origin: group.origin,
    archived: group.archived,
  };
}

describe('resolveEffectiveTagGroups', () => {
  it('discovers standalone tags and one stable top-prefix group independent of tag order', () => {
    const configured = settings();
    const first = resolveEffectiveTagGroups(configured, [
      '#home',
      '#work/client',
      '#work/client/urgent',
    ]);
    const second = resolveEffectiveTagGroups(configured, [
      '#work/client/urgent',
      '#home',
      '#work/client',
    ]);

    expect(first.map(summary)).toEqual([
      {
        id: discoveredTagGroupId('#home'),
        name: 'home',
        mode: 'manual',
        prefix: undefined,
        tags: ['#home'],
        origin: 'discovered',
        archived: false,
      },
      {
        id: discoveredPrefixGroupId('work'),
        name: 'work',
        mode: 'prefix',
        prefix: 'work',
        tags: undefined,
        origin: 'discovered',
        archived: false,
      },
    ]);
    expect(second.map((group) => group.id)).toEqual(first.map((group) => group.id));
  });

  it('lets configured groups claim tags without automatic duplicates even while archived', () => {
    const tagGroups: TagGroup[] = [
      { id: 'work', name: 'Clients', mode: 'prefix', prefix: 'work' },
      {
        id: 'manual-a',
        name: 'Manual A',
        mode: 'manual',
        tags: ['#manual-only', '#shared'],
        archived: true,
      },
      { id: 'manual-b', name: 'Manual B', mode: 'manual', tags: ['#shared'] },
    ];

    expect(
      resolveEffectiveTagGroups(settings({ tagGroups }), [
        '#work/client',
        '#manual-only',
        '#shared',
        '#free',
      ]).map(summary),
    ).toEqual([
      expect.objectContaining({ id: 'work', origin: 'configured', archived: false }),
      expect.objectContaining({ id: 'manual-a', origin: 'configured', archived: true }),
      expect.objectContaining({ id: 'manual-b', origin: 'configured', archived: false }),
      expect.objectContaining({ id: discoveredTagGroupId('#free'), origin: 'discovered' }),
    ]);
  });

  it('preserves configured nested prefixes and discovers descendants beyond exact manual claims', () => {
    const configured = settings({
      tagGroups: [
        { id: 'nested', name: 'Client', mode: 'prefix', prefix: 'work/client' },
        { id: 'exact', name: 'Work root', mode: 'manual', tags: ['#work'] },
      ],
    });

    const groups = resolveEffectiveTagGroups(configured, [
      '#work',
      '#work/client/urgent',
      '#work/other',
    ]);
    expect(groups.map(summary)).toEqual([
      expect.objectContaining({ id: 'nested', prefix: 'work/client', origin: 'configured' }),
      expect.objectContaining({ id: 'exact', tags: ['#work'], origin: 'configured' }),
      expect.objectContaining({
        id: discoveredPrefixGroupId('work'),
        prefix: 'work',
        origin: 'discovered',
      }),
    ]);
    const automatic = expectDefined(
      groups.find(({ id }) => id === discoveredPrefixGroupId('work')),
    );
    expect(tagMatchesGroup('#work', automatic)).toBe(true);
    expect(tagMatchesGroup('#work/client/urgent', automatic)).toBe(true);
    expect(tagMatchesGroup('#work/other', automatic)).toBe(true);
  });

  it('keeps zero-task archived branches restorable and suppresses future descendants', () => {
    const configured = settings({ archivedTagPrefixes: ['work'] });

    const empty = resolveEffectiveTagGroups(configured, []);
    const afterReload = resolveEffectiveTagGroups(configured, ['#work/new', '#home']);

    expect(empty.map(summary)).toEqual([
      expect.objectContaining({
        id: discoveredPrefixGroupId('work'),
        prefix: 'work',
        archived: true,
      }),
    ]);
    expect(afterReload.map(summary)).toEqual([
      expect.objectContaining({ id: discoveredTagGroupId('#home'), archived: false }),
      expect.objectContaining({ id: discoveredPrefixGroupId('work'), archived: true }),
    ]);
  });

  it('retains a promoted discovered id as configured identity', () => {
    const id = discoveredPrefixGroupId('work');
    const configured = settings({
      tagGroups: [{ id, name: 'Focused work', color: '#ff0000', mode: 'prefix', prefix: 'work' }],
    });

    expect(resolveEffectiveTagGroups(configured, ['#work/client']).map(summary)).toEqual([
      expect.objectContaining({ id, name: 'Focused work', origin: 'configured', archived: false }),
    ]);
  });

  it('retains full prefix membership after appearance promotion', () => {
    const id = discoveredPrefixGroupId('work');
    const configured = settings({
      tagGroups: [
        { id: 'client', name: 'Client', mode: 'prefix', prefix: 'work/client' },
        { id, name: 'Focused work', color: '#ff0000', mode: 'prefix', prefix: 'work' },
      ],
    });
    const groups = resolveEffectiveTagGroups(configured, ['#work/client/urgent', '#work/other']);
    const promoted = expectDefined(groups.find((group) => group.id === id));

    expect(tagMatchesGroup('#work/client/urgent', promoted)).toBe(true);
    expect(tagMatchesGroup('#work/other', promoted)).toBe(true);
  });
});
