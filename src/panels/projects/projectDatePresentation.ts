const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/u;

let cachedRelativeTimeFormat:
  { readonly locale: string; readonly value: Intl.RelativeTimeFormat } | undefined;
let cachedPrettyDateFormat:
  { readonly locale: string; readonly value: Intl.DateTimeFormat } | undefined;
let cachedPrettyDateTimeFormat:
  { readonly locale: string; readonly value: Intl.DateTimeFormat } | undefined;

function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  if (cachedRelativeTimeFormat?.locale === locale) return cachedRelativeTimeFormat.value;
  const value = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  cachedRelativeTimeFormat = { locale, value };
  return value;
}

function prettyDateFormat(locale: string, includeTime: boolean): Intl.DateTimeFormat {
  const cached = includeTime ? cachedPrettyDateTimeFormat : cachedPrettyDateFormat;
  if (cached?.locale === locale) return cached.value;
  const value = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
  const entry = { locale, value };
  if (includeTime) cachedPrettyDateTimeFormat = entry;
  else cachedPrettyDateFormat = entry;
  return value;
}

function validDateParts(year: number, month: number, day: number): boolean {
  const value = new Date(year, month - 1, day);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day;
}

function parseDateParts(value: string): readonly [number, number, number] | undefined {
  const match = DATE_ONLY.exec(value);
  if (match === null) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return validDateParts(...parts) ? parts : undefined;
}

function dateOnlyDifference(value: Date, now: Date): number {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const targetOrdinal = Date.UTC(year, month - 1, day);
  const nowOrdinal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return (targetOrdinal - nowOrdinal) / 86_400_000;
}

function matchesLocalParts(
  value: Date,
  parts: readonly [number, number, number, number, number, number, number],
): boolean {
  return [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds(),
  ].every((part, index) => part === parts[index]);
}

function splitDateTime(value: string): readonly [string, string] | undefined {
  const separator = value.indexOf('T');
  if (separator < 0 || separator !== value.lastIndexOf('T')) return undefined;
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function validClock(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

function validDateTime(value: string): Date | undefined {
  const separated = splitDateTime(value);
  if (separated === undefined) return undefined;
  const date = parseDateParts(separated[0]);
  if (date === undefined) return undefined;
  const match = ISO_TIME.exec(separated[1]);
  if (match === null) return undefined;
  const [year, month, day] = date;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const millisecond = Number((match[4] ?? '').padEnd(3, '0'));
  if (!validClock(hour, minute, second)) return undefined;
  if (match[5] === undefined) {
    const local = new Date(year, month - 1, day, hour, minute, second, millisecond);
    return matchesLocalParts(local, [year, month, day, hour, minute, second, millisecond])
      ? local
      : undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp);
}

interface ParsedProjectDate {
  readonly kind: 'date' | 'datetime';
  readonly value: Date;
}

function parseProjectDate(value: unknown): ParsedProjectDate | undefined {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return undefined;
  const dateParts = parseDateParts(value);
  if (dateParts !== undefined) {
    const [year, month, day] = dateParts;
    return { kind: 'date', value: new Date(year, month - 1, day) };
  }
  const datetime = validDateTime(value);
  return datetime === undefined ? undefined : { kind: 'datetime', value: datetime };
}

function signedNearest(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Formats strict project dates without changing their authored raw representation. */
export function formatProjectRelativeDate(
  value: unknown,
  now: Date,
  locale: string,
): string | undefined {
  const parsed = parseProjectDate(value);
  if (parsed === undefined) return undefined;
  const formatter = relativeTimeFormat(locale);
  if (parsed.kind === 'date') {
    return formatter.format(dateOnlyDifference(parsed.value, now), 'day');
  }

  const milliseconds = parsed.value.getTime() - now.getTime();
  const absoluteMilliseconds = Math.abs(milliseconds);
  if (absoluteMilliseconds < 30_000) return formatter.format(0, 'second');
  if (absoluteMilliseconds < 3_600_000)
    return formatter.format(signedNearest(milliseconds / 60_000), 'minute');
  if (absoluteMilliseconds < 86_400_000)
    return formatter.format(signedNearest(milliseconds / 3_600_000), 'hour');
  return formatter.format(signedNearest(milliseconds / 86_400_000), 'day');
}

/** Formats strict project dates in the system timezone without changing their authored value. */
export function formatProjectPrettyDate(value: unknown, locale: string): string | undefined {
  const parsed = parseProjectDate(value);
  if (parsed === undefined) return undefined;
  return prettyDateFormat(locale, parsed.kind === 'datetime').format(parsed.value);
}
