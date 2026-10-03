/** Namespaces saved group identity by the active grouping field. */
export function projectGroupCollapseKey(field: string, group: string): string {
  return JSON.stringify([field, group]);
}

export function setProjectGroupCollapsed(
  saved: readonly string[] | undefined,
  key: string,
  collapsed: boolean,
): string[] {
  const next = new Set(saved ?? []);
  if (collapsed) next.add(key);
  else next.delete(key);
  return [...next];
}
