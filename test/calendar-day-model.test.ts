import { describe, expect, it } from 'vitest';
import { localDate, shiftLocalDate, type LocalDate } from '../src/tasks';
import { buildCalendarDayModel } from '../src/views/calendarDayModel';
import {
  projectCalendarOccurrences,
  type CalendarOccurrence,
  type CalendarTaskSource,
} from '../src/views/calendarOccurrences';
import { expectDefined, subtask, task, type TaskFixtureInput } from './helpers';

const date = localDate('2026-10-16');
const range = { from: localDate('2026-10-01'), to: localDate('2026-11-30') };
const policy = { removeScheduledDate: false };

function rootSource(input: TaskFixtureInput): CalendarTaskSource {
  const root = task(input);
  return { root, node: root, target: { type: 'task', ref: root.ref } };
}

function project(
  materialized: readonly CalendarTaskSource[],
  recurringSources: readonly CalendarTaskSource[] = [],
): readonly CalendarOccurrence[] {
  return projectCalendarOccurrences({ materialized, recurringSources }, range, policy).occurrences;
}

function point(line: number): CalendarOccurrence {
  return expectDefined(
    project([rootSource({ title: `Item ${line}`, source: { line }, planning: { due: date } })])[0],
  );
}

function datesFrom(start: LocalDate, count: number): LocalDate[] {
  return Array.from({ length: count }, (_, index) => expectDefined(shiftLocalDate(start, index)));
}

