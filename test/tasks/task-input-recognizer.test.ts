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
