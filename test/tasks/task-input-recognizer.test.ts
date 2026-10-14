// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clockFrom } from '../../src/tasks/domain/clock';
import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import { projectTaskInput } from '../../src/tasks/domain/taskInputProjection';
import { createTaskInputState } from '../../src/tasks/domain/taskInputState';
import { taskInputReference } from '../../src/tasks/domain/taskInputTypes';
import { corpus } from '../fixtures/task-input-corpus';
import { codec, project, recognizer, reference } from '../support/taskInputHarness';

describe('task input literal corpus', () => {
  it('uses a hand-verified civil reference', () => {
    expect(new Date(reference.epochMs).toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });
  it.each(corpus)('$raw', ({ raw, due, time, title, tags }) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toEqual(due === null ? undefined : { type: 'set', value: due });
    expect(result.initial.time).toEqual(time === null ? undefined : { type: 'set', value: time });
    const parsed = codec.parseLine(`- [ ] ${result.markdownBody}`, { filePath: '', line: 0 });
    expect(parsed?.markdownTitle).toBe(title);
    expect(parsed?.tags).toEqual(tags);
  });
  it.each([
    ['Call on October 15', 'Call'],
    ['Завтра напомнить маме про билеты в 14:00 #семья', 'напомнить маме про билеты #семья'],
  ])('conserves raw source in %s', (raw, body) => {
    expect(project(createTaskInputState(raw)).markdownBody).toBe(body);
  });
});

describe('minimized property regressions: null library end is a point', () => {
  // Seeds 2026101301 path 0:0:0:0:0; 1302 path 0:0:0:0; 1304 path 0:0:0.
  it.each([
    ['alpha\t  details tomorrow notes  alpha', '2026-10-14', 'alpha\t  details notes  alpha'],
    ['Call tomorrow at 14:00', '2026-10-14', 'Call'],
    ['Call "alpha tomorrow at 2pm" tomorrow', '2026-10-14', 'Call "alpha tomorrow at 2pm"'],
    ['alpha Позвонить вчера', '2026-10-12', 'alpha Позвонить'],
    ['👩‍💻 Call tomorrow', '2026-10-14', '👩‍💻 Call'],
  ])('%s', (raw, due, body) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toEqual({ type: 'set', value: due });
    expect(result.markdownBody).toBe(body);
  });
});

describe('finite recognition policies', () => {
  it.each([
    'Call 15.10',
    'Call 2.10.3',
    'Call 10/15/2026',
    'Call 15.10.26',
    'Call 2026-02-30',
    'Call at 25:00',
    'Call в 12',
    'Call in 2 hours',
    'Call tomorrow UTC+07:00',
    'Call tomorrow GMT',
    'Call not tomorrow',
    'Позвонить не завтра',
    'Every Friday call',
    'Каждый вторник поливать цветы',
    'Call tomorrow from 10:00 to 11:00',
    'Call October 2026',
    'Call February',
    "today's report",
    'report for October 15',
    'dated October 15',
    'данные за 15 октября',
    'версия от 15 октября',
    'Call "tomorrow at 14:00"',
    'Call «tomorrow»',
    'Call “tomorrow”',
    "Call 'tomorrow'",
    'Call "tomorrow',
    'Call `tomorrow',
    'Call https://example.com/tomorrow',
    'Call [tomorrow](note)',
    'Call [[tomorrow]]',
    'Call <https://example.com/tomorrow>',
    'Call <!-- tomorrow -->',
    'Call #tomorrow',
    'Call about 14:00 tomorrow',
    'Call tomorrow around 2pm',
    'Позвонить в прошлое воскресенье',
  ])('keeps excluded source literal: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
    expect(result.markdownBody).toBe(raw);
  });
  it('keeps an apostrophe in ordinary prose', () => {
    const result = project(createTaskInputState("I'll call tomorrow"));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    expect(result.markdownBody).toBe("I'll call");
  });
  it.each([
    ['Call tomorrow `note` at 14:00'],
    ['Call tomorrow `#tag` at 14:00'],
    ['Call tomorrow [#tag](note) at 14:00'],
    ['Call tomorrow. at 14:00'],
  ])('does not link through a merge barrier: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.markdownBody).toBe(raw);
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
  });
  it('finds the next valid leap date without inferred noon', () => {
    const result = project(createTaskInputState('Call February 29'));
    expect(result.initial.due).toEqual({ type: 'set', value: '2028-02-29' });
    expect(result.initial.time).toBeUndefined();
  });
  it('uses current weekday even with a past hour', () => {
    const result = project(createTaskInputState('Call в вторник at 10:00'));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-13' });
    expect(result.initial.time).toEqual({ type: 'set', value: '10:00' });
  });
});

