const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/u;

let cachedRelativeTimeFormat:
  { readonly locale: string; readonly value: Intl.RelativeTimeFormat } | undefined;

function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  if (cachedRelativeTimeFormat?.locale === locale) return cachedRelativeTimeFormat.value;
  const value = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  cachedRelativeTimeFormat = { locale, value };
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

function dateOnlyDifference(value: string, now: Date): number | undefined {
  const parts = parseDateParts(value);
  if (parts === undefined) return undefined;
  const [year, month, day] = parts;
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

function signedNearest(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Formats strict project dates without changing their authored raw representation. */
export function formatProjectRelativeDate(
  value: unknown,
  now: Date,
  locale: string,
): string | undefined {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return undefined;
  const dayDifference = dateOnlyDifference(value, now);
  const formatter = relativeTimeFormat(locale);
  if (dayDifference !== undefined) return formatter.format(dayDifference, 'day');

  const target = validDateTime(value);
  if (target === undefined) return undefined;
  const milliseconds = target.getTime() - now.getTime();
  const absoluteMilliseconds = Math.abs(milliseconds);
  if (absoluteMilliseconds < 30_000) return formatter.format(0, 'second');
  if (absoluteMilliseconds < 3_600_000)
    return formatter.format(signedNearest(milliseconds / 60_000), 'minute');
  if (absoluteMilliseconds < 86_400_000)
    return formatter.format(signedNearest(milliseconds / 3_600_000), 'hour');
  return formatter.format(signedNearest(milliseconds / 86_400_000), 'day');
}
