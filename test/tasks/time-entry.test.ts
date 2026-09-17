import { describe, expect, it } from 'vitest';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import {
  closeEntryLine,
  formatOpenEntry,
  isTimeEntryShape,
  parseTimeEntryLine,
  type OffsetAt,
  type TimeEntryIssue,
} from '../../src/tasks/domain/timeEntry';

const plus3: OffsetAt = () => 180;
const ms = (iso: string): number => Date.parse(iso);

describe('parseTimeEntryLine', () => {
  it.each([
    [
      '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00',
      '2026-09-17T09:12:00+03:00',
      '2026-09-17T10:40:51+03:00',
    ],
    [
      '- 2026-09-17T09:12:00Z → 2026-09-17T09:13:00Z',
      '2026-09-17T09:12:00Z',
      '2026-09-17T09:13:00Z',
    ],
    [
      '- 2026-09-17T09:12:00.250+03:00 → 2026-09-17T09:13:00+03:00',
      '2026-09-17T09:12:00.250+03:00',
      '2026-09-17T09:13:00+03:00',
    ],
    [
      '- 2026-09-17T09:12+03:00 → 2026-09-17T10:00+03:00',
      '2026-09-17T09:12:00+03:00',
      '2026-09-17T10:00:00+03:00',
    ],
    [
      '- 2026-09-17 09:12 → 2026-09-17 10:40',
      '2026-09-17T09:12:00+03:00',
      '2026-09-17T10:40:00+03:00',
    ],
    ['- 2026-09-17 9:12 → 10:40', '2026-09-17T09:12:00+03:00', '2026-09-17T10:40:00+03:00'],
    [
      '- 2026-09-17T09:12:00+03:00 → 10:40:30',
      '2026-09-17T09:12:00+03:00',
      '2026-09-17T10:40:30+03:00',
    ],
    [
      '- 2026-09-17T23:30:00+03:00 → 2026-09-18T00:15:00+03:00',
      '2026-09-17T23:30:00+03:00',
      '2026-09-18T00:15:00+03:00',
    ],
    [
      '- 2026-09-17T09:12:00+03:00→2026-09-17T10:00:00+03:00',
      '2026-09-17T09:12:00+03:00',
      '2026-09-17T10:00:00+03:00',
    ],
    [
      '> - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:00:00+03:00\r',
      '2026-09-17T09:12:00+03:00',
      '2026-09-17T10:00:00+03:00',
    ],
  ])('reads closed entry %s', (line, start, end) => {
    expect(parseTimeEntryLine(line, plus3)).toEqual({
      state: 'closed',
      startMs: ms(start),
      endMs: ms(end),
    });
  });

  it('inherits a missing start offset from the end', () => {
    const parsed = parseTimeEntryLine('- 2026-09-17 09:12 → 2026-09-17T10:00:00+05:00', plus3);
    expect(parsed).toEqual({
      state: 'closed',
      startMs: ms('2026-09-17T09:12:00+05:00'),
      endMs: ms('2026-09-17T10:00:00+05:00'),
    });
  });

  it('inherits a missing end offset from the start', () => {
    const parsed = parseTimeEntryLine('- 2026-09-17T09:12:00-04:00 → 2026-09-17 10:00', plus3);
    expect(parsed?.endMs).toBe(ms('2026-09-17T10:00:00-04:00'));
  });

  it('resolves a fully floating entry through the device offset in two passes', () => {
    // Offset flips from +60 to +120 at 2026-03-29T01:00:00Z (a DST start).
    const flip = ms('2026-03-29T01:00:00Z');
    const dst: OffsetAt = (epochMs) => (epochMs >= flip ? 120 : 60);
    const parsed = parseTimeEntryLine('- 2026-03-29 04:00 → 2026-03-29 05:00', dst);
    expect(parsed?.startMs).toBe(ms('2026-03-29T04:00:00+02:00'));
    expect(parsed?.endMs).toBe(ms('2026-03-29T05:00:00+02:00'));
  });

  it.each([
    '- 2026-09-18T14:05:32+03:00 →',
    '- 2026-09-18T14:05:32+03:00 →   ',
    '- 2026-09-18 14:05 →',
  ])('reads running entry %s', (line) => {
    const parsed = parseTimeEntryLine(line, plus3);
    expect(parsed?.state).toBe('running');
    expect(parsed?.endMs).toBeUndefined();
    expect(parsed?.tail).toBeUndefined();
  });

  it('keeps free text after a closed entry as the tail', () => {
    const parsed = parseTimeEntryLine(
      '- 2026-09-18T11:00:00+03:00 → 2026-09-18T11:25:10+03:00 call with Bob → notes',
      plus3,
    );
    expect(parsed?.state).toBe('closed');
    expect(parsed?.tail).toBe('call with Bob → notes');
  });

  it('keeps free text after the arrow of a running entry as the tail', () => {
    const parsed = parseTimeEntryLine('- 2026-09-18T11:00:00+03:00 → call with Bob', plus3);
    expect(parsed).toEqual({
      state: 'running',
      startMs: ms('2026-09-18T11:00:00+03:00'),
      tail: 'call with Bob',
    });
  });

  it('reads a tail that starts with a valid time as the end', () => {
    const parsed = parseTimeEntryLine('- 2026-09-18T11:00:00+03:00 → 11:30 call', plus3);
    expect(parsed).toEqual({
      state: 'closed',
      startMs: ms('2026-09-18T11:00:00+03:00'),
      endMs: ms('2026-09-18T11:30:00+03:00'),
      tail: 'call',
    });
  });

  it.each([
    ['- 2026-13-45T09:12:00+03:00 →', 'invalid-start'],
    ['- 2026-09-17T24:00:00+03:00 →', 'invalid-start'],
    ['- 2026-09-17T09:60:00+03:00 →', 'invalid-start'],
    ['- 2026-09-17T09:12:00+15:00 →', 'invalid-start'],
    ['- 2026-09-17T09:12:00+03:00 → 25:99', 'invalid-end'],
    ['- 2026-09-17T09:12:00+03:00 → 2026-02-30T10:00:00+03:00', 'invalid-end'],
    ['- 2026-09-17T09:12:00+03:00 → 2026-09', 'invalid-end'],
    ['- 2026-09-17T14:05:00+03:00 → 13:20', 'end-before-start'],
    ['- 2026-09-17T14:05:00+03:00 → 2026-09-16T14:05:00+03:00', 'end-before-start'],
  ] satisfies Array<[string, TimeEntryIssue]>)('flags broken entry %s as %s', (line, issue) => {
    const parsed = parseTimeEntryLine(line, plus3);
    expect(parsed?.state).toBe('broken');
    expect(parsed?.issue).toBe(issue);
  });

  it('accepts an end equal to the start', () => {
    expect(parseTimeEntryLine('- 2026-09-17T09:12:00+03:00 → 09:12', plus3)?.state).toBe('closed');
  });

  it('leaves out every key it has no value for', () => {
    expect(parseTimeEntryLine('- 2026-13-45T09:12:00+03:00 →', plus3)).toStrictEqual({
      state: 'broken',
      issue: 'invalid-start',
    });
    expect(parseTimeEntryLine('- 2026-09-17T14:05:00+03:00 → 13:20 note', plus3)).toStrictEqual({
      state: 'broken',
      issue: 'end-before-start',
    });
    expect(parseTimeEntryLine('- 2026-09-18T14:05:32+03:00 →', plus3)).toStrictEqual({
      state: 'running',
      startMs: ms('2026-09-18T14:05:32+03:00'),
    });
  });

  it.each([
    '- plain comment',
    '- 2026-09-17T09:12:00+03:00: comment with an instant prefix',
    '- 2026-09-17: comment with a day prefix → arrow later',
    '- 2026-09-17 → moved to tomorrow',
    '- 2026-09-17 09:12 - 10:40',
    '- 2026-09-17 09:12 -> 10:40',
    '- note 2026-09-17 09:12 → 10:40',
    '- [ ] 2026-09-17 09:12 → 10:40',
    '- > 2026-09-17 09:12 → 10:40',
    '2026-09-17 09:12 → 10:40',
  ])('leaves %s to the comment path', (line) => {
    expect(parseTimeEntryLine(line, plus3)).toBeUndefined();
    expect(isTimeEntryShape(line)).toBe(false);
  });

  it('recognizes the shape of broken and running entries for recurrence stripping', () => {
    expect(isTimeEntryShape('  - 2026-13-45T09:12:00+03:00 →')).toBe(true);
    expect(isTimeEntryShape('\t- 2026-09-18 14:05 → text')).toBe(true);
  });
});

describe('writing', () => {
  it('formats a new running entry', () => {
    expect(formatOpenEntry(atomDateTime('2026-09-18T14:05:32+03:00'))).toBe(
      '2026-09-18T14:05:32+03:00 →',
    );
  });

  it('closes a running line and preserves a hand-written start and the tail', () => {
    expect(
      closeEntryLine(
        '    - 2026-09-18 14:05 → call with Bob',
        atomDateTime('2026-09-18T15:20:00+03:00'),
      ),
    ).toBe('    - 2026-09-18 14:05 → 2026-09-18T15:20:00+03:00 call with Bob');
    expect(
      closeEntryLine('- 2026-09-18T14:05:32+03:00 →', atomDateTime('2026-09-18T15:20:00+03:00')),
    ).toBe('- 2026-09-18T14:05:32+03:00 → 2026-09-18T15:20:00+03:00');
  });

  it('refuses to close a line that is not a running entry', () => {
    const end = atomDateTime('2026-09-18T15:20:00+03:00');
    expect(closeEntryLine('- plain comment', end)).toBeUndefined();
    expect(
      closeEntryLine('- 2026-09-18T14:05:32+03:00 → 2026-09-18T15:00:00+03:00', end),
    ).toBeUndefined();
  });
});
