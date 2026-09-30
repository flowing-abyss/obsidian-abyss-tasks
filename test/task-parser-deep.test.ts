// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatTaskLine,
  insertIntoTitleBody,
  parseTask as parseTaskWithCatalog,
} from '../src/parser/TaskParser';
import type { ParseContext } from '../src/parser/types';
import { canonicalStatusCatalog } from './helpers';

const statusCatalog = canonicalStatusCatalog();
const parseTask = (rawText: string, ctx: Omit<ParseContext, 'statusCatalog'>) =>
  parseTaskWithCatalog(rawText, { ...ctx, statusCatalog });

describe('insertIntoTitleBody', () => {
  const LINK = '[[att.png|image]]';

  it('appends to a title with no metadata', () => {
    expect(insertIntoTitleBody('- [ ] Buy milk', LINK)).toBe(`- [ ] Buy milk ${LINK}`);
  });

  it('inserts before the metadata suffix, preserving date + priority', () => {
    const out = insertIntoTitleBody('- [ ] Buy milk 📅 2026-07-02 🔼', LINK);
    expect(out).toContain(LINK);
    expect(out).toContain('📅 2026-07-02');
    expect(out).toContain('🔼');
    // link stays in the title body, before the date metadata
    expect(out.indexOf(LINK)).toBeLessThan(out.indexOf('📅'));
    expect(out.indexOf('Buy milk')).toBeLessThan(out.indexOf(LINK));
  });

  it('keeps the tag and inserts the link in the body for a tag-suffixed title', () => {
    const out = insertIntoTitleBody('- [ ] Buy milk #shop', LINK);
    expect(out).toContain(LINK);
    expect(out).toContain('#shop');
    expect(out.indexOf('Buy milk')).toBeLessThan(out.indexOf(LINK));
  });

  it('handles a blockquote/callout-prefixed task', () => {
    const out = insertIntoTitleBody('> - [ ] Buy milk 📅 2026-07-02', LINK);
    expect(out.startsWith('> - [ ] ')).toBe(true);
    expect(out).toContain(LINK);
    expect(out).toContain('📅 2026-07-02');
  });

  it('handles a done/in-progress checkbox', () => {
    expect(insertIntoTitleBody('- [x] Done thing', LINK)).toBe(`- [x] Done thing ${LINK}`);
    expect(insertIntoTitleBody('- [/] WIP', LINK)).toBe(`- [/] WIP ${LINK}`);
  });

  it('returns the line unchanged when it is not a task line', () => {
    expect(insertIntoTitleBody('- plain list item', LINK)).toBe('- plain list item');
    expect(insertIntoTitleBody('# heading', LINK)).toBe('# heading');
  });
});

describe('parseTask deep edges', () => {
  it('returns null when checkbox matches but rest is undefined (line 27)', () => {
    // CHECKBOX_RE: /^(\s*)- \[(.)\]\s*(.*)/
    // Input '- [ ]' → match[3] = '' (not undefined in normal regex, but test the guard)
    // The guard at line 27 checks `rest === undefined` — this is a defensive branch
    // that can't be reached via normal regex exec (match[3] is always string or undefined
    // when match fails entirely, but then we'd return null at line 23).
    // CURRENT BEHAVIOR: this branch is unreachable via public API.
    // We test the closest reachable case: '- [ ]' with empty rest → returns task with empty text.
    const t = parseTask('- [ ]', { filePath: 'f.md', line: 0 });
    expect(t).not.toBeNull();
    expect(t?.text).toBe('');
  });

  it('recurrence with empty capture → recurrence undefined (line 97)', () => {
    // RECURRENCE_RE.exec(text) matches but capture group [1] is empty string
    // → (match[1] ?? '').trim() || undefined → undefined
    const t = parseTask('- [ ] Task 🔁', { filePath: 'f.md', line: 0 });
    expect(t?.recurrence).toBeUndefined();
    expect(t?.text).toBe('Task');
  });

  it('recurrence with only spaces → trimmed to undefined (line 97)', () => {
    const t = parseTask('- [ ] Task 🔁   ', { filePath: 'f.md', line: 0 });
    expect(t?.recurrence).toBeUndefined();
  });
});

describe('formatTaskLine deep edges', () => {
  it('returns line as-is when no checkbox prefix (line 170)', () => {
    // FMT_PREFIX_RE: /^(\s*-\s\[[^\]]\]\s)/u — requires "- [x] " prefix
    // Line without prefix → returned unchanged
    const line = 'plain text without checkbox';
    expect(formatTaskLine(line)).toBe(line);
  });

  it('returns heading as-is when no checkbox prefix', () => {
    const line = '## My Heading';
    expect(formatTaskLine(line)).toBe(line);
  });

  it('handles created-date (➕) in canonical ordering', () => {
    const out = formatTaskLine('- [ ] Task ➕ 2026-07-05 🔁 every week 📅 2026-07-20');
    // canonical: title · 🔁 · ➕ · 📅
    expect(out).toBe('- [ ] Task 🔁 every week ➕ 2026-07-05 📅 2026-07-20');
  });

  it('preserves created-date position between recurrence and start', () => {
    const out = formatTaskLine(
      '- [ ] Task 🛫 2026-07-10 ➕ 2026-07-05 🔁 every week 📅 2026-07-20',
    );
    // canonical: title · 🔁 · ➕ · 🛫 · 📅
    expect(out).toBe('- [ ] Task 🔁 every week ➕ 2026-07-05 🛫 2026-07-10 📅 2026-07-20');
  });
});
