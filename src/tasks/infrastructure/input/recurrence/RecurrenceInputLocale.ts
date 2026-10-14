export interface RecurrenceInputLocale {
  readonly id: string;
  starts(text: string): readonly number[];
  toEnglish(completePhrase: string): string | undefined;
  isContinuation(tail: string): boolean;
  hasLeadingRestriction(clausePrefix: string): boolean;
  readonly clockCues: readonly string[];
}

export function normalizeRecurrencePhrase(text: string): string {
  return text
    .trim()
    .replace(/[^\S\r\n]+/gu, ' ')
    .toLowerCase();
}

/** Cue patterns are finite locale vocabulary, with Unicode source boundaries. */
export function recurrenceStarts(text: string, cue: RegExp): readonly number[] {
  return [...text.matchAll(cue)]
    .filter(
      (match) =>
        !/(?:\p{L}|\p{N}|[_./#-])$/u.test(text.slice(Math.max(0, match.index - 2), match.index)),
    )
    .map((match) => match.index);
}

export function recurrenceHead(text: string): string {
  return /^[\p{L}\p{N}_]+/u.exec(text)?.[0] ?? '';
}

export function englishOrdinal(value: string): string | undefined {
  const day = Number(value);
  if (!Number.isSafeInteger(day) || day < 1 || day > 31) return undefined;
  const teen = day % 100;
  const suffix =
    teen >= 11 && teen <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th');
  return `${String(day)}${suffix}`;
}
