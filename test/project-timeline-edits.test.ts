import { describe, expect, it } from 'vitest';
import {
  planProjectTimelineEdit,
  projectTimelineRawEditEligibility,
} from '../src/projects/projectTimelineEdits';

describe('project Timeline date edits', () => {
  it('moves closed ranges by inclusive calendar days across leap day', () => {
    expect(
      planProjectTimelineEdit(
        { kind: 'closed', startDay: '2028-02-28', endDay: '2028-03-01' },
        { type: 'move', deltaDays: 1 },
      ),
    ).toEqual({ kind: 'ready', startDay: '2028-02-29', endDay: '2028-03-02' });
  });

  it.each([
    [
      { type: 'resizeStart', day: '2026-09-10' } as const,
      { kind: 'ready', startDay: '2026-09-05', endDay: '2026-09-05' },
    ],
    [
      { type: 'resizeEnd', day: '2026-08-20' } as const,
      { kind: 'ready', startDay: '2026-09-01', endDay: '2026-09-01' },
    ],
  ])('clamps a resize that crosses the opposite endpoint', (intent, expected) => {
    expect(
      planProjectTimelineEdit(
        { kind: 'closed', startDay: '2026-09-01', endDay: '2026-09-05' },
        intent,
      ),
    ).toEqual(expected);
  });

  it.each([
    [
      { kind: 'open-end', startDay: '2026-09-01' } as const,
      { kind: 'ready', startDay: '2026-09-03' },
    ],
    [
      { kind: 'open-start', endDay: '2026-09-05' } as const,
      { kind: 'ready', endDay: '2026-09-07' },
    ],
  ])('moves an open range without creating its missing endpoint', (range, expected) => {
    expect(planProjectTimelineEdit(range, { type: 'move', deltaDays: 2 })).toEqual(expected);
  });

  it('normalizes a reverse draw into an inclusive closed range', () => {
    expect(
      planProjectTimelineEdit(
        { kind: 'unscheduled' },
        { type: 'draw', startDay: '2026-09-12', endDay: '2026-09-08' },
      ),
    ).toEqual({ kind: 'ready', startDay: '2026-09-08', endDay: '2026-09-12' });
  });

  it('initializes a missing End from Start before applying a relative keyboard adjustment', () => {
    expect(
      planProjectTimelineEdit(
        { kind: 'open-end', startDay: '2026-09-10' },
        { type: 'adjustEnd', deltaDays: 1 },
      ),
    ).toEqual({ kind: 'ready', startDay: '2026-09-10', endDay: '2026-09-11' });
    expect(
      planProjectTimelineEdit(
        { kind: 'open-end', startDay: '2026-09-10' },
        { type: 'adjustEnd', deltaDays: -1 },
      ),
    ).toEqual({ kind: 'ready', startDay: '2026-09-10', endDay: '2026-09-10' });
  });

  it.each([
    [
      { kind: 'malformed', start: 'later', end: '2026-09-01' } as const,
      { type: 'move', deltaDays: 1 } as const,
      'Invalid project dates must be repaired in the date fields before Timeline editing.',
    ],
    [
      { kind: 'closed', startDay: '2026-09-01', endDay: '2026-09-02' } as const,
      { type: 'resizeEnd', day: '2026-02-30' } as const,
      'The proposed Timeline date is invalid.',
    ],
    [
      { kind: 'closed', startDay: '9999-12-31', endDay: '9999-12-31' } as const,
      { type: 'move', deltaDays: 1 } as const,
      'The proposed Timeline date is outside the supported years 0100–9999.',
    ],
  ])('rejects malformed or unsupported date intent %#', (range, intent, reason) => {
    expect(planProjectTimelineEdit(range, intent)).toEqual({ kind: 'rejected', reason });
  });

  it.each([
    [
      { exists: false, value: undefined },
      { exists: true, value: '' },
    ],
    [
      { exists: true, value: null },
      { exists: true, value: '2026-09-03' },
    ],
  ])('allows missing and exact empty endpoint source states', (start, end) => {
    expect(projectTimelineRawEditEligibility(start, end)).toEqual({ kind: 'eligible' });
  });

  it.each(['2026-09-03T09:30', '2026-09-03T09:30+02:00'])('allows valid timestamp %s', (value) => {
    expect(
      projectTimelineRawEditEligibility(
        { exists: true, value },
        { exists: false, value: undefined },
      ),
    ).toEqual({ kind: 'eligible' });
  });

  it.each([['September 3', 'Start is not a valid date']])(
    'rejects lossy gesture editing for raw value %s',
    (value, prefix) => {
      expect(
        projectTimelineRawEditEligibility(
          { exists: true, value },
          { exists: true, value: '2026-09-04' },
        ),
      ).toEqual({
        kind: 'ineligible',
        reason: `${prefix}. Use the Start and End fields to edit this range.`,
      });
    },
  );
});
