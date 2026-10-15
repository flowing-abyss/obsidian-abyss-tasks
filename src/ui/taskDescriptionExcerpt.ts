import { matchSearchText, type PreparedSearchQuery, type SearchWordSegmenter } from '../tasks';
import { planTaskDescriptionExcerpts, type TextRange } from './taskDescriptionExcerptRanges';

export interface TextRun {
  readonly node: Text;
  readonly anchor: HTMLAnchorElement | undefined;
  readonly start: number;
  readonly end: number;
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

interface ElementRun {
  readonly node: Element;
  readonly start: number;
  readonly end: number;
}
/** Rendered block boundaries carry whitespace, never fabricated searchable characters. */
export function renderedText(container: HTMLElement): {
  text: string;
  runs: TextRun[];
  elements: ElementRun[];
} {
  let text = '';
  const runs: TextRun[] = [];
  const elements: ElementRun[] = [];
  function walk(node: Node, anchor?: HTMLAnchorElement): void {
    if (node.nodeType === 3) {
      const start = text.length;
      text += node.nodeValue ?? '';
      runs.push({ node: node as Text, anchor, start, end: text.length });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const start = text.length;
    if (skipElement(element)) {
      elements.push({ node: element, start, end: start });
      return;
    }
    if (element.tagName === 'BR') {
      text += '\n';
      elements.push({ node: element, start, end: text.length });
      return;
    }
    const block = blocks.has(element.tagName);
    if (block) text += '\n';
    const owner = element.tagName === 'A' ? (element as HTMLAnchorElement) : anchor;
    for (const child of element.childNodes) walk(child, owner);
    if (block) text += '\n';
    elements.push({ node: element, start, end: text.length });
  }
  for (const node of container.childNodes) walk(node);
  return { text, runs, elements };
}

interface WindowEdges {
  first?: Text;
  last?: Text;
}
/** Display only: link source proof and event wiring must already be complete. */
export function compactTaskDescriptionExcerpt(
  container: HTMLElement,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
  preferredAnchors: readonly HTMLAnchorElement[] = [],
): void {
  const { text, runs, elements } = renderedText(container);
  const anchors = anchorRanges(runs);
  const candidates = [
    ...matchSearchText(text, query, segment),
    ...preferredAnchors.flatMap((anchor) => anchors.get(anchor) ?? []),
  ];
  const ranges = planTaskDescriptionExcerpts(text, candidates, [...anchors.values()]);
  const ordinals = listOrdinals(elements);
  const edges = trimTextRuns(runs, ranges);
  // The collector supplies postorder elements, so discarded children leave no hidden subtree.
  for (const element of elements) {
    if (discardElement(element, ranges)) element.node.remove();
  }
  for (const [item, ordinal] of ordinals) {
    if (container.contains(item)) item.setAttribute('value', String(ordinal));
  }
  addOmissionCues(container, text, ranges, edges);
}
function addOmissionCues(
  container: HTMLElement,
  text: string,
  ranges: readonly TextRange[],
  edges: readonly WindowEdges[],
): void {
  addLeadingCue(container, text.slice(0, ranges[0]?.start ?? 0), edges[0]?.first);
  for (const [index, range] of ranges.entries()) {
    const last = edges[index]?.last;
    const next = ranges[index + 1];
    if (last !== undefined && hasOmittedGap(text, range.end, next))
      addEllipsis(container, last, false, next !== undefined);
  }
}
function hasOmittedGap(text: string, end: number, next?: TextRange): boolean {
  return next === undefined ? text.slice(end).trim() !== '' : end < next.start;
}
function addLeadingCue(container: HTMLElement, omitted: string, first?: Text): void {
  if (first !== undefined && omitted.trim() !== '') addEllipsis(container, first, true);
}
function anchorRanges(runs: readonly TextRun[]): Map<HTMLAnchorElement, TextRange> {
  const anchors = new Map<HTMLAnchorElement, TextRange>();
  for (const run of runs) {
    if (run.anchor === undefined || run.start === run.end) continue;
    const range = anchors.get(run.anchor);
    if (range === undefined) anchors.set(run.anchor, { start: run.start, end: run.end });
    else range.end = run.end;
  }
  return anchors;
}
function trimTextRuns(runs: readonly TextRun[], ranges: readonly TextRange[]): WindowEdges[] {
  const edges: WindowEdges[] = ranges.map(() => ({}));
  for (const run of runs) trimTextRun(run, ranges, edges);
  return edges;
}
function trimTextRun(run: TextRun, ranges: readonly TextRange[], edges: WindowEdges[]): void {
  const data = run.node.data;
  let previous: Text | undefined;
  for (const [index, range] of ranges.entries()) {
    const fragment = retainRunFragment(run, data, range, previous);
    if (fragment === undefined) continue;
    const edge = edges[index];
    if (edge !== undefined) {
      edge.first ??= fragment;
      edge.last = fragment;
    }
    previous = fragment;
  }
  if (previous === undefined) run.node.remove();
}
function retainRunFragment(
  run: TextRun,
  data: string,
  range: TextRange,
  previous?: Text,
): Text | undefined {
  const from = Math.max(range.start, run.start),
    to = Math.min(range.end, run.end);
  if (from >= to) return undefined;
  const fragment = previous === undefined ? run.node : run.node.ownerDocument.createTextNode('');
  fragment.data = data.slice(from - run.start, to - run.start);
  if (previous !== undefined) previous.parentNode?.insertBefore(fragment, previous.nextSibling);
  return fragment;
}
function discardElement(element: ElementRun, ranges: readonly TextRange[]): boolean {
  return (
    element.start === element.end ||
    !ranges.some((range) => element.start < range.end && range.start < element.end) ||
    (element.node.childNodes.length === 0 && element.node.tagName !== 'BR')
  );
}
function listOrdinals(elements: readonly ElementRun[]): Map<Element, number> {
  const ordinals = new Map<Element, number>();
  for (const { node } of elements) {
    if (node.tagName !== 'OL') continue;
    collectListOrdinals(node, ordinals);
  }
  return ordinals;
}
function collectListOrdinals(list: Element, ordinals: Map<Element, number>): void {
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  const step = list.hasAttribute('reversed') ? -1 : 1;
  let ordinal = Number(list.getAttribute('start') ?? (step === -1 ? items.length : 1));
  for (const item of items) {
    if (item.hasAttribute('value')) ordinal = Number(item.getAttribute('value'));
    ordinals.set(item, ordinal);
    ordinal += step;
  }
}
function addEllipsis(container: HTMLElement, text: Text, before: boolean, gap = false): void {
  const boundary = ellipsisEdge(container, text, gap);
  const edge = gap ? splitInlineGap(text, boundary) : boundary;
  const trailing = gap ? ' … ' : ' …';
  const cue = container.ownerDocument.createTextNode(before ? '… ' : trailing);
  edge.parentNode?.insertBefore(cue, before ? edge : edge.nextSibling);
}
function ellipsisEdge(container: HTMLElement, text: Text, gap: boolean): Node {
  let edge: Node = text;
  for (
    let parent = text.parentElement;
    parent !== null && parent !== container;
    parent = parent.parentElement
  ) {
    if (blocks.has(parent.tagName)) break;
    if (!gap || parent.tagName === 'A' || parent.tagName === 'MARK') edge = parent;
  }
  return edge;
}

/** Split only non-interactive ancestors; anchors retain one contiguous original fragment. */
function splitInlineGap(text: Text, boundary: Node): Node {
  let edge: Node = text;
  while (edge !== boundary && edge.parentElement !== null) {
    const parent = edge.parentElement;
    if (parent.tagName !== 'A') splitFollowingSiblings(edge, parent);
    edge = parent;
  }
  return edge;
}
function splitFollowingSiblings(edge: Node, parent: HTMLElement): void {
  const remainder = parent.cloneNode(false);
  for (let next = edge.nextSibling; next !== null; next = edge.nextSibling)
    remainder.appendChild(next);
  if (remainder.hasChildNodes()) parent.parentNode?.insertBefore(remainder, parent.nextSibling);
}
