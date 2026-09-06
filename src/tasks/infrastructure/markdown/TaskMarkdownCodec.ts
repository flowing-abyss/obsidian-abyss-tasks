import { parseLinks } from '../../../markdown/links';
import { type StatusCatalog } from '../../domain/StatusCatalog';
import { parseRecurrenceRule } from '../../domain/recurrence';
import {
  editRecurrenceIterationTaskLine,
  type RecurrenceTaskLineEdit,
  type RecurrenceTaskLineEditResult,
} from '../../domain/recurrenceIteration';
import {
  isTaskDependencyId,
  parseTaskLineSourceModel,
  type TaskLineSourceModel,
} from '../../domain/taskLineSourceModel';
import type {
  OnCompletion,
  TaskPriority,
  TaskStatus,
  TaskStatusRule,
  TaskStatusType,
} from '../../domain/types';
import {
  formatDurationMinutes,
  isSingleLineText,
  localDate,
  localTime,
  type TaskIssue,
  type TaskValidationField,
  type TaskValidationState,
  durationMinutes as validatedDurationMinutes,
  validateTaskChange,
} from '../../domain/validation';

export type LineEdit =
  | { readonly type: 'set-title'; readonly markdownTitle: string }
  | { readonly type: 'append-title'; readonly markdown: string }
  | { readonly type: 'edit-link'; readonly occurrence: number; readonly replacement: string }
  | {
      readonly type: 'set-status';
      readonly symbol: string;
      readonly today?: string;
      readonly addCompletionDate?: boolean;
    }
  | { readonly type: 'set-priority'; readonly priority: TaskPriority }
  | {
      readonly type: 'set-date';
      readonly field: 'due' | 'scheduled' | 'start';
      readonly value: string | null;
    }
  | { readonly type: 'set-time'; readonly value: string | null }
  | { readonly type: 'set-duration'; readonly value: number | null }
  | { readonly type: 'set-recurrence'; readonly value: string | null }
  | { readonly type: 'set-on-completion'; readonly value: OnCompletion | null }
  | { readonly type: 'set-dependency-id'; readonly value: string | null }
  | { readonly type: 'set-depends-on'; readonly values: readonly string[] }
  | {
      readonly type: 'change-tags';
      readonly add: readonly string[];
      readonly remove: readonly string[];
    };

export type LineEditResult =
  | { readonly type: 'changed'; readonly content: string }
  | { readonly type: 'unchanged'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

type PreparedLineEdit =
  | {
      readonly type: 'prepared';
      readonly content: string;
      readonly fields: readonly TaskValidationField[];
    }
  | Extract<LineEditResult, { readonly type: 'unchanged' | 'invalid' }>;

type TitleLineEdit = Extract<
  LineEdit,
  { readonly type: 'set-title' | 'append-title' | 'edit-link' }
>;

type DependencyLineEdit = Extract<
  LineEdit,
  { readonly type: 'set-dependency-id' | 'set-depends-on' }
>;

type PlanningLineEdit = Extract<
  LineEdit,
  { readonly type: 'set-date' | 'set-time' | 'set-duration' }
>;

type StatusStampKind = 'completion' | 'cancelled';

type StatusContentResult =
  | { readonly type: 'content'; readonly content: string }
  | Extract<LineEditResult, { readonly type: 'invalid' }>;

type StatusTransitionPreparation =
  | {
      readonly type: 'status-transition';
      readonly stampedKind: StatusStampKind | undefined;
      readonly preservedStamp: StatusStampKind | undefined;
    }
  | Extract<PreparedLineEdit, { readonly type: 'unchanged' | 'invalid' }>;

type AppliedLineEdit =
  | {
      readonly type: 'applied';
      readonly content: string;
      readonly parsed: ParsedTaskLine;
      readonly fields: readonly TaskValidationField[];
    }
  | Extract<LineEditResult, { readonly type: 'unchanged' | 'invalid' }>;

export type TaskSpanKind =
  | 'prefix'
  | 'title'
  | 'tag'
  | 'priority'
  | 'recurrence'
  | 'on-completion'
  | 'created'
  | 'start'
  | 'scheduled'
  | 'due'
  | 'completion'
  | 'cancelled'
  | 'time'
  | 'duration'
  | 'task-id'
  | 'depends-on'
  | 'block-id'
  | 'malformed-known'
  | 'separator'
  | 'unknown';

export interface SourceSpan {
  readonly kind: TaskSpanKind;
  readonly from: number;
  readonly to: number;
  readonly malformedKind?: Exclude<
    TaskSpanKind,
    'prefix' | 'title' | 'tag' | 'malformed-known' | 'separator' | 'unknown'
  >;
}

export interface ParsedTaskLine {
  readonly original: string;
  readonly lineEnding: '' | '\n' | '\r\n';
  readonly statusSymbol: string;
  readonly markdownTitle: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly dependencyId?: string;
  readonly dependsOn: readonly string[];
  readonly spans: readonly SourceSpan[];
  readonly occurrences: ReadonlyMap<TaskSpanKind, readonly SourceSpan[]>;
  readonly planning: {
    readonly due?: string;
    readonly created?: string;
    readonly scheduled?: string;
    readonly start?: string;
    readonly completion?: string;
    readonly cancelled?: string;
    readonly time?: string;
    readonly duration?: number;
  };
  readonly priority: TaskPriority;
  readonly recurrence?: string;
  readonly onCompletion: OnCompletion;
  readonly onCompletionExplicit: boolean;
  readonly source: {
    readonly filePath: string;
    readonly line: number;
    readonly originalMarkdown: string;
  };
}

interface ParseSource {
  readonly filePath: string;
  readonly line: number;
}

const MARKER_BY_FIELD: Readonly<Record<TaskValidationField, string>> = {
  title: '',
  status: '',
  due: '📅',
  scheduled: '⏳',
  start: '🛫',
  completion: '✅',
  cancelled: '❌',
  time: '⏰',
  duration: '⏱️',
  recurrence: '🔁',
  'on-completion': '🏁',
};

const SPAN_KIND_BY_FIELD: Readonly<Partial<Record<TaskValidationField, TaskSpanKind>>> = {
  due: 'due',
  scheduled: 'scheduled',
  start: 'start',
  completion: 'completion',
  cancelled: 'cancelled',
  time: 'time',
  duration: 'duration',
  recurrence: 'recurrence',
  'on-completion': 'on-completion',
};

const TOKEN_BY_PRIORITY: Readonly<Record<TaskPriority, string>> = {
  A: '🔺',
  B: '⏫',
  C: '🔼',
  D: '',
  E: '🔽',
  F: '⏬',
};

const TOKEN_RANK: Readonly<Partial<Record<TaskSpanKind, number>>> = {
  time: 10,
  duration: 20,
  priority: 30,
  recurrence: 40,
  'on-completion': 45,
  created: 50,
  start: 60,
  scheduled: 70,
  due: 80,
  cancelled: 90,
  completion: 100,
};

const METADATA_KINDS = new Set<TaskSpanKind>([
  'priority',
  'recurrence',
  'on-completion',
  'created',
  'start',
  'scheduled',
  'due',
  'completion',
  'cancelled',
  'time',
  'duration',
  'task-id',
  'depends-on',
  'block-id',
  'malformed-known',
]);

const TITLE_SEMANTIC_KINDS = new Set<TaskSpanKind>([...METADATA_KINDS, 'tag']);

const DATE_SPAN_KINDS = new Set<TaskSpanKind>([
  'created',
  'start',
  'scheduled',
  'due',
  'cancelled',
  'completion',
]);

const WIKILINK_ALIAS_RE = /\[\[([^|[\]]+)\|([^[\]]+)\]\]/gu;
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/gu;
const MD_LINK_RE = /\[([^[\]]+)\]\(([^)]+)\)/gu;
const BRACKETS_RE = /\[([^[\]]*)\]/gu;

