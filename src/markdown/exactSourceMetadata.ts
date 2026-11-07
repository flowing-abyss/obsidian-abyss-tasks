import type { CachedMetadata, CacheItem, Loc, Pos } from 'obsidian';

/** Only the verified host BOM normalization has a coordinate-preserving projection. */
export function exactSourceMetadata(
  observed: string,
  raw: string,
  cache: CachedMetadata,
): CachedMetadata | undefined {
  if (raw === observed) return cache;
  if (raw !== `\uFEFF${observed}`) return undefined;
  const starts = [0];
  for (let at = observed.indexOf('\n'); at >= 0; at = observed.indexOf('\n', at + 1))
    starts.push(at + 1);
  const location = (loc: Loc): Loc => {
    const start = starts[loc.line];
    if (
      !Number.isSafeInteger(loc.line) ||
      !Number.isSafeInteger(loc.col) ||
      loc.col < 0 ||
      start === undefined ||
      start + loc.col !== loc.offset ||
      loc.offset > observed.length ||
      loc.offset >= (starts[loc.line + 1] ?? Infinity)
    )
      throw new Error('Unproven metadata coordinate.');
    return { ...loc, offset: loc.offset + 1, col: loc.col + (loc.line === 0 ? 1 : 0) };
  };
  const position = (pos: Pos): Pos => ({ start: location(pos.start), end: location(pos.end) });
  const item = <T extends CacheItem>(value: T): T => ({
    ...value,
    position: position(value.position),
  });
  try {
    return {
      ...cache,
      ...referencePositions(cache, item),
      ...structurePositions(cache, item, position),
    };
  } catch {
    return undefined;
  }
}

type ProjectItem = <T extends CacheItem>(item: T) => T;
function referencePositions(cache: CachedMetadata, item: ProjectItem): CachedMetadata {
  return {
    ...(cache.links !== undefined && { links: cache.links.map(item) }),
    ...(cache.embeds !== undefined && { embeds: cache.embeds.map(item) }),
    ...(cache.tags !== undefined && { tags: cache.tags.map(item) }),
    ...(cache.footnotes !== undefined && { footnotes: cache.footnotes.map(item) }),
    ...(cache.footnoteRefs !== undefined && { footnoteRefs: cache.footnoteRefs.map(item) }),
    ...(cache.referenceLinks !== undefined && { referenceLinks: cache.referenceLinks.map(item) }),
  };
}
function structurePositions(
  cache: CachedMetadata,
  item: ProjectItem,
  position: (pos: Pos) => Pos,
): CachedMetadata {
  return {
    ...(cache.headings !== undefined && { headings: cache.headings.map(item) }),
    ...(cache.sections !== undefined && { sections: cache.sections.map(item) }),
    ...(cache.listItems !== undefined && { listItems: cache.listItems.map(item) }),
    ...(cache.frontmatterPosition !== undefined && {
      frontmatterPosition: position(cache.frontmatterPosition),
    }),
    ...(cache.blocks !== undefined && {
      blocks: Object.fromEntries(
        Object.entries(cache.blocks).map(([key, value]) => [key, item(value)]),
      ),
    }),
  };
}
