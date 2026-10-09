import { tagComparisonKey } from '../markdown/tagSyntax';
import type { PropertyFilter, TagPropertyFilter } from './types';

/** First identity slot, last authored clause; unrelated extension fields survive collisions. */
export function normalizeTagFilters(filters: readonly PropertyFilter[]): PropertyFilter[] {
  const result: PropertyFilter[] = [];
  const slots = new Map<string, number>();
  for (const filter of filters) {
    if (filter.type !== 'tag' && filter.type !== 'tag-exclude') {
      result.push(filter);
      continue;
    }
    const key = tagComparisonKey(filter.value);
    const slot = slots.get(key);
    if (slot === undefined) {
      slots.set(key, result.length);
      result.push({ ...filter });
    } else result[slot] = { ...result[slot], ...filter };
  }
  return result;
}

export function upsertTagFilter(
  filters: readonly PropertyFilter[],
  next: TagPropertyFilter,
): PropertyFilter[] {
  const result = normalizeTagFilters(filters);
  const slot = result.findIndex(
    (filter) =>
      (filter.type === 'tag' || filter.type === 'tag-exclude') &&
      tagComparisonKey(filter.value) === tagComparisonKey(next.value),
  );
  if (slot === -1) result.push({ ...next });
  else if (result[slot]?.type !== next.type) result[slot] = { ...result[slot], ...next };
  return result;
}
