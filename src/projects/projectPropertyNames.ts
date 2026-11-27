const projectPropertyCollator = new Intl.Collator(undefined, { sensitivity: 'accent' });

/** Sorts with the same equivalence used to bind authored property names. */
export function compareProjectPropertyNames(left: string, right: string): number {
  return projectPropertyCollator.compare(left, right);
}

/** Matches project property names case-insensitively while preserving accent distinctions. */
export function sameProjectPropertyName(left: string, right: string): boolean {
  return compareProjectPropertyNames(left, right) === 0;
}
