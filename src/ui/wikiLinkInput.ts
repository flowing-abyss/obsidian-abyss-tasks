import { consumeMarkdownFenceLine, type MarkdownFence } from '../markdown/fences';

export interface WikiLinkInputRange {
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

function escaped(value: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && value[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/** Draft-only syntax; offsets use the text field's UTF-16 selection coordinates. */
export function wikiLinkInputRange(
  value: string,
  start: number,
  end: number,
): WikiLinkInputRange | undefined {
  if (!collapsedInBounds(value, start, end)) return undefined;
  const from = value.lastIndexOf('[[', start - 2);
  if (from < 0 || escaped(value, from)) return undefined;
  const query = value.slice(from + 2, start);
  if (/[[\]#|\r\n]/u.test(query) || codeAt(value, from)) return undefined;
  const remainder = value.slice(start).split(/[[\]\r\n]/u, 1)[0] ?? '';
  if (/[#|]/u.test(remainder)) return undefined;
  const close = value.indexOf(']]', start);
  if (close < 0 || /[[\]\r\n]/u.test(value.slice(start, close))) return { from, to: start, query };
  return { from, to: close + 2, query };
}

function collapsedInBounds(value: string, start: number, end: number): boolean {
  return start === end && start >= 2 && start <= value.length;
}

function codeAt(value: string, from: number): boolean {
  let fence: MarkdownFence | undefined;
  let ticks = 0;
  for (const line of value.slice(0, from + 2).split('\n')) {
    const next = consumeMarkdownFenceLine(fence, line);
    fence = next.fence;
    if (!next.isContent) {
      ticks = 0;
      continue;
    }
    ticks = inlineTicks(line, ticks);
  }
  return fence !== undefined || ticks !== 0;
}

function inlineTicks(line: string, initial: number): number {
  let ticks = initial;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`' || escaped(line, i)) continue;
    let length = 1;
    while (line[i + length] === '`') length++;
    if (ticks === 0) ticks = length;
    else if (ticks === length) ticks = 0;
    i += length - 1;
  }
  return ticks;
}
