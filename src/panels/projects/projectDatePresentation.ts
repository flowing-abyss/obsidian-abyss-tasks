import { parseProjectDate } from '../../projects/projectDateValue';

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

function dateOnlyDifference(value: Date, now: Date): number {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const targetOrdinal = Date.UTC(year, month - 1, day);
  const nowOrdinal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return (targetOrdinal - nowOrdinal) / 86_400_000;
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
