// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseRecurrenceRule } from '../../src/tasks/domain/recurrence';
import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import { RecurrenceTextInputParser } from '../../src/tasks/infrastructure/input/RecurrenceTextInputParser';
import type { RecurrenceInputLocale } from '../../src/tasks/infrastructure/input/recurrence/RecurrenceInputLocale';

const parser = new RecurrenceTextInputParser();
const supported = [
  ['каждый день', 'every day'],
  ['ежедневно', 'every day'],
  ['раз в день', 'every day'],
  ['daily', 'every day'],
  ['каждые 2 дня', 'every 2 days'],
  ['каждые 3 дня', 'every 3 days'],
  ['каждые 5 дней', 'every 5 days'],
  ['раз в 2 недели', 'every 2 weeks'],
  ['каждую неделю', 'every week'],
  ['еженедельно', 'every week'],
  ['weekly', 'every week'],
  ['каждые 3 недели', 'every 3 weeks'],
  ['каждые 5 недель', 'every 5 weeks'],
  ['ежемесячно', 'every month'],
  ['monthly', 'every month'],
  ['каждый месяц', 'every month'],
  ['каждые 2 месяца', 'every 2 months'],
  ['каждые 5 месяцев', 'every 5 months'],
  ['каждый год', 'every year'],
  ['каждые 2 года', 'every 2 years'],
  ['каждые 5 лет', 'every 5 years'],
  ['yearly', 'every year'],
  ['по будням', 'every weekday'],
  ['каждый рабочий день', 'every weekday'],
  ['weekdays', 'every weekday'],
  ['по выходным', 'every week on Saturday, Sunday'],
  ['every weekend', 'every week on Saturday, Sunday'],
  ['каждый понедельник', 'every week on Monday'],
  ['каждую среду', 'every week on Wednesday'],
  ['каждая среда', 'every week on Wednesday'],
  ['каждая неделя', 'every week'],
  ['каждая пятница', 'every week on Friday'],
  ['каждая суббота', 'every week on Saturday'],
  ['каждую пятницу', 'every week on Friday'],
  ['каждую субботу', 'every week on Saturday'],
  ['каждое воскресенье', 'every week on Sunday'],
  ['по вторникам и четвергам', 'every week on Tuesday, Thursday'],
  ['по понедельникам, средам и пятницам', 'every week on Monday, Wednesday, Friday'],
  ['каждые 2 недели по вторникам и четвергам', 'every 2 weeks on Tuesday, Thursday'],
  ['every Monday', 'every week on Monday'],
  ['every Tuesday and Thursday', 'every week on Tuesday, Thursday'],
  ['каждый месяц 5 числа', 'every month on the 5th'],
  ['5 числа каждого месяца', 'every month on the 5th'],
  ['15-го числа каждого месяца', 'every month on the 15th'],
  ['каждый месяц 1 и 15 числа', 'every month on the 1st and 15th'],
  ['каждый первый понедельник месяца', 'every month on the 1st Monday'],
  ['каждый второй вторник месяца', 'every month on the 2nd Tuesday'],
  ['каждую третью среду месяца', 'every month on the 3rd Wednesday'],
  ['каждый четвертый четверг месяца', 'every month on the 4th Thursday'],
  ['каждую пятую пятницу месяца', 'every month on the 5th Friday'],
  ['каждый месяц в последнюю пятницу', 'every month on the last Friday'],
  ['каждый последний день месяца', 'every month on the last'],
  ['каждый год 5 июня', 'every June on the 5th'],
  ['ежегодно 5 июня', 'every June on the 5th'],
  ['каждый год 29 февраля', 'every February on the 29th'],
  ['каждые 2 года 29 февраля', 'every 2 years February on the 29th'],
  ['каждые 3 дня после выполнения', 'every 3 days when done'],
  ['через день', 'every 2 days'],
  ['  КАЖДЫЕ\t3   ДНЯ  ', 'every 3 days'],
] as const;

function extract(text: string) {
  return parser.extract({ text, protectedRanges: inspectTaskInput(text).protectedRanges });
}

