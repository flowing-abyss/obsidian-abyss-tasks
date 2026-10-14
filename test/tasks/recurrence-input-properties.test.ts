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

describe('fixed-seed review boundary properties', () => {
  it('protects parenthesized exceptions before and after a clock', () => {
    fc.assert(
      fc.property(
        prose,
        spacing,
        fc.constantFrom('', ' at 10:00', ' at 2pm'),
        (prefix, space, clock) => {
          const expression = `every${space}day${clock} (except Monday)`;
          const text = `${prefix} ${expression}; call tomorrow`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([]);
          expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
            expression,
          ]);
        },
      ),
      { seed: 2026101411, numRuns: 100 },
    );
  });
  it('protects leading restrictions through their current clause', () => {
    fc.assert(
      fc.property(
        prose,
        fc.constantFrom('until June every day', 'до июня каждый день', '3 times every day'),
        (prefix, expression) => {
          const protectedSource = `${prefix} ${expression}`;
          const text = `${protectedSource}; call tomorrow`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([]);
          expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
            protectedSource,
          ]);
          expect(
            result.protectedRanges.every(
              (range) => !text.slice(range.from, range.to).includes('tomorrow'),
            ),
          ).toBe(true);
        },
      ),
      { seed: 2026101412, numRuns: 100 },
    );
  });
  it('keeps finite weekday abbreviation dots inside unsupported source', () => {
    fc.assert(
      fc.property(prose, spacing, fc.boolean(), (prefix, space, uppercase) => {
        const source = uppercase ? 'EVERY DAY ON MON. AND FRI.' : 'every day on Mon. and Fri.';
        const expression = source.replaceAll(' ', space);
        const text = `${prefix} ${expression}; call tomorrow`;
        const result = parser.extract({
          text,
          protectedRanges: inspectTaskInput(text).protectedRanges,
        });
        expect(result.candidates).toEqual([]);
        expect(result.protectedRanges.map((range) => text.slice(range.from, range.to))).toEqual([
          expression,
        ]);
      }),
      { seed: 2026101413, numRuns: 100 },
    );
  });
});

describe('final review source ownership properties', () => {
  it('owns each reverse monthly selector across Unicode, spacing, suffixes and separators', () => {
    fc.assert(
      fc.property(
        fc.tuple(prose, spacing, fc.constantFrom(' и ', ', '), fc.boolean(), fc.boolean()),
        ([prefix, space, joiner, ordinal, uppercase]) => {
          const selectors = ordinal ? ['1-го', '15-го', '25-го'] : ['1', '15', '25'];
          const phrase = `${selectors.join(joiner)} числа каждого месяца`.replaceAll(' ', space);
          const source = uppercase ? phrase.toUpperCase() : phrase;
          const before = `${prefix} \`tomorrow\` `;
          const text = `${before}${source} аккуратно`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([
            {
              rule: 'every month on the 1st, 15th and 25th',
              ranges: [{ from: before.length, to: before.length + source.length }],
            },
          ]);
          expect(parser.parse(source)).toMatchObject({
            type: 'valid',
            raw: 'every month on the 1st, 15th and 25th',
          });
        },
      ),
      { seed: 2026101421, numRuns: 100 },
    );
  });
  it('protects invalid leading selectors through the clause instead of picking a valid suffix', () => {
    fc.assert(
      fc.property(
        prose,
        spacing,
        fc.constantFrom('0', '32', '-1', '+1', '1.5', '1-3', '1 / 3', '1-ого'),
        fc.constantFrom(' и ', ', ', ' или '),
        (prefix, space, invalid, separator) => {
          const expression = `${invalid}${separator}15 числа каждого месяца`.replaceAll(' ', space);
          const before = `${prefix} \`tomorrow\` `;
          const text = `${before}${expression}; call tomorrow`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([]);
          expect(result.protectedRanges).toEqual([
            { from: before.length, to: before.length + expression.length },
          ]);
        },
      ),
      { seed: 2026101422, numRuns: 100 },
    );
  });
  it('protects locale restrictions through punctuation and delegated clocks', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          prose,
          spacing,
          fc.boolean(),
          fc.constantFrom(' ', ' - ', ' — ', ' #work - ', ' `literal` - '),
          fc.constantFrom(
            { cue: 'every day', clock: 'at 10:00', tail: 'not on Monday' },
            { cue: 'every day', clock: 'at 10:00', tail: 'except Monday' },
            { cue: 'every day', clock: 'at 10:00', tail: 'two times' },
            { cue: 'каждый день', clock: 'в 10:00', tail: 'не в понедельник' },
            { cue: 'каждый день', clock: 'в 10:00', tail: 'кроме воскресенья' },
            { cue: 'каждый день', clock: 'в 10:00', tail: 'два раза' },
          ),
        ),
        ([prefix, space, clock, gap, entry]) => {
          const clockSource = clock ? ` ${entry.clock}` : '';
          const expression = `${entry.cue}${clockSource}${gap}${entry.tail}`.replaceAll(' ', space);
          const text = `${prefix} ${expression}; call tomorrow`;
          const result = parser.extract({
            text,
            protectedRanges: inspectTaskInput(text).protectedRanges,
          });
          expect(result.candidates).toEqual([]);
          expect(result.protectedRanges).toEqual([
            { from: prefix.length + 1, to: prefix.length + 1 + expression.length },
          ]);
        },
      ),
      { seed: 2026101423, numRuns: 120 },
    );
  });
});
