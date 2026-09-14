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