function collapseLinks(input: string): string {
  return input
    .replace(WIKILINK_ALIAS_RE, '🔗$1')
    .replace(WIKILINK_RE, (_match, link: string) => `🔗 ${link.replace(/\.[^.]*$/u, '')}`)
    .replace(MD_LINK_RE, '🌐 $1')
    .replace(BRACKETS_RE, '$1');
}

function spliceSource(source: string, from: number, to: number, replacement: string): string {
  return source.slice(0, from) + replacement + source.slice(to);
}

function removeSpan(source: string, span: SourceSpan): string {
  let from = span.from;
  let to = span.to;
  if (source[from - 1] === ' ') from--;
  else if (source[to] === ' ') to++;
  return spliceSource(source, from, to, '');
}

function isSemanticTitleSpan(span: SourceSpan): boolean {
  return span.kind === 'title' || span.kind === 'unknown';
}

function isIgnoredTitleSpan(span: SourceSpan, contentEnd: number): boolean {
  return span.kind === 'prefix' || (span.kind === 'separator' && span.from === contentEnd);
}

function appendTitleFragment(fragments: SourceSpan[], fragment: SourceSpan | null): void {
  if (fragment != null) fragments.push(fragment);
}

function extendTitleFragment(fragment: SourceSpan | null, span: SourceSpan): SourceSpan {
  return {
    kind: 'title',
    from: fragment === null ? span.from : fragment.from,
    to: span.to,
  };
}

function semanticTitleFragments(
  spans: readonly SourceSpan[],
  contentEnd: number,
): readonly SourceSpan[] {
  const fragments: SourceSpan[] = [];
  let fragment: SourceSpan | null = null;
  for (const span of spans) {
    if (isIgnoredTitleSpan(span, contentEnd)) continue;
    if (isSemanticTitleSpan(span)) {
      fragment = extendTitleFragment(fragment, span);
      continue;
    }
    if (span.kind === 'separator' && fragment != null) continue;
    appendTitleFragment(fragments, fragment);
    fragment = null;
  }
  appendTitleFragment(fragments, fragment);
  return fragments;
}

function isValidRankedSpan(parsed: ParsedTaskLine, span: SourceSpan, rank: number): boolean {
  const candidateRank = TOKEN_RANK[span.kind];
  if (candidateRank === undefined || candidateRank <= rank) return false;
  const raw = parsed.original.slice(span.from, span.to);
  try {
    if (DATE_SPAN_KINDS.has(span.kind)) localDate(raw.slice(-10));
    else if (span.kind === 'time') localTime(raw.slice(-5));
  } catch {
    return false;
  }
  return true;
}

