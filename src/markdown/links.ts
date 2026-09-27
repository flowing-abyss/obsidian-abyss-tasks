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
  /**
   * A wiki target is trimmed, drops one trailing backslash, and can be empty (`[[\|b]]`). A
   * Markdown target is the destination as written.
   */
  target: string;
  /**
   * The wiki alias, trimmed, which can be empty (`[[a|]]`), or else the target without folder and
   * extension. A Markdown display is the link text as written.
   */
  display: string;
  index: number;
}

function isEscaped(input: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor--) slashCount++;
  return slashCount % 2 === 1;
}

/** A Markdown link ends at an unescaped `)`, so none can start after the last one. */
function markdownLinkScope(input: string): string {
  let close = input.lastIndexOf(')');
  while (close >= 0 && isEscaped(input, close)) close = input.lastIndexOf(')', close - 1);
  return input.slice(0, close + 1);
}

function insideOrderedRange(
  at: number,
  ranges: readonly SourceRange[],
  cursor: { index: number },
): boolean {
  while ((ranges[cursor.index]?.to ?? Number.POSITIVE_INFINITY) <= at) cursor.index++;
  const range = ranges[cursor.index];
  return range !== undefined && at >= range.from && at < range.to;
}

/** One match of a search; an embed or image has no token, because it is not a link. */
interface LinkMatch {
  readonly from: number;
  readonly to: number;
  readonly token: LinkToken | undefined;
}

/**
 * Keeps each match that does not start inside an earlier kept match, and returns the links among
 * them, so no link starts inside an embed or image. No two matches start at one index, because a
 * wiki match starts with `[[` or `![[` and a Markdown link's text cannot start with `[`.
 */
function nonOverlappingTokens(matches: LinkMatch[]): LinkToken[] {
  matches.sort((left, right) => left.from - right.from);
  const accepted: LinkToken[] = [];
  let acceptedTo = 0;
  for (const match of matches) {
    if (match.from < acceptedTo) continue;
    acceptedTo = match.to;
    if (match.token !== undefined) accepted.push(match.token);
  }
  return accepted;
}

/** A wiki link's display without an alias: the target without folder and extension. */
function unaliasedDisplay(target: string): string {
  return target.replace(/\.[^.]*$/u, '').replace(/^.*\//u, '');
}

/**
 * Reads a wiki link's content as Obsidian does: the first `|` splits the target from the alias
 * unless nothing comes before it, both parts are trimmed, and one backslash at the end of the
 * target is dropped, which is how the table form `[[Note\|Alias]]` works.
 */
function wikiToken(raw: string, content: string, index: number): LinkToken {
  const text = content.trim();
  const pipe = text.indexOf('|');
  const written = pipe > 0 ? text.slice(0, pipe).trim() : text;
  const target = written.endsWith('\\') ? written.slice(0, -1).trim() : written;
  const alias = pipe > 0 ? text.slice(pipe + 1).trim() : undefined;
  return {
    raw,
    type: 'wiki',
    target,
    display: alias ?? unaliasedDisplay(target),
    index,
  };
}

function markdownToken(raw: string, text: string, destination: string, index: number): LinkToken {
  return { raw, type: 'md', target: destination, display: text, index };
}

function pushWikiMatches(
  matches: LinkMatch[],
  input: string,
  inlineCode: readonly SourceRange[],
): void {
  // A wiki link runs to the first `]]` after non-empty content and holds no `[[` or line break;
  // group 1 marks an embed. Group 3 passes over an escaped `\`, `[`, or `!`. The pattern is global
  // and never matches empty text, so each search starts where the previous match ended.
  const wiki = /(!?)\[\[((?:(?!\[\[)[^\r\n])+?)\]\]|(\\[\\[!])/gu;
  const rangeCursor = { index: 0 };
  let match: RegExpExecArray | null;
  while ((match = wiki.exec(input)) !== null) {
    if (match[3] !== undefined || insideOrderedRange(match.index, inlineCode, rangeCursor)) {
      continue;
    }
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      token: match[1] === '!' ? undefined : wikiToken(match[0], match[2] ?? '', match.index),
    });
  }
}

function pushMarkdownMatches(
  matches: LinkMatch[],
  input: string,
  inlineCode: readonly SourceRange[],
): void {
  // A backslash always takes the next character, and a match that starts with `!` is an image.
  // Group 3 passes over an escaped `\`, `[`, or `!`. The pattern is global and never matches
  // empty text, so each search starts where the previous match ended.
  const markdown = /!?\[((?:[^\\[\]]|\\[^])+)\]\(((?:[^\\)]|\\[^])+)\)|(\\[\\[!])/gu;
  const scope = markdownLinkScope(input);
  const rangeCursor = { index: 0 };
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(scope)) !== null) {
    if (match[3] !== undefined || insideOrderedRange(match.index, inlineCode, rangeCursor)) {
      continue;
    }
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      token: match[0].startsWith('!')
        ? undefined
        : markdownToken(match[0], match[1] ?? '', match[2] ?? '', match.index),
    });
  }
}

/**
 * Parse [[wiki]], [[wiki|alias]] and [md](url) links in document order. Embeds and images are not
 * links, and no link starts inside one.
 */
export function parseLinks(input: string): LinkToken[] {
  if (!input.includes('[')) return [];
  const inlineCode = inlineCodeRanges(input);
  const matches: LinkMatch[] = [];
  pushWikiMatches(matches, input, inlineCode);
  pushMarkdownMatches(matches, input, inlineCode);
  return nonOverlappingTokens(matches);
}

/** Return a link only when its markup occupies the complete value. */
export function exactLinkToken(value: string): LinkToken | undefined {
  const tokens = parseLinks(value);
  const token = tokens[0];
  return tokens.length === 1 && token?.raw === value ? token : undefined;
}

/**
 * The text that labels a link, never blank: its display, else a wiki link's target without folder
 * and extension, else the link as written.
 */
export function linkLabel(token: LinkToken): string {
  if (token.display.trim() !== '') return token.display;
  const unaliased = token.type === 'wiki' ? unaliasedDisplay(token.target) : '';
  return unaliased.trim() === '' ? token.raw : unaliased;
}

/** Present complete links by their label while retaining all other text exactly. */
export function linkValueLabel(value: string): string {
  const token = exactLinkToken(value);
  return token === undefined ? value : linkLabel(token);
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
  const basename = unaliasedDisplay(target);
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
    return a.href === token.target || unaliasedDisplay(a.href) === unaliasedDisplay(token.target);
  }
  return a.href === token.target;
}
