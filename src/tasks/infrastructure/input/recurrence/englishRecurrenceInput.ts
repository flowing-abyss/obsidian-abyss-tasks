import {
  normalizeRecurrencePhrase,
  recurrenceHead,
  recurrenceStarts,
  type RecurrenceInputLocale,
} from './RecurrenceInputLocale';

const DAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
const CONTINUATIONS = new Set([
  'on',
  'in',
  'of',
  'during',
  'from',
  'starting',
  'beginning',
  'until',
  'till',
  'through',
  'for',
  'except',
  'excluding',
  'but',
  'only',
  'at',
  'when',
  'and',
  'or',
  'before',
  'after',
  ...DAYS,
  'every',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'weekdays',
]);
const ALIASES: Readonly<Record<string, string>> = {
  daily: 'every day',
  weekly: 'every week',
  monthly: 'every month',
  yearly: 'every year',
  weekdays: 'every weekday',
  'every weekend': 'every week on Saturday, Sunday',
};

export const englishRecurrenceInput: RecurrenceInputLocale = {
  id: 'en',
  starts: (text) =>
    recurrenceStarts(text, /(?:every|daily|weekly|monthly|yearly|weekdays)(?![\p{L}\p{N}_])/giu),
  toEnglish: (completePhrase) => {
    const text = normalizeRecurrencePhrase(completePhrase);
    const whenDone = text.endsWith(' when done');
    const body = whenDone ? text.slice(0, -' when done'.length) : text;
    const alias = ALIASES[body];
    if (alias !== undefined) return `${alias}${whenDone ? ' when done' : ''}`;
    if (!body.startsWith('every ')) return undefined;
    const items = body.slice('every '.length).split(/, ?| and /u);
    if (items.every((item) => DAYS.has(item)))
      return `every week on ${items.join(', ')}${whenDone ? ' when done' : ''}`;
    return text;
  },
  isContinuation: (tail) =>
    CONTINUATIONS.has(recurrenceHead(tail)) || /^\d/u.test(tail) || /^to \d/u.test(tail),
  hasLeadingRestriction: (prefix) =>
    /(?:^|[^\p{L}\p{N}_])(?:not|never|only|except|excluding|until|till|through)(?![\p{L}\p{N}_])/iu.test(
      prefix,
    ) || /(?:^| )for \d+ times?(?: |$)/iu.test(prefix),
  clockCues: ['at'],
};
