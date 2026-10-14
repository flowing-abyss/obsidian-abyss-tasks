// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRecurrenceRule } from '../../src/tasks/domain/recurrence';
import { inputRangesOverlap, validInputRange } from '../../src/tasks/domain/taskInputGuards';
import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import { RecurrenceTextInputParser } from '../../src/tasks/infrastructure/input/RecurrenceTextInputParser';

const parser = new RecurrenceTextInputParser();
const phrase = fc.constantFrom(
  { source: 'каждый день', rule: 'every day' },
  { source: 'по вторникам и четвергам', rule: 'every week on Tuesday, Thursday' },
  { source: 'каждый месяц 5 числа', rule: 'every month on the 5th' },
  { source: 'каждые 3 дня после выполнения', rule: 'every 3 days when done' },
  { source: 'every month on the first Monday', rule: 'every month on the 1st Monday' },
  { source: 'every 2 weeks on Monday', rule: 'every 2 weeks on Monday' },
);
const prose = fc
  .array(fc.constantFrom('αβ', 'отчёт', 'plain', '漢字', '🧑‍💻', '𐐀'), {
    minLength: 1,
    maxLength: 30,
  })
  .map((words) => words.join(' '));
const spacing = fc.constantFrom(' ', '\t', '   ', '\u00a0');

// Missing normalization, original-source coordinates, or barrier checks break these properties.
describe('fixed-seed recurrence extraction properties', () => {
  it('keeps safe Unicode prose and original UTF-16 ownership around a canonical rule', () => {
    fc.assert(
      fc.property(
        fc.tuple(phrase, prose, prose, spacing, fc.boolean()),
        ([entry, prefix, suffix, space, uppercase]) => {
          const source = (uppercase ? entry.source.toUpperCase() : entry.source).replaceAll(
            ' ',
            space,
          );
          const text = `${prefix} ${source} ${suffix} #work`;
          const barriers = inspectTaskInput(text).protectedRanges;
          const request = Object.freeze({ text, protectedRanges: Object.freeze(barriers) });
          const result = parser.extract(request);
          expect(result.candidates.map((c) => c.rule)).toEqual([entry.rule]);
          const candidate = result.candidates[0];
          expect(candidate?.ranges).toEqual([
            { from: prefix.length + 1, to: prefix.length + 1 + source.length },
          ]);
          expect(candidate?.ranges.map((r) => text.slice(r.from, r.to))).toEqual([source]);
          expect(parseRecurrenceRule(entry.rule).type).toBe('valid');
          expect(request.text).toBe(text);
          for (const range of candidate?.ranges ?? []) {
            expect(validInputRange(text, range)).toBe(true);
            expect(barriers.some((barrier) => inputRangesOverlap(range, barrier))).toBe(false);
            expect(text.slice(0, range.from)).toBe(`${prefix} `);
            expect(text.slice(range.to)).toBe(` ${suffix} #work`);
          }
        },
      ),
      { seed: 2026101401, numRuns: 200 },
    );
  });
  it('never acquires recurrence source hidden in protected atoms', () => {
    fc.assert(
      fc.property(
        phrase,
        prose,
        fc.constantFrom('code', 'quote', 'link', 'embed'),
        (entry, prefix, kind) => {
          const wrappers: Record<string, string> = {
            code: `\`${entry.source}\``,
            quote: `«${entry.source}»`,
            link: `[${entry.source}](note.md)`,
            embed: `![[${entry.source}]]`,
          };
          const text = `${prefix} ${wrappers[kind] ?? ''} details`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([]);
        },
      ),
      { seed: 2026101402, numRuns: 120 },
    );
  });
  it('does not accept a prefix after clocks, tags, or commas hide a reserved qualifier', () => {
    fc.assert(
      fc.property(
        prose,
        spacing,
        fc.constantFrom('', ', ', ' #work ', ' at 10:00 ', ' at 2pm '),
        (prefix, space, gap) => {
          const text = `${prefix} every${space}day${gap} except Monday; call tomorrow`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([]);
          expect(
            result.protectedRanges.some((r) => text.slice(r.from, r.to).includes('except Monday')),
          ).toBe(true);
          expect(
            result.protectedRanges.every((r) => !text.slice(r.from, r.to).includes('tomorrow')),
          ).toBe(true);
        },
      ),
      { seed: 2026101403, numRuns: 120 },
    );
  });
});
