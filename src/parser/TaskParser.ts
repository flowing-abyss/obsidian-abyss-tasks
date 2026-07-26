import { durationMinutes, formatDurationMinutes } from '../tasks/domain/validation';
import { TaskMarkdownCodec } from '../tasks/infrastructure/markdown/TaskMarkdownCodec';
import { legacyTaskFromParsed } from './legacyTaskProjection';
import type { ParseContext, Task } from './types';

const DURATION_RE = /⏱️\s*(?:(\d{1,2}):([0-5]\d)(?=\s|$)|(?:(\d+)h)?(?:(\d+)m)?)/u;

/** Parse a duration token body (e.g. "1h30m", "2h", "45m", or legacy "01:30"). */
export function parseDurationToMinutes(raw: string): number | undefined {
  const value = raw.trim();
  const clock = /^(\d{1,2}):([0-5]\d)$/u.exec(value);
  if (clock) {
    const total = Number(clock[1]) * 60 + Number(clock[2]);
    return total > 0 ? total : undefined;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/u.exec(value);
  if (!m) return undefined;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
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
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  let body = '';
  if (m[1] && m[2]) {
    body = `${m[1]}:${m[2]}`;
  } else {
    if (m[3]) body += `${m[3]}h`;
    if (m[4]) body += `${m[4]}m`;
  }
  return { raw: m[0], minutes: parseDurationToMinutes(body) };
}

export function parseTask(rawText: string, ctx: ParseContext): Task | null {
  const codec = new TaskMarkdownCodec(ctx.statusCatalog);
  const parsed = codec.parseLine(rawText, { filePath: ctx.filePath, line: ctx.line });
  if (!parsed) return null;
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
  if (!prefixMatch) return line;
  const prefix = prefixMatch[1] ?? '';
  const rawAfterPrefix = line.slice(prefix.length);
  const spaceIdx = rawAfterPrefix.search(/\s(?:[📅⏳🛫✅❌⏰🔁🔺⏫🔼🔽⏬#➕]|⏱️)/u);
  const body = (spaceIdx >= 0 ? rawAfterPrefix.slice(0, spaceIdx) : rawAfterPrefix).trimEnd();
  const suffix = spaceIdx >= 0 ? rawAfterPrefix.slice(spaceIdx) : '';
  return formatTaskLine(`${prefix}${body} ${insertText}${suffix}`);
}

export function formatTaskLine(line: string): string {
  const prefixMatch = FMT_PREFIX_RE.exec(line);
  if (!prefixMatch) return line;
  const prefix = prefixMatch[1] ?? '';
  const rest = line.slice(prefix.length);

  // Extract each metadata field
  const time = /⏰\s*(\d{1,2}:\d{2})/u.exec(rest)?.[1];
  const durationMatch = matchDuration(rest);
  const durationMinutes = durationMatch?.minutes;
  // All five Tasks priority levels: 🔺⏫🔼🔽⏬
  const priorityMatch = /([🔺⏫🔼🔽⏬])/u.exec(rest);
  const priority = priorityMatch?.[1];
  const recurrenceMatch = /🔁\s*([^📅⏳🛫✅❌⏰🔺⏫🔼🔽⏬\n]*)/u.exec(rest);
  const recurrence = recurrenceMatch?.[1]?.trim() || undefined;
  const createdDate = /➕\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
  const startDate = /🛫\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
  const scheduledDate = /⏳\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
  const dueDate = /📅\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
  const cancelledDate = /❌\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
  const doneDate = /✅\s*(\d{4}-\d{2}-\d{2})/u.exec(rest)?.[1];
  const tags = Array.from(rest.matchAll(/#[\w/-]+/gu)).map((m) => m[0]);

  // Strip all recognized metadata to isolate the title. Duration is only
  // stripped when matchDuration recognized a valid token (has digits) — a
  // bare/malformed ⏱️ with no digits is left in place, matching parseTask's
  // treatment of malformed duration input as ordinary title text.
  const restWithoutDuration = durationMatch ? rest.replace(durationMatch.raw, '') : rest;
  const title = restWithoutDuration
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

  // Rebuild in canonical order
  const parts: string[] = [title, ...tags];
  if (time) parts.push(`⏰ ${time}`);
  if (durationMinutes !== undefined) parts.push(`⏱️ ${formatDurationFromMinutes(durationMinutes)}`);
  if (priority) parts.push(priority);
  if (recurrence) parts.push(`🔁 ${recurrence}`);
  if (createdDate) parts.push(`➕ ${createdDate}`);
  if (startDate) parts.push(`🛫 ${startDate}`);
  if (scheduledDate) parts.push(`⏳ ${scheduledDate}`);
  if (dueDate) parts.push(`📅 ${dueDate}`);
  if (cancelledDate) parts.push(`❌ ${cancelledDate}`);
  if (doneDate) parts.push(`✅ ${doneDate}`);

  return prefix + parts.filter(Boolean).join(' ');
}
