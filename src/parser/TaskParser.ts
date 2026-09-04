import { durationMinutes, formatDurationMinutes } from '../tasks/domain/validation';
import { TaskMarkdownCodec } from '../tasks/infrastructure/markdown/TaskMarkdownCodec';
import { legacyTaskFromParsed } from './legacyTaskProjection';
import type { ParseContext, Task } from './types';

const DURATION_RE = /⏱️\s*(?:(\d{1,2}):([0-5]\d)(?=\s|$)|(?:(\d+)h)?(?:(\d+)m)?)/u;

/** Parse a duration token body (e.g. "1h30m", "2h", "45m", or legacy "01:30"). */
export function parseDurationToMinutes(raw: string): number | undefined {
  const value = raw.trim();
  const clock = /^(\d{1,2}):([0-5]\d)$/u.exec(value);
  if (clock != null) {
    const total = Number(clock[1]) * 60 + Number(clock[2]);
    return total > 0 ? total : undefined;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/u.exec(value);
  if (m == null) return undefined;
  const hours = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const mins = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const total = hours * 60 + mins;
  return total > 0 ? total : undefined;
}

/** Format total minutes into the shortest "XhYm" form (e.g. 90 -> "1h30m", 120 -> "2h", 45 -> "45m"). */
export function formatDurationFromMinutes(minutes: number): string {
  return formatDurationMinutes(durationMinutes(minutes));
}

/**
 * Find a ⏱️ duration token in `text` and parse it via `parseDurationToMinutes`,
 * the single source of truth for h/m and clock-style parsing (including the "0m -> undefined"
 * rule). Returns `undefined` when no digit group follows ⏱️ at all (a bare/
 * malformed token) — callers should then treat it as ordinary title text, not
 * metadata, matching `parseTask`'s behavior for malformed input.
 */
function matchDuration(text: string): { raw: string; minutes: number | undefined } | undefined {
  const m = DURATION_RE.exec(text);
  if (m == null || !hasDurationParts(m)) return undefined;
  const body = durationBody(m);
  return { raw: m[0], minutes: parseDurationToMinutes(body) };
}

function hasDurationParts(match: RegExpExecArray): boolean {
  return [match[1], match[2], match[3], match[4]].some(
    (part) => part !== undefined && part.length > 0,
  );
}

function durationBody(match: RegExpExecArray): string {
  const hours = match[1];
  const clockMinutes = match[2];
  if (
    hours !== undefined &&
    hours.length > 0 &&
    clockMinutes !== undefined &&
    clockMinutes.length > 0
  ) {
    return `${hours}:${clockMinutes}`;
  }
  const durationHours = match[3];
  const durationMinutes = match[4];
  const hoursPart = durationHours === undefined ? '' : [durationHours, 'h'].join('');
  const minutesPart = durationMinutes === undefined ? '' : [durationMinutes, 'm'].join('');
  return [hoursPart, minutesPart].join('');
}

function appendTextPart(
  parts: string[],
  value: string | undefined,
  format: (present: string) => string,
): void {
  if (value !== undefined && value.length > 0) parts.push(format(value));
}

function appendDurationPart(parts: string[], minutes: number | undefined): void {
  if (minutes !== undefined) parts.push(`⏱️ ${formatDurationFromMinutes(minutes)}`);
}

export function parseTask(rawText: string, ctx: ParseContext): Task | null {
  const codec = new TaskMarkdownCodec(ctx.statusCatalog);
  const parsed = codec.parseLine(rawText, { filePath: ctx.filePath, line: ctx.line });
  if (parsed == null) return null;
  return legacyTaskFromParsed(parsed, ctx, (symbol) => codec.statusForSymbol(symbol));
}

// Checkbox prefix including trailing space and any blockquote/callout markers:
// "  - [x] ", "> - [x] ", "> > - [x] ".
const FMT_PREFIX_RE = /^([\s>]*-\s\[[^\]]\]\s)/u;

/**
 * Rewrite a raw task line so its metadata emojis appear in the canonical order
 * used by the Tasks plugin, with our ⏰ time marker first among all metadata.
 *
 * Canonical order: title · #tags · ⏰ · priority · 🔁 · 🛫 · ⏳ · 📅 · ❌ · ✅
 *
 * Tags are written immediately after the title text (before emoji markers) for
 * readability, but are parsed from anywhere in the line.
 *
 * Created-date (➕) is preserved if present, placed between recurrence and startDate
 * to match Tasks plugin ordering.
 */
/**
 * Insert `insertText` into a task line's title body, before the metadata suffix
 * (dates/priority/time/recurrence/tags), then re-canonicalize via `formatTaskLine`.
 * Returns the line unchanged if it is not a task line. Pure — unit-tested.
 */
