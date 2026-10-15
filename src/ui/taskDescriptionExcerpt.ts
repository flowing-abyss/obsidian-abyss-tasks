import { matchSearchText, type PreparedSearchQuery, type SearchWordSegmenter } from '../tasks';

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

/** Display only: link source proof and event wiring must already be complete. */
export function compactTaskDescriptionExcerpt(
  container: HTMLElement,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
  preferredAnchor?: HTMLAnchorElement,
): void {
  const { text, runs, elements } = renderedText(container);
  const match = matchSearchText(text, query, segment)[0] ?? anchorRange(runs, preferredAnchor);
  const range = excerptRange(text, match);
  const ordinals = listOrdinals(elements);
  const { first, last } = trimTextRuns(runs, range);
  // The collector supplies postorder elements, so discarded children leave no hidden subtree.
  for (const element of elements) {
    if (discardElement(element, range)) element.node.remove();
  }
  for (const [item, ordinal] of ordinals) {
    if (container.contains(item)) item.setAttribute('value', String(ordinal));
  }
  if (first !== undefined && text.slice(0, range.start).trim() !== '')
    addEllipsis(container, first, true);
  if (last !== undefined && text.slice(range.end).trim() !== '')
    addEllipsis(container, last, false);
}
interface TextRange {
  readonly start: number;
  readonly end: number;
}
function anchorRange(runs: readonly TextRun[], anchor?: HTMLAnchorElement): TextRange | undefined {
  if (anchor === undefined) return undefined;
  const retained = runs.filter((run) => run.anchor === anchor);
  const first = retained[0],
    last = retained[retained.length - 1];
  return first === undefined || last === undefined
    ? undefined
    : { start: first.start, end: last.end };
}
function excerptRange(text: string, match: TextRange = { start: 0, end: 0 }): TextRange {
  const prefix = Math.max(text.lastIndexOf('\n', match.start - 1) + 1, match.start - 24);
  const start = safeStart(text, match.start - text.slice(prefix, match.start).trimStart().length);
  const end = safeEnd(text, Math.min(text.length, Math.max(start + 240, match.end)));
  return { start, end: start + text.slice(start, end).trimEnd().length };
}
function trimTextRuns(runs: readonly TextRun[], range: TextRange): { first?: Text; last?: Text } {
  let first: Text | undefined, last: Text | undefined;
  for (const run of runs) {
    const from = Math.max(range.start, run.start),
      to = Math.min(range.end, run.end);
    if (from >= to) run.node.remove();
    else {
      run.node.data = run.node.data.slice(from - run.start, to - run.start);
      first ??= run.node;
      last = run.node;
    }
  }
  return first === undefined || last === undefined ? {} : { first, last };
}
function discardElement(element: ElementRun, range: TextRange): boolean {
  return (
    element.start === element.end ||
    element.end <= range.start ||
    element.start >= range.end ||
    (element.node.childNodes.length === 0 && element.node.tagName !== 'BR')
  );
}
function safeStart(text: string, offset: number): number {
  let at = offset;
  if (/[\uDC00-\uDFFF]/u.test(text[at] ?? '')) at++;
  while (at < text.length && /\p{M}/u.test(String.fromCodePoint(text.codePointAt(at) ?? 0)))
    at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  return at;
}
function safeEnd(text: string, offset: number): number {
  let at = offset;
  if (/[\uDC00-\uDFFF]/u.test(text[at] ?? '')) at--;
  // If the boundary precedes a combining mark, omit its whole base/mark cluster.
  while (at > 0 && /\p{M}/u.test(String.fromCodePoint(text.codePointAt(at) ?? 0))) {
    at = previousPoint(text, at);
  }
  return at;
}
function previousPoint(text: string, at: number): number {
  return at - (/[\uDC00-\uDFFF]/u.test(text[at - 1] ?? '') ? 2 : 1);
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
function addEllipsis(container: HTMLElement, text: Text, before: boolean): void {
  let edge: Node = text;
  while (
    edge.parentElement !== null &&
    edge.parentElement !== container &&
    !blocks.has(edge.parentElement.tagName)
  )
    edge = edge.parentElement;
  const cue = container.ownerDocument.createTextNode(before ? '… ' : ' …');
  edge.parentNode?.insertBefore(cue, before ? edge : edge.nextSibling);
}
