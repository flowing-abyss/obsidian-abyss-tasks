import type { ListSelection } from '../app/AppState';
import {
  sameTag,
  tagComparisonKey,
  tagHasPrefix,
  type TagRenameChange,
} from '../markdown/tagSyntax';
import type { CalendarSettings } from './types';

interface DerivedGroup {
  readonly tag: string;
  readonly prefix: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function changedTag(tag: string, change: TagRenameChange): string {
  if (sameTag(tag, change.oldTag)) return change.newTag;
  if (change.scope !== 'prefix' || !tagHasPrefix(tag, change.oldTag)) return tag;
  // Segment boundaries belong to the authored spelling, whose lowercase may be longer.
  return `${change.newTag}/${tag.split('/').slice(change.oldTag.split('/').length).join('/')}`;
}
function groupTag(id: string): DerivedGroup | undefined {
  let marker: string;
  if (id.startsWith('discovered:tag:')) marker = 'discovered:tag:';
  else if (id.startsWith('discovered:prefix:')) marker = 'discovered:prefix:';
  else return undefined;
  try {
    const value = decodeURIComponent(id.slice(marker.length).replace(/::\d+$/u, ''));
    const prefix = marker === 'discovered:prefix:';
    return { tag: prefix ? `#${value}` : value, prefix };
  } catch {
    return undefined;
  }
}
function groupId(tag: string, prefix: boolean, ids: ReadonlySet<string>): string {
  const value = prefix ? tag.slice(1) : tag;
  const base = `discovered:${prefix ? 'prefix' : 'tag'}:${encodeURIComponent(tagComparisonKey(value))}`;
  let id = base,
    n = 1;
  while (ids.has(id)) id = `${base}::${n++}`;
  return id;
}
function renamedGroup(id: string, change: TagRenameChange, ids: ReadonlySet<string>): string {
  if (ids.has(id)) return id;
  const parsed = groupTag(id);
  if (parsed === undefined || (parsed.prefix && change.scope !== 'prefix')) return id;
  const tag = changedTag(parsed.tag, change);
  return tag === parsed.tag ? id : groupId(tag, parsed.prefix, ids);
}
export function renameTagSelection(
  selection: ListSelection,
  change: TagRenameChange,
  configuredGroupIds: ReadonlySet<string>,
): ListSelection {
  let result = selection;
  if (typeof selection === 'object') {
    if (selection.type === 'tag') {
      const tag = changedTag(selection.tag, change);
      if (tag !== selection.tag) result = { type: 'tag', tag };
    } else if (selection.type === 'group') {
      const groupId = renamedGroup(selection.groupId, change, configuredGroupIds);
      if (groupId !== selection.groupId) result = { type: 'group', groupId };
    }
  }
  return result;
}
function keyIdentity(key: string, ids: ReadonlySet<string>): string | undefined {
  if (key.startsWith('tag:')) return `tag:${tagComparisonKey(key.slice(4))}`;
  if (!key.startsWith('group:') || ids.has(key.slice(6))) return undefined;
  const parsed = groupTag(key.slice(6));
  if (parsed === undefined) return undefined;
  return `group:${parsed.prefix ? 'prefix' : 'tag'}:${tagComparisonKey(parsed.tag)}`;
}
function renamedKey(key: string, change: TagRenameChange, ids: ReadonlySet<string>): string {
  if (sameTag(change.oldTag, change.newTag)) return key;
  if (key.startsWith('tag:')) return `tag:${changedTag(key.slice(4), change)}`;
  if (!key.startsWith('group:')) return key;
  return `group:${renamedGroup(key.slice(6), change, ids)}`;
}
function affectedKey(key: string, change: TagRenameChange, ids: ReadonlySet<string>): boolean {
  if (!sameTag(change.oldTag, change.newTag)) return renamedKey(key, change, ids) !== key;
  if (keyIdentity(key, ids) === undefined) return false;
  if (key.startsWith('tag:'))
    return change.scope === 'prefix'
      ? tagHasPrefix(key.slice(4), change.oldTag)
      : sameTag(key.slice(4), change.oldTag);
  const parsed = groupTag(key.slice(6));
  if (parsed === undefined || (parsed.prefix && change.scope !== 'prefix')) return false;
  return change.scope === 'prefix'
    ? tagHasPrefix(parsed.tag, change.oldTag)
    : sameTag(parsed.tag, change.oldTag);
}
function destinationOccupied(
  key: string,
  dest: string,
  keys: ReadonlySet<string>,
  ids: ReadonlySet<string>,
): boolean {
  if (dest === key) return false;
  const identity = keyIdentity(dest, ids);
  return [...keys].some(
    (other) =>
      other !== key &&
      (other === dest || (identity !== undefined && keyIdentity(other, ids) === identity)),
  );
}
function renameMapping(
  keys: ReadonlySet<string>,
  change: TagRenameChange,
  ids: ReadonlySet<string>,
): Map<string, string> | undefined {
  const mapped = new Map<string, string>(),
    families = new Map<string, string>();
  for (const key of keys) {
    if (!affectedKey(key, change, ids)) continue;
    const identity = keyIdentity(key, ids);
    if (identity !== undefined && families.has(identity)) return undefined;
    if (identity !== undefined) families.set(identity, key);
    const dest = renamedKey(key, change, ids);
    if (destinationOccupied(key, dest, keys, ids) || [...mapped.values()].includes(dest))
      return undefined;
    mapped.set(key, dest);
  }
  return mapped;
}
function renamedFilters(value: unknown, change: TagRenameChange): unknown {
  if (!record(value) || !Array.isArray(value['filters'])) return value;
  return {
    ...value,
    filters: value['filters'].map((filter: unknown) =>
      record(filter) && filter['type'] === 'tag' && typeof filter['value'] === 'string'
        ? { ...filter, value: changedTag(filter['value'], change) }
        : filter,
    ),
  };
}
function stageEntries(
  source: Record<string, unknown>,
  mapped: ReadonlyMap<string, string>,
  change: TagRenameChange,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source))
    target[mapped.get(key) ?? key] = renamedFilters(structuredClone(value), change);
  return target;
}
type TagViewRenameResult =
  | {
      type: 'ready';
      states: CalendarSettings['listViewStates'];
      rawEnvelope: Record<string, unknown> | undefined;
    }
  | { type: 'conflict' };
/** Detached finite staging; a conflict never mutates settings or the raw envelope. */
export function prepareTagViewStateRename(
  settings: CalendarSettings,
  rawEnvelope: Record<string, unknown> | undefined,
  change: TagRenameChange,
): TagViewRenameResult {
  const ids = new Set(settings.tagGroups.map((g) => g.id));
  const raw = rawEnvelope === undefined ? undefined : structuredClone(rawEnvelope);
  const views = raw !== undefined && record(raw['views']) ? raw['views'] : undefined;
  const rawStates =
    views !== undefined && record(views['listViewStates']) ? views['listViewStates'] : {};
  const decoded = settings.listViewStates ?? {};
  const keys = new Set([...Object.keys(decoded), ...Object.keys(rawStates)]);
  const mapped = renameMapping(keys, change, ids);
  if (mapped === undefined) return { type: 'conflict' };
  const states = stageEntries(decoded, mapped, change) as CalendarSettings['listViewStates'];
  if (views !== undefined) views['listViewStates'] = stageEntries(rawStates, mapped, change);
  return { type: 'ready', states, rawEnvelope: raw };
}
