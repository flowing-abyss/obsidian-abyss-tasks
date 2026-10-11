import fc from 'fast-check';
import type { TaskPriority } from '../../src/tasks/domain/types';

export interface TaskSyntaxCase {
  readonly source: string;
  readonly title: string;
  readonly status: ' ' | 'x';
  readonly tags: readonly string[];
  readonly dependencyId: string;
  readonly dependsOn: readonly string[];
  readonly due: string;
  readonly priority: TaskPriority;
  readonly lineEnding: '' | '\n' | '\r\n';
}

// These are authored grammar examples, independent of the production regex and parser.
export const validTagChunks = [
  'a',
  'Я',
  'ℹ',
  '\u0301',
  '\uFE0F',
  '\u200D',
  '😀',
  '🇳🇿',
  '🏽',
  '١',
  'Ⅷ',
  '２',
  '_',
  '-',
] as const;

export function validTagArbitrary(): fc.Arbitrary<string> {
  const segment = fc
    .tuple(
      fc.constantFrom('a', 'Я', 'ℹ', '\u0301', '\uFE0F', '\u200D', '😀', '🇳🇿'),
      fc.array(fc.constantFrom(...validTagChunks), { maxLength: 4 }),
    )
    .map(([nonNumber, rest]) => nonNumber + rest.join(''));
  return fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => `#${parts.join('/')}`);
}

const priorityCarriers: ReadonlyArray<{
  readonly symbol: string;
  readonly priority: TaskPriority;
}> = [
  { symbol: '🔺', priority: 'A' },
  { symbol: '⏫', priority: 'B' },
  { symbol: '🔼', priority: 'C' },
  { symbol: '', priority: 'D' },
  { symbol: '🔽', priority: 'E' },
  { symbol: '⏬', priority: 'F' },
];

export function taskSyntaxArbitrary(): fc.Arbitrary<TaskSyntaxCase> {
  const id = fc
    .array(fc.constantFrom('a', 'Z', '0', '_', '-'), { minLength: 1, maxLength: 8 })
    .map((parts) => parts.join(''));
  return fc
    .record({
      prefix: fc.constantFrom('-', '*', '+', '12)', '> \t12.', '  -', '>>-'),
      status: fc.constantFrom(' ' as const, 'x' as const),
      title: fc
        .array(fc.constantFrom('Read', 'Задача', 'café', '日本語', '𐐀word'), {
          minLength: 1,
          maxLength: 4,
        })
        .map((words) => words.join(' ')),
      tags: fc.array(validTagArbitrary(), { maxLength: 3 }),
      dependencyId: id,
      dependsOn: fc.array(id, { minLength: 1, maxLength: 3 }),
      due: fc.integer({ min: 1, max: 28 }).map((day) => `2026-10-${String(day).padStart(2, '0')}`),
      carrier: fc.constantFrom(...priorityCarriers),
      lineEnding: fc.constantFrom('' as const, '\n' as const, '\r\n' as const),
    })
    .map(({ prefix, carrier, ...value }) => ({
      ...value,
      priority: carrier.priority,
      source: `${prefix} [${value.status}] ${[
        value.title,
        ...value.tags,
        carrier.symbol,
        `📅 ${value.due}`,
        `🆔 ${value.dependencyId}`,
        `⛔ ${value.dependsOn.join(', ')}`,
      ]
        .filter((part) => part.length > 0)
        .join(' ')}${value.lineEnding}`,
    }));
}