describe('bounded recurrence input adapter', () => {
  it.each(supported)('translates the complete field %s', (text, rule) => {
    const parsed = parser.parse(text);
    expect(parsed).toMatchObject({ type: 'valid', raw: rule });
    if (parsed.type !== 'valid') throw new Error('Expected valid recurrence');
    const label = `${parsed.canonical}${parsed.whenDone ? ' when done' : ''}`;
    expect(label).toBe(rule);
  });
  it.each(supported)('extracts original source for %s', (phrase, rule) => {
    const text = `🧑‍💻 Выполнить ${phrase.trim()} аккуратно`;
    const result = extract(text);
    expect(result.candidates.map((c) => c.rule)).toEqual([rule]);
    expect(result.candidates[0]?.ranges.map((r) => text.slice(r.from, r.to))).toEqual([
      phrase.trim(),
    ]);
  });
  it.each([
    'every day',
    'every 2 weeks on Tuesday, Friday',
    'every month on the first Monday',
    'every month on the 2nd last Friday',
    'every month on the last',
    'every month on the 1st and 15th',
    'every 1 days',
    'every weekday',
    'every year',
    'every February on the 29th',
    'every April and December on the 1st and 24th',
    'every 2 years on February 29th',
    'every week when done',
    '  EVERY\tWEEK  ',
  ])('keeps valid English authored raw for %s', (raw) => {
    expect(parser.parse(raw)).toEqual(parseRecurrenceRule(raw));
    expect(parser.parse(raw)).toMatchObject({ type: 'valid', raw });
  });
  it.each([
    'каждый день trailing',
    'каждый день после выполнения trailing',
    'every day trailing',
    'every day at 10:00',
    'каждый день в 10:00',
    'каждый второй вторник',
    'каждые 0 дней',
    'каждые -2 дня',
    'каждые 1.5 дня',
    'каждые 9007199254740992 дня',
    'every 0 days',
    'every -2 days',
    'every 1.5 days',
    'every 9007199254740992 days',
    'every hour',
    'каждый час',
    'tous les jours',
    'cada día',
    'через 2 дня',
    'в понедельник',
    'каждый день до завтра',
    'каждый день 3 раза',
    'каждый день кроме воскресенья',
  ])('rejects the complete field %s', (text) => {
    expect(parser.parse(text).type).toBe('invalid');
  });
});

