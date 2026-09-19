import { describe, expect, it } from 'vitest';
import { compileNotePathPattern } from '../src/markdown/notePathPattern';
import { useRealMoment } from './helpers';

useRealMoment();

describe('compileNotePathPattern', () => {
  it('keeps date-like letters literal outside explicit markers', () => {
    expect(compileNotePathPattern('My/Daily active.md').resolve('2026-09-14')).toBe(
      'My/Daily active.md',
    );
  });

  it('resolves DATE-prefixed and shorthand markers and adds markdown extensions', () => {
    expect(compileNotePathPattern('daily/{{DATE:YYYY-MM-DD}}').resolve('2026-09-14')).toBe(
      'daily/2026-09-14.md',
    );
    expect(compileNotePathPattern('archive/{{YYYY}}/{{MM-DD}}.md').resolve('2026-09-14')).toBe(
      'archive/2026/09-14.md',
    );
    expect(compileNotePathPattern('weeks/{{GGGG}}/[W]{{WW}}').resolve('2025-12-29')).toBe(
      'weeks/2026/[W]01.md',
    );
  });

  it('matches only paths produced by one valid calendar date', () => {
    const pattern = compileNotePathPattern('archive/{{YYYY}}/{{MM-DD}}.md');
    expect(pattern.matches('archive/2024/02-29.md')).toBe(true);
    expect(pattern.matches('archive/2025/02-29.md')).toBe(false);
    expect(pattern.matches('archive/2025/02-28.md')).toBe(true);
    expect(pattern.matches('archive-neighbor/2025/02-28.md')).toBe(false);
  });

  it('requires repeated date fields to agree', () => {
    const pattern = compileNotePathPattern('archive/{{YYYY}}/{{YYYY}}.md');
    expect(pattern.matches('archive/2025/2025.md')).toBe(true);
    expect(pattern.matches('archive/2025/2026.md')).toBe(false);
  });

  it('round-trips adjacent variable-width fields when another marker fixes the date', () => {
    const pattern = compileNotePathPattern('archive/{{YYYY-MM-DD}}-{{M}}{{D}}');
    const path = pattern.resolve('2026-11-01');

    expect(path).toBe('archive/2026-11-01-111.md');
    expect(pattern.matches(path)).toBe(true);
  });

  it.each([
    ['archive/{{YYYY}}-{{M}}{{D}}-{{DD}}', '2026-11-01', 'archive/2026-111-02.md'],
    ['archive/{{M}}{{D}}-{{DD}}', '2026-11-01', 'archive/111-02.md'],
    ['archive/{{YYYY}}-{{M}}{{D}}-{{DDD}}', '2026-11-01', 'archive/2026-111-304.md'],
    ['archive/{{GGGG}}-{{M}}{{D}}-{{WW}}', '2026-11-01', 'archive/2026-111-43.md'],
    ['archive/{{DDD}}-{{MM-DD}}', '2025-03-01', 'archive/60-03-02.md'],
    ['archive/{{M}}{{YYYY}}{{D}}-{{YY}}', '2012-11-01', 'archive/1120121-13.md'],
  ])(
    'round-trips ambiguous fields using independent calendar constraints: %s',
    (source, date, invalidNeighbor) => {
      const pattern = compileNotePathPattern(source);
      expect(pattern.matches(pattern.resolve(date))).toBe(true);
      expect(pattern.matches(invalidNeighbor)).toBe(false);
    },
  );

  it('bounds repeated ambiguous marker and token partitions', () => {
    const adjacentMarkers = compileNotePathPattern(`archive/${'{{M}}'.repeat(24)}`);
    expect(adjacentMarkers.matches(`archive/${'1'.repeat(36)}.md`)).toBe(false);

    const adjacentTokens = compileNotePathPattern(`archive/{{${'MD'.repeat(12)}}}`);
    expect(adjacentTokens.matches(`archive/${'1'.repeat(30)}.md`)).toBe(false);
  });

  it('preserves source offsets when Unicode literal case folding changes length', () => {
    const pattern = compileNotePathPattern('İ/{{YYYY-MM-DD}}');
    expect(pattern.matches(pattern.resolve('2012-11-01'))).toBe(true);
  });

  it('matches partial and mixed calendar and ISO-week paths against one candidate date', () => {
    const partial = compileNotePathPattern('archive/{{MM-DD}}.md');
    expect(partial.matches('archive/02-29.md')).toBe(true);
    expect(partial.matches('archive/02-30.md')).toBe(false);

    const mixed = compileNotePathPattern('archive/{{YYYY-MM-WW}}.md');
    const path = mixed.resolve('2026-09-14');
    expect(path).toBe('archive/2026-09-38.md');
    expect(mixed.matches(path)).toBe(true);
    expect(mixed.matches('archive/2026-09-53.md')).toBe(false);
  });

  it('round-trips quarter-day and two-digit calendar year with an ISO year', () => {
    const quarterDay = compileNotePathPattern('archive/{{Q-D}}.md');
    expect(quarterDay.matches(quarterDay.resolve('2026-05-15'))).toBe(true);

    const twoDigitIsoYear = compileNotePathPattern('archive/{{YY-GGGG}}.md');
    expect(twoDigitIsoYear.matches(twoDigitIsoYear.resolve('1999-06-15'))).toBe(true);
  });

  it.each([
    ['{{YYYY-MM-DD}}', '2000-02-29'],
    ['{{YY-MM-DD}}', '1999-12-31'],
    ['{{MM-DD}}', '2024-02-29'],
    ['{{YYYY-DDDD}}', '2000-12-31'],
    ['{{Q-D}}', '2026-05-15'],
    ['{{YYYY-Q-DD}}', '2026-05-31'],
    ['{{GGGG-WW}}', '2015-12-31'],
    ['{{YYYY-MM-WW}}', '2026-09-14'],
    ['{{GGGG-MM-DD}}', '2021-01-01'],
    ['{{YY-GGGG}}', '1999-06-15'],
  ])('matches its resolved %s path for %s', (format, date) => {
    const pattern = compileNotePathPattern(`matrix/${format}.md`);
    expect(pattern.matches(pattern.resolve(date))).toBe(true);
  });

  it('rejects impossible mixed values while accepting valid candidates', () => {
    expect(compileNotePathPattern('matrix/{{YY-GGGG}}.md').matches('matrix/99-2000.md')).toBe(
      false,
    );
    expect(compileNotePathPattern('matrix/{{YYYY-MM-WW}}.md').matches('matrix/2026-09-53.md')).toBe(
      false,
    );
    expect(compileNotePathPattern('matrix/{{YYYY-MM-DD}}.md').matches('matrix/1900-02-29.md')).toBe(
      false,
    );
  });

  it('validates ordinal, quarter and ISO week periods precisely', () => {
    expect(compileNotePathPattern('ordinal/{{YYYY}}-{{DDDD}}').matches('ordinal/2024-366.md')).toBe(
      true,
    );
    expect(compileNotePathPattern('ordinal/{{YYYY}}-{{DDDD}}').matches('ordinal/2025-366.md')).toBe(
      false,
    );
    expect(compileNotePathPattern('quarter/{{YYYY}}-Q{{Q}}').matches('quarter/2026-Q4.md')).toBe(
      true,
    );
    expect(compileNotePathPattern('week/{{GGGG}}-W{{WW}}').matches('week/2025-W53.md')).toBe(false);
    expect(compileNotePathPattern('week/{{GGGG}}-W{{WW}}').matches('week/2026-W01.md')).toBe(true);
  });

  it.each([
    '',
    '/',
    '/absolute.md',
    '../outside.md',
    'folder/../outside.md',
    'folder/',
    'daily/{{}}',
    'daily/{{DATE:}}',
    'daily/{{YYYY-MM-DD}',
    'daily/{YYYY-MM-DD}}',
    'daily/{{yyyy-MM-DD}}',
    'daily/{{YYYY-MMM-DD}}',
  ])('rejects invalid pattern %j before it can be used', (pattern) => {
    expect(() => compileNotePathPattern(pattern)).toThrow();
  });

  it('rejects invalid local dates at resolution time', () => {
    expect(() => compileNotePathPattern('daily/{{YYYY-MM-DD}}').resolve('2025-02-29')).toThrow();
  });
});
