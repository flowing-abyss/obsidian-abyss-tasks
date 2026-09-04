import { describe, expect, it } from 'vitest';
import { clockFrom } from '../../src/tasks/domain/clock';
import {
  formatNewCommentTimestamp,
  parseCommentTimestampPrefix,
} from '../../src/tasks/domain/commentTimestamp';

describe('comment timestamp codec', () => {
  it.each([
    '2026-08-11T16:32:10+07:00',
    '2026-08-11T09:32:10Z',
    '2026-08-11T09:32:10.123Z',
    '2026-08-11T09:32:10.123456-05:30',
    '2026-08-11',
  ])('parses %s without changing its source lexeme', (raw) => {
    const parsed = parseCommentTimestampPrefix(`  - ${raw}: body`);

    expect(parsed).toMatchObject({ prefix: `  - ${raw}: `, text: 'body' });
    expect(parsed?.timestamp?.raw).toBe(raw);
  });

  it.each([
    '2026-02-30',
    '2026-08-11T24:00:00Z',
    '2026-08-11T12:00:60Z',
    '2026-08-11T12:00:00-00:00',
    '2026-08-11T12:00:00+14:01',
    '2026-08-11T12:00:00+15:00',
    '2026-08-11T12:00:00+12:99',
  ])('keeps invalid timestamp-shaped %s as complete undated text', (raw) => {
    expect(parseCommentTimestampPrefix(`  - ${raw}: body`)).toEqual({
      prefix: '  - ',
      timestamp: undefined,
      text: `${raw}: body`,
    });
  });

  it('returns an undated comment without consuming colon-bearing prose', () => {
    expect(parseCommentTimestampPrefix('>   - Meet at 12:30: bring notes')).toEqual({
      prefix: '>   - ',
      timestamp: undefined,
      text: 'Meet at 12:30: bring notes',
    });
  });

  it('preserves a carriage return convention while parsing the comment', () => {
    expect(parseCommentTimestampPrefix('  - 2026-08-11: body\r')).toMatchObject({
      prefix: '  - 2026-08-11: ',
      text: 'body',
    });
  });

  it('rejects lines that are not Markdown comment list items', () => {
    expect(parseCommentTimestampPrefix('2026-08-11: body')).toBeUndefined();
    expect(parseCommentTimestampPrefix('  - ')).toBeUndefined();
  });

  it('formats a new comment from the already captured clock reading', () => {
    const reading = clockFrom(Date.parse('2026-08-11T09:32:10Z'), 420).read();

    expect(formatNewCommentTimestamp(reading)).toBe('2026-08-11T16:32:10+07:00');
  });

  it('converts a January instant through the proleptic calendar', () => {
    expect(parseCommentTimestampPrefix('  - 2026-01-11T09:32:10Z: body')).toMatchObject({
      timestamp: { precision: 'instant', epochMs: Date.parse('2026-01-11T09:32:10Z') },
    });
  });

  it('keeps an impossible instant date as undated text', () => {
    expect(parseCommentTimestampPrefix('  - 2026-02-30T09:32:10Z: body')).toEqual({
      prefix: '  - ',
      timestamp: undefined,
      text: '2026-02-30T09:32:10Z: body',
    });
  });
});
