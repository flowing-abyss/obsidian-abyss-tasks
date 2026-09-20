import { describe, expect, it } from 'vitest';
import { projectCalendarDay } from '../src/projects/projectDateValue';
import type {
  ProjectTimelineEditIntent,
  ProjectTimelineRawEndpoint,
} from '../src/projects/projectTimelineEdits';
import { planProjectTimelineEndpointEdit } from '../src/projects/projectTimelineEndpointEdits';
import type { ProjectTimelineRange } from '../src/projects/projectTimelineModel';

const absent = { exists: false, value: undefined };
const raw = (value: unknown): ProjectTimelineRawEndpoint => ({ exists: true, value });
function plan(
  range: ProjectTimelineRange,
  start: ProjectTimelineRawEndpoint,
  end: ProjectTimelineRawEndpoint,
  intent: ProjectTimelineEditIntent,
) {
  const result = planProjectTimelineEndpointEdit(range, { start, end }, intent);
  if (result.kind === 'ready') {
    expect(projectCalendarDay(result.start.value)).toBe(
      result.range.kind === 'closed' || result.range.kind === 'open-end'
        ? result.range.startDay
        : undefined,
    );
    expect(projectCalendarDay(result.end.value)).toBe(
      result.range.kind === 'closed' || result.range.kind === 'open-start'
        ? result.range.endDay
        : undefined,
    );
  }
  return result;
}