describe('extraction boundary policy', () => {
  it.each([
    ['Send report every day to Anna', 'every day', 'every day'],
    ['Every day buy milk', 'every day', 'Every day'],
    [
      'Отправить отчёт каждый понедельник в 10:00 Анне',
      'every week on Monday',
      'каждый понедельник',
    ],
    ['every day at 2pm', 'every day', 'every day'],
    ['every day at 10:00', 'every day', 'every day'],
    ['every day at 10:00 am to Anna', 'every day', 'every day'],
    ['every day, write notes', 'every day', 'every day'],
    ['каждый день, писать заметки', 'every day', 'каждый день'],
    ['every day #work', 'every day', 'every day'],
    ['every day; call tomorrow', 'every day', 'every day'],
    ['every day. Call tomorrow', 'every day', 'every day'],
    ['каждый день! Позвонить завтра', 'every day', 'каждый день'],
    ['every day\ncall tomorrow', 'every day', 'every day'],
  ] as const)('accepts the complete phrase in %s', (text, rule, source) => {
    const result = extract(text);
    expect(result.candidates.map((c) => c.rule)).toEqual([rule]);
    expect(result.candidates[0]?.ranges.map((r) => text.slice(r.from, r.to))).toEqual([source]);
  });
  it.each([
    'every day during June',
    'every day and write notes',
    'every day in the office',
    'каждый день в июне',
    'каждый день после обеда',
    'every day except Monday',
    'every day at 10:00 #work except Monday',
    'каждый день в 10:00 #work кроме воскресенья',
    'every day at 10:00 `literal` except Monday',
    'every day at 10:00) except Monday',
    'every day at 10:00 except Monday',
    'каждый день в 10:00 кроме воскресенья',
    'every day at 25:00',
    'every day at 10:60',
    'every day at 13pm',
    'every day at 10',
    'every day at',
    'every day at 10:00-11:00',
    'every day at 10:00 to 11:00',
    'every day at 10:00 and 11:00',
    'every day, except Monday',
    'каждый день, кроме воскресенья',
    'every day #work except Monday',
    'каждый день #work кроме воскресенья',
    'every day `literal` except Monday',
    'not every day',
    'only every day',
    'until June every day',
    'except Monday every day',
    'не каждый день',
    'только каждый день',
    'до июня каждый день',
    'кроме воскресенья каждый день',
    'every week on',
    'every month on the',
    'каждый месяц в',
    'каждый второй вторник',
    'every day; every hour',
    'every day; каждый час',
    'every day every week',
    'каждый день каждую неделю',
    'every 1.5 days',
    'every -2 days',
    'каждые 1.5 дня',
    'каждые 0 дней',
    'every day for 3 times',
    'каждый день 3 раза',
    '𝕒every day',
    '𐐀каждый день',
    'item.every day',
    '1.5 числа каждого месяца',
    'job_every_day',
    'ежедневность',
    '#ежедневно',
    'someevery day',
    'https://site.test/every/day',
    '`every day`',
    '«каждый день»',
    '"every day"',
    '[every day](file)',
    '[[каждый день]]',
    '<span>every day</span>',
    '🔁 every day',
  ])('does not accept a shorter prefix in %s', (text) => {
    expect(extract(text).candidates).toEqual([]);
  });
  it.each([
    '<span><em>every day</em></span>',
    '<span>every day',
    '<div>each <span>каждый день</span></div>',
    '<span><!-- note -->every day</span>',
  ])('protects HTML element bodies in %s', (text) => {
    const result = extract(text);
    expect(result.candidates).toEqual([]);
    expect(
      result.protectedRanges.some(
        (r) =>
          text.slice(r.from, r.to).includes('every day') ||
          text.slice(r.from, r.to).includes('каждый день'),
      ),
    ).toBe(true);
  });
  it.each([
    '<br>every day',
    '<span/>every day',
    '<img src="literal">every day',
    '<span>literal</span> every day',
  ])('recognizes text outside HTML in %s', (text) => {
    expect(extract(text).candidates.map((c) => c.rule)).toEqual(['every day']);
  });
  it('protects unsupported source through its clause, preserving later clauses', () => {
    const text = 'Пить воду каждый день кроме воскресенья; позвонить завтра';
    const result = extract(text);
    expect(result.candidates).toEqual([]);
    expect(result.protectedRanges.map((r) => text.slice(r.from, r.to))).toEqual([
      'каждый день кроме воскресенья',
    ]);
  });
  it('protects both conflicting cues without selecting one', () => {
    const text = 'every day; every week';
    const result = extract(text);
    expect(result.candidates).toEqual([]);
    expect(result.protectedRanges.map((r) => text.slice(r.from, r.to))).toEqual([
      'every day',
      'every week',
    ]);
  });
  it('never crosses a protected atom to assemble grammar', () => {
    const text = 'every week `opaque` on Monday';
    expect(extract(text).candidates).toEqual([]);
  });
  it('keeps over-limit recurrence lists literal without truncation fallback', () => {
    const text = `every week on ${Array.from({ length: 90 }, () => 'Monday').join(', ')}`;
    expect(extract(text).candidates).toEqual([]);
    expect(extract(text).protectedRanges).toEqual([{ from: 0, to: text.length }]);
  });
  it('tries existing English field parsing before alias length limits', () => {
    const raw = `every${' '.repeat(600)}day`;
    expect(parser.parse(raw)).toMatchObject({ type: 'valid', raw });
  });
  it('supports an independent registered locale including restrictions and clocks', () => {
    const locale: RecurrenceInputLocale = {
      id: 'test',
      starts: (text) =>
        [...text.matchAll(/(?:^| )cada(?= |$)/gu)].map(
          (m) => m.index + (m[0].startsWith(' ') ? 1 : 0),
        ),
      toEnglish: (text) => (text === 'cada día' ? 'every day' : undefined),
      isContinuation: (tail) => /^(?:salvo|a)(?: |$)/u.test(tail),
      hasLeadingRestriction: (prefix) => /(?:^| )nunca(?: |$)/u.test(prefix),
      clockCues: ['a'],
    };
    const other = new RecurrenceTextInputParser([locale]);
    expect(other.parse('cada día')).toMatchObject({ type: 'valid', raw: 'every day' });
    expect(
      other
        .extract({ text: 'cada día a 10:00 llamar', protectedRanges: [] })
        .candidates.map((c) => c.rule),
    ).toEqual(['every day']);
    for (const text of [
      'nunca cada día',
      'cada día a 10:00 salvo lunes',
      'cada día a 25:00',
      'каждый день',
    ])
      expect(other.extract({ text, protectedRanges: [] }).candidates).toEqual([]);
  });
  it('propagates unexpected locale implementation errors to the outer boundary', () => {
    const broken: RecurrenceInputLocale = {
      id: 'broken',
      starts: () => [0],
      toEnglish: () => {
        throw new Error('adapter failure');
      },
      isContinuation: () => false,
      hasLeadingRestriction: () => false,
      clockCues: [],
    };
    expect(() => new RecurrenceTextInputParser([broken]).parse('broken')).toThrow(
      'adapter failure',
    );
    expect(() =>
      new RecurrenceTextInputParser([broken]).extract({ text: 'broken', protectedRanges: [] }),
    ).toThrow('adapter failure');
  });
});

describe('candidate budget ownership', () => {
  const locale: RecurrenceInputLocale = {
    id: 'budget',
    starts: (text) => (text.startsWith('cue ') ? [0] : []),
    toEnglish: (text) => (/^cue (?:unit(?: unit)*|a+)$/u.test(text) ? 'every day' : undefined),
    isContinuation: (tail) => tail.startsWith('unit') || tail.startsWith('a'),
    hasLeadingRestriction: () => false,
    clockCues: [],
  };
  const bounded = new RecurrenceTextInputParser([locale]);
  it.each([
    [`cue ${'a'.repeat(508)}`, true],
    [`cue ${'a'.repeat(509)}`, false],
    [`cue ${Array.from({ length: 79 }, () => 'unit').join(' ')}`, true],
    [`cue ${Array.from({ length: 80 }, () => 'unit').join(' ')}`, false],
  ])('accepts only complete candidates within both bounds (%s)', (text, accepted) => {
    expect(bounded.parse(text).type).toBe(accepted ? 'valid' : 'invalid');
    const result = bounded.extract({ text, protectedRanges: [] });
    expect(result.candidates.map((c) => c.rule)).toEqual(accepted ? ['every day'] : []);
    expect(result.protectedRanges).toEqual([{ from: 0, to: text.length }]);
  });
});

