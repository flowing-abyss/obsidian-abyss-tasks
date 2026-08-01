import { describe, expect, it } from 'vitest';
import { formatTaskLine, parseTask as parseTaskWithCatalog } from '../src/parser/TaskParser';
import type { ParseContext } from '../src/parser/types';
import { canonicalStatusCatalog } from './helpers';

const statusCatalog = canonicalStatusCatalog();
const parseTask = (rawText: string, ctx: Omit<ParseContext, 'statusCatalog'>) =>
  parseTaskWithCatalog(rawText, { ...ctx, statusCatalog });

describe('parseTask', () => {
  it('returns null for non-task lines', () => {
    expect(parseTask('- just a list item', { filePath: 'f.md', line: 0 })).toBeNull();
    expect(parseTask('# heading', { filePath: 'f.md', line: 0 })).toBeNull();
    expect(parseTask('plain text', { filePath: 'f.md', line: 0 })).toBeNull();
    expect(parseTask('', { filePath: 'f.md', line: 0 })).toBeNull();
  });

  it('parses open task', () => {
    const t = parseTask('- [ ] Do something', { filePath: 'f.md', line: 5 });
    expect(t).not.toBeNull();
    expect(t?.status).toBe('open');
    expect(t?.text).toBe('Do something');
    expect(t?.line).toBe(5);
    expect(t?.priority).toBe('D');
  });

  it('parses done task', () => {
    const t = parseTask('- [x] Done task ✅ 2026-06-22', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('done');
    expect(t?.completion).toBe('2026-06-22');
    expect(t?.text).not.toContain('✅');
  });

  it('parses done task with capital X', () => {
    const t = parseTask('- [X] Done', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('done');
  });

  it('parses cancelled task via checkbox char', () => {
    const t = parseTask('- [-] Cancelled task', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('cancelled');
  });

  it('parses in-progress task via checkbox char', () => {
    const t = parseTask('- [/] In progress', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('in-progress');
  });

  it('parses due date and removes from text', () => {
    const t = parseTask('- [ ] Buy groceries 📅 2026-07-01', { filePath: 'f.md', line: 0 });
    expect(t?.due).toBe('2026-07-01');
    expect(t?.text).toBe('Buy groceries');
  });

  it('parses scheduled date', () => {
    const t = parseTask('- [ ] Review PR ⏳ 2026-06-25', { filePath: 'f.md', line: 0 });
    expect(t?.scheduled).toBe('2026-06-25');
    expect(t?.text).toBe('Review PR');
  });

  it('parses a task inside a blockquote (> - [ ])', () => {
    const t = parseTask('> - [ ] Quoted task 📅 2026-07-01', { filePath: 'f.md', line: 2 });
    expect(t).not.toBeNull();
    expect(t?.status).toBe('open');
    expect(t?.text).toBe('Quoted task');
    expect(t?.due).toBe('2026-07-01');
    expect(t?.rawText).toBe('> - [ ] Quoted task 📅 2026-07-01');
  });

  it('parses a done task inside a blockquote', () => {
    const t = parseTask('> - [x] Quoted done ✅ 2026-06-22', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('done');
    expect(t?.completion).toBe('2026-06-22');
    expect(t?.text).toBe('Quoted done');
  });

  it('parses a task inside a nested/callout blockquote (> > - [ ])', () => {
    const t = parseTask('> > - [ ] Deeply quoted', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('open');
    expect(t?.text).toBe('Deeply quoted');
  });

  it('parses start date', () => {
    const t = parseTask('- [ ] Long task 🛫 2026-06-20 📅 2026-06-30', {
      filePath: 'f.md',
      line: 0,
    });
    expect(t?.start).toBe('2026-06-20');
    expect(t?.due).toBe('2026-06-30');
  });

  it('parses completion date', () => {
    const t = parseTask('- [x] Done ✅ 2026-06-01', { filePath: 'f.md', line: 0 });
    expect(t?.completion).toBe('2026-06-01');
  });

  it('parses cancelled emoji and sets status', () => {
    const t = parseTask('- [ ] Dropped ❌ 2026-06-10', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('cancelled');
    expect(t?.cancelledDate).toBe('2026-06-10');
  });

  it('parses time and strips it from display text', () => {
    const t = parseTask('- [ ] Meeting ⏰ 14:30 with team', { filePath: 'f.md', line: 0 });
    expect(t?.time).toBe('14:30');
    expect(t?.text).toBe('Meeting with team');
  });

  it('parses recurrence', () => {
    const t = parseTask('- [ ] Standup 🔁 every day', { filePath: 'f.md', line: 0 });
    expect(t?.recurrence).toBe('every day');
    expect(t?.text).not.toContain('🔁');
  });

  it('projects lifecycle, recurrence, and completion policy through the legacy task adapter', () => {
    const task = parseTask(
      '- [x] Ship 🔁 every week 🏁 delete ➕ 2026-08-01 ✅ 2026-08-02 ❌ 2026-08-03',
      { filePath: 'f.md', line: 0 },
    );

    expect(task).toMatchObject({
      recurrence: 'every week',
      onCompletion: 'delete',
      onCompletionExplicit: true,
      created: '2026-08-01',
      completion: '2026-08-02',
      cancelledDate: '2026-08-03',
      markdownText: 'Ship',
    });
  });

  it('keeps an invalid raw recurrence readable while separating the completion policy', () => {
    const task = parseTask('- [ ] Ship 🔁 not a rule 🏁 KEEP ➕ 2026-08-01', {
      filePath: 'f.md',
      line: 0,
    });

    expect(task).toMatchObject({
      recurrence: 'not a rule',
      onCompletion: 'keep',
      onCompletionExplicit: true,
      created: '2026-08-01',
      markdownText: 'Ship',
    });
  });

  it.each([
    ['priority', '🔺 trailing', 'every day', 'Task trailing'],
    ['recurrence', '🔁 every week', 'every day 🔁 every week', 'Task'],
    ['created', '➕ 2026-01-01 trailing', 'every day ➕ 2026-01-01 trailing', 'Task'],
    ['start', '🛫 2026-01-01 trailing', 'every day  trailing', 'Task'],
    ['scheduled', '⏳ 2026-01-01 trailing', 'every day  trailing', 'Task'],
    ['due', '📅 2026-01-01 trailing', 'every day  trailing', 'Task'],
    ['completion', '✅ 2026-01-01 trailing', 'every day  trailing', 'Task'],
    ['cancelled', '❌ 2026-01-01 trailing', 'every day  trailing', 'Task'],
    ['time', '⏰ 09:30 trailing', 'every day  trailing', 'Task'],
    ['duration', '⏱️ 1h trailing', 'every day  trailing', 'Task'],
    ['tag', '#work trailing', 'every day #work trailing', 'Task'],
    ['task ID', '🆔 task-1 trailing', 'every day 🆔 task-1 trailing', 'Task 🆔 task-1'],
    ['dependency', '⛔ prep-1 trailing', 'every day ⛔ prep-1 trailing', 'Task ⛔ prep-1'],
    ['block ID', 'trailing ^task-block', 'every day trailing ^task-block', 'Task ^task-block'],
    ['unknown', '🧭 trailing', 'every day 🧭 trailing', 'Task'],
    ['title', 'trailing', 'every day trailing', 'Task'],
  ] as const)(
    'uses the parent recurrence policy before %s spans',
    (_kind, suffix, recurrence, markdownText) => {
      const t = parseTask(`- [ ] Task 🔁 every day ${suffix}`, { filePath: 'f.md', line: 0 });
      expect(t?.recurrence).toBe(recurrence);
      expect(t?.markdownText).toBe(markdownText);
    },
  );

  it('parses highest priority (🔺)', () => {
    const t = parseTask('- [ ] Urgent task 🔺', { filePath: 'f.md', line: 0 });
    expect(t?.priority).toBe('A');
    expect(t?.text).not.toContain('🔺');
  });

  it('parses high priority (⏫)', () => {
    const t = parseTask('- [ ] Urgent task ⏫', { filePath: 'f.md', line: 0 });
    expect(t?.priority).toBe('B');
    expect(t?.text).not.toContain('⏫');
  });

  it('parses medium priority (🔼)', () => {
    const t = parseTask('- [ ] Medium 🔼', { filePath: 'f.md', line: 0 });
    expect(t?.priority).toBe('C');
  });

  it('parses low priority (🔽)', () => {
    const t = parseTask('- [ ] Low 🔽', { filePath: 'f.md', line: 0 });
    expect(t?.priority).toBe('E');
  });

  it('parses lowest priority (⏬)', () => {
    const t = parseTask('- [ ] Lowest ⏬', { filePath: 'f.md', line: 0 });
    expect(t?.priority).toBe('F');
    expect(t?.text).not.toContain('⏬');
  });

  it('collapses wikilink with alias', () => {
    const t = parseTask('- [ ] See [[My Note|alias]]', { filePath: 'f.md', line: 0 });
    expect(t?.text).toContain('🔗My Note');
    expect(t?.text).not.toContain('[[');
  });

  it('collapses plain wikilink', () => {
    const t = parseTask('- [ ] See [[My Note]]', { filePath: 'f.md', line: 0 });
    expect(t?.text).toContain('🔗 My Note');
  });

  it('collapses markdown link', () => {
    const t = parseTask('- [ ] See [Google](https://google.com)', { filePath: 'f.md', line: 0 });
    expect(t?.text).toContain('🌐 Google');
    expect(t?.text).not.toContain('https://');
  });

  it('strips globalTaskFilter tag', () => {
    const t = parseTask('- [ ] #task/one-off Buy milk', {
      filePath: 'f.md',
      line: 0,
      globalTaskFilter: '#task/one-off',
    });
    expect(t?.text).toBe('Buy milk');
    expect(t?.text).not.toContain('#task/one-off');
  });

  it('strips all other hashtags', () => {
    const t = parseTask('- [ ] Buy #shopping milk', { filePath: 'f.md', line: 0 });
    expect(t?.text).toBe('Buy milk');
  });

  it('preserves dailyNoteDate from context', () => {
    const t = parseTask('- [ ] Something', {
      filePath: 'periodic/daily/2026-06-22.md',
      line: 0,
      dailyNoteDate: '2026-06-22',
    });
    expect(t?.dailyNoteDate).toBe('2026-06-22');
  });

  it('preserves rawText unchanged', () => {
    const raw = '- [ ] Task with 📅 2026-07-01 metadata';
    const t = parseTask(raw, { filePath: 'f.md', line: 0 });
    expect(t?.rawText).toBe(raw);
  });

  it('keeps existing Tasks IDs, dependencies, and block IDs visible through the legacy parser', () => {
    const raw = '- [ ] Task 🆔 task-1 ⛔ prep-1 ^task-block';
    const t = parseTask(raw, { filePath: 'f.md', line: 0 });
    expect(t?.markdownText).toBe('Task 🆔 task-1 ⛔ prep-1 ^task-block');
    expect(t?.rawText).toBe(raw);
  });

  it('handles indented tasks', () => {
    const t = parseTask('  - [ ] Indented subtask', { filePath: 'f.md', line: 0 });
    expect(t).not.toBeNull();
    expect(t?.text).toBe('Indented subtask');
  });

  // --- Edge cases (Phase 1 coverage) ---

  it('keeps only the first due date (CURRENT BEHAVIOR, follow-up FU-4)', () => {
    const t = parseTask('- [ ] Task 📅 2026-01-01 📅 2026-01-02', { filePath: 'f.md', line: 0 });
    expect(t?.due).toBe('2026-01-01');
    // second emoji not stripped: stays in text
    expect(t?.text).toContain('📅 2026-01-02');
  });

  it('keeps first-occurrence semantics when a zero duration precedes a valid duplicate', () => {
    const t = parseTask('- [ ] Task ⏱️ 0m ⏱️ 1h', { filePath: 'f.md', line: 0 });
    expect(t?.duration).toBeUndefined();
    expect(t?.text).toBe('Task ⏱️ 1h');
  });

  it('does not match a non-date string (CURRENT BEHAVIOR)', () => {
    const t = parseTask('- [ ] Task 📅 not-a-date', { filePath: 'f.md', line: 0 });
    expect(t?.due).toBeUndefined();
    // regex requires \d{4}-\d{2}-\d{2} shape; non-digit text doesn't match, emoji stays in text
    expect(t?.text).toContain('📅');
  });

  it('matches a structurally-shaped but semantically-invalid date (CURRENT BEHAVIOR, follow-up FU-3)', () => {
    // 2026-13-99 has the \d{4}-\d{2}-\d{2} shape, so it matches; no date-range validation
    const t = parseTask('- [ ] Task 📅 2026-13-99', { filePath: 'f.md', line: 0 });
    expect(t?.due).toBe('2026-13-99');
    expect(t?.text).not.toContain('📅');
  });

  it('matches time with two-digit minutes, rejects single-digit minutes', () => {
    const ok = parseTask('- [ ] Task ⏰ 09:05', { filePath: 'f.md', line: 0 });
    expect(ok?.time).toBe('09:05');
    expect(ok?.text).not.toContain('⏰');

    const no = parseTask('- [ ] Task ⏰ 9:5', { filePath: 'f.md', line: 0 });
    // CURRENT BEHAVIOR: single-digit minute does not match TIME_RE \d{1,2}:\d{2}
    expect(no?.time).toBeUndefined();
    expect(no?.text).toContain('⏰ 9:5');
  });

  it('accepts out-of-range time values (CURRENT BEHAVIOR, follow-up FU-3)', () => {
    const t = parseTask('- [ ] Task ⏰ 25:99', { filePath: 'f.md', line: 0 });
    expect(t?.time).toBe('25:99');
  });

  it('treats empty recurrence as undefined', () => {
    const t = parseTask('- [ ] Task 🔁 ', { filePath: 'f.md', line: 0 });
    expect(t?.recurrence).toBeUndefined();
    expect(t?.text).not.toContain('🔁');
  });

  it('stops recurrence at the next metadata emoji', () => {
    const t = parseTask('- [ ] Task 🔁 every week 📅 2026-01-01', { filePath: 'f.md', line: 0 });
    expect(t?.recurrence).toBe('every week');
    expect(t?.due).toBe('2026-01-01');
    expect(t?.text).not.toContain('🔁');
  });

  it('removes every marker captured by the legacy duplicate-recurrence value', () => {
    const t = parseTask('- [ ] Task 🔁 every day 🔁 every week', { filePath: 'f.md', line: 0 });
    expect(t?.recurrence).toBe('every day 🔁 every week');
    expect(t?.markdownText).toBe('Task');
  });

  it('removes trailing title text consumed around an already-extracted date', () => {
    const t = parseTask('- [ ] Task 🔁 every day 📅 2026-01-01 trailing', {
      filePath: 'f.md',
      line: 0,
    });
    expect(t?.recurrence).toBe('every day  trailing');
    expect(t?.markdownText).toBe('Task');
  });

  it('keeps explicit task carriers visible inside the legacy recurrence range', () => {
    const t = parseTask(
      '- [ ] Task 🔁 every day 📅 2026-01-01 trailing 🆔 task-1 ⛔ prep-1 ^task-block',
      { filePath: 'f.md', line: 0 },
    );
    expect(t?.markdownText).toBe('Task 🆔 task-1 ⛔ prep-1 ^task-block');
  });

  it('strips literal non-link brackets from title (CURRENT BEHAVIOR)', () => {
    const t = parseTask('- [ ] Note [draft]', { filePath: 'f.md', line: 0 });
    // BRACKETS_RE collapses [draft] to draft after wikilink/md-link collapses ran
    expect(t?.text).toBe('Note draft');
  });

  it('strips file extension from wikilink', () => {
    const t = parseTask('- [ ] [[note.md]] task', { filePath: 'f.md', line: 0 });
    expect(t?.text).toContain('🔗 note');
    expect(t?.text).not.toContain('note.md');
  });

  it('parses a task with tab indentation', () => {
    const t = parseTask('\t- [ ] Tabbed task', { filePath: 'f.md', line: 0 });
    expect(t).not.toBeNull();
    expect(t?.text).toBe('Tabbed task');
  });

  it('removes a canonical longer tag without partial global-filter corruption', () => {
    const t = parseTask('- [ ] #task/x Buy', {
      filePath: 'f.md',
      line: 0,
      globalTaskFilter: '#task',
    });
    expect(t?.text).toBe('Buy');
    expect(t?.markdownText).toBe('Buy');
  });

  it('cancelled emoji overrides a done checkbox to cancelled', () => {
    const t = parseTask('- [x] Done but cancelled ❌ 2026-06-22', { filePath: 'f.md', line: 0 });
    expect(t?.status).toBe('cancelled');
    expect(t?.cancelledDate).toBe('2026-06-22');
  });

  it('empty title with only metadata', () => {
    const t = parseTask('- [ ] 📅 2026-01-01', { filePath: 'f.md', line: 0 });
    expect(t?.due).toBe('2026-01-01');
    expect(t?.text).toBe('');
  });

  it('whitespace-only after checkbox yields empty text', () => {
    const t = parseTask('- [ ]   ', { filePath: 'f.md', line: 0 });
    expect(t?.text).toBe('');
  });
});

describe('formatTaskLine', () => {
  it('returns non-task lines unchanged', () => {
    expect(formatTaskLine('- plain list item')).toBe('- plain list item');
    expect(formatTaskLine('# heading')).toBe('# heading');
  });

  it('leaves already-canonical line unchanged', () => {
    const line =
      '- [ ] Buy milk #shopping ⏰ 09:00 ⏫ 🔁 every day 🛫 2026-01-01 ⏳ 2026-01-10 📅 2026-01-20 ❌ 2026-01-21 ✅ 2026-01-22';
    expect(formatTaskLine(line)).toBe(line);
  });

  it('reorders emojis into canonical Tasks order', () => {
    const input = '- [ ] Task 📅 2026-07-01 ⏫ ⏳ 2026-06-25 🛫 2026-06-20';
    const result = formatTaskLine(input);
    expect(result).toBe('- [ ] Task ⏫ 🛫 2026-06-20 ⏳ 2026-06-25 📅 2026-07-01');
  });

  it('places ⏰ before all other metadata', () => {
    const input = '- [ ] Meeting 📅 2026-07-01 ⏰ 09:30';
    expect(formatTaskLine(input)).toBe('- [ ] Meeting ⏰ 09:30 📅 2026-07-01');
  });

  it('moves tags before emoji metadata', () => {
    const input = '- [ ] Task 📅 2026-07-01 #work #urgent';
    expect(formatTaskLine(input)).toBe('- [ ] Task #work #urgent 📅 2026-07-01');
  });

  it('preserves the blockquote prefix when reordering metadata', () => {
    const input = '> - [ ] Task 📅 2026-07-01 #work';
    expect(formatTaskLine(input)).toBe('> - [ ] Task #work 📅 2026-07-01');
  });

  it('preserves created date (➕) between recurrence and start date', () => {
    const input = '- [ ] Task ➕ 2026-01-01 🛫 2026-01-05 📅 2026-01-10';
    expect(formatTaskLine(input)).toBe('- [ ] Task ➕ 2026-01-01 🛫 2026-01-05 📅 2026-01-10');
  });

  it('handles recurrence with text', () => {
    const input = '- [ ] Standup 📅 2026-07-01 🔁 every weekday';
    expect(formatTaskLine(input)).toBe('- [ ] Standup 🔁 every weekday 📅 2026-07-01');
  });

  it('is idempotent', () => {
    const input = '- [ ] Task 📅 2026-07-01 ⏫ #work ⏰ 09:00 🔁 every day 🛫 2026-06-20';
    const once = formatTaskLine(input);
    expect(formatTaskLine(once)).toBe(once);
  });

  it('preserves indentation and checkbox state', () => {
    const input = '  - [x] Done task 📅 2026-07-01 ✅ 2026-07-01';
    expect(formatTaskLine(input)).toBe('  - [x] Done task 📅 2026-07-01 ✅ 2026-07-01');
  });

  it('handles all five priority levels', () => {
    expect(formatTaskLine('- [ ] Task ⏬ 📅 2026-07-01')).toBe('- [ ] Task ⏬ 📅 2026-07-01');
    expect(formatTaskLine('- [ ] Task 🔺 📅 2026-07-01')).toBe('- [ ] Task 🔺 📅 2026-07-01');
  });

  // --- Edge cases (Phase 1 coverage) ---

  it('preserves a capital [X] checkbox', () => {
    expect(formatTaskLine('- [X] Done 📅 2026-07-01 ✅ 2026-07-01')).toBe(
      '- [X] Done 📅 2026-07-01 ✅ 2026-07-01',
    );
  });

  it('passes a literal non-metadata emoji with no date through unchanged', () => {
    // bare 📅 with no date is neither extracted nor stripped
    expect(formatTaskLine('- [ ] Meeting 📅 kickoff')).toBe('- [ ] Meeting 📅 kickoff');
  });

  it('extracts a date-bearing emoji embedded in prose (CURRENT BEHAVIOR, follow-up FU-5)', () => {
    // author intent: 📅 is prose; parser extracts it as due
    const out = formatTaskLine('- [ ] Meeting 📅 2026-01-01 kickoff');
    expect(out).toBe('- [ ] Meeting kickoff 📅 2026-01-01');
  });

  it('round-trips a tag containing hyphen and slash', () => {
    const out = formatTaskLine('- [ ] Task 📅 2026-07-01 #a/b-c');
    expect(out).toBe('- [ ] Task #a/b-c 📅 2026-07-01');
  });

  it('emits both cancelled and done dates in canonical order', () => {
    const out = formatTaskLine('- [x] Task ✅ 2026-07-22 ❌ 2026-07-21 📅 2026-07-20');
    // canonical order: … 📅 ❌ ✅
    expect(out).toBe('- [x] Task 📅 2026-07-20 ❌ 2026-07-21 ✅ 2026-07-22');
  });

  it('handles a line with only metadata and an empty title', () => {
    const out = formatTaskLine('- [ ] 📅 2026-01-01');
    expect(out).toBe('- [ ] 📅 2026-01-01');
  });

  it('rebuilds a line with all metadata fields in canonical order', () => {
    const out = formatTaskLine(
      '- [ ] Task ✅ 2026-07-22 ❌ 2026-07-21 📅 2026-07-20 ⏳ 2026-07-15 🛫 2026-07-10 ➕ 2026-07-05 🔁 every week ⏬ #work ⏰ 09:00',
    );
    // canonical: title · #tags · ⏰ · priority · 🔁 · ➕ · 🛫 · ⏳ · 📅 · ❌ · ✅
    expect(out).toBe(
      '- [ ] Task #work ⏰ 09:00 ⏬ 🔁 every week ➕ 2026-07-05 🛫 2026-07-10 ⏳ 2026-07-15 📅 2026-07-20 ❌ 2026-07-21 ✅ 2026-07-22',
    );
  });

  it('is idempotent for a shuffled-metadata line', () => {
    const shuffled = '- [ ] Task 📅 2026-07-01 ⏫ ⏳ 2026-06-25 🛫 2026-06-20 #work ⏰ 09:30';
    const once = formatTaskLine(shuffled);
    expect(formatTaskLine(once)).toBe(once);
  });
});

describe('markdownText preserves link markup', () => {
  const ctx = { filePath: 'n.md', line: 0 };

  it('keeps wiki, alias and markdown links verbatim while stripping metadata + tags', () => {
    const raw =
      '- [ ] Read [[Sources|secondary sources]] and [docs](https://x.io) #task/reference 📅 2026-07-01 🔼';
    const t = parseTask(raw, ctx)!;
    expect(t.markdownText).toBe('Read [[Sources|secondary sources]] and [docs](https://x.io)');
    // text keeps the collapsed, human-readable form (note name, not alias — matches
    // existing collapseLinks/wikilink-alias behavior, unchanged by this feature)
    expect(t.text).toContain('Sources');
    expect(t.text).not.toContain('[[');
    expect(t.text).not.toContain('](');
  });

  it('markdownText has no leftover tags or metadata emoji', () => {
    const t = parseTask('- [ ] Plain task #task 📅 2026-07-01', ctx)!;
    expect(t.markdownText).toBe('Plain task');
  });

  it('preserves inline-code tag lookalikes while removing only canonical tag spans', () => {
    const t = parseTask('- [ ] Task `#task` #real #real', {
      ...ctx,
      globalTaskFilter: '#task',
    })!;

    expect(t.markdownText).toBe('Task `#task`');
    expect(t.text).toBe('Task `#task`');
  });
});
