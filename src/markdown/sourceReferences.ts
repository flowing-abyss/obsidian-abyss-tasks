import { consumeMarkdownFenceLine, type MarkdownFence } from './fences';
import { inlineCodeRanges, type SourceRange } from './inlineCode';
import { markdownLinkTargetParts } from './linkTarget';
import {
  aliasSeparator,
  buildLinkRaw,
  parseLinks,
  parseSourceReferences,
  writtenAlias,
  type LinkToken,
} from './links';

export interface SourceReferenceResolver {
  readonly resolve: (target: string, sourcePath: string) => string | undefined;
  readonly linktext: (resolvedPath: string, destinationPath: string) => string;
}

/** Existing clipboard policy: unresolved references remain authored and editable links only. */
export function rebaseMarkdownLinks(
  value: string,
  sourcePath: string,
  destinationPath: string,
  resolver: SourceReferenceResolver,
): string {
  let result = value;
  for (const link of [...parseLinks(value)].reverse()) {
    const { resolverTarget, subpath, externalTarget } = markdownLinkTargetParts(link);
    if (externalTarget !== undefined) continue;
    const resolved = resolver.resolve(resolverTarget, sourcePath);
    if (resolved === undefined) continue;
    const linktext = resolver.linktext(resolved, destinationPath);
    const target = `${link.type === 'md' ? encodeURI(linktext) : linktext}${subpath}`;
    const raw = buildLinkRaw(link.type, target, writtenAlias(link), aliasSeparator(link));
    result = `${result.slice(0, link.index)}${raw}${result.slice(link.index + link.raw.length)}`;
  }
  return result;
}

/**
 * Accept only the existing single-line token forms. Uncovered brackets may be reference links
 * whose definitions live elsewhere; multiline code needs block parsing to prove its scope.
 * This stricter transfer guard grants no new ordinary editable-link or clipboard authority.
 */
function provenReferences(text: string): LinkToken[] | undefined {
  const code = inlineCodeRanges(text);
  if (code.some(({ from, to }) => /[\r\n]/u.test(text.slice(from, to)))) return undefined;
  const tokens = parseSourceReferences(text);
  if (
    tokens.some(
      (token) =>
        /[\r\n]/u.test(token.raw) || (token.type === 'md' && /[()\s<>]/u.test(token.target)),
    )
  )
    return undefined;
  const ranges = [
    ...code,
    ...tokens.map((token) => ({ from: token.index, to: token.index + token.raw.length })),
    // A task checkbox is structural syntax, not an outgoing reference.
    ...text.matchAll(/^[\t >]*(?:[-*+]|\d+[.)]) \[[^\r\n]\]/gmu),
  ]
    .map((range) =>
      'from' in range ? range : { from: range.index, to: range.index + range[0].length },
    )
    .sort((a, b) => a.from - b.from);
  return hasUnprovedReference(text, ranges) ? undefined : tokens;
}

function hasUnprovedReference(text: string, ranges: readonly SourceRange[]): boolean {
  let cursor = 0;
  let at = 0;
  while (at < text.length) {
    while ((ranges[cursor]?.to ?? Infinity) <= at) cursor++;
    const range = ranges[cursor];
    if (range !== undefined && range.from <= at) {
      at = range.to;
      continue;
    }
    if (text[at] === '\\') {
      at += escapedReferenceLength(text, at);
    } else if (text[at] === '[' || text[at] === '<') return true;
    at++;
  }
  return false;
}

/** Retain the shared reader's escaped-wiki convention and escaped punctuation. */
function escapedReferenceLength(text: string, at: number): number {
  const escapedWiki = /^\[\[[^[\]\r\n]+\]\]/u.exec(text.slice(at + 1));
  return escapedWiki?.[0].length ?? 1;
}

/** Fences separate inline parsing regions; tokens still refer to original source offsets. */
function referencesOutsideFences(text: string): LinkToken[] | undefined {
  let fence: MarkdownFence | undefined;
  let from = 0;
  let at = 0;
  const ranges: Array<{ from: number; to: number }> = [];
  for (const line of text.split('\n')) {
    const consumed = consumeMarkdownFenceLine(fence, line);
    fence = consumed.fence;
    if (!consumed.isContent) {
      if (from < at) ranges.push({ from, to: at });
      from = at + line.length + 1;
    }
    at += line.length + 1;
  }
  if (from < text.length) ranges.push({ from, to: text.length });
  const tokens: LinkToken[] = [];
  for (const range of ranges) {
    const proven = provenReferences(text.slice(range.from, range.to));
    if (proven === undefined) return undefined;
    tokens.push(...proven.map((token) => ({ ...token, index: token.index + range.from })));
  }
  return tokens;
}

function replaceTarget(link: LinkToken, target: string): string | undefined {
  const at =
    link.type === 'md' ? link.raw.lastIndexOf(link.target) : link.raw.indexOf(link.target, 2);
  if (at < 0 || link.target.length === 0) return undefined;
  return link.raw.slice(0, at) + target + link.raw.slice(at + link.target.length);
}

export interface SourceReferenceTransfer {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly movedAnchors: ReadonlySet<string>;
  readonly resolver: SourceReferenceResolver;
}
function transferredTarget(link: LinkToken, transfer: SourceReferenceTransfer): string | undefined {
  const { sourcePath, destinationPath, movedAnchors, resolver } = transfer;
  const parts = markdownLinkTargetParts(link);
  if (
    parts.externalTarget !== undefined ||
    (link.type === 'md' && /^[a-z][a-z\d+.-]*:/iu.test(link.target))
  )
    return link.target;
  const resolved =
    parts.resolverTarget === '' ? sourcePath : resolver.resolve(parts.resolverTarget, sourcePath);
  if (resolved === undefined) return undefined;
  const moved =
    resolved === sourcePath &&
    parts.subpath.startsWith('#^') &&
    movedAnchors.has(parts.subpath.slice(2));
  const linktext = resolver.linktext(moved ? destinationPath : resolved, destinationPath);
  return `${link.type === 'md' ? encodeURI(linktext) : linktext}${parts.subpath}`;
}

/** Transfers existing Markdown; unresolved internal references cannot safely change their base. */
export function rebaseMarkdownSourceReferences(
  text: string,
  transfer: SourceReferenceTransfer,
): string | undefined {
  let result = text;
  const references = referencesOutsideFences(text);
  if (references === undefined) return undefined;
  references.reverse();
  for (const link of references) {
    const target = transferredTarget(link, transfer);
    if (target === undefined) return undefined;
    if (target === link.target) continue;
    const raw = replaceTarget(link, target);
    if (raw === undefined) return undefined;
    result = result.slice(0, link.index) + raw + result.slice(link.index + link.raw.length);
  }
  return result;
}
