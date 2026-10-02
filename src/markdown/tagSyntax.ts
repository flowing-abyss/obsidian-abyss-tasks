/** Shared tag validity and derived identity; authored spelling is never rewritten. */
export type TagRenameScope = 'exact' | 'prefix';
export interface TagRenameChange {
  readonly oldTag: string;
  readonly newTag: string;
  readonly scope: TagRenameScope;
}
export const TAG_CHARACTER_SOURCE = String.raw`(?:[\p{L}\p{M}\p{N}\p{Pc}-]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D)`;
const VALID_TAG = new RegExp(
  String.raw`^#${TAG_CHARACTER_SOURCE}+(?:/${TAG_CHARACTER_SOURCE}+)*$`,
  'u',
);
export function normalizeTag(value: string): string | null {
  const trimmed = value.trim(),
    tag = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return VALID_TAG.test(tag) && !/^\p{N}+$/u.test(tag.slice(1).replace(/\//gu, '')) ? tag : null;
}
export function tagComparisonKey(tag: string): string {
  return tag.toLowerCase();
}
export function sameTag(a: string, b: string): boolean {
  return tagComparisonKey(a) === tagComparisonKey(b);
}
export function tagHasPrefix(tag: string, prefix: string): boolean {
  return sameTag(tag, prefix) || tagComparisonKey(tag).startsWith(`${tagComparisonKey(prefix)}/`);
}