describe('bounded calendar day model', () => {
  it.each([
    { count: 0, dots: 0, overflow: false },
    { count: 1, dots: 1, overflow: false },
    { count: 2, dots: 2, overflow: false },
    { count: 3, dots: 3, overflow: false },
    { count: 4, dots: 3, overflow: true },
    { count: 20, dots: 3, overflow: true },
  ])('summarizes $count occurrences with bounded indicators', ({ count, dots, overflow }) => {
    const sources = Array.from({ length: count }, (_, line) => point(line));
    const summary = expectDefined(buildCalendarDayModel(sources, [date]).get(date));
    expect(summary).toMatchObject({ date, count, dots, overflow });
    expect(summary.entries).toHaveLength(count);
  });

  it('preserves input order and object identity while deduplicating only within each date', () => {
    const span = expectDefined(
      project([
        rootSource({
          source: { line: 5 },
          planning: { start: '2026-10-15', due: '2026-10-17' },
        }),
      ])[0],
    );
    const first = point(1);
    const last = point(2);
    const visible = datesFrom(localDate('2026-10-15'), 3);
    const model = buildCalendarDayModel([last, span, first, span, last], visible);
    expect(model.get(date)?.entries.map((entry) => entry.key)).toEqual([
      'f.md:2:2026-10-16',
      'f.md:5:2026-10-17',
      'f.md:1:2026-10-16',
    ]);
    for (const [index, source] of [last, span, first].entries()) {
      const entry = expectDefined(model.get(date)?.entries[index]);
      expect(entry.occurrence).toBe(source);
      expect(entry.occurrence.source).toBe(source.source);
    }
    expect(model.get(localDate('2026-10-15'))?.count).toBe(1);
    expect(model.get(localDate('2026-10-17'))?.count).toBe(1);
  });

  it('groups coincident roles once and keeps distinct scheduled and due points on their own dates', () => {
    const sources = project([
      rootSource({
        planning: { start: date, scheduled: date, due: date },
        source: { line: 1 },
      }),
      rootSource({
        planning: { scheduled: '2026-10-15', due: date },
        source: { line: 2 },
      }),
    ]);
    const model = buildCalendarDayModel(sources, datesFrom(localDate('2026-10-14'), 4));
    expect(model.get(localDate('2026-10-15'))?.entries.map((entry) => entry.key)).toEqual([
      'f.md:2:2026-10-15',
    ]);
    expect(model.get(date)?.entries.map((entry) => entry.key)).toEqual([
      'f.md:1:2026-10-16',
      'f.md:2:2026-10-16',
    ]);
    expect(model.get(localDate('2026-10-14'))?.count).toBe(0);
    expect(model.get(localDate('2026-10-17'))?.count).toBe(0);
  });

  it('preserves distinct same-title children and their exact subtask targets under one root', () => {
    const parent = task({ title: 'Parent', source: { filePath: 'Nested.md', line: 4 } });
    const children = [1, 2].map((relativeLine) =>
      subtask({
        title: 'Same title',
        planning: { due: date },
        ref: { parent: { type: 'task', ref: parent.ref }, relativeLine },
      }),
    );
    const root = task({ ...parent, subtasks: children });
    const sources = project(
      children.map((node) => ({ root, node, target: { type: 'subtask', ref: node.ref } })),
    );
    const entries = expectDefined(buildCalendarDayModel(sources, [date]).get(date)).entries;
    expect(entries.map((entry) => entry.key)).toEqual([
      'Nested.md:4:subtask:1:2026-10-16',
      'Nested.md:4:subtask:2:2026-10-16',
    ]);
    for (const [index, child] of children.entries()) {
      const entry = expectDefined(entries[index]);
      expect(entry.occurrence.source.target).toEqual({ type: 'subtask', ref: child.ref });
      expect(entry.occurrence).toBe(expectDefined(sources[index]));
      expect(entry.occurrence.source.node).toBe(child);
      expect(entry.occurrence.source.root).toBe(root);
    }
  });

  it('keeps timed spans inclusive and completion canonical on start, middle, and due dates', () => {
    const sources = project([
      rootSource({
        planning: {
          start: '2026-10-15',
          due: '2026-10-17',
          scheduled: '2026-11-01',
          time: '09:30',
          duration: 90,
        },
      }),
    ]);
    const model = buildCalendarDayModel(sources, datesFrom(localDate('2026-10-14'), 5));
    expect([...model.values()].map((summary) => summary.count)).toEqual([0, 1, 1, 1, 0]);
    expect(model.get(localDate('2026-10-15'))?.entries[0]?.completion).toEqual({
      kind: 'continuation',
      due: '2026-10-17',
    });
    expect(model.get(date)?.entries[0]?.completion).toEqual({
      kind: 'continuation',
      due: '2026-10-17',
    });
    expect(model.get(localDate('2026-10-17'))?.entries[0]?.completion).toEqual({ kind: 'allowed' });
    expect(model.get(date)?.entries[0]?.occurrence.planning.time).toBe('09:30');
  });

  it('keeps reversed spans as authored points without filling the dates between', () => {
    const sources = project([
      rootSource({ planning: { start: '2026-10-17', due: '2026-10-15', scheduled: '2026-10-17' } }),
    ]);
    const model = buildCalendarDayModel(sources, datesFrom(localDate('2026-10-15'), 3));
    expect([...model.values()].map((summary) => summary.count)).toEqual([1, 0, 1]);
    expect(model.get(localDate('2026-10-15'))?.entries[0]?.completion).toEqual({ kind: 'allowed' });
    expect(model.get(localDate('2026-10-17'))?.entries[0]?.completion).toEqual({ kind: 'allowed' });
  });

  it.each([7, 42])('bounds a whole-domain interval to the exact %i supplied dates', (count) => {
    const visible = datesFrom(localDate('2026-10-01'), count);
    const sources = project([
      rootSource({ planning: { start: '0000-01-01', due: '9999-12-31' } }),
      rootSource({ source: { line: 1 }, planning: { due: '2026-11-30' } }),
    ]);
    const model = buildCalendarDayModel(sources, visible);
    expect([...model.keys()]).toEqual(visible);
    expect([...model.values()].map((summary) => summary.count)).toEqual(
      Array<number>(count).fill(1),
    );
    expect(model.has(localDate('0000-01-01'))).toBe(false);
    expect(model.has(localDate('9999-12-31'))).toBe(false);
    expect(model.has(localDate('2026-11-30'))).toBe(false);
  });

  it('does not introduce a status filter for supplied done and cancelled occurrences', () => {
    const sources = project([
      rootSource({ status: 'done', source: { line: 1 }, planning: { due: date } }),
      rootSource({ status: 'cancelled', source: { line: 2 }, planning: { due: date } }),
    ]);
    const summary = expectDefined(buildCalendarDayModel(sources, [date]).get(date));
    expect(summary.entries.map((entry) => entry.occurrence.source.node.status)).toEqual([
      'done',
      'cancelled',
    ]);
    expect(summary.count).toBe(2);
  });

  it('uses forecast planning for distinct points and spans while retaining forecast ownership', () => {
    const points = rootSource({
      recurrence: 'every day',
      planning: { scheduled: '2026-10-14', due: '2026-10-15' },
    });
    const span = rootSource({
      recurrence: 'every day',
      source: { line: 1 },
      planning: { start: '2026-10-14', due: '2026-10-16' },
    });
    const forecasts = project([], [points, span]);
    const pointForecast = expectDefined(
      forecasts.find(
        (source) =>
          source.kind === 'forecast' &&
          source.source === points &&
          source.referenceDate === '2026-10-17',
      ),
    );
    const spanForecast = expectDefined(
      forecasts.find(
        (source) =>
          source.kind === 'forecast' &&
          source.source === span &&
          source.referenceDate === '2026-10-19',
      ),
    );
    const model = buildCalendarDayModel([pointForecast, spanForecast], datesFrom(date, 5));
    expect([...model.values()].map((summary) => summary.count)).toEqual([1, 2, 1, 1, 0]);
    expect(model.get(date)?.entries[0]?.completion).toEqual({ kind: 'allowed' });
    expect(model.get(localDate('2026-10-17'))?.entries[1]?.completion).toEqual({
      kind: 'continuation',
      due: '2026-10-19',
    });
    expect(model.get(localDate('2026-10-18'))?.entries[0]?.completion).toEqual({
      kind: 'continuation',
      due: '2026-10-19',
    });
    expect(model.get(localDate('2026-10-19'))?.entries[0]?.completion).toEqual({ kind: 'allowed' });
    const entry = expectDefined(model.get(localDate('2026-10-17'))?.entries[1]);
    expect(entry.occurrence).toBe(spanForecast);
    expect(entry.occurrence.source).toBe(span);
    expect(entry.occurrence.kind).toBe('forecast');
    expect(entry.occurrence.source.target).toEqual({ type: 'task', ref: span.root.ref });
    expect(entry.key).toBe(spanForecast.key);
  });

  it('returns only requested empty dates, including a disjoint input order, and freezes exposed records', () => {
    const visible = [localDate('2026-11-01'), localDate('2026-10-01')];
    const sources = [point(1)];
    const model = buildCalendarDayModel(sources, visible);
    expect([...model.keys()]).toEqual(visible);
    expect([...model.values()]).toEqual(
      visible.map((date) => ({ date, entries: [], count: 0, dots: 0, overflow: false })),
    );
    expect(buildCalendarDayModel(sources, []).size).toBe(0);
    const summary = expectDefined(buildCalendarDayModel(sources, [date]).get(date));
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.entries)).toBe(true);
    expect(Object.isFrozen(summary.entries[0])).toBe(true);
    expect(Object.isFrozen(summary.entries[0]?.completion)).toBe(true);
  });
});

