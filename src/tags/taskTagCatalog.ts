import { extractMarkdownBodyTags } from '../markdown/markdownTagRename';
import type { CalendarSettings, TagGroup } from '../settings/types';
import { normalizeTaskTagInput, type TaskNodeSnapshot } from '../tasks';

function addInput(target: string[], seen: Set<string>, input: string): void {
  const tags = normalizeTaskTagInput(input);
  if (tags === undefined) return;
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    target.push(tag);
  }
}

function addGroup(target: string[], seen: Set<string>, group: TagGroup): void {
  if (group.mode === 'prefix') {
    addInput(target, seen, group.prefix ?? '');
    return;
  }
  for (const tag of group.tags ?? []) addInput(target, seen, tag);
}

/** Builds the assignable catalog strictly from public task snapshots and explicit configuration. */
export function collectTaskTags(
  nodes: readonly TaskNodeSnapshot[],
  settings: CalendarSettings,
  selected: readonly string[] = [],
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of selected) addInput(result, seen, tag);
  for (const { node } of nodes) for (const tag of node.tags) addInput(result, seen, tag);
  for (const tag of settings.pinnedTags) addInput(result, seen, tag);
  for (const tag of settings.archivedTags) addInput(result, seen, tag);
  for (const group of settings.tagGroups) addGroup(result, seen, group);
  for (const tag of extractMarkdownBodyTags(settings.taskPrefix)) addInput(result, seen, tag);
  if (settings.inbox.mode !== 'untagged') addInput(result, seen, settings.inbox.tag);
  return result;
}
