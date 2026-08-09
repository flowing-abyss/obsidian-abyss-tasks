import { parseLinks } from '../../../parser/links';
import { StatusCatalog } from '../../domain/StatusCatalog';
import { parseRecurrenceRule } from '../../domain/recurrence';
import {
  editRecurrenceIterationTaskLine,
  type RecurrenceTaskLineEdit,
  type RecurrenceTaskLineEditResult,
} from '../../domain/recurrenceIteration';
import { parseTaskLineSourceModel } from '../../domain/taskLineSourceModel';
import type { OnCompletion, TaskPriority, TaskStatus } from '../../domain/types';
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

const WIKILINK_ALIAS_RE = /\[\[([^|[\]]+)\|([^[\]]+)\]\]/gu;
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/gu;
const MD_LINK_RE = /\[([^[\]]+)\]\(([^)]+)\)/gu;
const BRACKETS_RE = /\[([^[\]]*)\]/gu;

function collapseLinks(input: string): string {
  return input
    .replace(WIKILINK_ALIAS_RE, '🔗$1')
    .replace(WIKILINK_RE, (_match, link: string) => '🔗 ' + link.replace(/\.[^.]*$/u, ''))
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

function semanticTitleFragments(
  spans: readonly SourceSpan[],
  contentEnd: number,
): readonly SourceSpan[] {
  const fragments: SourceSpan[] = [];
  let fragmentFrom: number | undefined;
  let fragmentTo: number | undefined;
  for (const span of spans) {
    if (span.kind === 'prefix' || (span.kind === 'separator' && span.from === contentEnd)) continue;
    if (isSemanticTitleSpan(span)) {
      fragmentFrom ??= span.from;
      fragmentTo = span.to;
      continue;
    }
    if (span.kind === 'separator' && fragmentFrom !== undefined) continue;
    if (fragmentFrom !== undefined && fragmentTo !== undefined) {
      fragments.push({ kind: 'title', from: fragmentFrom, to: fragmentTo });
      fragmentFrom = undefined;
      fragmentTo = undefined;
    }
  }
  if (fragmentFrom !== undefined && fragmentTo !== undefined) {
    fragments.push({ kind: 'title', from: fragmentFrom, to: fragmentTo });
  }
  return fragments;
}

function insertionPoint(parsed: ParsedTaskLine, kind: TaskSpanKind): number {
  const rank = TOKEN_RANK[kind];
  if (rank !== undefined) {
    const later = parsed.spans.find((span) => {
      const candidateRank = TOKEN_RANK[span.kind];
      if (candidateRank === undefined || candidateRank <= rank) return false;
      const raw = parsed.original.slice(span.from, span.to);
      try {
        if (
          span.kind === 'created' ||
          span.kind === 'start' ||
          span.kind === 'scheduled' ||
          span.kind === 'due' ||
          span.kind === 'cancelled' ||
          span.kind === 'completion'
        ) {
          localDate(raw.slice(-10));
        } else if (span.kind === 'time') {
          localTime(raw.slice(-5));
        }
      } catch {
        return false;
      }
      return true;
    });
    const carrierAt =
      kind === 'recurrence' || kind === 'on-completion'
        ? Math.min(
            parsed.occurrences.get('task-id')?.[0]?.from ?? Infinity,
            parsed.occurrences.get('depends-on')?.[0]?.from ?? Infinity,
            parsed.occurrences.get('block-id')?.[0]?.from ?? Infinity,
          )
        : Infinity;
    if (later) return Math.min(later.from, carrierAt);
    if (carrierAt !== Infinity) return carrierAt;
  }
  const blockId = parsed.occurrences.get('block-id')?.[0];
  if (blockId) return blockId.from;
  return parsed.original.length - parsed.lineEnding.length;
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
    if (!link) return invalid('invalid-target', 'link');
    const content = spliceSource(source, link.index, link.index + link.raw.length, replacement);
    return content === source
      ? { type: 'unchanged', content: source }
      : { type: 'changed', content };
  }

  private malformedFields(parsed: ParsedTaskLine): ReadonlySet<TaskValidationField> {
    const malformed = new Set<TaskValidationField>();
    for (const [field, kind] of Object.entries(SPAN_KIND_BY_FIELD) as Array<
      [TaskValidationField, TaskSpanKind]
    >) {
      if (
        parsed.spans.some((span) => span.kind === 'malformed-known' && span.malformedKind === kind)
      ) {
        malformed.add(field);
      }
    }
    if (
      (parsed.occurrences.get('duration')?.length ?? 0) > 0 &&
      parsed.planning.duration === undefined
    ) {
      malformed.add('duration');
    }
    if (
      (parsed.occurrences.get('recurrence')?.length ?? 0) > 0 &&
      parsed.recurrence === undefined
    ) {
      malformed.add('recurrence');
    }
    return malformed;
  }

  private validationState(parsed: ParsedTaskLine): TaskValidationState {
    return {
      markdownTitle: parsed.markdownTitle,
      statusSymbol: parsed.statusSymbol,
      statusConfigured: this.statusCatalog.ruleForSymbol(parsed.statusSymbol) !== undefined,
      planning: parsed.planning,
      recurrence: parsed.recurrence,
      onCompletion: parsed.onCompletion,
      malformedFields: [...this.malformedFields(parsed)],
    };
  }

  /** Validates a complete candidate line before task creation writes it to the vault. */
  validateLine(original: string): readonly TaskIssue[] {
    const parsed = this.parseLine(original, { filePath: '', line: 0 });
    if (!parsed) return [{ code: 'invalid-task-syntax' }];
    return validateTaskChange(
      this.validationState(parsed),
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

  private duplicateIssue(parsed: ParsedTaskLine, kind: TaskSpanKind, field: string): TaskIssue[] {
    return (parsed.occurrences.get(kind)?.length ?? 0) > 1
      ? [{ code: 'duplicate-field', field }]
      : [];
  }

  private malformedTargetIssue(parsed: ParsedTaskLine, field: TaskValidationField): TaskIssue[] {
    if (!this.malformedFields(parsed).has(field)) return [];
    if (field === 'time') return [{ code: 'invalid-time', field }];
    if (field === 'duration') return [{ code: 'invalid-duration', field }];
    if (field === 'on-completion') return [{ code: 'invalid-on-completion', field }];
    if (field === 'recurrence') return [{ code: 'unparseable-rule', field }];
    return [{ code: 'invalid-date', field }];
  }

  private replaceOrInsertToken(
    parsed: ParsedTaskLine,
    kind: TaskSpanKind,
    token: string | null,
  ): string {
    const occurrence = parsed.occurrences.get(kind)?.[0];
    if (occurrence) {
      return token === null
        ? removeSpan(parsed.original, occurrence)
        : spliceSource(parsed.original, occurrence.from, occurrence.to, token);
    }
    return token === null ? parsed.original : insertToken(parsed, kind, token);
  }

  private editableTitleFragments(parsed: ParsedTaskLine): readonly SourceSpan[] {
    const contentEnd = parsed.original.length - parsed.lineEnding.length;
    return semanticTitleFragments(parsed.spans, contentEnd);
  }

  private linkTitleFragments(parsed: ParsedTaskLine): readonly SourceSpan[] {
    const contentEnd = parsed.original.length - parsed.lineEnding.length;
    return semanticTitleFragments(parsed.spans, contentEnd);
  }

  private replaceTitle(parsed: ParsedTaskLine, markdownTitle: string): string {
    const fragments = this.editableTitleFragments(parsed);
    const first = fragments[0];
    if (first) {
      let content = parsed.original;
      const removals = markdownTitle ? fragments.slice(1) : fragments;
      for (const fragment of [...removals].reverse()) {
        content = removeSpan(content, fragment);
      }
      return markdownTitle ? spliceSource(content, first.from, first.to, markdownTitle) : content;
    }

    const contentEnd = parsed.original.length - parsed.lineEnding.length;
    const firstProtected = parsed.spans.find(
      (span) => span.kind !== 'prefix' && span.kind !== 'separator',
    );
    const at = firstProtected?.from ?? contentEnd;
    const left = /\s/u.test(parsed.original[at - 1] ?? '') ? '' : ' ';
    const right = /\s/u.test(parsed.original[at] ?? '') || at === contentEnd ? '' : ' ';
    return spliceSource(parsed.original, at, at, `${left}${markdownTitle}${right}`);
  }

  private appendTitle(parsed: ParsedTaskLine, markdown: string): string {
    const fragments = this.editableTitleFragments(parsed);
    const last = fragments[fragments.length - 1];
    if (!last) return this.replaceTitle(parsed, markdown);
    return spliceSource(parsed.original, last.to, last.to, ` ${markdown}`);
  }

  private editTitleLink(
    parsed: ParsedTaskLine,
    occurrence: number,
    replacement: string,
  ): PreparedLineEdit {
    if (!Number.isInteger(occurrence) || occurrence < 0) return invalid('invalid-target', 'link');
    let remaining = occurrence;
    for (const fragment of this.linkTitleFragments(parsed)) {
      const source = parsed.original.slice(fragment.from, fragment.to);
      const links = parseLinks(source);
      if (remaining >= links.length) {
        remaining -= links.length;
        continue;
      }
      const link = links[remaining];
      if (!link) return invalid('invalid-target', 'link');
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

  private introducedTitleIssues(
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
        parsed.spans.filter(
          (span) => span.kind === 'malformed-known' && span.malformedKind === kind,
        ).length;
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

    const valueIssues = validateTaskChange(this.validationState(after), introducedFields);
    return valueIssues.length > 0 ? valueIssues : [{ code: 'invalid-target', field: 'title' }];
  }

  private prepareTagChange(
    parsed: ParsedTaskLine,
    add: readonly string[],
    remove: readonly string[],
  ): PreparedLineEdit {
    const normalize = (tag: string): string => (tag.startsWith('#') ? tag : `#${tag}`);
    const additions = [...new Set(add.map(normalize))];
    const removals = new Set(remove.map(normalize));
    if ([...additions, ...removals].some((tag) => !/^#[\w/-]+$/u.test(tag))) {
      return invalid('invalid-target', 'tags');
    }

    let content = parsed.original;
    for (const span of [...(parsed.occurrences.get('tag') ?? [])].reverse()) {
      const tag = parsed.original.slice(span.from, span.to);
      if (removals.has(tag)) content = removeSpan(content, span);
    }
    const candidate = this.parseLine(content, { filePath: '', line: 0 })!;
    const present = new Set(candidate.tags);
    const pending = additions.filter((tag) => !present.has(tag));
    if (pending.length === 0) return { type: 'prepared', content, fields: [] };

    const tags = candidate.occurrences.get('tag') ?? [];
    const lastTag = tags[tags.length - 1];
    if (lastTag) {
      return {
        type: 'prepared',
        content: spliceSource(content, lastTag.to, lastTag.to, ` ${pending.join(' ')}`),
        fields: [],
      };
    }
    const protectedSpan = candidate.spans.find(
      (span) => METADATA_KINDS.has(span.kind) || span.kind === 'block-id',
    );
    const at = protectedSpan?.from ?? content.length - candidate.lineEnding.length;
    const left = /\s/u.test(content[at - 1] ?? '') ? '' : ' ';
    const right = /\s/u.test(content[at] ?? '') || at === content.length ? '' : ' ';
    return {
      type: 'prepared',
      content: spliceSource(content, at, at, `${left}${pending.join(' ')}${right}`),
      fields: [],
    };
  }

  private prepareStatusEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-status' }>,
  ): PreparedLineEdit {
    if (parsed.statusSymbol === edit.symbol) {
      return { type: 'unchanged', content: parsed.original };
    }
    const rule = this.statusCatalog.ruleForSymbol(edit.symbol);
    if (edit.symbol.length !== 1 || !rule) return invalid('invalid-status', 'status');
    const currentRule = this.statusCatalog.ruleForSymbol(parsed.statusSymbol);

    const issues: TaskIssue[] = [];
    for (const field of ['completion', 'cancelled'] as const) {
      issues.push(...this.duplicateIssue(parsed, field, field));
      issues.push(...this.malformedTargetIssue(parsed, field));
    }
    if (issues.length > 0) return { type: 'invalid', issues };

    const statusAt = (parsed.occurrences.get('prefix')?.[0]?.to ?? 0) - 2;
    let content = spliceSource(parsed.original, statusAt, statusAt + 1, edit.symbol);
    let stampedKind: 'completion' | 'cancelled' | undefined;
    if (rule.type === 'done') stampedKind = 'completion';
    if (rule.type === 'cancelled') stampedKind = 'cancelled';
    const preservesStamp = stampedKind !== undefined && currentRule?.type === rule.type;
    if (stampedKind !== undefined && !preservesStamp && edit.today === undefined) {
      return invalid('invalid-status', 'status');
    }
    for (const kind of ['completion', 'cancelled'] as const) {
      if (preservesStamp && kind === stampedKind) continue;
      const current = this.parseLine(content, { filePath: '', line: 0 })!;
      content = this.replaceOrInsertToken(current, kind, null);
    }
    if (
      stampedKind !== undefined &&
      edit.today !== undefined &&
      (stampedKind === 'cancelled' || edit.addCompletionDate !== false)
    ) {
      const marker = stampedKind === 'completion' ? '✅' : '❌';
      const current = this.parseLine(content, { filePath: '', line: 0 })!;
      content = this.replaceOrInsertToken(current, stampedKind, `${marker} ${edit.today}`);
    }
    return { type: 'prepared', content, fields: ['status', 'completion', 'cancelled'] };
  }

  private preparePriorityEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-priority' }>,
  ): PreparedLineEdit {
    const issues = this.duplicateIssue(parsed, 'priority', 'priority');
    if (issues.length > 0) return { type: 'invalid', issues };
    const occurrences = parsed.occurrences.get('priority')?.length ?? 0;
    if (parsed.priority === edit.priority && (edit.priority !== 'D' || occurrences === 0)) {
      return { type: 'unchanged', content: parsed.original };
    }
    const content = this.replaceOrInsertToken(
      parsed,
      'priority',
      TOKEN_BY_PRIORITY[edit.priority] || null,
    );
    return { type: 'prepared', content, fields: [] };
  }

  private prepareDateEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-date' }>,
  ): PreparedLineEdit {
    const issues = [
      ...this.duplicateIssue(parsed, edit.field, edit.field),
      ...this.malformedTargetIssue(parsed, edit.field),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const current = parsed.planning[edit.field];
    if (
      (edit.value === null && current === undefined) ||
      (edit.value !== null && current === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    const marker = MARKER_BY_FIELD[edit.field];
    const token = edit.value === null ? null : `${marker} ${edit.value}`;
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(parsed, edit.field, token),
      fields: [edit.field],
    };
  }

  private prepareTimeEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-time' }>,
  ): PreparedLineEdit {
    const issues = [
      ...this.duplicateIssue(parsed, 'time', 'time'),
      ...this.malformedTargetIssue(parsed, 'time'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const current = parsed.planning.time;
    if (
      (edit.value === null && current === undefined) ||
      (edit.value !== null && current === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(
        parsed,
        'time',
        edit.value === null ? null : `⏰ ${edit.value}`,
      ),
      fields: ['time'],
    };
  }

  private prepareDurationEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-duration' }>,
  ): PreparedLineEdit {
    const issues = [
      ...this.duplicateIssue(parsed, 'duration', 'duration'),
      ...this.malformedTargetIssue(parsed, 'duration'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const current = parsed.planning.duration;
    if (
      (edit.value === null && current === undefined) ||
      (edit.value !== null && current === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    let token: string | null = null;
    if (edit.value !== null) {
      try {
        token = `⏱️ ${formatDurationMinutes(validatedDurationMinutes(edit.value))}`;
      } catch {
        return invalid('invalid-duration', 'duration');
      }
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(parsed, 'duration', token),
      fields: ['duration'],
    };
  }

  private prepareRecurrenceEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-recurrence' }>,
  ): PreparedLineEdit {
    if (edit.value !== null && !isSingleLineText(edit.value)) {
      return invalid('invalid-target', 'recurrence');
    }
    const issues = [
      ...this.duplicateIssue(parsed, 'recurrence', 'recurrence'),
      ...this.malformedTargetIssue(parsed, 'recurrence'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const recurrence = edit.value === null ? undefined : parseRecurrenceRule(edit.value);
    if (recurrence?.type === 'invalid') {
      return invalid(recurrence.code, 'recurrence');
    }
    if (
      (edit.value === null && parsed.recurrence === undefined) ||
      (edit.value !== null && parsed.recurrence === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(
        parsed,
        'recurrence',
        edit.value === null ? null : `🔁 ${edit.value}`,
      ),
      fields: ['recurrence'],
    };
  }

  private prepareOnCompletionEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-on-completion' }>,
  ): PreparedLineEdit {
    if (
      edit.value !== null &&
      (!isSingleLineText(edit.value) || (edit.value !== 'keep' && edit.value !== 'delete'))
    ) {
      return invalid('invalid-target', 'on-completion');
    }
    const issues = [
      ...this.duplicateIssue(parsed, 'on-completion', 'on-completion'),
      ...this.malformedTargetIssue(parsed, 'on-completion'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    if (
      (edit.value === null && !parsed.onCompletionExplicit) ||
      (edit.value !== null && parsed.onCompletionExplicit && parsed.onCompletion === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(
        parsed,
        'on-completion',
        edit.value === null ? null : `🏁 ${edit.value}`,
      ),
      fields: ['on-completion'],
    };
  }

  private prepareLineEdit(parsed: ParsedTaskLine, edit: LineEdit): PreparedLineEdit {
    switch (edit.type) {
      case 'set-title':
        if (!isSingleLineText(edit.markdownTitle)) return invalid('invalid-target', 'title');
        return parsed.markdownTitle === edit.markdownTitle
          ? { type: 'unchanged', content: parsed.original }
          : {
              type: 'prepared',
              content: this.replaceTitle(parsed, edit.markdownTitle),
              fields: ['title'],
            };
      case 'append-title':
        if (!isSingleLineText(edit.markdown)) return invalid('invalid-target', 'title');
        return edit.markdown.length === 0
          ? { type: 'unchanged', content: parsed.original }
          : {
              type: 'prepared',
              content: this.appendTitle(parsed, edit.markdown),
              fields: ['title'],
            };
      case 'edit-link':
        if (!isSingleLineText(edit.replacement)) return invalid('invalid-target', 'link');
        return this.editTitleLink(parsed, edit.occurrence, edit.replacement);
      case 'set-status':
        return this.prepareStatusEdit(parsed, edit);
      case 'set-priority':
        return this.preparePriorityEdit(parsed, edit);
      case 'set-date':
        return this.prepareDateEdit(parsed, edit);
      case 'set-time':
        return this.prepareTimeEdit(parsed, edit);
      case 'set-duration':
        return this.prepareDurationEdit(parsed, edit);
      case 'set-recurrence':
        return this.prepareRecurrenceEdit(parsed, edit);
      case 'set-on-completion':
        return this.prepareOnCompletionEdit(parsed, edit);
      case 'change-tags':
        return this.prepareTagChange(parsed, edit.add, edit.remove);
    }
  }

  applyLineEdit(original: string, edit: LineEdit): LineEditResult {
    const parsed = this.parseLine(original, { filePath: '', line: 0 });
    if (!parsed) return invalid('invalid-task-syntax');
    const prepared = this.prepareLineEdit(parsed, edit);
    if (prepared.type !== 'prepared') return prepared;
    if (prepared.content === original) return { type: 'unchanged', content: original };
    const reparsed = this.parseLine(prepared.content, { filePath: '', line: 0 });
    if (!reparsed) return invalid('invalid-task-syntax');
    if (edit.type === 'set-title' || edit.type === 'append-title' || edit.type === 'edit-link') {
      const titleIssues = this.introducedTitleIssues(parsed, reparsed);
      if (titleIssues.length > 0) return { type: 'invalid', issues: titleIssues };
    }
    const issues = validateTaskChange(this.validationState(reparsed), new Set(prepared.fields));
    if (issues.length > 0) return { type: 'invalid', issues };
    return { type: 'changed', content: prepared.content };
  }

  /** Applies correlated field edits as one candidate and validates only the final state. */
  applyLineEdits(
    original: string,
    edits: readonly LineEdit[],
    requestedFields: readonly TaskValidationField[] = [],
  ): LineEditResult {
    const before = this.parseLine(original, { filePath: '', line: 0 });
    if (!before) return invalid('invalid-task-syntax');

    let current = before;
    let content = original;
    const changedFields = new Set<TaskValidationField>(requestedFields);
    for (const edit of edits) {
      const prepared = this.prepareLineEdit(current, edit);
      if (prepared.type === 'invalid') return prepared;
      if (prepared.type === 'unchanged') continue;
      content = prepared.content;
      for (const field of prepared.fields) changedFields.add(field);
      const reparsed = this.parseLine(content, { filePath: '', line: 0 });
      if (!reparsed) return invalid('invalid-task-syntax');
      if (edit.type === 'set-title' || edit.type === 'append-title' || edit.type === 'edit-link') {
        const titleIssues = this.introducedTitleIssues(current, reparsed);
        if (titleIssues.length > 0) return { type: 'invalid', issues: titleIssues };
      }
      current = reparsed;
    }
    const issues = validateTaskChange(this.validationState(current), changedFields);
    if (issues.length > 0) return { type: 'invalid', issues };
    return content === original
      ? { type: 'unchanged', content: original }
      : { type: 'changed', content };
  }

  parseLine(original: string, source: ParseSource): ParsedTaskLine | null {
    const model = parseTaskLineSourceModel(original);
    if (!model) return null;
    return {
      original: model.original,
      lineEnding: model.lineEnding,
      statusSymbol: model.statusSymbol,
      markdownTitle: model.markdownTitle,
      title: collapseLinks(model.markdownTitle),
      tags: model.tags,
      spans: model.spans,
      occurrences: model.occurrences,
      planning: model.planning,
      priority: model.priority,
      recurrence: model.recurrence,
      onCompletion: model.onCompletion,
      onCompletionExplicit: model.onCompletionExplicit,
      source: { ...source, originalMarkdown: original },
    };
  }
}