export function insertIntoTitleBody(line: string, insertText: string): string {
  const prefixMatch = /^([\s>]*- \[.\] )/u.exec(line);
  if (prefixMatch == null) return line;
  const prefix = prefixMatch[1] ?? '';
  const rawAfterPrefix = line.slice(prefix.length);
  const spaceIdx = rawAfterPrefix.search(/\s(?:[📅⏳🛫✅❌⏰🔁🔺⏫🔼🔽⏬#➕]|⏱️)/u);
  const body = (spaceIdx >= 0 ? rawAfterPrefix.slice(0, spaceIdx) : rawAfterPrefix).trimEnd();
  const suffix = spaceIdx >= 0 ? rawAfterPrefix.slice(spaceIdx) : '';
  return formatTaskLine(`${prefix}${body} ${insertText}${suffix}`);
}

interface FormattedTaskFields {
  readonly time: string | undefined;
  readonly durationMatch: ReturnType<typeof matchDuration>;
  readonly priority: string | undefined;
  readonly recurrence: string | undefined;
  readonly createdDate: string | undefined;
  readonly startDate: string | undefined;
  readonly scheduledDate: string | undefined;
  readonly dueDate: string | undefined;
  readonly cancelledDate: string | undefined;
  readonly doneDate: string | undefined;
  readonly tags: readonly string[];
}

function firstCapture(pattern: RegExp, source: string): string | undefined {
  return pattern.exec(source)?.[1];
}

function nonEmptyTrimmedCapture(pattern: RegExp, source: string): string | undefined {
  const value = firstCapture(pattern, source)?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function formattedTaskFields(rest: string): FormattedTaskFields {
  return {
    time: firstCapture(/⏰\s*(\d{1,2}:\d{2})/u, rest),
    durationMatch: matchDuration(rest),
    priority: firstCapture(/([🔺⏫🔼🔽⏬])/u, rest),
    recurrence: nonEmptyTrimmedCapture(/🔁\s*([^📅⏳🛫✅❌⏰🔺⏫🔼🔽⏬\n]*)/u, rest),
    createdDate: firstCapture(/➕\s*(\d{4}-\d{2}-\d{2})/u, rest),
    startDate: firstCapture(/🛫\s*(\d{4}-\d{2}-\d{2})/u, rest),
    scheduledDate: firstCapture(/⏳\s*(\d{4}-\d{2}-\d{2})/u, rest),
    dueDate: firstCapture(/📅\s*(\d{4}-\d{2}-\d{2})/u, rest),
    cancelledDate: firstCapture(/❌\s*(\d{4}-\d{2}-\d{2})/u, rest),
    doneDate: firstCapture(/✅\s*(\d{4}-\d{2}-\d{2})/u, rest),
    tags: Array.from(rest.matchAll(/#[\w/-]+/gu), (match) => match[0]),
  };
}

function titleWithoutMetadata(
  rest: string,
  durationMatch: ReturnType<typeof matchDuration>,
): string {
  const source = durationMatch == null ? rest : rest.replace(durationMatch.raw, '');
  return source
    .replace(/⏰\s*\d{1,2}:\d{2}/gu, '')
    .replace(/[🔺⏫🔼🔽⏬]/gu, '')
    .replace(/🔁\s*[^📅⏳🛫✅❌⏰🔺⏫🔼🔽⏬\n]*/gu, '')
    .replace(/➕\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/🛫\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/⏳\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/❌\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/✅\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/#[\w/-]+/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function canonicalParts(title: string, fields: FormattedTaskFields): string[] {
  const parts: string[] = [title, ...fields.tags];
  appendTextPart(parts, fields.time, (value) => `⏰ ${value}`);
  appendDurationPart(parts, fields.durationMatch?.minutes);
  appendTextPart(parts, fields.priority, (value) => value);
  appendTextPart(parts, fields.recurrence, (value) => `🔁 ${value}`);
  appendTextPart(parts, fields.createdDate, (value) => `➕ ${value}`);
  appendTextPart(parts, fields.startDate, (value) => `🛫 ${value}`);
  appendTextPart(parts, fields.scheduledDate, (value) => `⏳ ${value}`);
  appendTextPart(parts, fields.dueDate, (value) => `📅 ${value}`);
  appendTextPart(parts, fields.cancelledDate, (value) => `❌ ${value}`);
  appendTextPart(parts, fields.doneDate, (value) => `✅ ${value}`);
  return parts;
}

export function formatTaskLine(line: string): string {
  const prefixMatch = FMT_PREFIX_RE.exec(line);
  if (prefixMatch == null) return line;
  const prefix = prefixMatch[1] ?? '';
  const rest = line.slice(prefix.length);
  const fields = formattedTaskFields(rest);
  const title = titleWithoutMetadata(rest, fields.durationMatch);
  const parts = canonicalParts(title, fields);
  return prefix + parts.filter(Boolean).join(' ');
}