describe('canonical tags between natural components', () => {
  it.each([
    ['Call tomorrow #work at 14:00', 'Call #work'],
    ['Call at 14:00 #work tomorrow', 'Call #work'],
    ['Позвонить завтра #дом в 14:00', 'Позвонить #дом'],
  ])('%s', (raw, body) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    expect(result.initial.time).toEqual({ type: 'set', value: '14:00' });
    expect(result.markdownBody).toBe(body);
  });
});

describe('frozen civil reference and supported calendar boundaries', () => {
  it('derives exact local minute/second/offset from the application clock', () => {
    const reading = clockFrom(1791867605000, 420).read();
    expect(taskInputReference(reading)).toEqual({
      epochMs: 1791867605000,
      localDate: '2026-10-13',
      localTime: '12:00',
      second: 5,
      offsetMinutes: 420,
    });
  });
  it('crosses the year boundary by civil day rather than UTC slicing', () => {
    const state = createTaskInputState('Call January 1');
    const inspection = inspectTaskInput(state.raw);
    const ref = taskInputReference(clockFrom(1798693200000, 420).read());
    expect(ref.localDate).toBe('2026-12-31');
    const result = projectTaskInput({
      state,
      reference: ref,
      inspection,
      sourcePlanning: {},
      candidates: recognizer.recognize({
        text: state.raw,
        reference: ref,
        protectedRanges: inspection.protectedRanges,
      }),
    });
    expect(result.initial.due).toEqual({ type: 'set', value: '2027-01-01' });
    expect(result.initial.time).toBeUndefined();
  });
  it.each([
    'Call at 25:00 tomorrow',
    'Call 29 February 2027',
    'Call October 15 26',
    'Call on 15.10.2026 yesterday',
  ])('preserves invalid or competing calendar source: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
    expect(result.markdownBody).toBe(raw);
  });
});

describe('library certainty and exact clock ownership', () => {
  it('does not describe an inferred relative year as authored', () => {
    const result = project(createTaskInputState('Call tomorrow'));
    expect(result.candidates[0]?.yearExplicit).toBe(false);
  });
  it.each(['Call 114:00 tomorrow', 'Call at 14:99 tomorrow', 'Call about at 2pm tomorrow'])(
    'rejects an unsupported clock expression before nested date rescue: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toBeUndefined();
      expect(result.initial.time).toBeUndefined();
      expect(result.markdownBody).toBe(raw);
    },
  );
});

describe('clock lexical boundaries', () => {
  it.each(['Call model2pm tomorrow', 'Call at 2pmish tomorrow'])(
    'does not consume a clock nested in an authored word: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
      expect(result.initial.time).toBeUndefined();
      expect(result.markdownBody).toBe(raw.slice(0, raw.length - ' tomorrow'.length));
    },
  );
});

describe('review regressions: alternatives and numeric content dates', () => {
  it.each(['Call tomorrow or at 14:00', 'Позвонить завтра или в 14:00'])(
    'keeps alternatives neutral and literal: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toBeUndefined();
      expect(result.initial.time).toBeUndefined();
      expect(result.ambiguity).toBe(true);
      expect(result.markdownBody).toBe(raw);
    },
  );
  it.each(['report for 2026-10-15', 'Подготовить отчёт за 15.10.2026'])(
    'keeps numeric report dates literal: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toBeUndefined();
      expect(result.initial.time).toBeUndefined();
      expect(result.markdownBody).toBe(raw);
      expect(result.candidates).toEqual([
        expect.objectContaining({ status: 'unsupported', reason: 'content' }),
      ]);
    },
  );
});

describe('alternative guard preserves canonical tag joins', () => {
  it.each([
    ['Call tomorrow #or at 14:00', 'Call #or'],
    ['Позвонить завтра #или в 14:00', 'Позвонить #или'],
  ])('%s', (raw, body) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    expect(result.initial.time).toEqual({ type: 'set', value: '14:00' });
    expect(result.ambiguity).toBe(false);
    expect(result.markdownBody).toBe(body);
  });
});

