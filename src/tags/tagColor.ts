import type { TagGroup } from '../settings/types';
import { tagMatchesGroup } from './effectiveTagGroups';

/**
 * The color for an already-extracted tag string (e.g. "#work" or "work"), matching it
 * against the plugin's configured tag groups.
 */
export function colorForTag(tag: string, tagGroups: TagGroup[]): string | undefined {
  for (const group of tagGroups) {
    if (tagMatchesGroup(tag.startsWith('#') ? tag : `#${tag}`, group)) return group.color;
  }
  return undefined;
}

/** The color for a task's first canonical tag, or undefined if no tag/no matching group. */
export function tagColorFor(
  tags: readonly string[] | undefined,
  tagGroups: TagGroup[],
): string | undefined {
  const first = tags?.[0];
  return first !== undefined && first.length > 0 ? colorForTag(first, tagGroups) : undefined;
}