describe('reviewed unsupported-expression ownership', () => {
  it.each([
    'every day (except Monday)',
    'каждый день (кроме воскресенья)',
    'every day at 10:00 (except Monday)',
    'каждый день в 10:00 (кроме воскресенья)',
    'every day ((except Monday))',
  ])('inspects a parenthesized restriction without accepting the rule: %s', (text) => {
    const result = extract(text);
    expect(result.candidates).toEqual([]);
    expect(result.protectedRanges).toEqual([{ from: 0, to: text.length }]);
  });
  it.each([
    'every day (write notes)',
    'every day at 10:00 (write notes)',
    'каждый день (писать заметки)',
  ])('leaves ordinary parenthetical prose outside the recurrence range: %s', (text) => {
    const result = extract(text);
    expect(result.candidates.map((candidate) => candidate.rule)).toEqual(['every day']);
    expect(result.candidates[0]?.ranges.map((range) => text.slice(range.from, range.to))).toEqual([
      text.startsWith('каждый') ? 'каждый день' : 'every day',
    ]);
  });
  it.each([
    ['until June every day', 20],
    ['до июня каждый день', 19],
    ['3 times every day', 17],
    ['for 3 times every day', 21],
    ['3 раза каждый день', 18],
  ] as const)('protects a leading restriction and the rule: %s', (text, to) => {
    const result = extract(text);
    expect(result.candidates).toEqual([]);
    expect(result.protectedRanges).toEqual([{ from: 0, to }]);
  });
  it.each([
    ['until June every day; call tomorrow', 'until June every day', 20],
    ['до июня каждый день; позвонить завтра', 'до июня каждый день', 19],
    ['3 times every day; call tomorrow', '3 times every day', 17],
    ['Prepare until June every day; call tomorrow', 'Prepare until June every day', 28],
    ['  until June every day ; call tomorrow', 'until June every day', 22],
  ] as const)('keeps a later semicolon clause independent: %s', (text, protectedSource, to) => {
    const result = extract(text);
    expect(result.candidates).toEqual([]);
    expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
      protectedSource,
    ]);
    expect(result.protectedRanges[0]?.to).toBe(to);
  });
  it.each([
    ['every day on Mon. and Fri.; call tomorrow', 'every day on Mon. and Fri.'],
    ['every day on Mon. and Fri. Call tomorrow.', 'every day on Mon. and Fri. Call tomorrow'],
    [
      'every day on Mon. and Fri. Another sentence; call tomorrow',
      'every day on Mon. and Fri. Another sentence',
    ],
    ['каждый день по пн. и пт.; позвонить завтра', 'каждый день по пн. и пт.'],
    [
      'every day on Mon. and Fri. Write notes. Call tomorrow.',
      'every day on Mon. and Fri. Write notes',
    ],
  ] as const)(
    'keeps weekday dots inside protection and genuine clause endings outside: %s',
    (text, protectedSource) => {
      const result = extract(text);
      expect(result.candidates).toEqual([]);
      expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
        protectedSource,
      ]);
    },
  );
});

describe('registered abbreviation protection', () => {
  const locale: RecurrenceInputLocale = {
    id: 'abbreviations',
    starts: (text) => (text.startsWith('cada ') ? [0] : []),
    toEnglish: (text) => (text === 'cada día' ? 'every day' : undefined),
    isContinuation: (tail) => tail.startsWith('en '),
    hasLeadingRestriction: () => false,
    clockCues: [],
    weekdayAbbreviations: ['dx', 'fx'],
  };
  it('gets abbreviation vocabulary from an independent locale and retains a later sentence', () => {
    const text = 'cada día en Dx. y Fx. escribir. mañana';
    const result = new RecurrenceTextInputParser([locale]).extract({ text, protectedRanges: [] });
    expect(result.candidates).toEqual([]);
    expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
      'cada día en Dx. y Fx. escribir',
    ]);
  });
  it.each(['every Mon.', 'every Mon. and Fri.', 'каждый пн.', 'каждый день по пн. и пт.'])(
    'does not add abbreviation grammar: %s',
    (text) => {
      expect(parser.parse(text).type).toBe('invalid');
      const result = extract(text);
      expect(result.candidates).toEqual([]);
      expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
        text,
      ]);
    },
  );
});