describe('numeric identifiers beside natural dates and clocks', () => {
  it.each([
    [
      'SMART-CAPTURE-SMOKE-20261013-01 Набрать другу в 12:00 послезавтра #new/tag',
      'SMART-CAPTURE-SMOKE-20261013-01 Набрать другу #new/tag',
      '2026-10-15',
    ],
    ['ISSUE-2026 Call tomorrow at 12:00', 'ISSUE-2026 Call', '2026-10-14'],
    ['Call at 12:00 tomorrow ISSUE-0700', 'Call ISSUE-0700', '2026-10-14'],
    ['ЗАДАЧА-2026 Позвонить завтра в 12:00', 'ЗАДАЧА-2026 Позвонить', '2026-10-14'],
    ['Позвонить в 12:00 завтра ЗАДАЧА-0700', 'Позвонить ЗАДАЧА-0700', '2026-10-14'],
    ['Compare 2025-2026 tomorrow at 12:00', 'Compare 2025-2026', '2026-10-14'],
    ['Сравнить в 12:00 завтра 2025-2026', 'Сравнить 2025-2026', '2026-10-14'],
    ['Call build+0700 tomorrow at 12:00', 'Call build+0700', '2026-10-14'],
    ['Call +123456 tomorrow at 12:00', 'Call +123456', '2026-10-14'],
    ['Call at 12:00 tomorrow -123456', 'Call -123456', '2026-10-14'],
    ['Call ref-0700x tomorrow at 12:00', 'Call ref-0700x', '2026-10-14'],
    ['Позвонить в 12:00 завтра -123456', 'Позвонить -123456', '2026-10-14'],
    ['Call tomorrow ISSUE-2026 at 12:00', 'Call ISSUE-2026', '2026-10-14'],
    ['Позвонить в 12:00 ЗАДАЧА-2026 завтра', 'Позвонить ЗАДАЧА-2026', '2026-10-14'],
    ['Call tomorrow -123456 at 12:00', 'Call -123456', '2026-10-14'],
    ['Call  tomorrow +123456 at 12:00  notes', 'Call  +123456  notes', '2026-10-14'],
  ])(
    'preserves identifier text and consumes only accepted temporal ranges: %s',
    (raw, body, due) => {
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toEqual({ type: 'set', value: due });
      expect(result.initial.time).toEqual({ type: 'set', value: '12:00' });
      expect(result.markdownBody).toBe(body);
      expect(result.candidates.some((candidate) => candidate.reason === 'timezone')).toBe(false);
    },
  );

  it.each([
    'Call tomorrow at 12:00+07:00',
    'Call tomorrow at 12:00-07:00',
    'Call tomorrow at 12:00+0700',
    'Call tomorrow at 12:00-0700',
    'Call tomorrow at 12:00 +07:00',
    'Call tomorrow at 12:00 -07:00',
    'Call tomorrow at 12:00 +0700',
    'Call tomorrow at 12:00 -0700',
    'Позвонить в 12:00+0700 завтра',
    'Позвонить в 12:00-0700 завтра',
    'Позвонить в 12:00 +07:00 завтра',
    'Позвонить в 12:00 -07:00 завтра',
    'Call tomorrow at 2pm+0700',
    'Call tomorrow at 2pm-0700',
    'Call tomorrow at 2pm+07:00',
    'Call tomorrow at 2pm-07:00',
    'Call tomorrow at 12:00 (+0700)',
    'Call tomorrow at 12:00 (-07:00)',
    'Call tomorrow at 12:00 +0700.',
    'Call tomorrow at 12:00 -07:00, please',
    'Call tomorrow at 12:00 UTC',
    'Call tomorrow at 12:00 GMT',
    'Call tomorrow at 12:00 CET',
    'Позвонить в 12:00 MSK завтра',
    'Call tomorrow -2026',
  ])('keeps genuine or conservatively ambiguous timezone tokens literal: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
    expect(result.markdownBody).toBe(raw);
    expect(result.candidates).toEqual([
      expect.objectContaining({ status: 'unsupported', reason: 'timezone' }),
    ]);
  });
});