function rankedInsertionSpan(parsed: ParsedTaskLine, rank: number): SourceSpan | undefined {
  return parsed.spans.find((span) => isValidRankedSpan(parsed, span, rank));
}

function firstOccurrenceFrom(parsed: ParsedTaskLine, kind: TaskSpanKind): number {
  return parsed.occurrences.get(kind)?.[0]?.from ?? Infinity;
}

function relationCarrierInsertionPoint(parsed: ParsedTaskLine, kind: TaskSpanKind): number {
  if (kind !== 'recurrence' && kind !== 'on-completion') return Infinity;
  return Math.min(
    firstOccurrenceFrom(parsed, 'task-id'),
    firstOccurrenceFrom(parsed, 'depends-on'),
    firstOccurrenceFrom(parsed, 'block-id'),
  );
}

function fallbackInsertionPoint(parsed: ParsedTaskLine): number {
  return (
    parsed.occurrences.get('block-id')?.[0]?.from ??
    parsed.original.length - parsed.lineEnding.length
  );
}

function dependencyCarrierInsertionPoint(
  parsed: ParsedTaskLine,
  kind: 'task-id' | 'depends-on',
): number {
  const blockId = firstOccurrenceFrom(parsed, 'block-id');
  const carrier =
    kind === 'task-id' ? Math.min(firstOccurrenceFrom(parsed, 'depends-on'), blockId) : blockId;
  return carrier === Infinity ? parsed.original.length - parsed.lineEnding.length : carrier;
}

function insertionPoint(parsed: ParsedTaskLine, kind: TaskSpanKind): number {
  if (kind === 'task-id' || kind === 'depends-on') {
    return dependencyCarrierInsertionPoint(parsed, kind);
  }
  const rank = TOKEN_RANK[kind];
  if (rank === undefined) return fallbackInsertionPoint(parsed);
  const later = rankedInsertionSpan(parsed, rank);
  const carrierAt = relationCarrierInsertionPoint(parsed, kind);
  if (later != null) return Math.min(later.from, carrierAt);
  return carrierAt === Infinity ? fallbackInsertionPoint(parsed) : carrierAt;
}

function insertToken(parsed: ParsedTaskLine, kind: TaskSpanKind, token: string): string {
  const at = insertionPoint(parsed, kind);
  const before = parsed.original[at - 1];
  const after = parsed.original[at];
  const left = before === undefined || /\s/u.test(before) ? '' : ' ';
  const right = after === undefined || /\s/u.test(after) ? '' : ' ';
  return spliceSource(parsed.original, at, at, `${left}${token}${right}`);
}

function invalid(
  code: TaskIssue['code'],
  field?: string,
): Extract<LineEditResult, { readonly type: 'invalid' }> {
  return { type: 'invalid', issues: [{ code, ...(field !== undefined && { field }) }] };
}

function normalizedTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)))];
}

