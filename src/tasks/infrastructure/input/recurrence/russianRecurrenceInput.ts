import {
  englishOrdinal,
  normalizeRecurrencePhrase,
  recurrenceHead,
  recurrenceStarts,
  type RecurrenceInputLocale,
} from './RecurrenceInputLocale';

const UNITS: Readonly<Record<string, string>> = {
  день: 'day',
  дня: 'day',
  дней: 'day',
  неделю: 'week',
  неделя: 'week',
  недели: 'week',
  недель: 'week',
  месяц: 'month',
  месяца: 'month',
  месяцев: 'month',
  год: 'year',
  года: 'year',
  лет: 'year',
};
const DAYS: Readonly<Record<string, string>> = {
  понедельник: 'Monday',
  понедельникам: 'Monday',
  вторник: 'Tuesday',
  вторникам: 'Tuesday',
  среда: 'Wednesday',
  среду: 'Wednesday',
  средам: 'Wednesday',
  четверг: 'Thursday',
  четвергам: 'Thursday',
  пятница: 'Friday',
  пятницу: 'Friday',
  пятницам: 'Friday',
  суббота: 'Saturday',
  субботу: 'Saturday',
  субботам: 'Saturday',
  воскресенье: 'Sunday',
  воскресеньям: 'Sunday',
};
const MONTHS: Readonly<Record<string, string>> = {
  января: 'January',
  февраля: 'February',
  марта: 'March',
  апреля: 'April',
  мая: 'May',
  июня: 'June',
  июля: 'July',
  августа: 'August',
  сентября: 'September',
  октября: 'October',
  ноября: 'November',
  декабря: 'December',
};
const ORDINALS: Readonly<Record<string, string>> = {
  первый: '1st',
  первую: '1st',
  первая: '1st',
  второй: '2nd',
  вторую: '2nd',
  вторая: '2nd',
  третий: '3rd',
  третью: '3rd',
  третья: '3rd',
  четвертый: '4th',
  четвёртый: '4th',
  четвертую: '4th',
  четвёртую: '4th',
  четвертая: '4th',
  четвёртая: '4th',
  пятый: '5th',
  пятую: '5th',
  пятая: '5th',
  последний: 'last',
  последнюю: 'last',
  последняя: 'last',
};
const ALIASES: Readonly<Record<string, string>> = {
  ежедневно: 'every day',
  еженедельно: 'every week',
  ежемесячно: 'every month',
  ежегодно: 'every year',
  'по будням': 'every weekday',
  'каждый рабочий день': 'every weekday',
  'по выходным': 'every week on Saturday, Sunday',
  'через день': 'every 2 days',
};
const CONTINUATIONS = new Set([
  'в',
  'во',
  'на',
  'с',
  'со',
  'начиная',
  'до',
  'по',
  'кроме',
  'исключая',
  'только',
  'после',
  'перед',
  'и',
  'или',
  'раз',
  'каждый',
  'каждую',
  'каждая',
  'каждое',
  'каждые',
  'каждого',
  'месяца',
  'числа',
  'раза',
  'ежедневно',
  'еженедельно',
  'ежемесячно',
  'ежегодно',
  ...Object.keys(DAYS),
  ...Object.keys(MONTHS),
  ...Object.keys(ORDINALS),
]);

