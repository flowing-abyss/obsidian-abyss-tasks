const projectPropertyCollator = new Intl.Collator(undefined, { sensitivity: 'accent' });

/** Matches project property names case-insensitively while preserving accent distinctions. */
export function sameProjectPropertyName(left: string, right: string): boolean {
  return projectPropertyCollator.compare(left, right) === 0;
}
