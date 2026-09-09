import type { LinkToken } from '../markdown/links';

export interface ProjectTableLinkTargetParts {
  readonly resolverTarget: string;
  readonly subpath: string;
  readonly externalTarget?: string;
}

/** Separates preserved link text from the path accepted by Obsidian's native resolver. */
export function projectTableLinkTargetParts(
  link: Pick<LinkToken, 'target' | 'type'>,
): ProjectTableLinkTargetParts {
  if (link.type === 'md' && /^[a-z][a-z\d+.-]*:\/\//iu.test(link.target)) {
    return { resolverTarget: link.target, subpath: '', externalTarget: link.target };
  }
  const subpathIndex = link.target.indexOf('#');
  const path = subpathIndex < 0 ? link.target : link.target.slice(0, subpathIndex);
  const subpath = subpathIndex < 0 ? '' : link.target.slice(subpathIndex);
  if (link.type === 'wiki') return { resolverTarget: path, subpath };
  try {
    return { resolverTarget: decodeURIComponent(path), subpath };
  } catch {
    return { resolverTarget: path, subpath };
  }
}