function tagsAreValid(tags: Iterable<string>): boolean {
  return [...tags].every((tag) => /^#[\w/-]+$/u.test(tag));
}

function contentWithoutTags(parsed: ParsedTaskLine, removals: ReadonlySet<string>): string {
  let content = parsed.original;
  for (const span of [...(parsed.occurrences.get('tag') ?? [])].reverse()) {
    const tag = parsed.original.slice(span.from, span.to);
    if (removals.has(tag)) content = removeSpan(content, span);
  }
  return content;
}

function insertTags(
  content: string,
  parsed: ParsedTaskLine,
  tags: readonly string[],
): PreparedLineEdit {
  const occurrences = parsed.occurrences.get('tag') ?? [];
  const lastTag = occurrences[occurrences.length - 1];
  if (lastTag != null) {
    return {
      type: 'prepared',
      content: spliceSource(content, lastTag.to, lastTag.to, ` ${tags.join(' ')}`),
      fields: [],
    };
  }
  const protectedSpan = parsed.spans.find(
    (span) => METADATA_KINDS.has(span.kind) || span.kind === 'block-id',
  );
  const at = protectedSpan?.from ?? content.length - parsed.lineEnding.length;
  const left = /\s/u.test(content[at - 1] ?? '') ? '' : ' ';
  const right = /\s/u.test(content[at] ?? '') || at === content.length ? '' : ' ';
  return {
    type: 'prepared',
    content: spliceSource(content, at, at, `${left}${tags.join(' ')}${right}`),
    fields: [],
  };
}

function hasMalformedKind(parsed: ParsedTaskLine, kind: TaskSpanKind): boolean {
  return parsed.spans.some(
    (span) => span.kind === 'malformed-known' && span.malformedKind === kind,
  );
}

function hasUnparsedOccurrence(
  parsed: ParsedTaskLine,
  kind: TaskSpanKind,
  value: unknown,
): boolean {
  return (parsed.occurrences.get(kind)?.length ?? 0) > 0 && value === undefined;
}

function replaceExistingTitle(
  parsed: ParsedTaskLine,
  fragments: readonly SourceSpan[],
  markdownTitle: string,
): string {
  const first = fragments[0];
  if (first == null) return parsed.original;
  let content = parsed.original;
  const removals = markdownTitle.length > 0 ? fragments.slice(1) : fragments;
  for (const fragment of [...removals].reverse()) content = removeSpan(content, fragment);
  return markdownTitle.length > 0
    ? spliceSource(content, first.from, first.to, markdownTitle)
    : content;
}

function insertTitleBeforeMetadata(parsed: ParsedTaskLine, markdownTitle: string): string {
  const contentEnd = parsed.original.length - parsed.lineEnding.length;
  const firstProtected = parsed.spans.find(
    (span) => span.kind !== 'prefix' && span.kind !== 'separator',
  );
  const at = firstProtected?.from ?? contentEnd;
  const left = /\s/u.test(parsed.original[at - 1] ?? '') ? '' : ' ';
  const right = /\s/u.test(parsed.original[at] ?? '') || at === contentEnd ? '' : ' ';
  return spliceSource(parsed.original, at, at, `${left}${markdownTitle}${right}`);
}

function statusStampKind(type: TaskStatusType): StatusStampKind | undefined {
  if (type === 'done') return 'completion';
  return type === 'cancelled' ? 'cancelled' : undefined;
}

function validStatusTarget(
  symbol: string,
  rule: TaskStatusRule | undefined,
): rule is TaskStatusRule {
  return symbol.length === 1 && rule !== undefined;
}

function statusDateIsMissing(
  stampedKind: StatusStampKind | undefined,
  preservesStamp: boolean,
  today: string | undefined,
): boolean {
  return stampedKind !== undefined && !preservesStamp && today === undefined;
}

function isTitleLineEdit(edit: LineEdit): edit is TitleLineEdit {
  return edit.type === 'set-title' || edit.type === 'append-title' || edit.type === 'edit-link';
}

function isDependencyLineEdit(edit: LineEdit): edit is DependencyLineEdit {
  return edit.type === 'set-dependency-id' || edit.type === 'set-depends-on';
}

function isPlanningLineEdit(edit: LineEdit): edit is PlanningLineEdit {
  return edit.type === 'set-date' || edit.type === 'set-time' || edit.type === 'set-duration';
}

function invalidRecurrenceValue(
  value: string | null,
): Extract<LineEditResult, { readonly type: 'invalid' }> | null {
  if (value === null) return null;
  if (!isSingleLineText(value)) return invalid('invalid-target', 'recurrence');
  const recurrence = parseRecurrenceRule(value);
  return recurrence.type === 'invalid' ? invalid(recurrence.code, 'recurrence') : null;
}

function malformedFields(parsed: ParsedTaskLine): ReadonlySet<TaskValidationField> {
  const malformed = new Set<TaskValidationField>();
  for (const [field, kind] of Object.entries(SPAN_KIND_BY_FIELD) as Array<
    [TaskValidationField, TaskSpanKind]
  >) {
    if (hasMalformedKind(parsed, kind)) malformed.add(field);
  }
  if (hasUnparsedOccurrence(parsed, 'duration', parsed.planning.duration))
    malformed.add('duration');
  if (hasUnparsedOccurrence(parsed, 'recurrence', parsed.recurrence)) malformed.add('recurrence');
  return malformed;
}

function duplicateIssue(parsed: ParsedTaskLine, kind: TaskSpanKind, field: string): TaskIssue[] {
  return (parsed.occurrences.get(kind)?.length ?? 0) > 1
    ? [{ code: 'duplicate-field', field }]
    : [];
}

function malformedTargetIssue(parsed: ParsedTaskLine, field: TaskValidationField): TaskIssue[] {
  if (!malformedFields(parsed).has(field)) return [];
  if (field === 'time') return [{ code: 'invalid-time', field }];
  if (field === 'duration') return [{ code: 'invalid-duration', field }];
  if (field === 'on-completion') return [{ code: 'invalid-on-completion', field }];
  if (field === 'recurrence') return [{ code: 'unparseable-rule', field }];
  return [{ code: 'invalid-date', field }];
}

function replaceOrInsertToken(
  parsed: ParsedTaskLine,
  kind: TaskSpanKind,
  token: string | null,
): string {
  const occurrence = parsed.occurrences.get(kind)?.[0];
  if (occurrence != null) {
    return token === null
      ? removeSpan(parsed.original, occurrence)
      : spliceSource(parsed.original, occurrence.from, occurrence.to, token);
  }
  return token === null ? parsed.original : insertToken(parsed, kind, token);
}

function editableTitleFragments(parsed: ParsedTaskLine): readonly SourceSpan[] {
  const contentEnd = parsed.original.length - parsed.lineEnding.length;
  return semanticTitleFragments(parsed.spans, contentEnd);
}

function replaceTitle(parsed: ParsedTaskLine, markdownTitle: string): string {
  const fragments = editableTitleFragments(parsed);
  return fragments.length > 0
    ? replaceExistingTitle(parsed, fragments, markdownTitle)
    : insertTitleBeforeMetadata(parsed, markdownTitle);
}

function appendTitle(parsed: ParsedTaskLine, markdown: string): string {
  const fragments = editableTitleFragments(parsed);
  const last = fragments[fragments.length - 1];
  if (last == null) return replaceTitle(parsed, markdown);
  return spliceSource(parsed.original, last.to, last.to, ` ${markdown}`);
}

function editTitleLink(
  parsed: ParsedTaskLine,
  occurrence: number,
  replacement: string,
): PreparedLineEdit {
  if (!Number.isInteger(occurrence) || occurrence < 0) return invalid('invalid-target', 'link');
  let remaining = occurrence;
  for (const fragment of editableTitleFragments(parsed)) {
    const source = parsed.original.slice(fragment.from, fragment.to);
    const links = parseLinks(source);
    if (remaining >= links.length) {
      remaining -= links.length;
      continue;
    }
    const link = links[remaining];
    if (link == null) return invalid('invalid-target', 'link');
    return {
      type: 'prepared',
      content: spliceSource(
        parsed.original,
        fragment.from + link.index,
        fragment.from + link.index + link.raw.length,
        replacement,
      ),
      fields: ['title'],
    };
  }
  return invalid('invalid-target', 'link');
}

function statusTransitionIssues(parsed: ParsedTaskLine): readonly TaskIssue[] {
  const issues: TaskIssue[] = [];
  for (const field of ['completion', 'cancelled'] as const) {
    issues.push(...duplicateIssue(parsed, field, field));
    issues.push(...malformedTargetIssue(parsed, field));
  }
  return issues;
}

function preparePriorityEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-priority' }>,
): PreparedLineEdit {
  const issues = duplicateIssue(parsed, 'priority', 'priority');
  if (issues.length > 0) return { type: 'invalid', issues };
  const occurrences = parsed.occurrences.get('priority')?.length ?? 0;
  if (parsed.priority === edit.priority && (edit.priority !== 'D' || occurrences === 0)) {
    return unchangedLine(parsed);
  }
  const priorityToken = TOKEN_BY_PRIORITY[edit.priority];
  const content = replaceOrInsertToken(
    parsed,
    'priority',
    priorityToken.length === 0 ? null : priorityToken,
  );
  return { type: 'prepared', content, fields: [] };
}

function prepareDateEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-date' }>,
): PreparedLineEdit {
  const issues = [
    ...duplicateIssue(parsed, edit.field, edit.field),
    ...malformedTargetIssue(parsed, edit.field),
  ];
  if (issues.length > 0) return { type: 'invalid', issues };
  const current = parsed.planning[edit.field];
  if (
    (edit.value === null && current === undefined) ||
    (edit.value !== null && current === edit.value)
  ) {
    return unchangedLine(parsed);
  }
  const marker = MARKER_BY_FIELD[edit.field];
  const token = edit.value === null ? null : `${marker} ${edit.value}`;
  return preparedToken(parsed, edit.field, token, [edit.field]);
}

function prepareTimeEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-time' }>,
): PreparedLineEdit {
  const issues = [
    ...duplicateIssue(parsed, 'time', 'time'),
    ...malformedTargetIssue(parsed, 'time'),
  ];
  if (issues.length > 0) return { type: 'invalid', issues };
  const current = parsed.planning.time;
  if (
    (edit.value === null && current === undefined) ||
    (edit.value !== null && current === edit.value)
  ) {
    return unchangedLine(parsed);
  }
  return preparedToken(parsed, 'time', edit.value === null ? null : `⏰ ${edit.value}`, ['time']);
}

function prepareDurationEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-duration' }>,
): PreparedLineEdit {
  const issues = [
    ...duplicateIssue(parsed, 'duration', 'duration'),
    ...malformedTargetIssue(parsed, 'duration'),
  ];
  if (issues.length > 0) return { type: 'invalid', issues };
  const current = parsed.planning.duration;
  if (
    (edit.value === null && current === undefined) ||
    (edit.value !== null && current === edit.value)
  ) {
    return unchangedLine(parsed);
  }
  let token: string | null = null;
  if (edit.value !== null) {
    try {
      token = `⏱️ ${formatDurationMinutes(validatedDurationMinutes(edit.value))}`;
    } catch {
      return invalid('invalid-duration', 'duration');
    }
  }
  return preparedToken(parsed, 'duration', token, ['duration']);
}

function unchangedLine(parsed: ParsedTaskLine): Extract<PreparedLineEdit, { type: 'unchanged' }> {
  return { type: 'unchanged', content: parsed.original };
}

function preparedToken(
  parsed: ParsedTaskLine,
  kind: TaskSpanKind,
  token: string | null,
  fields: readonly TaskValidationField[],
): PreparedLineEdit {
  return { type: 'prepared', content: replaceOrInsertToken(parsed, kind, token), fields };
}

function prepareRecurrenceEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-recurrence' }>,
): PreparedLineEdit {
  const valueIssue = invalidRecurrenceValue(edit.value);
  if (valueIssue !== null) return valueIssue;
  const issues = [
    ...duplicateIssue(parsed, 'recurrence', 'recurrence'),
    ...malformedTargetIssue(parsed, 'recurrence'),
  ];
  if (issues.length > 0) return { type: 'invalid', issues };
  if (
    (edit.value === null && parsed.recurrence === undefined) ||
    (edit.value !== null && parsed.recurrence === edit.value)
  ) {
    return unchangedLine(parsed);
  }
  return preparedToken(parsed, 'recurrence', edit.value === null ? null : `🔁 ${edit.value}`, [
    'recurrence',
  ]);
}

function prepareOnCompletionEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-on-completion' }>,
): PreparedLineEdit {
  if (edit.value !== null && !isSingleLineText(edit.value)) {
    return invalid('invalid-target', 'on-completion');
  }
  const issues = [
    ...duplicateIssue(parsed, 'on-completion', 'on-completion'),
    ...malformedTargetIssue(parsed, 'on-completion'),
  ];
  if (issues.length > 0) return { type: 'invalid', issues };
  if (
    (edit.value === null && !parsed.onCompletionExplicit) ||
    (edit.value !== null && parsed.onCompletionExplicit && parsed.onCompletion === edit.value)
  ) {
    return unchangedLine(parsed);
  }
  return preparedToken(parsed, 'on-completion', edit.value === null ? null : `🏁 ${edit.value}`, [
    'on-completion',
  ]);
}

function dependencyEditValues(
  parsed: ParsedTaskLine,
  edit: DependencyLineEdit,
): {
  readonly kind: 'task-id' | 'depends-on';
  readonly field: 'dependency-id' | 'depends-on';
  readonly marker: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
} {
  return edit.type === 'set-dependency-id'
    ? {
        kind: 'task-id' as const,
        field: 'dependency-id' as const,
        marker: '🆔',
        before: parsed.dependencyId === undefined ? [] : [parsed.dependencyId],
        after: edit.value === null ? [] : [edit.value],
      }
    : {
        kind: 'depends-on' as const,
        field: 'depends-on' as const,
        marker: '⛔',
        before: parsed.dependsOn,
        after: edit.values,
      };
}

function prepareDependencyLineEdit(
  parsed: ParsedTaskLine,
  edit: DependencyLineEdit,
): PreparedLineEdit {
  const { kind, field, marker, before, after } = dependencyEditValues(parsed, edit);
  if (!after.every(isTaskDependencyId)) return invalid('invalid-target', field);
  const issues = duplicateIssue(parsed, kind, field);
  if (issues.length > 0) return { type: 'invalid', issues };
  if (hasMalformedKind(parsed, kind)) return invalid('invalid-target', field);
  if (before.length === after.length && before.every((value, index) => value === after[index]))
    return unchangedLine(parsed);
  return preparedToken(
    parsed,
    kind,
    after.length === 0 ? null : `${marker} ${after.join(', ')}`,
    [],
  );
}

function prepareSetTitleEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-title' }>,
): PreparedLineEdit {
  if (!isSingleLineText(edit.markdownTitle)) return invalid('invalid-target', 'title');
  return parsed.markdownTitle === edit.markdownTitle
    ? unchangedLine(parsed)
    : {
        type: 'prepared',
        content: replaceTitle(parsed, edit.markdownTitle),
        fields: ['title'],
      };
}

function prepareAppendTitleEdit(
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'append-title' }>,
): PreparedLineEdit {
  if (!isSingleLineText(edit.markdown)) return invalid('invalid-target', 'title');
  return edit.markdown.length === 0
    ? unchangedLine(parsed)
    : {
        type: 'prepared',
        content: appendTitle(parsed, edit.markdown),
        fields: ['title'],
      };
}

function prepareTitleLineEdit(parsed: ParsedTaskLine, edit: TitleLineEdit): PreparedLineEdit {
  switch (edit.type) {
    case 'set-title':
      return prepareSetTitleEdit(parsed, edit);
    case 'append-title':
      return prepareAppendTitleEdit(parsed, edit);
    case 'edit-link':
      if (!isSingleLineText(edit.replacement)) return invalid('invalid-target', 'link');
      return editTitleLink(parsed, edit.occurrence, edit.replacement);
  }
}

function preparePlanningLineEdit(parsed: ParsedTaskLine, edit: PlanningLineEdit): PreparedLineEdit {
  switch (edit.type) {
    case 'set-date':
      return prepareDateEdit(parsed, edit);
    case 'set-time':
      return prepareTimeEdit(parsed, edit);
    case 'set-duration':
      return prepareDurationEdit(parsed, edit);
  }
}

function validationState(
  statusCatalog: StatusCatalog,
  parsed: ParsedTaskLine,
): TaskValidationState {
  return {
    markdownTitle: parsed.markdownTitle,
    statusSymbol: parsed.statusSymbol,
    statusConfigured: statusCatalog.ruleForSymbol(parsed.statusSymbol) !== undefined,
    planning: parsed.planning,
    ...(parsed.recurrence !== undefined && { recurrence: parsed.recurrence }),
    onCompletion: parsed.onCompletion,
    malformedFields: [...malformedFields(parsed)],
  };
}

function introducedTitleIssues(
  statusCatalog: StatusCatalog,
  before: ParsedTaskLine,
  after: ParsedTaskLine,
): readonly TaskIssue[] {
  const introducedFields = new Set<TaskValidationField>();
  const duplicateIssues: TaskIssue[] = [];
  for (const [field, kind] of Object.entries(SPAN_KIND_BY_FIELD) as Array<
    [TaskValidationField, TaskSpanKind]
  >) {
    const carrierCount = (parsed: ParsedTaskLine): number =>
      (parsed.occurrences.get(kind)?.length ?? 0) +
      parsed.spans.filter((span) => span.kind === 'malformed-known' && span.malformedKind === kind)
        .length;
    const beforeOccurrences = carrierCount(before);
    const afterOccurrences = carrierCount(after);
    if (afterOccurrences > beforeOccurrences) introducedFields.add(field);
    if (afterOccurrences > beforeOccurrences && afterOccurrences > 1) {
      duplicateIssues.push({ code: 'duplicate-field', field });
    }
  }
  if (duplicateIssues.length > 0) return duplicateIssues;

  const introducedSemanticSpan = [...TITLE_SEMANTIC_KINDS].some(
    (kind) =>
      (after.occurrences.get(kind)?.length ?? 0) > (before.occurrences.get(kind)?.length ?? 0),
  );
  if (introducedFields.size === 0 && !introducedSemanticSpan) {
    return [];
  }

  const valueIssues = validateTaskChange(validationState(statusCatalog, after), introducedFields);
  return valueIssues.length > 0 ? valueIssues : [{ code: 'invalid-target', field: 'title' }];
}

