import { readCommentBlock } from '../../domain/commentSource';
import { readTaskLinePrefix } from '../../domain/taskLineSourceModel';
import { consumeMarkdownFenceLine, type MarkdownFence } from './taskBlockSyntax';

export interface FallbackListItem {
  readonly task?: string | undefined;
  readonly parent: number;
  readonly position: {
    readonly start: { readonly line: number; readonly col: number; readonly offset: number };
    readonly end: { readonly line: number; readonly col: number; readonly offset: number };
  };
}

interface FallbackListAncestor {
  readonly line: number;
  readonly indent: number;
}

interface FallbackFenceTransition {
  readonly active: MarkdownFence | undefined;
  readonly skip: boolean;
  readonly opening: boolean;
}

interface FallbackScanState {
  readonly items: FallbackListItem[];
  readonly ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>;
  offset: number;
  frontmatter: boolean;
  fence: MarkdownFence | undefined;
  previousQuoteDepth: number | undefined;
}

interface FallbackListLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly quoteDepth: number;
  readonly prefix: string;
}

const FALLBACK_LIST_ITEM_RE = /^([\s>]*)(?:[-*+]|\d+[.)])\s+/u;
const FALLBACK_PREFIX_RE = /^([\s>]*)/u;

function fallbackFenceState(
  line: string,
  active: MarkdownFence | undefined,
): FallbackFenceTransition {
  const consumed = consumeMarkdownFenceLine(active, line);
  return { active: consumed.fence, skip: !consumed.isContent, opening: consumed.opened };
}

function transitionFallbackQuoteDepth(
  quoteDepth: number,
  previousQuoteDepth: number | undefined,
  ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>,
): number {
  if (previousQuoteDepth !== undefined && previousQuoteDepth !== quoteDepth) {
    ancestorsByQuoteDepth.clear();
  }
  return quoteDepth;
}

function transitionFallbackNonListBoundary(
  quoteDepth: number,
  indent: number,
  previousQuoteDepth: number | undefined,
  ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>,
): number {
  const nextQuoteDepth = transitionFallbackQuoteDepth(
    quoteDepth,
    previousQuoteDepth,
    ancestorsByQuoteDepth,
  );
  const ancestors = ancestorsByQuoteDepth.get(quoteDepth) ?? [];
  while ((ancestors[ancestors.length - 1]?.indent ?? Number.NEGATIVE_INFINITY) >= indent) {
    ancestors.pop();
  }
  ancestorsByQuoteDepth.set(quoteDepth, ancestors);
  return nextQuoteDepth;
}

function fallbackIndent(prefix: string): number {
  return prefix.replace(/\t/gu, '    ').length;
}

function advanceFallbackOffset(state: FallbackScanState, line: string): void {
  state.offset += line.length + 1;
}

function consumeFallbackFrontmatter(
  state: FallbackScanState,
  line: string,
  lineNumber: number,
): boolean {
  if (!state.frontmatter) return false;
  if (lineNumber > 0 && line.trim() === '---') state.frontmatter = false;
  advanceFallbackOffset(state, line);
  return true;
}

function transitionFallbackBoundary(
  state: FallbackScanState,
  quoteDepth: number,
  prefix: string,
): void {
  state.previousQuoteDepth = transitionFallbackNonListBoundary(
    quoteDepth,
    fallbackIndent(prefix),
    state.previousQuoteDepth,
    state.ancestorsByQuoteDepth,
  );
}

function consumeFallbackFence(
  state: FallbackScanState,
  line: string,
  quoteDepth: number,
  prefix: string,
): boolean {
  const transition = fallbackFenceState(line, state.fence);
  state.fence = transition.active;
  if (!transition.skip) return false;
  if (transition.opening) transitionFallbackBoundary(state, quoteDepth, prefix);
  advanceFallbackOffset(state, line);
  return true;
}

function fallbackParent(
  ancestors: FallbackListAncestor[],
  indent: number,
  lineNumber: number,
): number {
  while ((ancestors[ancestors.length - 1]?.indent ?? Number.NEGATIVE_INFINITY) >= indent) {
    ancestors.pop();
  }
  return ancestors[ancestors.length - 1]?.line ?? -(lineNumber + 1);
}

