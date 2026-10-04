import type { SearchTextProjection } from '../markdown/searchText';
import { matchSearchText, type PreparedSearchQuery, type SearchWordSegmenter } from '../tasks';

interface TextRun {
  readonly node: Text;
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
  function walk(node: Node): void {
    if (node.nodeType === 3) {
      const start = text.length;
      text += node.nodeValue ?? '';
      runs.push({ node: node as Text, start, end: text.length });
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
    for (const child of element.childNodes) walk(child);
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
function align(projected: string, rendered: string): Map<number, number> | undefined {
  const offsets = new Map<number, number>();
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
    offsets.set(source++, actual++);
  }
  return rendered.slice(actual).trim() === '' ? offsets : undefined;
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
  offsets: Map<number, number>,
  matching: { query: PreparedSearchQuery; segment: SearchWordSegmenter },
): MarkRange[] {
  const ranges: MarkRange[] = [];
  for (const match of matchSearchText(text, matching.query, matching.segment)) {
    const start = offsets.get(match.start),
      end = offsets.get(match.end - 1);
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
  runs.reverse();
  for (const range of matchedRanges(projection.visible.text, offsets, { query, segment }))
    for (const run of runs) wrapFragment(container, run, range);
}
