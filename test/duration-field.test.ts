import { describe, expect, it } from 'vitest';
import {
  formatDurationFromMinutes,
  formatTaskLine,
  insertIntoTitleBody,
  parseDurationToMinutes,
  parseTask as parseTaskWithCatalog,
} from '../src/parser/TaskParser';
import type { ParseContext } from '../src/parser/types';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog } from './helpers';

const statusCatalog = canonicalStatusCatalog();
const codec = new TaskMarkdownCodec(statusCatalog);
const parseTask = (rawText: string, ctx: Omit<ParseContext, 'statusCatalog'>) =>
  parseTaskWithCatalog(rawText, { ...ctx, statusCatalog });

describe('duration parsing', () => {
  it('validates introduced duration values and preserves the original on failure', () => {
    expect(codec.applyLineEdit('- [ ] gym ⏱️ 45m', { type: 'set-duration', value: 0 })).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-duration', field: 'duration' }],
    });
  });

  it('rejects clearing a recognized malformed zero-minute duration instead of returning unchanged', () => {
    expect(codec.applyLineEdit('- [ ] gym ⏱️ 0m', { type: 'set-duration', value: null })).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-duration', field: 'duration' }],
    });
  });

  it('parses hours+minutes combined', () => {
    expect(parseDurationToMinutes('1h30m')).toBe(90);
  });
  it('parses hours only', () => {
    expect(parseDurationToMinutes('2h')).toBe(120);
  });
  it('parses minutes only', () => {
    expect(parseDurationToMinutes('45m')).toBe(45);
  });
  it('parses clock-style hours and minutes used by existing vault tasks', () => {
    expect(parseDurationToMinutes('01:00')).toBe(60);
    expect(parseDurationToMinutes('1:30')).toBe(90);
    expect(parseDurationToMinutes('01:60')).toBeUndefined();
  });
  it('returns undefined for garbage', () => {
    expect(parseDurationToMinutes('')).toBeUndefined();
  });

  it('formats to shortest form', () => {
    expect(formatDurationFromMinutes(90)).toBe('1h30m');
    expect(formatDurationFromMinutes(120)).toBe('2h');
    expect(formatDurationFromMinutes(45)).toBe('45m');
  });

  it('parseTask extracts duration and strips it from text', () => {
    const t = parseTask('- [ ] gym ⏰ 15:00 ⏱️ 2h', { filePath: 'f.md', line: 0 });
    expect(t?.time).toBe('15:00');
    expect(t?.duration).toBe(120);
    expect(t?.text).toBe('gym');
  });

  it('parses and safely canonicalizes a clock-style duration when resizing', () => {
    const source = '- [ ] gym ⏰ 09:00 ⏱️ 01:00';
    const parsed = codec.parseLine(source, { filePath: 'f.md', line: 0 });

    expect(parsed?.planning.duration).toBe(60);
    expect(parsed?.title).toBe('gym');
    expect(codec.applyLineEdit(source, { type: 'set-duration', value: 90 })).toEqual({
      type: 'changed',
      content: '- [ ] gym ⏰ 09:00 ⏱️ 1h30m',
    });
  });

  it('rejects editing a clock-style duration with a non-whitespace suffix', () => {
    expect(
      codec.applyLineEdit('- [ ] gym ⏱️ 01:00oops', { type: 'set-duration', value: 90 }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-duration', field: 'duration' }],
    });
  });

  it('parseTask leaves duration undefined when absent', () => {
    const t = parseTask('- [ ] gym ⏰ 15:00', { filePath: 'f.md', line: 0 });
    expect(t?.duration).toBeUndefined();
  });

  it('formatTaskLine round-trips duration in canonical order (after time, before priority)', () => {
    const line = formatTaskLine('- [ ] gym ⏱️ 1h30m ⏰ 15:00 🔺');
    expect(line).toBe('- [ ] gym ⏰ 15:00 ⏱️ 1h30m 🔺');
  });

  it('formatTaskLine drops duration cleanly when title is re-edited without it', () => {
    const line = formatTaskLine('- [ ] gym ⏰ 15:00 ⏱️ 45m');
    expect(line).toContain('⏱️ 45m');
    expect(line).not.toContain('gym ⏱️'); // title itself must not contain the emoji
  });

  it('insertIntoTitleBody recognizes ⏱️ as a metadata boundary, not swallowing it into the title', () => {
    const line = '- [ ] gym ⏱️ 45m';
    const result = insertIntoTitleBody(line, '#tag');
    expect(result).toContain('#tag');
    expect(result).toContain('⏱️ 45m');
    expect(result).not.toContain('gym ⏱️'); // title itself must not carry the duration emoji
  });

  it('zero-minute duration ("0m") is treated as no duration by both parseTask and formatTaskLine', () => {
    // parseDurationToMinutes itself already returns undefined for a total of 0 minutes.
    expect(parseDurationToMinutes('0m')).toBeUndefined();

    const t = parseTask('- [ ] gym ⏱️ 0m', { filePath: 'f.md', line: 0 });
    expect(t?.duration).toBeUndefined();
    expect(t?.text).toBe('gym'); // token still stripped from title even though minutes is 0

    const line = formatTaskLine('- [ ] gym ⏱️ 0m');
    expect(line).not.toContain('⏱️'); // no duration is re-emitted for a zero-minute token
    expect(line).toBe('- [ ] gym');
  });

  it('a bare/malformed ⏱️ with no digits is left as ordinary title text by both parseTask and formatTaskLine', () => {
    const t = parseTask('- [ ] gym ⏱️', { filePath: 'f.md', line: 0 });
    expect(t?.duration).toBeUndefined();
    expect(t?.text).toBe('gym ⏱️'); // malformed token is not metadata, so it stays in the title

    const line = formatTaskLine('- [ ] gym ⏱️');
    expect(line).toBe('- [ ] gym ⏱️'); // formatTaskLine must not silently delete it either
  });
});
