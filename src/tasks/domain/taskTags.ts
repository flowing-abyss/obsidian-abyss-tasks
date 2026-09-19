import { isCanonicalTaskTag, parseTaskLineSourceModel } from './taskLineSourceModel';

function normalizeToken(token: string): string | undefined {
  const body = token.replace(/^#+/u, '');
  if (body.length === 0) return undefined;
  const tag = `#${body}`;
  return isCanonicalTaskTag(tag) ? tag : undefined;
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

function tagOccurrences(source: string, rootLine: boolean): readonly TagOccurrence[] {
  const prefix = rootLine ? '- [ ] ' : '';
  const model = parseTaskLineSourceModel(`${prefix}${source}`);
  if (model === null) return [];
  return (model.occurrences.get('tag') ?? []).map(({ from, to }) => ({
    tag: model.original.slice(from, to),
    from: from - prefix.length,
    to: to - prefix.length,
  }));
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

export interface TaskTagChange {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export interface TaskCreationTagPolicyResult {
  readonly markdown: string;
  readonly tags?: TaskTagChange;
}

function sourceLines(source: string): readonly string[] {
  const lines: string[] = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf('\n', from);
    if (newline < 0) {
      lines.push(source.slice(from));
      break;
    }
    lines.push(source.slice(from, newline + 1));
    from = newline + 1;
  }
  return lines;
}

function withoutLineEnding(source: string): { readonly content: string; readonly ending: string } {
  if (source.endsWith('\r\n')) return { content: source.slice(0, -2), ending: '\r\n' };
  if (source.endsWith('\n')) return { content: source.slice(0, -1), ending: '\n' };
  return { content: source, ending: '' };
}

function duplicateOccurrences(occurrences: readonly TagOccurrence[]): readonly TagOccurrence[] {
  const seen = new Set<string>();
  return occurrences.filter(({ tag }) => {
    if (seen.has(tag)) return true;
    seen.add(tag);
    return false;
  });
}

function configuredInboxTag(inbox: TaskInboxTagPolicy): string | undefined {
  if (!inbox.removeTagOnAssign || inbox.mode === 'untagged') return undefined;
  const tags = normalizeTaskTagInput(inbox.tag);
  return tags?.length === 1 ? tags[0] : undefined;
}

function rootTagsAfterInitial(
  occurrences: readonly TagOccurrence[],
  initial: TaskTagChange | undefined,
): ReadonlySet<string> {
  const removed = new Set(initial?.remove ?? []);
  return new Set([
    ...occurrences.map(({ tag }) => tag).filter((tag) => !removed.has(tag)),
    ...(initial?.add ?? []).filter((tag) => !removed.has(tag)),
  ]);
}

function linePolicy(
  source: string,
  rootLine: boolean,
  inboxTag: string | undefined,
  initial: TaskTagChange | undefined,
): { readonly markdown: string; readonly removesInbox: boolean } {
  const occurrences = tagOccurrences(source, rootLine);
  const duplicates = duplicateOccurrences(occurrences);
  const tags = rootLine
    ? rootTagsAfterInitial(occurrences, initial)
    : new Set(occurrences.map(({ tag }) => tag));
  const removesInbox = inboxTag !== undefined && [...tags].some((tag) => tag !== inboxTag);
  const inboxAlreadyRemoved =
    inboxTag !== undefined && initial?.remove?.includes(inboxTag) === true;
  const inboxOccurrences =
    removesInbox && !inboxAlreadyRemoved ? occurrences.filter(({ tag }) => tag === inboxTag) : [];
  const removals = [
    ...new Map([...duplicates, ...inboxOccurrences].map((item) => [item.from, item])).values(),
  ].sort((left, right) => left.from - right.from);
  return { markdown: removeOccurrences(source, removals), removesInbox };
}

function withoutInitialInbox(
  initial: TaskTagChange,
  inboxTag: string | undefined,
  removesInbox: boolean,
): TaskTagChange {
  if (inboxTag === undefined || !removesInbox) return initial;
  return {
    ...initial,
    ...(initial.add !== undefined && { add: initial.add.filter((tag) => tag !== inboxTag) }),
  };
}

/** Applies prefix text, per-task deduplication, and Inbox removal to authored task Markdown. */
export function applyTaskCreationTagPolicy(
  prefix: string,
  markdown: string,
  inbox: TaskInboxTagPolicy,
  initial?: TaskTagChange,
): TaskCreationTagPolicyResult {
  const combined = prefixTaskMarkdown(prefix, markdown);
  const inboxTag = configuredInboxTag(inbox);
  let rootRemovesInbox = false;
  const lines = sourceLines(combined).map((line, index) => {
    const { content, ending } = withoutLineEnding(line);
    const result = linePolicy(content, index === 0, inboxTag, index === 0 ? initial : undefined);
    if (index === 0) rootRemovesInbox = result.removesInbox;
    return `${result.markdown}${ending}`;
  });
  return {
    markdown: lines.join(''),
    ...(initial !== undefined && {
      tags: withoutInitialInbox(initial, inboxTag, rootRemovesInbox),
    }),
  };
}
