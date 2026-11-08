import { projectSearchText } from '../markdown/searchText';
import { renderedText, type TextRun } from './taskDescriptionExcerpt';
const limit = 16000;
const selector = '.abyss-text-difference';
function clear(element: HTMLElement): void {
  for (const fragment of element.querySelectorAll(selector)) {
    if (fragment.tagName === 'DEL') fragment.remove();
    else fragment.replaceWith(...fragment.childNodes);
  }
}
function normalized(text: string): { text: string; offsets: number[] } {
  const offsets: number[] = [];
  let value = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index] ?? '';
    if (/\s/u.test(character)) {
      if (value === '' || value.endsWith(' ')) continue;
      value += ' ';
    } else value += character;
    offsets.push(index);
  }
  return { text: value.trimEnd(), offsets };
}
function fragments(before: string, after: string): { start: number; end: number; removed: string } {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const a = [...segmenter.segment(before)].map((part) => part.segment);
  const b = [...segmenter.segment(after)].map((part) => part.segment);
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const sharedStart = b.slice(0, prefix).join('').length;
  const oldEnd = a.slice(0, a.length - suffix).join('').length;
  const newEnd = b.slice(0, b.length - suffix).join('').length;
  const start = Math.min(wordEdge(before, sharedStart, false), wordEdge(after, sharedStart, false));
  const extension = Math.max(
    wordEdge(before, oldEnd, true) - oldEnd,
    wordEdge(after, newEnd, true) - newEnd,
  );
  return { start, end: newEnd + extension, removed: before.slice(start, oldEnd + extension) };
}
function wordEdge(text: string, offset: number, end: boolean): number {
  for (const part of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    const stop = part.index + part.segment.length;
    if (part.index >= offset) break;
    if (stop > offset && part.isWordLike === true) return end ? stop : part.index;
  }
  return offset;
}

function deletion(element: HTMLElement, text: string): HTMLElement {
  const old = element.createEl('del');
  old.remove();
  old.className = 'abyss-text-difference';
  old.textContent = text;
  old.inert = true;
  return old;
}
function wrap(run: TextRun, start: number, end: number): void {
  const from = Math.max(start, run.start) - run.start;
  const to = Math.min(end, run.end) - run.start;
  if (from >= to) return;
  if (to < run.node.length) run.node.splitText(to);
  const text = from === 0 ? run.node : run.node.splitText(from);
  const inserted = run.node.parentElement?.createEl('ins');
  if (inserted === undefined) return;
  inserted.remove();
  inserted.className = 'abyss-text-difference';
  text.parentNode?.insertBefore(inserted, text);
  inserted.append(text);
}
/** Compare rendered text only. Native Markdown nodes, anchors and their listeners stay owned. */
export function decorateTaskTextDifference(
  element: HTMLElement,
  previous: string | undefined,
): void {
  clear(element);
  if (previous === undefined) return;
  if (previous.length > limit) {
    showBoundedPrevious(element, previous);
    return;
  }
  const before = normalized(projectSearchText(previous, 'prose').visible.text).text;
  const rendered = renderedText(element),
    current = normalized(rendered.text);
  if (before === current.text) return;
  if (Math.max(before.length, current.text.length) > limit) {
    showBoundedPrevious(element, before);
    return;
  }
  const difference = fragments(before, current.text);
  const start = current.offsets[difference.start] ?? rendered.text.length;
  const end =
    difference.end > difference.start ? (current.offsets[difference.end - 1] ?? start) + 1 : start;
  for (const run of [...rendered.runs].reverse()) wrap(run, start, end);
  if (difference.removed === '') return;
  insertDeletion(element, start, difference.removed);
}
function insertDeletion(element: HTMLElement, start: number, removed: string): void {
  const anchor = renderedText(element).runs.find((run) => run.end >= start && run.start <= start);
  const old = deletion(element, removed);
  if (anchor === undefined) element.append(old);
  else {
    const offset = Math.min(start - anchor.start, anchor.node.length);
    const insertion = anchor.node.parentElement?.closest('ins.abyss-text-difference');
    if (offset === 0 && insertion != null) insertion.before(old);
    else {
      const next = offset === 0 ? anchor.node : anchor.node.splitText(offset);
      next.parentNode?.insertBefore(old, next);
    }
  }
}

function showBoundedPrevious(element: HTMLElement, text: string): void {
  let end = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const next = part.index + part.segment.length;
    if (next > limit) break;
    end = next;
  }
  element.prepend(deletion(element, `${text.slice(0, end)}${end < text.length ? '…' : ''} `));
}
