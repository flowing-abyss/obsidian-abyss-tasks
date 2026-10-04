import { drainCollectionSteps, stableSortSteps, type CollectionSteps } from '../collectionSteps';
import { sameTag, tagComparisonKey, tagHasPrefix } from '../markdown/tagSyntax';
import type { CalendarSettings, TagGroup } from '../settings/types';
import { normalizeTaskTagInput } from '../tasks';

export interface EffectiveTagGroup extends TagGroup {
  readonly origin: 'configured' | 'discovered';
  readonly archived: boolean;
}

type CatalogSettings = Pick<CalendarSettings, 'tagGroups' | 'archivedTags' | 'archivedTagPrefixes'>;

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
  return `discovered:prefix:${encodeURIComponent(tagComparisonKey(prefix))}`;
}

export function discoveredTagGroupId(tag: string): string {
  return `discovered:tag:${encodeURIComponent(tagComparisonKey(tag))}`;
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

export function tagMatchesGroup(tag: string, group: TagMatchGroup): boolean {
  return drainCollectionSteps(matchGroup(tag, group, false));
}
export function tagMatchesGroupSteps(tag: string, group: TagMatchGroup): CollectionSteps<boolean> {
  return matchGroup(tag, group, true);
}
function* matchGroup(
  tag: string,
  group: TagMatchGroup,
  cooperative: boolean,
): CollectionSteps<boolean> {
  if (group.mode === 'prefix') {
    const prefix = normalizeTagPrefix(group.prefix ?? '');
    if (cooperative) yield 'atom';
    const matches = prefix !== undefined && tagHasPrefix(tag, `#${prefix}`);
    if (cooperative) yield 'atom';
    return matches;
  }
  return yield* manualGroupMatch(tag, group.tags ?? [], cooperative);
}
function* manualGroupMatch(
  tag: string,
  tags: readonly string[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const candidate of tags) {
    const normalized = oneTag(candidate) ?? '';
    if (cooperative) yield 'atom';
    const matches = sameTag(normalized, tag);
    if (cooperative) yield 'atom';
    if (matches) return true;
  }
  return false;
}

export function isTagNavigationArchived(settings: CatalogSettings, tag: string): boolean {
  if (settings.archivedTags.some((candidate) => sameTag(candidate, tag))) return true;
  if (
    settings.archivedTagPrefixes.some((input) => {
      const prefix = normalizeTagPrefix(input);
      return prefix !== undefined && tagHasPrefix(tag, `#${prefix}`);
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

interface DiscoveredCandidate {
  readonly key: string;
  readonly group: EffectiveTagGroup;
}

export function resolveEffectiveTagGroups(
  settings: CatalogSettings,
  tags: readonly string[],
): readonly EffectiveTagGroup[] {
  return drainCollectionSteps(resolveGroups(settings, tags, false));
}
export function resolveEffectiveTagGroupsSteps(
  settings: CatalogSettings,
  tags: Iterable<string>,
): CollectionSteps<readonly EffectiveTagGroup[]> {
  return resolveGroups(settings, tags, true);
}
function* copyObservedTags(
  normalized: ReadonlyMap<string, string>,
  values: string[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const tag of normalized.values()) {
    values.push(tag);
    if (cooperative) yield 'cheap';
  }
  return true;
}
function* normalizedTags(tags: Iterable<string>, cooperative: boolean): CollectionSteps<string[]> {
  const normalized = new Map<string, string>();
  const values: string[] = [];
  try {
    for (const value of tags) {
      const tag = oneTag(value);
      if (cooperative) yield 'atom';
      if (tag === undefined) continue;
      addPrefix(normalized, tag);
      if (cooperative) yield 'atom';
    }
    const copied = yield* copyObservedTags(normalized, values, cooperative);
    if (copied === undefined) throw new Error('Observed copy ended without a result');
    const compare = (a: string, b: string): number => a.localeCompare(b);
    if (cooperative) return yield* stableSortSteps(values, compare);
    values.sort(compare);
    return values;
  } finally {
    normalized.clear();
  }
}
function* insertConfiguredTags(
  unique: Set<string>,
  tags: readonly string[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const tag of tags) {
    unique.add(tag);
    if (cooperative) yield 'cheap';
  }
  return true;
}
function* configuredTags(tags: readonly string[], cooperative: boolean): CollectionSteps<string[]> {
  const unique = new Set<string>(),
    output: string[] = [];
  try {
    for (const value of tags) {
      const parsed = normalizeTaskTagInput(value) ?? [];
      if (cooperative) yield 'atom';
      const inserted = yield* insertConfiguredTags(unique, parsed, cooperative);
      if (inserted === undefined) throw new Error('Tag insertion ended without a result');
    }
    for (const value of unique) {
      output.push(value);
      if (cooperative) yield 'cheap';
    }
    return output;
  } finally {
    unique.clear();
  }
}
function* configuredGroup(
  group: TagGroup,
  cooperative: boolean,
): CollectionSteps<EffectiveTagGroup> {
  const entry: EffectiveTagGroup = {
    ...group,
    origin: 'configured',
    archived: group.archived === true,
  };
  if (group.tags !== undefined) {
    const tags = yield* configuredTags(group.tags, cooperative);
    if (tags === undefined) throw new Error('Configured tags ended without a result');
    entry.tags = tags;
  }
  if (group.prefix !== undefined) {
    const prefix = normalizeTagPrefix(group.prefix);
    if (cooperative) yield 'atom';
    if (prefix === undefined) delete entry.prefix;
    else entry.prefix = prefix;
  }
  return entry;
}
function* configuredGroups(
  settings: CatalogSettings,
  cooperative: boolean,
): CollectionSteps<EffectiveTagGroup[]> {
  const output: EffectiveTagGroup[] = [];
  for (const group of settings.tagGroups) {
    const entry = yield* configuredGroup(group, cooperative);
    if (entry === undefined) throw new Error('Configured group ended without a result');
    output.push(entry);
    if (cooperative) yield 'cheap';
  }
  return output;
}
function* isClaimed(
  tag: string,
  groups: readonly EffectiveTagGroup[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const group of groups) {
    const matches = yield* matchGroup(tag, group, cooperative);
    if (matches === undefined) throw new Error('Catalog membership ended without a result');
    if (matches) return true;
  }
  return false;
}
function* unclaimedTags(
  observed: readonly string[],
  configured: readonly EffectiveTagGroup[],
  cooperative: boolean,
): CollectionSteps<string[]> {
  const output: string[] = [];
  for (const tag of observed) {
    const claimed = yield* isClaimed(tag, configured, cooperative);
    if (claimed === undefined) throw new Error('Catalog claim ended without a result');
    if (!claimed) output.push(tag);
    if (cooperative) yield 'cheap';
  }
  return output;
}
function addPrefix(branches: Map<string, string>, prefix: string): void {
  const key = tagComparisonKey(prefix),
    previous = branches.get(key);
  if (previous === undefined || prefix < previous) branches.set(key, prefix);
}
function* discoveredPrefixes(
  settings: CatalogSettings,
  tags: readonly string[],
  cooperative: boolean,
): CollectionSteps<{ branches: Map<string, string>; archived: Set<string> }> {
  const branches = new Map<string, string>(),
    archived = new Set<string>();
  for (const input of settings.archivedTagPrefixes) {
    const prefix = normalizeTagPrefix(input);
    if (cooperative) yield 'atom';
    if (prefix === undefined) continue;
    archived.add(tagComparisonKey(prefix));
    addPrefix(branches, prefix);
    if (cooperative) yield 'atom';
  }
  const added = yield* addObservedPrefixes(tags, branches, cooperative);
  if (added === undefined) throw new Error('Observed prefixes ended without a result');
  return { branches, archived };
}
function* addObservedPrefixes(
  tags: readonly string[],
  branches: Map<string, string>,
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const tag of tags) {
    const slash = tag.indexOf('/');
    if (slash > 1) addPrefix(branches, tag.slice(1, slash));
    if (cooperative) yield 'atom';
  }
  return true;
}
function* prefixClaimed(
  prefix: string,
  groups: readonly EffectiveTagGroup[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const group of groups) {
    const matches =
      group.mode === 'prefix' && sameTag(normalizeTagPrefix(group.prefix ?? '') ?? '', prefix);
    if (cooperative) yield 'atom';
    if (matches) return true;
  }
  return false;
}
function* reservePrefix(
  prefix: string,
  occupied: Set<string>,
  cooperative: boolean,
): CollectionSteps<string> {
  const preferred = discoveredPrefixGroupId(prefix);
  if (cooperative) yield 'atom';
  return yield* reserveId(preferred, occupied, cooperative);
}
function* prefixCandidates(
  prefixes: { branches: Map<string, string>; archived: Set<string> },
  configured: readonly EffectiveTagGroup[],
  occupied: Set<string>,
  cooperative: boolean,
): CollectionSteps<DiscoveredCandidate[]> {
  const output: DiscoveredCandidate[] = [];
  for (const [key, prefix] of prefixes.branches) {
    const claimed = yield* prefixClaimed(prefix, configured, cooperative);
    if (claimed === undefined) throw new Error('Prefix claim ended without a result');
    if (claimed) continue;
    const id = yield* reservePrefix(prefix, occupied, cooperative);
    if (id === undefined) throw new Error('Prefix identity ended without a result');
    output.push({
      key: prefix,
      group: {
        id,
        name: prefix,
        mode: 'prefix',
        prefix,
        origin: 'discovered',
        archived: prefixes.archived.has(key),
      },
    });
    if (cooperative) yield 'cheap';
  }
  return output;
}
function* archivedTag(
  tag: string,
  archived: readonly string[],
  cooperative: boolean,
): CollectionSteps<boolean> {
  for (const candidate of archived) {
    const matches = sameTag(candidate, tag);
    if (cooperative) yield 'atom';
    if (matches) return true;
  }
  return false;
}
function* tagCandidate(
  tag: string,
  archivedTags: readonly string[],
  occupied: Set<string>,
  cooperative: boolean,
): CollectionSteps<DiscoveredCandidate> {
  const archived = yield* archivedTag(tag, archivedTags, cooperative);
  if (archived === undefined) throw new Error('Archive match ended without a result');
  const preferred = discoveredTagGroupId(tag);
  if (cooperative) yield 'atom';
  const id = yield* reserveId(preferred, occupied, cooperative);
  if (id === undefined) throw new Error('Catalog identity ended without a result');
  return {
    key: tag.slice(1),
    group: { id, name: tag.slice(1), mode: 'manual', tags: [tag], origin: 'discovered', archived },
  };
}
function* appendTagCandidates(
  output: DiscoveredCandidate[],
  tags: readonly string[],
  context: {
    branches: ReadonlyMap<string, string>;
    archived: readonly string[];
    occupied: Set<string>;
  },
  cooperative: boolean,
): CollectionSteps<boolean> {
  const { branches, archived, occupied } = context;
  for (const tag of tags) {
    const top = tag.slice(1).split('/')[0] ?? '';
    const covered = top !== '' && branches.has(tagComparisonKey(top));
    if (cooperative) yield 'atom';
    if (covered) continue;
    const candidate = yield* tagCandidate(tag, archived, occupied, cooperative);
    if (candidate === undefined) throw new Error('Tag candidate ended without a result');
    output.push(candidate);
    if (cooperative) yield 'cheap';
  }
  return true;
}
function* discoverGroups(
  settings: CatalogSettings,
  unclaimed: readonly string[],
  configured: readonly EffectiveTagGroup[],
  cooperative: boolean,
): CollectionSteps<DiscoveredCandidate[]> {
  const occupied = new Set<string>();
  for (const group of configured) {
    occupied.add(group.id);
    if (cooperative) yield 'cheap';
  }
  const prefixes = yield* discoveredPrefixes(settings, unclaimed, cooperative);
  if (prefixes === undefined) throw new Error('Prefixes ended without a result');
  try {
    const discovered = yield* prefixCandidates(prefixes, configured, occupied, cooperative);
    if (discovered === undefined) throw new Error('Prefix candidates ended without a result');
    const appended = yield* appendTagCandidates(
      discovered,
      unclaimed,
      { branches: prefixes.branches, archived: settings.archivedTags, occupied },
      cooperative,
    );
    if (appended === undefined) throw new Error('Tag candidates ended without a result');
    const compare = (a: DiscoveredCandidate, b: DiscoveredCandidate): number => {
      const key = a.key.localeCompare(b.key);
      return key === 0 ? a.group.id.localeCompare(b.group.id) : key;
    };
    if (cooperative) return yield* stableSortSteps(discovered, compare);
    discovered.sort(compare);
    return discovered;
  } finally {
    occupied.clear();
    prefixes.branches.clear();
    prefixes.archived.clear();
  }
}
function* resolveGroups(
  settings: CatalogSettings,
  tags: Iterable<string>,
  cooperative: boolean,
): CollectionSteps<readonly EffectiveTagGroup[]> {
  const observed = yield* normalizedTags(tags, cooperative);
  if (observed === undefined) throw new Error('Observed tags ended without a result');
  const configured = yield* configuredGroups(settings, cooperative);
  if (configured === undefined) throw new Error('Configured groups ended without a result');
  const unclaimed = yield* unclaimedTags(observed, configured, cooperative);
  if (unclaimed === undefined) throw new Error('Unclaimed tags ended without a result');
  const discovered = yield* discoverGroups(settings, unclaimed, configured, cooperative);
  if (discovered === undefined) throw new Error('Discovered groups ended without a result');
  for (const { group } of discovered) {
    configured.push(group);
    if (cooperative) yield 'cheap';
  }
  return configured;
}
function* reserveId(
  preferred: string,
  occupied: Set<string>,
  cooperative: boolean,
): CollectionSteps<string> {
  let id = preferred,
    suffix = 1;
  while (occupied.has(id)) {
    id = `${preferred}::${suffix++}`;
    if (cooperative) yield 'cheap';
  }
  occupied.add(id);
  if (cooperative) yield 'cheap';
  return id;
}
