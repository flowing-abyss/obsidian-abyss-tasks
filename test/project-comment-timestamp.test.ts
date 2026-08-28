import { describe, expect, it } from 'vitest';
import { parseCommentTimestampBody } from '../src/tasks/domain/commentTimestamp';

describe('Project comment timestamp scalar parser', () => {
  it.each([
    [
      '2026-08-11T16:32:10.123456-05:30:  release notes',
      '2026-08-11T16:32:10.123456-05:30:  ',
      '2026-08-11T16:32:10.123456-05:30',
      'release notes',
      'instant',
      Date.parse('2026-08-11T22:02:10.123Z'),
    ],
    ['2026-08-11: legacy note', '2026-08-11: ', '2026-08-11', 'legacy note', 'day', undefined],
  ] as const)(
    'parses %s without normalizing its raw timestamp or body',
    (source, prefix, raw, text, precision, epochMs) => {
      const parsed = parseCommentTimestampBody(source);

      expect(parsed).toMatchObject({ kind: 'timestamp', prefix, text });
      if (parsed.kind !== 'timestamp') throw new Error('expected a timestamp scalar');
      expect(parsed.timestamp.raw).toBe(raw);
      expect(parsed.timestamp.precision).toBe(precision);
      if (epochMs !== undefined) expect(parsed.timestamp).toMatchObject({ epochMs });
      expect(`${parsed.prefix}${parsed.text}`).toBe(source);
    },
  );

  it.each([
    ['2026-08-11:', '2026-08-11:', ''],
    ['2026-08-11: \t ', '2026-08-11: \t ', ''],
    ['2026-08-11:  keep  trailing spaces  ', '2026-08-11:  ', 'keep  trailing spaces  '],
  ])('preserves empty and whitespace-delimited bodies for %s', (source, prefix, text) => {
    const parsed = parseCommentTimestampBody(source);

    expect(parsed).toMatchObject({ kind: 'timestamp', prefix, text });
    if (parsed.kind !== 'timestamp') throw new Error('expected a timestamp scalar');
    expect(`${parsed.prefix}${parsed.text}`).toBe(source);
  });

  it.each([
    '2026-02-30: impossible date',
    '2026-08-11T24:00:00Z: impossible hour',
    '2026-08-11T12:00:00-00:00: negative zero offset',
    '2026-08-11T12:00:00+14:01: offset past RFC3339 limit',
    '2026-08-11 body without separator',
  ])('keeps malformed timestamp-shaped scalar %s unparsed without losing text', (source) => {
    expect(parseCommentTimestampBody(source)).toEqual({ kind: 'malformed', text: source });
  });

  it('keeps ordinary undated prose distinct from malformed timestamp-shaped scalars', () => {
    expect(parseCommentTimestampBody('Meet at 12:30: bring notes')).toEqual({
      kind: 'undated',
      text: 'Meet at 12:30: bring notes',
    });
  });
});
