const MAX_WINDOWS = 3;
const RETAINED_CHARACTERS = 240;
const LEADING_CONTEXT = 24;
export interface TextRange {
  start: number;
  end: number;
}
function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of [...ranges].sort((a, b) =>
    a.start === b.start ? a.end - b.end : a.start - b.start,
  )) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}
function intersects(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}
/** One anchor can retain only contiguous label text; its original handler must survive. */
function anchorCandidates(
  candidates: readonly TextRange[],
  anchors: readonly TextRange[],
): TextRange[] {
  const grouped: TextRange[] = [];
  let anchorAt = 0;
  for (const candidate of mergeRanges(candidates)) {
    while ((anchors[anchorAt]?.end ?? Infinity) <= candidate.start) anchorAt++;
    const anchor = anchors[anchorAt];
    const previous = grouped[grouped.length - 1];
    if (
      anchor !== undefined &&
      previous !== undefined &&
      intersects(candidate, anchor) &&
      intersects(previous, anchor)
    )
      previous.end = candidate.end;
    else grouped.push({ ...candidate });
  }
  return grouped;
}
function selectCandidates(
  text: string,
  candidates: readonly TextRange[],
  anchors: readonly TextRange[],
): TextRange[] {
  const selected: TextRange[] = [];
  for (const candidate of anchorCandidates(candidates, anchors)) {
    const previous = selected[selected.length - 1];
    if (
      previous !== undefined &&
      candidate.end - previous.start <= RETAINED_CHARACTERS / MAX_WINDOWS &&
      !text.slice(previous.start, candidate.end).includes('\n')
    )
      previous.end = candidate.end;
    else if (selected.length < MAX_WINDOWS) selected.push({ ...candidate });
    else break;
  }
  return selected;
}
export function planTaskDescriptionExcerpts(
  text: string,
  candidates: readonly TextRange[],
  anchors: readonly TextRange[],
): TextRange[] {
  const selected = selectCandidates(text, candidates, anchors);
  if (selected.length === 0) return [openingRange(text)];
  // Reserve a fair allocation for every distinct hit before adding any context.
  const allocation = Math.floor(RETAINED_CHARACTERS / selected.length);
  const windows = selected.map((match) => windowRange(text, match, allocation));
  let spare =
    RETAINED_CHARACTERS - windows.reduce((sum, range) => sum + range.end - range.start, 0);
  for (const [index, match] of selected.entries()) {
    const window = windows[index];
    if (window === undefined) continue;
    const needed = match.end - window.end;
    // Short labels can borrow unused allocation; an oversized hit remains safely shortened.
    if (needed > 0 && needed <= spare) {
      const expanded = windowRange(text, match, window.end - window.start + spare);
      spare -= expanded.end - expanded.start - (window.end - window.start);
      windows[index] = expanded;
    }
  }
  return contiguousAnchors(mergeRanges(windows), anchors);
}
function openingRange(text: string): TextRange {
  const start = safeStart(text, text.length - text.trimStart().length);
  const end = safeEnd(text, Math.min(text.length, start + RETAINED_CHARACTERS));
  return { start, end: start + text.slice(start, end).trimEnd().length };
}
function windowRange(text: string, match: TextRange, allocation: number): TextRange {
  const lineStart = text.lastIndexOf('\n', match.start - 1) + 1;
  const prefix = Math.max(lineStart, match.start - LEADING_CONTEXT);
  // Preserve the hit before spending its allocation on leading context.
  const leading = Math.min(
    match.start - prefix,
    Math.max(0, allocation - (match.end - match.start)),
  );
  const start = safeStart(text, match.start - leading);
  const newline = text.indexOf('\n', match.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const end = safeEnd(text, Math.min(lineEnd, start + allocation));
  return { start, end: start + text.slice(start, end).trimEnd().length };
}
function contiguousAnchors(windows: TextRange[], anchors: readonly TextRange[]): TextRange[] {
  for (const anchor of anchors) retainContiguousAnchor(windows, anchor);
  return windows.filter((window) => window.start < window.end);
}
function retainContiguousAnchor(windows: TextRange[], anchor: TextRange): void {
  const affected = windows.filter((window) => intersects(window, anchor));
  const first = affected[0],
    last = affected[affected.length - 1];
  if (first === undefined || last === undefined || first === last) return;
  const retained = rangeLength(windows),
    replaced = rangeLength(affected);
  if (retained - replaced + last.end - first.start <= RETAINED_CHARACTERS) {
    first.end = last.end;
    windows.splice(windows.indexOf(first) + 1, affected.length - 1);
  } else {
    for (const window of affected.slice(1)) window.start = Math.min(window.end, anchor.end);
  }
}
function rangeLength(ranges: readonly TextRange[]): number {
  return ranges.reduce((sum, range) => sum + range.end - range.start, 0);
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
