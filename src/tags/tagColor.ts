import type { TagGroup } from '../settings/types';

/**
 * The color for an already-extracted tag string (e.g. "#work" or "work"), matching it
 * against the plugin's configured tag groups.
 */
export function colorForTag(tag: string, tagGroups: TagGroup[]): string | undefined {
  const noHash = tag.replace(/^#/, '');
  for (const group of tagGroups) {
    if (group.mode === 'prefix' && matchesPrefixGroup(noHash, group.prefix)) return group.color;
    if (group.mode === 'manual' && matchesManualGroup(tag, noHash, group.tags)) return group.color;
  }
  return undefined;
}

function matchesPrefixGroup(noHash: string, prefix: string | undefined): boolean {
  return prefix !== undefined && (noHash === prefix || noHash.startsWith(`${prefix}/`));
}

function matchesManualGroup(
  tag: string,
  noHash: string,
  tags: readonly string[] | undefined,
): boolean {
  return tags?.includes(tag) === true || tags?.includes(noHash) === true;
}

/** The color for a task's first canonical tag, or undefined if no tag/no matching group. */
export function tagColorFor(
  tags: readonly string[] | undefined,
  tagGroups: TagGroup[],
): string | undefined {
  const first = tags?.[0];
  return first !== undefined && first.length > 0 ? colorForTag(first, tagGroups) : undefined;
}
