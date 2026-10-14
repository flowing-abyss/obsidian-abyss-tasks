// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';

describe('raw task input inspection', () => {
  it('reports UTF-16 raw coordinates and protects canonical metadata and links', () => {
    const raw = '👩‍💻 Call [tomorrow](note) #work 📅 2026-10-15 ⏰ 12:00';
    const inspection = inspectTaskInput(raw);
    expect(inspection.tags).toEqual([{ value: '#work', range: { from: 28, to: 33 } }]);
    expect(inspection.carriers).toEqual([
      { role: 'due', range: { from: 34, to: 47 }, value: '2026-10-15' },
      { role: 'time', range: { from: 48, to: 55 }, value: '12:00' },
    ]);
    expect(inspection.protectedRanges.map(({ from, to }) => raw.slice(from, to))).toEqual([
      '[tomorrow](note)',
      '#work',
      '📅 2026-10-15',
      '⏰ 12:00',
    ]);
  });

  it('ignores tags and carriers in atomic Markdown while protecting malformed known carriers', () => {
    const raw =
      'Call `#code 📅 2026-10-15` [#link](tomorrow) ![tomorrow](img) <i title="tomorrow"> #work 📅 tomorrow ⏳ nope';
    const inspection = inspectTaskInput(raw);
    expect(inspection.tags.map(({ value }) => value)).toEqual(['#work']);
    expect(
      inspection.carriers.map(({ role, range, value }) => ({
        role,
        text: raw.slice(range.from, range.to),
        value,
      })),
    ).toEqual([
      { role: 'due', text: '📅 tomorrow', value: undefined },
      { role: 'scheduled', text: '⏳ nope', value: undefined },
    ]);
    expect(inspection.protectedRanges.map(({ from, to }) => raw.slice(from, to))).toEqual([
      '`#code 📅 2026-10-15`',
      '[#link](tomorrow)',
      '![tomorrow](img)',
      '<i title="tomorrow">',
      '#work',
      '📅 tomorrow',
      '⏳ nope',
    ]);
  });

  it('protects syntactically shaped invalid dates and times without inventing values', () => {
    const raw = 'Call 📅 2026-02-30 ⏰ 25:00';
    const inspection = inspectTaskInput(raw);
    expect(inspection.carriers).toEqual([
      { role: 'due', range: { from: 5, to: 18 } },
      { role: 'time', range: { from: 19, to: 26 } },
    ]);
    expect(inspection.protectedRanges.map(({ from, to }) => raw.slice(from, to))).toEqual([
      '📅 2026-02-30',
      '⏰ 25:00',
    ]);
  });

  it('retains duplicate occurrences and protects every known carrier', () => {
    const raw =
      'Call #work #work 📅 2026-10-15 📅 2026-10-16 ➕ 2026-10-13 🔼 🔁 every day ⏱️ 1h 🆔 abc ⛔ def ^block';
    const inspection = inspectTaskInput(raw);
    expect(inspection.tags.map(({ value }) => value)).toEqual(['#work', '#work']);
    expect(inspection.carriers.map(({ role, value }) => ({ role, value }))).toEqual([
      { role: 'due', value: '2026-10-15' },
      { role: 'due', value: '2026-10-16' },
      { role: 'recurrence', value: 'every day' },
    ]);
    expect(inspection.protectedRanges.map(({ from, to }) => raw.slice(from, to))).toEqual([
      '#work',
      '#work',
      '📅 2026-10-15',
      '📅 2026-10-16',
      '➕ 2026-10-13',
      '🔼',
      '🔁 every day',
      '⏱️ 1h',
      '🆔 abc',
      '⛔ def',
      '^block',
    ]);
  });
});

it.each(['every day except Monday', 'каждый день', 'nonsense'])(
  'protects an invalid canonical recurrence without granting metadata ownership: %s',
  (rule) => {
    const raw = `Call 🔁 ${rule}`;
    const inspection = inspectTaskInput(raw);
    expect(inspection.carriers).toEqual([
      { role: 'recurrence', range: { from: 5, to: raw.length } },
    ]);
    expect(inspection.protectedRanges).toContainEqual({ from: 5, to: raw.length });
  },
);