function appendFallbackListItem(state: FallbackScanState, item: FallbackListLine): void {
  const { line, lineNumber, quoteDepth, prefix } = item;
  state.previousQuoteDepth = transitionFallbackQuoteDepth(
    quoteDepth,
    state.previousQuoteDepth,
    state.ancestorsByQuoteDepth,
  );
  const indent = fallbackIndent(prefix);
  const ancestors = state.ancestorsByQuoteDepth.get(quoteDepth) ?? [];
  const task = readTaskLinePrefix(line)?.statusSymbol;
  state.items.push({
    ...(task !== undefined && { task }),
    parent: fallbackParent(ancestors, indent, lineNumber),
    position: {
      start: { line: lineNumber, col: prefix.length, offset: state.offset },
      end: { line: lineNumber, col: line.length, offset: state.offset + line.length },
    },
  });
  ancestors.push({ line: lineNumber, indent });
  state.ancestorsByQuoteDepth.set(quoteDepth, ancestors);
}

function consumeFallbackLine(state: FallbackScanState, line: string, lineNumber: number): void {
  if (consumeFallbackFrontmatter(state, line, lineNumber)) return;
  const leadingPrefix = FALLBACK_PREFIX_RE.exec(line)?.[1] ?? '';
  const quoteDepth = [...leadingPrefix].filter((character) => character === '>').length;
  if (consumeFallbackFence(state, line, quoteDepth, leadingPrefix)) return;
  if (/^[\s>]*$/u.test(line)) {
    advanceFallbackOffset(state, line);
    return;
  }
  const listMatch = FALLBACK_LIST_ITEM_RE.exec(line);
  if (listMatch == null) {
    transitionFallbackBoundary(state, quoteDepth, leadingPrefix);
    advanceFallbackOffset(state, line);
    return;
  }
  appendFallbackListItem(state, {
    line,
    lineNumber,
    quoteDepth,
    prefix: listMatch[1] ?? '',
  });
  advanceFallbackOffset(state, line);
}

function sourceComment(
  state: FallbackScanState,
  lines: readonly string[],
  lineNumber: number,
): ReturnType<typeof readCommentBlock> {
  return !state.frontmatter && state.fence === undefined
    ? readCommentBlock(lines, lineNumber)
    : undefined;
}
export function* taskSourceListItemSteps(
  lines: readonly string[],
): Generator<FallbackListItem | undefined> {
  const state: FallbackScanState = {
    items: [],
    ancestorsByQuoteDepth: new Map(),
    offset: 0,
    frontmatter: lines[0]?.trim() === '---',
    fence: undefined,
    previousQuoteDepth: undefined,
  };
  let lineNumber = 0;
  while (lineNumber < lines.length) {
    const comment = sourceComment(state, lines, lineNumber);
    const priorCount = state.items.length;
    consumeFallbackLine(state, lines[lineNumber] ?? '', lineNumber);
    yield state.items.length > priorCount ? state.items[state.items.length - 1] : undefined;
    // Accepted continuations belong to the list head even when quote spacing changes.
    // Their raw indentation must not pop the head's task ancestors.
    if (comment !== undefined) {
      for (let continuation = lineNumber + 1; continuation < comment.toExclusive; continuation++)
        advanceFallbackOffset(state, lines[continuation] ?? '');
      lineNumber = comment.toExclusive;
    } else lineNumber++;
  }
}

export function fallbackListItems(data: string): FallbackListItem[] {
  const result: FallbackListItem[] = [];
  for (const item of taskSourceListItemSteps(data.split('\n')))
    if (item !== undefined) result.push(item);
  return result;
}

export function hasTaskAncestor(
  item: FallbackListItem,
  itemByLine: ReadonlyMap<number, FallbackListItem>,
): boolean {
  let parentLine = item.parent;
  const seen = new Set<number>();
  while (parentLine >= 0 && !seen.has(parentLine)) {
    if (parentLine === item.position.start.line) return false;
    seen.add(parentLine);
    const parent = itemByLine.get(parentLine);
    if (parent == null) return false;
    if (parent.task !== undefined) return true;
    parentLine = parent.parent;
  }
  return false;
}
