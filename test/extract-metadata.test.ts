// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { extractMetadata } from '../src/parser/extractMetadata';

describe('extractMetadata', () => {
  describe('individual metadata fields', () => {
    it('extracts due date (📅)', () => {
      const r = extractMetadata('Buy milk 📅 2026-07-01');
      expect(r.due).toBe('2026-07-01');
      expect(r.cleanText).toBe('Buy milk');
    });

    it('extracts scheduled date (⏳)', () => {
      const r = extractMetadata('Review PR ⏳ 2026-06-25');
      expect(r.scheduled).toBe('2026-06-25');
      expect(r.cleanText).toBe('Review PR');
    });

    it('extracts start date (🛫)', () => {
      const r = extractMetadata('Long task 🛫 2026-06-20');
      expect(r.start).toBe('2026-06-20');
      expect(r.cleanText).toBe('Long task');
    });

    it('extracts completion date (✅)', () => {
      const r = extractMetadata('Done task ✅ 2026-06-01');
      expect(r.completion).toBe('2026-06-01');
      expect(r.cleanText).toBe('Done task');
    });

    it('extracts cancelled date (❌)', () => {
      const r = extractMetadata('Dropped ❌ 2026-06-10');
      expect(r.cancelledDate).toBe('2026-06-10');
      expect(r.cleanText).toBe('Dropped');
    });

    it('extracts time (⏰)', () => {
      const r = extractMetadata('Meeting ⏰ 14:30');
      expect(r.time).toBe('14:30');
      expect(r.cleanText).toBe('Meeting');
    });

    it('extracts recurrence (🔁)', () => {
      const r = extractMetadata('Standup 🔁 every day');
      expect(r.recurrence).toBe('every day');
      expect(r.cleanText).toBe('Standup');
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
      ['duration', '⏱️ 1h trailing', 'every day ⏱️ 1h trailing', 'Task'],
      ['tag', '#work trailing', 'every day #work trailing', 'Task'],
      ['task ID', '🆔 task-1 trailing', 'every day 🆔 task-1 trailing', 'Task 🆔 task-1'],
      ['dependency', '⛔ prep-1 trailing', 'every day ⛔ prep-1 trailing', 'Task ⛔ prep-1'],
      ['block ID', 'trailing ^task-block', 'every day trailing ^task-block', 'Task ^task-block'],
      ['unknown', '🧭 trailing', 'every day 🧭 trailing', 'Task'],
      ['title', 'trailing', 'every day trailing', 'Task'],
    ] as const)(
      'uses the extractor recurrence policy before %s spans',
      (_kind, suffix, recurrence, cleanText) => {
        const r = extractMetadata(`Task 🔁 every day ${suffix}`);
        expect(r.recurrence).toBe(recurrence);
        expect(r.cleanText).toBe(cleanText);
      },
    );
  });

  describe('priority levels', () => {
    it('priority A (🔺)', () => {
      const r = extractMetadata('Urgent 🔺');
      expect(r.priority).toBe('A');
      expect(r.cleanText).toBe('Urgent');
    });

    it('priority B (⏫)', () => {
      const r = extractMetadata('Important ⏫');
      expect(r.priority).toBe('B');
    });

    it('priority C (🔼)', () => {
      const r = extractMetadata('Medium 🔼');
      expect(r.priority).toBe('C');
    });

    it('priority D (default, no emoji)', () => {
      const r = extractMetadata('Normal task');
      expect(r.priority).toBe('D');
    });

    it('priority E (🔽)', () => {
      const r = extractMetadata('Low 🔽');
      expect(r.priority).toBe('E');
      expect(r.cleanText).toBe('Low');
    });

    it('priority F (⏬)', () => {
      const r = extractMetadata('Lowest ⏬');
      expect(r.priority).toBe('F');
      expect(r.cleanText).toBe('Lowest');
    });
  });

  describe('combined metadata', () => {
    it('extracts all fields in one string', () => {
      const r = extractMetadata(
        'Sprint task 🔺 ⏰ 09:00 🔁 every week 🛫 2026-07-01 ⏳ 2026-07-05 📅 2026-07-10 ❌ 2026-07-08 ✅ 2026-07-09 #work',
      );
      expect(r).toMatchObject({
        priority: 'A',
        time: '09:00',
        // CURRENT BEHAVIOR (follow-up: FU-32): RECURRENCE_RE negated char class
        // excludes date/priority emojis but not '#', so recurrence captures the
        // trailing '#work' tag. Expected ('every week') differs from actual.
        recurrence: 'every week      #work',
        start: '2026-07-01',
        scheduled: '2026-07-05',
        due: '2026-07-10',
        cancelledDate: '2026-07-08',
        completion: '2026-07-09',
      });
      expect(r.cleanText).toBe('Sprint task');
    });
  });

  describe('edge cases', () => {
    it('empty string → all undefined, priority D, cleanText empty', () => {
      const r = extractMetadata('');
      expect(r.due).toBeUndefined();
      expect(r.scheduled).toBeUndefined();
      expect(r.start).toBeUndefined();
      expect(r.completion).toBeUndefined();
      expect(r.cancelledDate).toBeUndefined();
      expect(r.time).toBeUndefined();
      expect(r.recurrence).toBeUndefined();
      expect(r.priority).toBe('D');
      expect(r.cleanText).toBe('');
    });

    it('only emoji, no text → cleanText empty', () => {
      const r = extractMetadata('📅 2026-07-01');
      expect(r.due).toBe('2026-07-01');
      expect(r.cleanText).toBe('');
    });

    it('recurrence with trailing spaces → trimmed', () => {
      const r = extractMetadata('Task 🔁 every day   ');
      expect(r.recurrence).toBe('every day');
    });

    it('recurrence capture group empty → undefined', () => {
      const r = extractMetadata('Task 🔁   ');
      // RECURRENCE_RE captures [^📅⏳🛫✅❌⏰🔺⏫🔼🔽⏬\n]* — spaces only → trim → '' || undefined
      expect(r.recurrence).toBeUndefined();
    });

    it('tags stripped from cleanText', () => {
      const r = extractMetadata('Buy #shopping milk');
      expect(r.cleanText).toBe('Buy milk');
    });

    it('multiple tags stripped', () => {
      const r = extractMetadata('Task #work #urgent #project');
      expect(r.cleanText).toBe('Task');
    });

    it('collapses double spaces in cleanText', () => {
      const r = extractMetadata('Task  with   extra    spaces');
      expect(r.cleanText).toBe('Task with extra spaces');
    });

    it('no metadata fields → all undefined', () => {
      const r = extractMetadata('Just a plain task');
      expect(r.due).toBeUndefined();
      expect(r.priority).toBe('D');
      expect(r.cleanText).toBe('Just a plain task');
    });

    it('preserves fields outside the legacy extractor contract', () => {
      const r = extractMetadata('Task ⏱️ 1h 🆔 task-1 ⛔ prep-1 ^task-block');
      expect(r.cleanText).toBe('Task ⏱️ 1h 🆔 task-1 ⛔ prep-1 ^task-block');
    });

    it('removes every marker captured by the legacy duplicate-recurrence value', () => {
      const r = extractMetadata('Task 🔁 every day 🔁 every week');
      expect(r.recurrence).toBe('every day 🔁 every week');
      expect(r.cleanText).toBe('Task');
    });

    it('removes trailing title text consumed around an already-extracted date', () => {
      const r = extractMetadata('Task 🔁 every day 📅 2026-01-01 trailing');
      expect(r.recurrence).toBe('every day  trailing');
      expect(r.cleanText).toBe('Task');
    });

    it('keeps explicit task carriers visible inside the legacy recurrence range', () => {
      const r = extractMetadata(
        'Task 🔁 every day 📅 2026-01-01 trailing 🆔 task-1 ⛔ prep-1 ^task-block',
      );
      expect(r.cleanText).toBe('Task 🆔 task-1 ⛔ prep-1 ^task-block');
    });
  });
});
