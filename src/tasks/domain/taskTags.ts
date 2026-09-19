const TAG_CHARACTER = String.raw`(?:[\p{L}\p{M}\p{N}\p{Pc}-]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D)`;
const VALID_TASK_TAG = new RegExp(String.raw`^#${TAG_CHARACTER}+(?:/${TAG_CHARACTER}+)*$`, 'u');
const MARKDOWN_TASK_TAG = new RegExp(
  String.raw`(?<!#)#${TAG_CHARACTER}+(?:/${TAG_CHARACTER}+)*(?!${TAG_CHARACTER}|/)`,
  'gu',
);
const ALL_NUMERIC = /^\p{N}+$/u;

function normalizeToken(token: string): string | undefined {
  const body = token.replace(/^#+/u, '');
  if (body.length === 0) return undefined;
  const tag = `#${body}`;
  if (!VALID_TASK_TAG.test(tag)) return undefined;
  return ALL_NUMERIC.test(body.replace(/\//gu, '')) ? undefined : tag;
}

/**
 * Normalizes user-facing task-tag input. Empty hash tokens are ignored, while any other invalid
 * token rejects the whole input so callers never partially apply a draft.
 */
export function normalizeTaskTagInput(input: string): readonly string[] | undefined {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.trim().split(/\s+/u)) {
    if (/^#*$/u.test(raw)) continue;
    const tag = normalizeToken(raw);
    if (tag === undefined) return undefined;
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** Prepends the configured Markdown fragment without interpreting prose or inline code as tags. */
function prefixTaskMarkdown(prefix: string, markdown: string): string {
  const normalizedPrefix = prefix.trim();
  return normalizedPrefix.length === 0 ? markdown : `${normalizedPrefix} ${markdown}`;
}

interface TagOccurrence {
  readonly tag: string;
  readonly from: number;
  readonly to: number;
}

function isEscaped(source: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && source[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function backtickRunLength(source: string, open: number): number {
  let length = 1;
  while (source[open + length] === '`') length += 1;
  return length;
}

function closingBacktickDelimiter(source: string, delimiter: string, from: number): number {
  let close = source.indexOf(delimiter, from);
  while (close >= 0 && (source[close - 1] === '`' || source[close + delimiter.length] === '`')) {
    close = source.indexOf(delimiter, close + 1);
  }
  return close;
}

function inlineCodeRanges(
  source: string,
): ReadonlyArray<{ readonly from: number; readonly to: number }> {
  const ranges: Array<{ readonly from: number; readonly to: number }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('`', cursor);
    if (open < 0) break;
    if (isEscaped(source, open)) {
      cursor = open + 1;
      continue;
    }
    const runLength = backtickRunLength(source, open);
    const delimiter = '`'.repeat(runLength);
    const close = closingBacktickDelimiter(source, delimiter, open + runLength);
    if (close < 0) {
      cursor = open + runLength;
      continue;
    }
    ranges.push({ from: open, to: close + runLength });
    cursor = close + runLength;
  }
  return ranges;
}

function tagOccurrences(source: string): readonly TagOccurrence[] {
  const code = inlineCodeRanges(source);
  const occurrences: TagOccurrence[] = [];
  for (const match of source.matchAll(MARKDOWN_TASK_TAG)) {
    const from = match.index;
    const tag = match[0];
    if (isEscaped(source, from) || code.some((range) => from >= range.from && from < range.to))
      continue;
    occurrences.push({ tag, from, to: from + tag.length });
  }
  return occurrences;
}

function removeOccurrences(source: string, occurrences: readonly TagOccurrence[]): string {
  let result = source;
  for (const occurrence of [...occurrences].reverse()) {
    let from = occurrence.from;
    let to = occurrence.to;
    if (/[ \t]/u.test(result[to] ?? '')) to += 1;
    else if (/[ \t]/u.test(result[from - 1] ?? '')) from -= 1;
    result = result.slice(0, from) + result.slice(to);
  }
  return result;
}

export interface TaskInboxTagPolicy {
  readonly mode: 'tag' | 'untagged' | 'both';
  readonly tag: string;
  readonly removeTagOnAssign: boolean;
}

/** Applies prefix text and the Inbox-removal rule to authored task Markdown. */
export function applyTaskCreationTagPolicy(
  prefix: string,
  markdown: string,
  inbox: TaskInboxTagPolicy,
): string {
  let combined = prefixTaskMarkdown(prefix, markdown);
  const seen = new Set<string>();
  const duplicates = tagOccurrences(combined).filter(({ tag }) => {
    if (seen.has(tag)) return true;
    seen.add(tag);
    return false;
  });
  combined = removeOccurrences(combined, duplicates);
  if (!inbox.removeTagOnAssign || inbox.mode === 'untagged') return combined;
  const inboxTags = normalizeTaskTagInput(inbox.tag);
  if (inboxTags?.length !== 1) return combined;
  const inboxTag = inboxTags[0];
  const occurrences = tagOccurrences(combined);
  if (inboxTag === undefined || !occurrences.some(({ tag }) => tag !== inboxTag)) return combined;
  return removeOccurrences(
    combined,
    occurrences.filter(({ tag }) => tag === inboxTag),
  );
}