describe('nested calendar forecasts', () => {
  it('retains the exact forecast child node, root and target', () => {
    const parent = task({ title: 'Parent', source: { filePath: 'Nested.md', line: 4 } });
    const child = subtask({
      title: 'Child forecast',
      recurrence: 'every day',
      planning: { due: '2026-10-15' },
      ref: { parent: { type: 'task', ref: parent.ref }, relativeLine: 2 },
    });
    const source: CalendarTaskSource = {
      root: task({ ...parent, subtasks: [child] }),
      node: child,
      target: { type: 'subtask', ref: child.ref },
    };
    const forecasts = project([], [source]);
    const forecast = expectDefined(
      forecasts.find(
        (occurrence) => occurrence.kind === 'forecast' && occurrence.referenceDate === date,
      ),
    );
    const entry = expectDefined(buildCalendarDayModel([forecast], [date]).get(date)?.entries[0]);
    expect(entry.key).toBe('Nested.md:4:subtask:2:2026-10-16');
    expect(entry.occurrence.kind).toBe('forecast');
    expect(entry.occurrence.source.target).toEqual({ type: 'subtask', ref: child.ref });
    expect(entry.occurrence).toBe(forecast);
    expect(entry.occurrence.source).toBe(source);
    expect(entry.occurrence.source.node).toBe(child);
    expect(entry.occurrence.source.root).toBe(source.root);
    expect(entry.completion).toEqual({ kind: 'allowed' });
  });
});