function prepareTagChange(
  parsed: ParsedTaskLine,
  add: readonly string[],
  remove: readonly string[],
): PreparedLineEdit {
  const additions = normalizedTags(add);
  const removals = new Set(normalizedTags(remove));
  if (!tagsAreValid([...additions, ...removals])) return invalid('invalid-target', 'tags');

  const content = contentWithoutTags(parsed, removals);
  const candidate = parseTaskLine(content);
  if (candidate === null) return invalid('invalid-task-syntax');
  const present = new Set(candidate.tags);
  const pending = additions.filter((tag) => !present.has(tag));
  if (pending.length === 0) return { type: 'prepared', content, fields: [] };
  return insertTags(content, candidate, pending);
}

function clearStatusStamps(
  content: string,
  preserved: StatusStampKind | undefined,
): StatusContentResult {
  let updated = content;
  for (const kind of ['completion', 'cancelled'] as const) {
    if (kind === preserved) continue;
    const parsed = parseTaskLine(updated);
    if (parsed === null) return invalid('invalid-task-syntax');
    updated = replaceOrInsertToken(parsed, kind, null);
  }
  return { type: 'content', content: updated };
}

function writeStatusStamp(
  content: string,
  stampedKind: StatusStampKind | undefined,
  edit: Extract<LineEdit, { readonly type: 'set-status' }>,
): StatusContentResult {
  if (stampedKind === undefined || edit.today === undefined) {
    return { type: 'content', content };
  }
  if (stampedKind === 'completion' && edit.addCompletionDate === false) {
    return { type: 'content', content };
  }
  const parsed = parseTaskLine(content);
  if (parsed === null) return invalid('invalid-task-syntax');
  const marker = stampedKind === 'completion' ? '✅' : '❌';
  return {
    type: 'content',
    content: replaceOrInsertToken(parsed, stampedKind, `${marker} ${edit.today}`),
  };
}

function prepareStatusTransition(
  statusCatalog: StatusCatalog,
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-status' }>,
): StatusTransitionPreparation {
  if (parsed.statusSymbol === edit.symbol) {
    return unchangedLine(parsed);
  }
  const rule = statusCatalog.ruleForSymbol(edit.symbol);
  if (!validStatusTarget(edit.symbol, rule)) return invalid('invalid-status', 'status');
  const issues = statusTransitionIssues(parsed);
  if (issues.length > 0) return { type: 'invalid', issues };

  const stampedKind = statusStampKind(rule.type);
  const currentRule = statusCatalog.ruleForSymbol(parsed.statusSymbol);
  const preservesStamp = stampedKind !== undefined && currentRule?.type === rule.type;
  if (statusDateIsMissing(stampedKind, preservesStamp, edit.today)) {
    return invalid('invalid-status', 'status');
  }
  return {
    type: 'status-transition',
    stampedKind,
    preservedStamp: preservesStamp ? stampedKind : undefined,
  };
}

function prepareStatusEdit(
  statusCatalog: StatusCatalog,
  parsed: ParsedTaskLine,
  edit: Extract<LineEdit, { readonly type: 'set-status' }>,
): PreparedLineEdit {
  const transition = prepareStatusTransition(statusCatalog, parsed, edit);
  if (transition.type !== 'status-transition') return transition;
  const statusAt = (parsed.occurrences.get('prefix')?.[0]?.to ?? 0) - 2;
  const statusContent = spliceSource(parsed.original, statusAt, statusAt + 1, edit.symbol);
  const cleared = clearStatusStamps(statusContent, transition.preservedStamp);
  if (cleared.type === 'invalid') return cleared;
  const stamped = writeStatusStamp(cleared.content, transition.stampedKind, edit);
  if (stamped.type === 'invalid') return stamped;
  return {
    type: 'prepared',
    content: stamped.content,
    fields: ['status', 'completion', 'cancelled'],
  };
}

function prepareLineEdit(
  statusCatalog: StatusCatalog,
  parsed: ParsedTaskLine,
  edit: LineEdit,
): PreparedLineEdit {
  if (isTitleLineEdit(edit)) return prepareTitleLineEdit(parsed, edit);
  if (isDependencyLineEdit(edit)) return prepareDependencyLineEdit(parsed, edit);
  if (isPlanningLineEdit(edit)) return preparePlanningLineEdit(parsed, edit);
  if (edit.type === 'change-tags') return prepareTagChange(parsed, edit.add, edit.remove);
  switch (edit.type) {
    case 'set-status':
      return prepareStatusEdit(statusCatalog, parsed, edit);
    case 'set-priority':
      return preparePriorityEdit(parsed, edit);
    case 'set-recurrence':
      return prepareRecurrenceEdit(parsed, edit);
    case 'set-on-completion':
      return prepareOnCompletionEdit(parsed, edit);
  }
}