function translatedList(
  text: string,
  item: (value: string) => string | undefined,
): string | undefined {
  const values = text.split(/, ?| и /u).map(item);
  return values.length > 0 && values.every((value) => value !== undefined)
    ? values.join(', ')
    : undefined;
}
function dates(text: string): string | undefined {
  return translatedList(text, (value) => englishOrdinal(value.replace(/-го$/u, '')));
}
function weekdaySelector(text: string): string | undefined {
  const parts = text.replace(/^в /u, '').split(' ');
  const ordinal = ORDINALS[parts[0] ?? ''];
  if (parts.length !== 2 || ordinal === undefined) return undefined;
  if (parts[1] === 'день' && ordinal === 'last') return 'the last';
  const day = DAYS[parts[1] ?? ''];
  return day === undefined ? undefined : `the ${ordinal} ${day}`;
}
function monthlySelector(text: string): string | undefined {
  if (!text.endsWith(' числа')) return weekdaySelector(text);
  const list = dates(text.slice(0, -' числа'.length));
  return list === undefined ? undefined : `the ${list}`;
}
function weeklySelector(text: string): string | undefined {
  return translatedList(text.replace(/^по /u, ''), (day) => DAYS[day]);
}
function annualSelector(text: string): string | undefined {
  const annual = /^(\d+)(?:-го)? (\p{L}+)$/u.exec(text);
  if (annual === null) return undefined;
  const day = englishOrdinal(annual[1] ?? '');
  const month = MONTHS[annual[2] ?? ''];
  return day === undefined || month === undefined ? undefined : `${month} ${day}`;
}
const SELECTORS: Readonly<Record<string, (text: string) => string | undefined>> = {
  week: weeklySelector,
  month: monthlySelector,
  year: annualSelector,
};
function unitBase(
  match: RegExpExecArray,
): { readonly unit: string; readonly rule: string } | undefined {
  const unit = UNITS[match[2] ?? ''];
  const interval = match[1] ?? '1';
  const count = Number(interval);
  if (unit === undefined || !Number.isSafeInteger(count) || count < 1) return undefined;
  return { unit, rule: count === 1 ? `every ${unit}` : `every ${interval} ${unit}s` };
}
function unitPhrase(text: string): string | undefined {
  const match =
    /^(?:каждый|каждую|каждая|каждое|каждые|раз в) (?:(\d+) )?(\p{L}+)(?: (.+))?$/u.exec(text);
  if (match === null) return undefined;
  const base = unitBase(match);
  if (base === undefined) return undefined;
  const tail = match[3];
  if (tail === undefined) return base.rule;
  const selector = SELECTORS[base.unit]?.(tail);
  return selector === undefined ? undefined : `${base.rule} on ${selector}`;
}
function monthlyPhrase(text: string): string | undefined {
  const reverse = /^(.+) каждого месяца$/u.exec(text);
  const monthly = /^(?:каждый|каждую|каждая|каждое) (.+) месяца$/u.exec(text);
  const input = reverse?.[1] ?? monthly?.[1];
  if (input === undefined) return undefined;
  const selector = monthlySelector(input);
  return selector === undefined ? undefined : `every month on ${selector}`;
}
function weekdayPhrase(text: string): string | undefined {
  const weekdays = /^(?:каждый|каждую|каждая|каждое|по) (.+)$/u.exec(text);
  if (weekdays === null) return undefined;
  const list = translatedList(weekdays[1] ?? '', (day) => DAYS[day]);
  return list === undefined ? undefined : `every week on ${list}`;
}
function russianPhrase(text: string): string | undefined {
  const alias = ALIASES[text];
  if (alias !== undefined) return alias;
  const annual = /^ежегодно (.+)$/u.exec(text);
  if (annual !== null) return unitPhrase(`каждый год ${annual[1] ?? ''}`);
  return monthlyPhrase(text) ?? weekdayPhrase(text) ?? unitPhrase(text);
}
const CUES = new Set([
  'каждый',
  'каждую',
  'каждая',
  'каждое',
  'каждые',
  'ежедневно',
  'еженедельно',
  'ежемесячно',
  'ежегодно',
]);
interface CueWord {
  readonly value: string;
  readonly from: number;
  readonly to: number;
}
function nextWords(
  text: string,
  words: readonly CueWord[],
  index: number,
  expected: readonly string[],
): boolean {
  let cursor = index;
  let previous = words[cursor];
  for (const value of expected) {
    const next = words[++cursor];
    if (previous === undefined || next?.value !== value) return false;
    if (!/^[^\S\r\n]+$/u.test(text.slice(previous.to, next.from))) return false;
    previous = next;
  }
  return true;
}
function weekdayCue(text: string, words: readonly CueWord[], index: number): boolean {
  const following = words[index + 1]?.value ?? '';
  const supported =
    DAYS[following] !== undefined || following === 'будням' || following === 'выходным';
  return supported && nextWords(text, words, index, [following]);
}
function contextualCue(text: string, words: readonly CueWord[], index: number): boolean {
  const value = words[index]?.value;
  if (value === 'раз') return nextWords(text, words, index, ['в']);
  if (value === 'через') return nextWords(text, words, index, ['день']);
  if (value === 'по') return weekdayCue(text, words, index);
  return (
    /^\d+(?:-го)?$/u.test(value ?? '') &&
    nextWords(text, words, index, ['числа', 'каждого', 'месяца'])
  );
}
function russianStarts(text: string): readonly number[] {
  const words = [...text.matchAll(/[\p{L}\p{N}_]+(?:-го)?/giu)].map((match) => ({
    value: match[0].toLowerCase(),
    from: match.index,
    to: match.index + match[0].length,
  }));
  const starts = new Set(recurrenceStarts(text, /[\p{L}\p{N}_]+(?:-го)?/giu));
  return words
    .filter(
      (word, index) =>
        starts.has(word.from) && (CUES.has(word.value) || contextualCue(text, words, index)),
    )
    .map((word) => word.from);
}

export const russianRecurrenceInput: RecurrenceInputLocale = {
  id: 'ru',
  starts: russianStarts,
  toEnglish: (phrase) => {
    const text = normalizeRecurrencePhrase(phrase);
    const whenDone = text.endsWith(' после выполнения');
    const body = whenDone ? text.slice(0, -' после выполнения'.length) : text;
    const translated = russianPhrase(body);
    if (translated === undefined) return undefined;
    return `${translated}${whenDone ? ' when done' : ''}`;
  },
  isContinuation: (tail) => CONTINUATIONS.has(recurrenceHead(tail)) || /^\d/u.test(tail),
  hasLeadingRestriction: (prefix) =>
    /(?:^|[^\p{L}\p{N}_])(?:не|никогда|только|кроме|исключая|до)(?![\p{L}\p{N}_])/iu.test(prefix) ||
    /(?:^| )\d+ раз(?:а)?(?: |$)/iu.test(prefix),
  clockCues: ['в'],
  weekdayAbbreviations: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'],
};
