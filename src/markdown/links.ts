import { inlineCodeRanges, type SourceRange } from './inlineCode';

// Link regexes shared across parsing and collapsing.
const WIKILINK_ALIAS_RE = /\[\[([^|[\]]+)\|([^[\]]+)\]\]/gu;
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/gu;
const MD_LINK_RE = /\[([^[\]]+)\]\(([^)]+)\)/gu;
const BRACKETS_RE = /\[([^[\]]*)\]/gu;

/** Collapse links to the readable, non-clickable placeholder form (legacy `text`). */
export function collapseLinks(input: string): string {
  return input
    .replace(WIKILINK_ALIAS_RE, '🔗$1')
    .replace(WIKILINK_RE, (_m, link: string) => `🔗 ${link.replace(/\.[^.]*$/u, '')}`)
    .replace(MD_LINK_RE, '🌐 $1')
    .replace(BRACKETS_RE, '$1');
}

export interface LinkToken {
  raw: string;
  type: 'wiki' | 'md';
  target: string;
  display: string;
  index: number;
}

function isEscaped(input: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor--) slashCount++;
  return slashCount % 2 === 1;
}

function insideOrderedRange(
  at: number,
  ranges: readonly SourceRange[],
  cursor: { index: number },
): boolean {
  while (cursor.index < ranges.length) {
    const range = ranges[cursor.index];
    if (range === undefined || range.to > at) break;
    cursor.index++;
  }
  const range = ranges[cursor.index];
  return range !== undefined && at >= range.from && at < range.to;
}

function nonOverlappingTokens(candidates: readonly LinkToken[]): LinkToken[] {
  const ordered = [...candidates].sort((left, right) => {
    const indexOrder = left.index - right.index;
    if (indexOrder !== 0) return indexOrder;
    const lengthOrder = right.raw.length - left.raw.length;
    return lengthOrder !== 0 ? lengthOrder : left.type.localeCompare(right.type);
  });
  const accepted: LinkToken[] = [];
  let acceptedTo = 0;
  for (const candidate of ordered) {
    if (candidate.index < acceptedTo) continue;
    accepted.push(candidate);
    acceptedTo = candidate.index + candidate.raw.length;
  }
  return accepted;
}

function wikiLinkTokens(input: string, inlineCode: readonly SourceRange[]): LinkToken[] {
  const tokens: LinkToken[] = [];
  const wiki = /(?<!!)\[\[((?:\\.|[^|[\]])+)(?:\|((?:\\.|[^[\]])+))?\]\]/gu;
  const rangeCursor = { index: 0 };
  let match: RegExpExecArray | null;
  while ((match = wiki.exec(input)) !== null) {
    if (isEscaped(input, match.index) || insideOrderedRange(match.index, inlineCode, rangeCursor)) {
      continue;
    }
    const target = match[1] ?? '';
    const alias = match[2];
    tokens.push({
      raw: match[0],
      type: 'wiki',
      target,
      display: alias ?? target.replace(/\.[^.]*$/u, '').replace(/^.*\//u, ''),
      index: match.index,
    });
  }
  return tokens;
}

function markdownLinkTokens(input: string, inlineCode: readonly SourceRange[]): LinkToken[] {
  const tokens: LinkToken[] = [];
  const markdown = /(?<!!)\[((?:\\.|[^[\]])+)\]\(((?:\\.|[^)])+)\)/gu;
  const rangeCursor = { index: 0 };
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(input)) !== null) {
    if (isEscaped(input, match.index) || insideOrderedRange(match.index, inlineCode, rangeCursor)) {
      continue;
    }
    tokens.push({
      raw: match[0],
      type: 'md',
      target: match[2] ?? '',
      display: match[1] ?? '',
      index: match.index,
    });
  }
  return tokens;
}

/** Parse [[wiki]], [[wiki|alias]] and [md](url) links in document order. */
export function parseLinks(input: string): LinkToken[] {
  const inlineCode = inlineCodeRanges(input);
  return nonOverlappingTokens([
    ...wikiLinkTokens(input, inlineCode),
    ...markdownLinkTokens(input, inlineCode),
  ]);
}

/** Total number of links (wiki + markdown) across the given texts. */
export function countLinksIn(texts: Array<string | undefined>): number {
  let total = 0;
  for (const text of texts) {
    if (text !== undefined && text.length > 0) total += parseLinks(text).length;
  }
  return total;
}

/** Build the raw markup for a link, omitting the wiki alias when it equals the basename. */
export function buildLinkRaw(type: 'wiki' | 'md', target: string, display: string): string {
  if (type === 'md') return `[${display}](${target})`;
  const basename = target.replace(/\.[^.]*$/u, '').replace(/^.*\//u, '');
  return Boolean(display) && display !== basename ? `[[${target}|${display}]]` : `[[${target}]]`;
}

export interface AnchorDescriptor {
  text: string;
  href: string;
}

/**
 * For each anchor (in document order), find the parseLinks token it represents.
 * Returns, per anchor index, the matched token's occurrence index (its index in
 * `tokens`) or -1 if the anchor matches no token (e.g. an auto-linked bare URL).
 * Each token is consumed by at most one anchor; matching is by display text or
 * link target, scanning the first not-yet-consumed matching token.
 */
export function pairAnchorsToTokens(anchors: AnchorDescriptor[], tokens: LinkToken[]): number[] {
  const consumed = new Array(tokens.length).fill(false) as boolean[];
  return anchors.map((a) => {
    for (let k = 0; k < tokens.length; k++) {
      if (consumed[k] ?? false) continue;
      const token = tokens[k];
      if (token !== undefined && anchorMatchesToken(a, token)) {
        consumed[k] = true;
        return k;
      }
    }
    return -1;
  });
}

function anchorMatchesToken(a: AnchorDescriptor, token: LinkToken): boolean {
  const text = a.text.trim();
  if (Boolean(text) && text === token.display) return true;
  if (a.href.length === 0) return false;
  if (token.type === 'wiki') {
    const base = (s: string): string => s.replace(/\.[^.]*$/u, '').replace(/^.*\//u, '');
    return a.href === token.target || base(a.href) === base(token.target);
  }
  return a.href === token.target;
}