describe('colon-form numeric identifiers never become clocks', () => {
  it.each<[string, string, string | undefined]>([
    ['Call build+07:00 tomorrow', 'Call build+07:00', undefined],
    ['Call build+07:00 tomorrow at 12:00', 'Call build+07:00', '12:00'],
    ['Позвонить завтра ЗАДАЧА-07:00', 'Позвонить ЗАДАЧА-07:00', undefined],
    ['Позвонить завтра ЗАДАЧА-07:00 в 12:00', 'Позвонить ЗАДАЧА-07:00', '12:00'],
    ['Позвонить в 12:00 ЗАДАЧА-07:00 завтра', 'Позвонить ЗАДАЧА-07:00', '12:00'],
    ['Call at 12:00 build+07:00 tomorrow', 'Call build+07:00', '12:00'],
    ['Call tomorrow build-07:00 at 12:00', 'Call build-07:00', '12:00'],
    ['Call build+25:00 tomorrow', 'Call build+25:00', undefined],
    ['Call build+25:00 tomorrow at 12:00', 'Call build+25:00', '12:00'],
    ['Позвонить в 12:00 ЗАДАЧА-25:00 завтра', 'Позвонить ЗАДАЧА-25:00', '12:00'],
  ])(
    'preserves the exact identifier with independently authored planning: %s',
    (raw, body, time) => {
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
      expect(result.initial.time).toEqual(
        time === undefined ? undefined : { type: 'set', value: time },
      );
      expect(result.markdownBody).toBe(body);
      expect(result.ambiguity).toBe(false);
    },
  );
  it.each([
    'Call tomorrow at 12:00+07:00',
    'Call tomorrow at 12:00-07:00',
    'Call tomorrow at 25:00',
    'Позвонить завтра в 25:00',
    'Call build+07:00 tomorrow at 25:00',
    'Call build+25:00 tomorrow at 25:00',
  ])('preserves genuine timezone and invalid-clock refusals: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
    expect(result.markdownBody).toBe(raw);
  });
});

describe('timezone alias case refusal', () => {
  it.each([
    'Call tomorrow at 14:00 PST',
    'Call tomorrow at 14:00 pst',
    'Call tomorrow at 14:00 PsT',
    'Позвонить завтра в 14:00 MSK',
    'Позвонить завтра в 14:00 msk',
    'Позвонить завтра в 14:00 MsK',
  ])('preserves the entire timezone-qualified clause: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.candidates).toEqual([
      expect.objectContaining({ status: 'unsupported', reason: 'timezone' }),
    ]);
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
    expect(result.markdownBody).toBe(raw);
  });
});

describe('nearest strictly past weekdays', () => {
  it.each([
    ['2026-10-15', 'last Friday', 'в прошлую пятницу', '2026-10-09'],
    ['2026-10-16', 'last Friday', 'в прошлую пятницу', '2026-10-09'],
    ['2026-10-17', 'last Friday', 'в прошлую пятницу', '2026-10-16'],
    ['2026-10-18', 'last Monday', 'в прошлый понедельник', '2026-10-12'],
    ['2026-10-19', 'last Sunday', 'в воскресенье на прошлой неделе', '2026-10-18'],
    ['2026-10-18', 'last Sunday', 'в воскресенье на прошлой неделе', '2026-10-11'],
    ['2026-10-17', 'Friday', 'в пятницу', '2026-10-23'],
    ['2026-10-15', 'next Friday', 'в следующую пятницу', '2026-10-23'],
    ['2026-10-18', 'next Monday', 'в следующий понедельник', '2026-10-19'],
  ])('%s: %s / %s → %s', (day, english, russian, due) => {
    const ref = taskInputReference(clockFrom(Date.parse(`${day}T12:00:00+07:00`), 420).read());
    for (const raw of [`Call ${english}`, `Позвонить ${russian}`]) {
      const inspection = inspectTaskInput(raw);
      const result = projectTaskInput({
        state: createTaskInputState(raw),
        reference: ref,
        inspection,
        sourcePlanning: {},
        candidates: recognizer.recognize({
          text: raw,
          reference: ref,
          protectedRanges: inspection.protectedRanges,
        }),
      });
      expect(result.initial.due).toEqual({ type: 'set', value: due });
      expect(result.markdownBody).toBe(raw.startsWith('Call') ? 'Call' : 'Позвонить');
    }
  });
});

