import type { SourceRange } from '../markdown/inlineCode';
import { searchTextSourceRanges, type SearchTextProjection } from '../markdown/searchText';
import { matchSearchText, type PreparedSearchQuery, type SearchWordSegmenter } from '../tasks';

interface TextRun {
  readonly node: Text;
  readonly anchor: HTMLAnchorElement | undefined;
  readonly start: number;
  readonly end: number;
}
interface MarkRange {
  start: number;
  end: number;
}
const excluded = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SVG']);
const blocks = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function skipElement(element: Element): boolean {
  return (
    element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    excluded.has(element.tagName) ||
    element.getAttribute('aria-hidden') === 'true'
  );
}

/** Rendered block boundaries carry whitespace, never fabricated searchable characters. */
function renderedText(container: HTMLElement): { text: string; runs: TextRun[] } {
  let text = '';
  const runs: TextRun[] = [];
  function walk(node: Node, anchor?: HTMLAnchorElement): void {
    if (node.nodeType === 3) {
      const start = text.length;
      text += node.nodeValue ?? '';
      runs.push({ node: node as Text, anchor, start, end: text.length });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (skipElement(element)) return;
    if (element.tagName === 'BR') {
      text += '\n';
      return;
    }
    const block = blocks.has(element.tagName);
    if (block) text += '\n';
    const owner = element.tagName === 'A' ? (element as HTMLAnchorElement) : anchor;
    for (const child of element.childNodes) walk(child, owner);
    if (block) text += '\n';
  }
  for (const node of container.childNodes) walk(node);
  return { text, runs };
}
function isWhitespace(text: string, at: number): boolean {
  return /\s/u.test(text[at] ?? '');
}
function skipWhitespace(text: string, at: number): number {
  let cursor = at;
  while (isWhitespace(text, cursor)) cursor++;
  return cursor;
}
/** Only identical non-whitespace text with corresponding whitespace runs is provable. */
function align(projected: string, rendered: string): AlignmentRun[] | undefined {
  const offsets: AlignmentRun[] = [];
  let source = skipWhitespace(projected, 0),
    actual = skipWhitespace(rendered, 0);
  while (source < projected.length) {
    if (isWhitespace(projected, source)) {
      if (!isWhitespace(rendered, actual)) return undefined;
      source = skipWhitespace(projected, source);
      actual = skipWhitespace(rendered, actual);
      continue;
    }
    if (projected[source] !== rendered[actual]) return undefined;
    appendAlignment(offsets, source, actual);
    source++;
    actual++;
  }
  return rendered.slice(actual).trim() === '' ? offsets : undefined;
}
interface AlignmentRun extends MarkRange {
  readonly actual: number;
}
function appendAlignment(offsets: AlignmentRun[], source: number, actual: number): void {
  const previous = offsets[offsets.length - 1];
  if (previous?.end === source) previous.end++;
  else offsets.push({ start: source, end: source + 1, actual });
}
function alignedOffset(runs: readonly AlignmentRun[], offset: number): number | undefined {
  let low = 0,
    high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((runs[middle]?.end ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  const run = runs[low];
  return run !== undefined && offset >= run.start ? run.actual + offset - run.start : undefined;
}
function projectedOffset(runs: readonly AlignmentRun[], offset: number): number | undefined {
  let low = 0,
    high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle];
    if (run !== undefined && run.actual + run.end - run.start <= offset) low = middle + 1;
    else high = middle;
  }
  const run = runs[low];
  return run !== undefined && offset >= run.actual ? run.start + offset - run.actual : undefined;
}
/** Shares whole-field alignment with marks; only anchor spans with exact source evidence escape. */
export function renderedAnchorSources(
  container: HTMLElement,
  projection: SearchTextProjection,
): ReadonlyMap<HTMLAnchorElement, readonly SourceRange[]> {
  const { text, runs } = renderedText(container);
  const offsets = align(projection.visible.text, text);
  const sources = new Map<HTMLAnchorElement, readonly SourceRange[]>();
  if (offsets === undefined) return sources;
  for (const [anchor, range] of anchorRanges(runs)) {
    const from = projectedOffset(offsets, range.start),
      to = projectedOffset(offsets, range.end - 1);
    if (from !== undefined && to !== undefined)
      sources.set(anchor, searchTextSourceRanges(projection.visible, { from, to: to + 1 }));
  }
  return sources;
}
function anchorRanges(runs: readonly TextRun[]): Map<HTMLAnchorElement, MarkRange> {
  const ranges = new Map<HTMLAnchorElement, MarkRange>();
  for (const run of runs) {
    if (run.anchor === undefined || run.start === run.end) continue;
    const previous = ranges.get(run.anchor);
    if (previous === undefined) ranges.set(run.anchor, { start: run.start, end: run.end });
    else previous.end = run.end;
  }
  return ranges;
}
function mergeRanges(ranges: MarkRange[]): MarkRange[] {
  ranges.sort((a, b) => {
    const order = a.start - b.start;
    return order === 0 ? a.end - b.end : order;
  });
  const merged: MarkRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged.reverse();
}
function matchedRanges(
  text: string,
  offsets: readonly AlignmentRun[],
  matching: { query: PreparedSearchQuery; segment: SearchWordSegmenter },
): MarkRange[] {
  const ranges: MarkRange[] = [];
  for (const match of matchSearchText(text, matching.query, matching.segment)) {
    const start = alignedOffset(offsets, match.start),
      end = alignedOffset(offsets, match.end - 1);
    if (start !== undefined && end !== undefined) ranges.push({ start, end: end + 1 });
  }
  return mergeRanges(ranges);
}
function wrapFragment(container: HTMLElement, run: TextRun, range: MarkRange): void {
  const from = Math.max(range.start, run.start) - run.start;
  const to = Math.min(range.end, run.end) - run.start;
  if (from >= to) return;
  if (to < run.node.length) run.node.splitText(to);
  const fragment = from === 0 ? run.node : run.node.splitText(from);
  // Obsidian's element helper creates the mark in this element's owning document.
  const mark = container.createEl('mark', { cls: 'abyss-search-match' });
  fragment.parentNode?.insertBefore(mark, fragment);
  mark.appendChild(fragment);
}
/** Marks mutate text nodes only, preserving the host's anchors and their installed listeners. */
export function markSearchText(
  container: HTMLElement,
  projection: SearchTextProjection,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
): void {
  for (const mark of container.querySelectorAll('mark.abyss-search-match'))
    mark.replaceWith(...mark.childNodes);
  const { text, runs } = renderedText(container);
  const offsets = align(projection.visible.text, text);
  if (offsets === undefined) return;
  wrapRanges(container, runs, matchedRanges(projection.visible.text, offsets, { query, segment }));
}
function wrapRanges(
  container: HTMLElement,
  runs: readonly TextRun[],
  ranges: readonly MarkRange[],
): void {
  let index = runs.length - 1;
  for (const range of ranges) index = wrapRange(container, runs, index, range);
}
function wrapRange(
  container: HTMLElement,
  runs: readonly TextRun[],
  startIndex: number,
  range: MarkRange,
): number {
  let index = startIndex;
  while (index >= 0 && (runs[index]?.start ?? 0) >= range.end) index--;
  for (let at = index; at >= 0; at--) {
    const run = runs[at];
    if (run === undefined || run.end <= range.start) break;
    wrapFragment(container, run, range);
    // A run spanning several matches stays available; every disjoint run is skipped once.
    if (run.start >= range.start) index = at - 1;
  }
  return index;
}
