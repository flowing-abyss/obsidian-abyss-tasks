const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/u;

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

function parseOffsetDateTime(value: string): Date | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function parseDateTime(value: string): Date | undefined {
  const separated = splitDateTime(value);
  if (separated === undefined) return undefined;
  const date = parseDateParts(separated[0]);
  const match = ISO_TIME.exec(separated[1]);
  if (date === undefined || match === null) return undefined;
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
  return parseOffsetDateTime(value);
}

export interface ParsedProjectDate {
  readonly kind: 'date' | 'datetime';
  readonly value: Date;
}

/** Parses the strict date and datetime forms accepted by project presentation. */
export function parseProjectDate(value: unknown): ParsedProjectDate | undefined {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return undefined;
  const dateParts = parseDateParts(value);
  if (dateParts !== undefined) {
    const [year, month, day] = dateParts;
    return { kind: 'date', value: new Date(year, month - 1, day) };
  }
  const datetime = parseDateTime(value);
  return datetime === undefined ? undefined : { kind: 'datetime', value: datetime };
}

/** Returns the system-local calendar day used by the project date presentation. */
export function projectCalendarDay(value: unknown): string | undefined {
  const parsed = parseProjectDate(value);
  if (parsed === undefined) return undefined;
  return projectCalendarDayFromParsed(parsed);
}

export function projectCalendarDayFromParsed(parsed: ParsedProjectDate): string {
  const year = String(parsed.value.getFullYear()).padStart(4, '0');
  const month = String(parsed.value.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