describe('clock colon delimiters and signed title fragments', () => {
  it.each([
    'Сегодня в 10:00: приём',
    'Сегодня в 10:00:приём',
    'Сегодня в 10:00: `приём`',
    'Сегодня в 10:00: ',
  ])('owns only the complete clock before title colon: %s', (raw) => {
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-13' });
    expect(result.initial.time).toEqual({ type: 'set', value: '10:00' });
    expect(
      result.candidates
        .flatMap((candidate) => candidate.ranges)
        .map((range) => raw.slice(range.from, range.to)),
    ).toEqual(['Сегодня', 'в 10:00']);
  });
  it.each([
    '10:00:30',
    '10:00:3',
    ['10', '', '00'].join(':'),
    '25:00',
    ['10', '00', '', ''].join(':'),
    '10:00: 3',
    '10:00 +0700',
    '10:00-11:00',
  ])('retains unsupported clock: %s', (clock) => {
    const raw = `Сегодня в ${clock} — приём`;
    const result = project(createTaskInputState(raw));
    expect(result.markdownBody).toBe(raw);
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toBeUndefined();
  });
  it.each(['-5 градусов', '+5 градусов', '-5.5 градусов', '+5,5 градусов', '-0.25 units'])(
    'preserves signed non-timezone fragment: %s',
    (title) => {
      const raw = `Завтра ${title}`;
      const result = project(createTaskInputState(raw));
      expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
      expect(result.markdownBody).toBe(title);
      expect(
        result.candidates
          .flatMap((candidate) => candidate.ranges)
          .map((range) => raw.slice(range.from, range.to)),
      ).toEqual(['Завтра']);
    },
  );
});

describe('review round one: date ranges precede signed title masking', () => {
  it.each(['June 5-7 conference', '5-7 June conference', '5-7 июня конференция'])(
    'retains the real range decision: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.markdownBody).toBe(raw);
      expect(result.initial.due).toBeUndefined();
      expect(result.initial.time).toBeUndefined();
      expect(result.candidates).toContainEqual(
        expect.objectContaining({ status: 'range', reason: 'range' }),
      );
    },
  );
  it('still masks a signed number following a relative point', () => {
    const result = project(createTaskInputState('Tomorrow -5 degrees'));
    expect(result.markdownBody).toBe('-5 degrees');
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
  });
});

describe('final review: hyphenated named point dates', () => {
  it.each(['June-5 conference', '5-June conference'])(
    'retains accepted named-date planning: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.markdownBody).toBe('conference');
      expect(result.initial.due).toEqual({ type: 'set', value: '2027-06-05' });
      expect(result.initial.time).toBeUndefined();
      expect(result.candidates).toContainEqual(
        expect.objectContaining({ status: 'point', dateOrigin: 'named', date: '2027-06-05' }),
      );
    },
  );
});

describe('signed suffix ownership at resolved date boundaries', () => {
  it.each([
    ['Tomorrow-5 degrees', 'Tomorrow', '-5 degrees', '2026-10-14'],
    ['Завтра-5 градусов', 'Завтра', '-5 градусов', '2026-10-14'],
    ['Tomorrow+5 degrees', 'Tomorrow', '+5 degrees', '2026-10-14'],
    ['Завтра+5 градусов', 'Завтра', '+5 градусов', '2026-10-14'],
    ['Today-0 units', 'Today', '-0 units', '2026-10-13'],
    ['Yesterday+14 units', 'Yesterday', '+14 units', '2026-10-12'],
    ['Tomorrow-5.5 degrees', 'Tomorrow', '-5.5 degrees', '2026-10-14'],
    ['Завтра+5,5 градусов', 'Завтра', '+5,5 градусов', '2026-10-14'],
    ['5 June-5 degrees', '5 June', '-5 degrees', '2027-06-05'],
    ['5 июня+5 units', '5 июня', '+5 units', '2027-06-05'],
  ])('consumes only the date before its signed title: %s', (raw, date, title, due) => {
    const result = project(createTaskInputState(raw));
    expect(result.markdownBody).toBe(title);
    expect(result.initial.due).toEqual({ type: 'set', value: due });
    expect(result.initial.time).toBeUndefined();
    expect(
      result.candidates
        .flatMap((candidate) => candidate.ranges)
        .map((range) => raw.slice(range.from, range.to)),
    ).toEqual([date]);
  });

  it.each(['June+5 units', 'June-5.5 units', 'June-5,5 units'])(
    'does not turn a signed value into a named date: %s',
    (raw) => {
      const result = project(createTaskInputState(raw));
      expect(result.markdownBody).toBe(raw);
      expect(result.initial.due).toBeUndefined();
    },
  );
});
