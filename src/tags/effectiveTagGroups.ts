import type { CalendarSettings, TagGroup } from '../settings/types';
import { normalizeTaskTagInput } from '../tasks';

export interface EffectiveTagGroup extends TagGroup {
  readonly origin: 'configured' | 'discovered';
  readonly archived: boolean;
}

export type TagMatchGroup = Pick<TagGroup, 'mode' | 'prefix' | 'tags'>;

function oneTag(input: string): string | undefined {
  const tags = normalizeTaskTagInput(input);
  return tags?.length === 1 ? tags[0] : undefined;
}

export function normalizeTagPrefix(input: string): string | undefined {
  const tag = oneTag(input);
  if (tag === undefined) return undefined;
  return tag.slice(1);
}

export function discoveredPrefixGroupId(prefix: string): string {
  return `discovered:prefix:${encodeURIComponent(prefix)}`;
}

export function discoveredTagGroupId(tag: string): string {
  return `discovered:tag:${encodeURIComponent(tag)}`;
}

export function prefixForDiscoveredGroupId(id: string): string | undefined {
  const marker = 'discovered:prefix:';
  if (!id.startsWith(marker)) return undefined;
  try {
    return decodeURIComponent(id.slice(marker.length).replace(/::\d+$/u, ''));
  } catch {
    return undefined;
  }
}

export function tagForDiscoveredGroupId(id: string): string | undefined {
  const marker = 'discovered:tag:';
  if (!id.startsWith(marker)) return undefined;
  try {
    return decodeURIComponent(id.slice(marker.length).replace(/::\d+$/u, ''));
  } catch {
    return undefined;
  }
}

export function tagMatchesGroup(tag: string, group: TagMatchGroup): boolean {
  if (group.mode === 'prefix') {
    const prefix = normalizeTagPrefix(group.prefix ?? '');
    return prefix !== undefined && (tag === `#${prefix}` || tag.startsWith(`#${prefix}/`));
  }
  return (group.tags ?? []).some((candidate) => oneTag(candidate) === tag);
}

export function isTagNavigationArchived(settings: CalendarSettings, tag: string): boolean {
  if (settings.archivedTags.includes(tag)) return true;
  if (
    settings.archivedTagPrefixes.some((input) => {
      const prefix = normalizeTagPrefix(input);
      return prefix !== undefined && (tag === `#${prefix}` || tag.startsWith(`#${prefix}/`));
    })
  ) {
    return true;
  }
  const matching = settings.tagGroups.filter((group) => tagMatchesGroup(tag, group));
  return (
    matching.some((group) => group.archived === true) &&
    !matching.some((group) => group.archived !== true)
  );
}

export function effectiveGroupCaptureTag(
  group: Pick<TagGroup, 'mode' | 'prefix' | 'tags'>,
): string | undefined {
  if (group.mode === 'prefix') {
    const prefix = normalizeTagPrefix(group.prefix ?? '');
    return prefix === undefined ? undefined : `#${prefix}`;
  }
  return oneTag(group.tags?.[0] ?? '');
}

function normalizedObservedTags(tags: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of tags) {
    const tag = oneTag(value);
    if (tag !== undefined) normalized.add(tag);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function configuredGroups(settings: CalendarSettings): EffectiveTagGroup[] {
  return settings.tagGroups.map((group) => {
    const configured: EffectiveTagGroup = {
      ...group,
      origin: 'configured',
      archived: group.archived === true,
    };
    if (group.tags !== undefined) {
      configured.tags = [
        ...new Set(group.tags.flatMap((value) => normalizeTaskTagInput(value) ?? [])),
      ];
    }
    if (group.prefix !== undefined) {
      const prefix = normalizeTagPrefix(group.prefix);
      if (prefix === undefined) delete configured.prefix;
      else configured.prefix = prefix;
    }
    return configured;
  });
}

interface DiscoveredCandidate {
  readonly key: string;
  readonly group: EffectiveTagGroup;
}

function discoveredPrefix(prefix: string, archived: boolean): DiscoveredCandidate {
  return {
    key: prefix,
    group: {
      id: discoveredPrefixGroupId(prefix),
      name: prefix,
      mode: 'prefix',
      prefix,
      origin: 'discovered',
      archived,
    },
  };
}

function uniqueDiscoveredId(preferred: string, occupied: Set<string>): string {
  if (!occupied.has(preferred)) return preferred;
  let suffix = 1;
  while (occupied.has(`${preferred}::${suffix}`)) suffix += 1;
  return `${preferred}::${suffix}`;
}

function reserveDiscoveredId(
  candidate: DiscoveredCandidate,
  occupied: Set<string>,
): DiscoveredCandidate {
  const id = uniqueDiscoveredId(candidate.group.id, occupied);
  occupied.add(id);
  return id === candidate.group.id
    ? candidate
    : { ...candidate, group: { ...candidate.group, id } };
}

function discoveredTag(tag: string, archived: boolean): DiscoveredCandidate {
  return {
    key: tag.slice(1),
    group: {
      id: discoveredTagGroupId(tag),
      name: tag.slice(1),
      mode: 'manual',
      tags: [tag],
      origin: 'discovered',
      archived,
    },
  };
}

/** Resolves configured and task-derived navigation groups without persisting the discovered catalog. */
export function resolveEffectiveTagGroups(
  settings: CalendarSettings,
  tags: readonly string[],
): readonly EffectiveTagGroup[] {
  const observed = normalizedObservedTags(tags);
  const configured = configuredGroups(settings);
  const occupiedIds = new Set(configured.map(({ id }) => id));
  const unclaimed = observed.filter(
    (tag) => !configured.some((group) => tagMatchesGroup(tag, group)),
  );
  const archivedPrefixes = new Set(
    settings.archivedTagPrefixes
      .map(normalizeTagPrefix)
      .filter((prefix): prefix is string => prefix !== undefined),
  );
  const branchPrefixes = new Set<string>(archivedPrefixes);
  for (const tag of unclaimed) {
    const slash = tag.indexOf('/');
    if (slash > 1) branchPrefixes.add(tag.slice(1, slash));
  }

  const discovered: DiscoveredCandidate[] = [];
  for (const prefix of branchPrefixes) {
    if (
      configured.some(
        (group) => group.mode === 'prefix' && normalizeTagPrefix(group.prefix ?? '') === prefix,
      )
    ) {
      continue;
    }
    discovered.push(
      reserveDiscoveredId(discoveredPrefix(prefix, archivedPrefixes.has(prefix)), occupiedIds),
    );
  }
  for (const tag of unclaimed) {
    const top = tag.slice(1).split('/')[0] ?? '';
    if (top !== '' && branchPrefixes.has(top)) continue;
    discovered.push(
      reserveDiscoveredId(discoveredTag(tag, settings.archivedTags.includes(tag)), occupiedIds),
    );
  }
  discovered.sort((left, right) => {
    const byKey = left.key.localeCompare(right.key);
    return byKey === 0 ? left.group.id.localeCompare(right.group.id) : byKey;
  });
  return [...configured, ...discovered.map(({ group }) => group)];
}
