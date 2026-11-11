import { projectSearchText } from '../markdown/searchText';
import { renderedText, type TextRun } from './taskDescriptionExcerpt';
const limit = 16000;
const selector = '.abyss-text-difference';
function clear(element: HTMLElement): void {
  for (const fragment of element.querySelectorAll(selector)) {
    if (fragment.tagName === 'DEL' && !fragment.hasAttribute('data-retained-text'))
      fragment.remove();
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

type Difference = ReturnType<typeof fragments>;
type Word = Intl.SegmentData;
function lengthAt(table: Uint32Array, index: number): number {
  return table[index] ?? 0;
}
function wordAt(words: readonly Word[], index: number): Word {
  return words[index] ?? { segment: '', index: 0, input: '' };
}
function alignment(a: readonly Word[], b: readonly Word[]): Uint32Array {
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        wordAt(a, i).segment === wordAt(b, j).segment
          ? 1 + lengthAt(lengths, (i + 1) * width + j + 1)
          : Math.max(lengthAt(lengths, (i + 1) * width + j), lengthAt(lengths, i * width + j + 1));
  return lengths;
}
interface WordCursor {
  i: number;
  j: number;
  span: Difference;
  result: Difference[];
}
function flush(cursor: WordCursor): void {
  if (cursor.span.removed !== '' || cursor.span.start !== cursor.span.end)
    cursor.result.push({ ...cursor.span });
  cursor.span.removed = '';
}
function matchedWord(cursor: WordCursor, word: Word, base: number): void {
  const pending = cursor.span.removed !== '' || cursor.span.start !== cursor.span.end;
  if (word.segment.trim() === '' && pending) {
    cursor.span.removed += word.segment;
    cursor.span.end += word.segment.length;
  } else {
    flush(cursor);
    cursor.span.start = base + word.index + word.segment.length;
    cursor.span.end = cursor.span.start;
  }
  cursor.i++;
  cursor.j++;
}
function alignWords(a: readonly Word[], b: readonly Word[], base: number): Difference[] {
  const lengths = alignment(a, b),
    width = b.length + 1;
  const cursor: WordCursor = {
    i: 0,
    j: 0,
    span: { start: base, end: base, removed: '' },
    result: [],
  };
  while (cursor.i < a.length || cursor.j < b.length) {
    const { i, j } = cursor;
    const old = wordAt(a, i),
      next = wordAt(b, j);
    if (i < a.length && j < b.length && old.segment === next.segment)
      matchedWord(cursor, next, base);
    else if (
      i < a.length &&
      (j === b.length ||
        lengthAt(lengths, (i + 1) * width + j) >= lengthAt(lengths, i * width + j + 1))
    ) {
      cursor.span.removed += old.segment;
      cursor.i++;
    } else {
      cursor.span.end = base + next.index + next.segment.length;
      cursor.j++;
    }
  }
  flush(cursor);
  return cursor.result;
}
/** Bounded word alignment keeps unchanged phrases outside separate edits. */
function differences(before: string, after: string): Difference[] {
  const outer = fragments(before, after);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const a = [...segmenter.segment(outer.removed)];
  const b = [...segmenter.segment(after.slice(outer.start, outer.end))];
  // Long unrelated passages retain the bounded single-span fallback.
  return (a.length + 1) * (b.length + 1) > 262144 ? [outer] : alignWords(a, b, outer.start);
}

function deletion(element: HTMLElement, text: string): HTMLElement {
  const old = element.createEl('del');
  old.remove();
  old.className = 'abyss-text-difference';
  old.textContent = text;
  old.inert = true;
  return old;
}
function wrap(run: TextRun, start: number, end: number, removed = false): void {
  if (end <= run.start || start >= run.end) return;
  const slice = run.node.data.slice(
    Math.max(start, run.start) - run.start,
    Math.min(end, run.end) - run.start,
  );
  const leading = slice.length - slice.trimStart().length;
  const from = Math.max(start, run.start) - run.start + leading;
  const to = from + slice.trim().length;
  if (from >= to) return;
  if (to < run.node.length) run.node.splitText(to);
  const text = from === 0 ? run.node : run.node.splitText(from);
  wrapText(text, removed);
}
function wrapText(text: Text, removed: boolean): void {
  const inserted = text.parentElement?.createEl(removed ? 'del' : 'ins');
  if (inserted === undefined) return;
  inserted.remove();
  inserted.className = 'abyss-text-difference';
  if (removed) inserted.setAttribute('data-retained-text', '');
  text.parentNode?.insertBefore(inserted, text);
  inserted.append(text);
}
function comparisonText(
  previous: string,
  renderedPrevious: string | undefined,
): { source: string; text: string } {
  return {
    source: renderedPrevious ?? previous,
    text: normalized(renderedPrevious ?? projectSearchText(previous, 'prose').visible.text).text,
  };
}
/** Compare rendered text only. Native Markdown nodes, anchors and their listeners stay owned. */
export function decorateTaskTextDifference(
  element: HTMLElement,
  previous: string | undefined,
  renderedPrevious?: string,
  removed = false,
): void {
  clear(element);
  if (removed) {
    const rendered = renderedText(element);
    for (const run of [...rendered.runs].reverse()) wrap(run, run.start, run.end, true);
    return;
  }
  if (previous === undefined) return;
  const comparison = comparisonText(previous, renderedPrevious);
  if (comparison.source.length > limit) {
    showBoundedPrevious(element, comparison.source);
    return;
  }
  const before = comparison.text;
  const rendered = renderedText(element),
    current = normalized(rendered.text);
  if (before === current.text) return;
  if (Math.max(before.length, current.text.length) > limit) {
    showBoundedPrevious(element, before);
    return;
  }
  applyDifferences(element, differences(before, current.text), rendered, current.offsets);
}
function applyDifferences(
  element: HTMLElement,
  changes: Difference[],
  rendered: ReturnType<typeof renderedText>,
  offsets: readonly number[],
): void {
  changes.reverse();
  for (const difference of changes) {
    const start = offsets[difference.start] ?? rendered.text.length;
    const end =
      difference.end > difference.start ? (offsets[difference.end - 1] ?? start) + 1 : start;
    for (const run of [...rendered.runs].reverse()) wrap(run, start, end);
    if (difference.removed.trim() !== '') insertDeletion(element, start, difference.removed.trim());
  }
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