describe('lossless Timeline endpoint plans', () => {
  it.each(['09:30', '09:30:15', '09:30:15.1', '09:30:15.12', '09:30:15.123'])(
    'creates End with inherited clock and precision %s',
    (clock) => {
      const start = raw(`2026-09-03T${clock}`);
      expect(
        plan({ kind: 'open-end', startDay: '2026-09-03' }, start, absent, {
          type: 'resizeEnd',
          day: '2026-09-07',
        }),
      ).toEqual({
        kind: 'ready',
        range: { kind: 'closed', startDay: '2026-09-03', endDay: '2026-09-07' },
        start,
        end: raw(`2026-09-07T${clock}`),
      });
    },
  );
  it.each(['Z', '+00:00', '+02:00'])(
    'inherits an explicit %s carrier for a missing End',
    (suffix) => {
      expect(
        plan(
          { kind: 'open-end', startDay: '2026-09-03' },
          raw(`2026-09-03T09:30:15.120${suffix}`),
          absent,
          { type: 'resizeEnd', day: '2026-09-07' },
        ),
      ).toMatchObject({
        kind: 'ready',
        start: raw(`2026-09-03T09:30:15.120${suffix}`),
        end: raw(`2026-09-07T09:30:15.120${suffix}`),
      });
    },
  );
  it.each([
    ['0100-01-02', -1, '0100-01-01'],
    ['9999-12-30', 1, '9999-12-31'],
  ] as const)('retains supported edge year from %s', (startDay, deltaDays, target) => {
    expect(
      plan({ kind: 'open-end', startDay }, raw(`${startDay}T09:30`), absent, {
        type: 'move',
        deltaDays,
      }),
    ).toMatchObject({ kind: 'ready', start: raw(`${target}T09:30`) });
  });
  it('creates Start with the End clock', () => {
    const end = raw('2026-09-07T09:30:15.12');
    expect(
      plan({ kind: 'open-start', endDay: '2026-09-07' }, absent, end, {
        type: 'resizeStart',
        day: '2026-09-03',
      }),
    ).toMatchObject({ kind: 'ready', start: raw('2026-09-03T09:30:15.12'), end });
  });
  it.each(['resizeStart', 'setStart'] as const)('clamps %s backward retaining clocks', (type) => {
    expect(
      plan(
        { kind: 'closed', startDay: '2026-09-01', endDay: '2026-09-03' },
        raw('2026-09-01T18:00'),
        raw('2026-09-03T09:00'),
        { type, day: '2026-09-03' },
      ),
    ).toMatchObject({
      kind: 'ready',
      range: { kind: 'closed', startDay: '2026-09-02', endDay: '2026-09-03' },
      start: raw('2026-09-02T18:00'),
      end: raw('2026-09-03T09:00'),
    });
  });
  it.each(['resizeEnd', 'setEnd', 'adjustEnd'] as const)(
    'clamps %s forward retaining clocks',
    (type) => {
      const intent = type === 'adjustEnd' ? { type, deltaDays: -2 } : { type, day: '2026-09-01' };
      expect(
        plan(
          { kind: 'closed', startDay: '2026-09-01', endDay: '2026-09-03' },
          raw('2026-09-01T18:00'),
          raw('2026-09-03T09:00'),
          intent,
        ),
      ).toMatchObject({
        kind: 'ready',
        start: raw('2026-09-01T18:00'),
        end: raw('2026-09-02T09:00'),
      });
    },
  );
  it.each([null, '', undefined])(
    'preserves missing/empty %s evidence while moving either open range',
    (value) => {
      const empty = { exists: value !== undefined, value };
      expect(
        plan({ kind: 'open-end', startDay: '2026-09-03' }, raw('2026-09-03T09:30'), empty, {
          type: 'move',
          deltaDays: 1,
        }),
      ).toMatchObject({ kind: 'ready', start: raw('2026-09-04T09:30'), end: empty });
      expect(
        plan({ kind: 'open-start', endDay: '2026-09-03' }, empty, raw('2026-09-03T09:30'), {
          type: 'move',
          deltaDays: -1,
        }),
      ).toMatchObject({ kind: 'ready', start: empty, end: raw('2026-09-02T09:30') });
    },
  );
  it('moves a closed mixed range without converting its encodings', () => {
    expect(
      plan(
        { kind: 'closed', startDay: '2026-09-03', endDay: '2026-09-04' },
        raw('2026-09-03'),
        raw('2026-09-04T09:30:15.12'),
        { type: 'move', deltaDays: 2 },
      ),
    ).toMatchObject({
      kind: 'ready',
      start: raw('2026-09-05'),
      end: raw('2026-09-06T09:30:15.12'),
    });
  });
  it.each(['2026-09-03T09:30Z', '2026-09-03T09:30+00:00'])('preserves exact no-op %s', (value) => {
    const start = raw(value);
    const startDay = projectCalendarDay(value);
    if (startDay === undefined) throw new Error('Invalid fixture');
    expect(
      plan({ kind: 'open-end', startDay }, start, absent, { type: 'move', deltaDays: 0 }),
    ).toMatchObject({ kind: 'ready', start, end: absent });
  });
  it('creates date-only assignments from unscheduled click and draw', () => {
    expect(
      plan({ kind: 'unscheduled' }, absent, raw(null), { type: 'setStart', day: '2026-09-03' }),
    ).toMatchObject({ kind: 'ready', start: raw('2026-09-03'), end: raw(null) });
    expect(
      plan({ kind: 'unscheduled' }, absent, absent, {
        type: 'draw',
        startDay: '2026-09-05',
        endDay: '2026-09-03',
      }),
    ).toMatchObject({ kind: 'ready', start: raw('2026-09-03'), end: raw('2026-09-05') });
  });
  it('allows an inherited timed endpoint on the same day', () => {
    expect(
      plan({ kind: 'open-end', startDay: '2026-09-03' }, raw('2026-09-03T18:00'), absent, {
        type: 'setEnd',
        day: '2026-09-03',
      }),
    ).toMatchObject({ kind: 'ready', end: raw('2026-09-03T18:00') });
  });
  it.each([
    ['0100-01-01', -1],
    ['9999-12-31', 1],
  ] as const)('rejects crossing supported boundary %s', (startDay, deltaDays) => {
    expect(
      plan({ kind: 'open-end', startDay }, raw(`${startDay}T09:30`), absent, {
        type: 'move',
        deltaDays,
      }),
    ).toMatchObject({ kind: 'rejected' });
  });
  it.each(['broken', '2026-02-30T09:30', 123])('rejects malformed raw source %s', (value) => {
    expect(
      plan({ kind: 'open-end', startDay: '2026-09-03' }, raw(value), absent, {
        type: 'move',
        deltaDays: 1,
      }),
    ).toMatchObject({ kind: 'rejected' });
  });
  it('rejects a reversed source even when given valid display days', () => {
    expect(
      plan(
        { kind: 'closed', startDay: '2026-09-03', endDay: '2026-09-03' },
        raw('2026-09-03T18:00'),
        raw('2026-09-03T09:00'),
        { type: 'resizeEnd', day: '2026-09-04' },
      ),
    ).toMatchObject({ kind: 'rejected' });
  });
});