function applyPreparedLineEdit(
  statusCatalog: StatusCatalog,
  current: ParsedTaskLine,
  edit: LineEdit,
  prepared = prepareLineEdit(statusCatalog, current, edit),
): AppliedLineEdit {
  if (prepared.type !== 'prepared') return prepared;
  const reparsed = parseTaskLine(prepared.content);
  if (reparsed === null) return invalid('invalid-task-syntax');
  if (isTitleLineEdit(edit)) {
    const titleIssues = introducedTitleIssues(statusCatalog, current, reparsed);
    if (titleIssues.length > 0) return { type: 'invalid', issues: titleIssues };
  }
  return {
    type: 'applied',
    content: prepared.content,
    parsed: reparsed,
    fields: prepared.fields,
  };
}

/** Omit source-scanner coordinates/carriers from the codec's public line shape. */
function taskLineFields({
  contentEnd: _contentEnd,
  statusAt: _statusAt,
  carriers: _carriers,
  ...fields
}: TaskLineSourceModel): Omit<TaskLineSourceModel, 'contentEnd' | 'statusAt' | 'carriers'> {
  return fields;
}

function parseTaskLine(
  original: string,
  source: ParseSource = { filePath: '', line: 0 },
): ParsedTaskLine | null {
  const model = parseTaskLineSourceModel(original);
  if (model == null) return null;
  return {
    ...taskLineFields(model),
    title: collapseLinks(model.markdownTitle),
    source: { ...source, originalMarkdown: original },
  };
}

export class TaskMarkdownCodec {
  constructor(private readonly statusCatalog: StatusCatalog) {}

  statusForSymbol(symbol: string): TaskStatus {
    return this.statusCatalog.statusForSymbol(symbol);
  }

  applyRecurrenceIterationLineEdit(
    original: string,
    edit: RecurrenceTaskLineEdit,
  ): RecurrenceTaskLineEditResult {
    if (this.validateLine(original).length > 0) {
      return { type: 'invalid', code: 'invalid-task-syntax' };
    }
    return editRecurrenceIterationTaskLine(original, edit);
  }

  editTextLink(source: string, occurrence: number, replacement: string): LineEditResult {
    if (!isSingleLineText(replacement)) return invalid('invalid-target', 'link');
    if (!Number.isInteger(occurrence) || occurrence < 0) return invalid('invalid-target', 'link');
    const link = parseLinks(source)[occurrence];
    if (link == null) return invalid('invalid-target', 'link');
    const content = spliceSource(source, link.index, link.index + link.raw.length, replacement);
    return content === source
      ? { type: 'unchanged', content: source }
      : { type: 'changed', content };
  }

  /** Validates a complete candidate line before task creation writes it to the vault. */
  validateLine(original: string): readonly TaskIssue[] {
    const parsed = parseTaskLine(original);
    if (parsed == null) return [{ code: 'invalid-task-syntax' }];
    return validateTaskChange(
      validationState(this.statusCatalog, parsed),
      new Set<TaskValidationField>([
        'due',
        'scheduled',
        'start',
        'completion',
        'cancelled',
        'time',
        'duration',
        'recurrence',
        'on-completion',
      ]),
    );
  }

  applyLineEdit(original: string, edit: LineEdit): LineEditResult {
    const parsed = parseTaskLine(original);
    if (parsed == null) return invalid('invalid-task-syntax');
    const prepared = prepareLineEdit(this.statusCatalog, parsed, edit);
    if (prepared.type !== 'prepared') return prepared;
    if (prepared.content === original) return { type: 'unchanged', content: original };
    const applied = applyPreparedLineEdit(this.statusCatalog, parsed, edit, prepared);
    if (applied.type !== 'applied') return applied;
    const issues = validateTaskChange(
      validationState(this.statusCatalog, applied.parsed),
      new Set(prepared.fields),
    );
    if (issues.length > 0) return { type: 'invalid', issues };
    return { type: 'changed', content: prepared.content };
  }

  /** Applies correlated field edits as one candidate and validates only the final state. */
  applyLineEdits(
    original: string,
    edits: readonly LineEdit[],
    requestedFields: readonly TaskValidationField[] = [],
  ): LineEditResult {
    const before = parseTaskLine(original);
    if (before == null) return invalid('invalid-task-syntax');

    let current = before;
    let content = original;
    const changedFields = new Set<TaskValidationField>(requestedFields);
    for (const edit of edits) {
      const applied = applyPreparedLineEdit(this.statusCatalog, current, edit);
      if (applied.type === 'invalid') return applied;
      if (applied.type === 'unchanged') continue;
      content = applied.content;
      for (const field of applied.fields) changedFields.add(field);
      current = applied.parsed;
    }
    const issues = validateTaskChange(validationState(this.statusCatalog, current), changedFields);
    if (issues.length > 0) return { type: 'invalid', issues };
    return content === original
      ? { type: 'unchanged', content: original }
      : { type: 'changed', content };
  }
  parseLine(original: string, source: ParseSource): ParsedTaskLine | null {
    return parseTaskLine(original, source);
  }
}
