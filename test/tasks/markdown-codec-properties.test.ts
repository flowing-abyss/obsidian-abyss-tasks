// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseTaskLineSourceModel } from '../../src/tasks/domain/taskLineSourceModel';
import {
  TaskMarkdownCodec,
  type ParsedTaskLine,
} from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from '../helpers';
import { taskSyntaxArbitrary, type TaskSyntaxCase } from '../support/taskSyntaxArbitraries';

const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
const location = { filePath: 'qa.md', line: 0 };
const parameters = { seed: 20261011, numRuns: 200 };
const endings = fc.constantFrom('' as const, '\n' as const, '\r\n' as const);

function expectPartition(
  parsed: Pick<ParsedTaskLine, 'spans' | 'original'>,
  expectedSource: string,
): void {
  expect(parsed.original).toBe(expectedSource);
  expect(parsed.spans[0]?.from).toBe(0);
  expect(parsed.spans[parsed.spans.length - 1]?.to).toBe(expectedSource.length);
  expect(parsed.spans.map((span) => expectedSource.slice(span.from, span.to)).join('')).toBe(
    expectedSource,
  );
  for (const span of parsed.spans) {
    expect(span.to).toBeGreaterThan(span.from);
    expect(span.from).toBeGreaterThanOrEqual(0);
    expect(span.to).toBeLessThanOrEqual(expectedSource.length);
  }
  for (let i = 1; i < parsed.spans.length; i++) {
    expect(parsed.spans[i]?.from).toBe(parsed.spans[i - 1]?.to);
  }
}

function expectFields(
  parsed: Pick<
    ParsedTaskLine,
    | 'original'
    | 'spans'
    | 'statusSymbol'
    | 'markdownTitle'
    | 'tags'
    | 'dependencyId'
    | 'dependsOn'
    | 'planning'
    | 'priority'
    | 'lineEnding'
  >,
  value: TaskSyntaxCase,
  expectedSource: string,
): void {
  expect(parsed.statusSymbol).toBe(value.status);
  expect(parsed.markdownTitle).toBe(value.title);
  expect(parsed.tags).toEqual(value.tags);
  expect(parsed.dependencyId).toBe(value.dependencyId);
  expect(parsed.dependsOn).toEqual(value.dependsOn);
  expect(parsed.planning.due).toBe(value.due);
  expect(parsed.priority).toBe(value.priority);
  expect(parsed.lineEnding).toBe(value.lineEnding);
  expectPartition(parsed, expectedSource);
}

describe('independent canonical task grammar', () => {
  it('reads generated authored fields and partitions every UTF-16 source unit', () => {
    fc.assert(
      fc.property(taskSyntaxArbitrary(), (value) => {
        expectFields(expectDefined(codec.parseLine(value.source, location)), value, value.source);
        expectFields(expectDefined(parseTaskLineSourceModel(value.source)), value, value.source);
      }),
      parameters,
    );
  });

  it('changes only the fixture status byte and makes the repeated edit idempotent', () => {
    fc.assert(
      fc.property(
        taskSyntaxArbitrary(),
        fc.constantFrom('-', '> \t12)', '  *'),
        (value, prefix) => {
          const source = `${prefix} [ ] ${value.source.slice(value.source.indexOf(']') + 2)}`;
          const statusAt = prefix.length + 2;
          const edit = {
            type: 'set-status' as const,
            symbol: 'x',
            today: '2026-10-11',
            addCompletionDate: false,
          };
          const result = codec.applyLineEdit(source, edit);
          expect(result.type).toBe('changed');
          if (result.type === 'invalid') throw new Error('Generated valid status edit was refused');
          expect(result.content).toBe(`${source.slice(0, statusAt)}x${source.slice(statusAt + 1)}`);
          expectFields(
            expectDefined(codec.parseLine(result.content, location)),
            { ...value, status: 'x' },
            result.content,
          );
          expect(codec.applyLineEdit(result.content, edit).type).toBe('unchanged');
        },
      ),
      parameters,
    );
  });

  it('refuses a done transition without today even when completion stamping is disabled', () => {
    fc.assert(
      fc.property(endings, (ending) => {
        expect(
          codec.applyLineEdit(`- [ ] Task${ending}`, {
            type: 'set-status',
            symbol: 'x',
            addCompletionDate: false,
          }),
        ).toEqual({ type: 'invalid', issues: [{ code: 'invalid-status', field: 'status' }] });
      }),
      parameters,
    );
  });

  it('replaces tags through case aliases while preserving unrelated authored bytes', () => {
    fc.assert(
      fc.property(taskSyntaxArbitrary(), (value) => {
        const prefix = `> \t12) [${value.status}] ${value.title}`;
        const suffix = `🧩 future 📅 ${value.due} 🆔 ${value.dependencyId} ⛔ ${value.dependsOn.join(', ')} ^keep${value.lineEnding}`;
        const source = `${prefix} #OLD #keep ${suffix}`;
        const edit = { type: 'change-tags' as const, add: ['#NEW', '#KEEP'], remove: ['#old'] };
        const result = codec.applyLineEdit(source, edit);
        expect(result).toEqual({ type: 'changed', content: `${prefix} #keep #NEW ${suffix}` });
        if (result.type === 'invalid') throw new Error('Generated valid tag edit was refused');
        const parsed = expectDefined(codec.parseLine(result.content, location));
        expectFields(
          parsed,
          {
            ...value,
            title: `${value.title} 🧩 future`,
            priority: 'D',
            tags: ['#keep', '#NEW'],
          },
          result.content,
        );
        expect(codec.applyLineEdit(result.content, edit).type).toBe('unchanged');
      }),
      parameters,
    );
  });

  it.each([
    ['📅 nope', 'due'],
    ['⏰ 9:5', 'time'],
    ['⏱️ nope', 'duration'],
    ['🆔 bad.id', 'task-id'],
    ['⛔ one,,two', 'depends-on'],
    ['^bad/value', 'block-id'],
  ] as const)('preserves the malformed-known suffix %s and its exact span', (suffix, kind) => {
    fc.assert(
      fc.property(endings, (ending) => {
        const source = `- [ ] Task ${suffix}${ending}`;
        const parsed = expectDefined(codec.parseLine(source, location));
        expect(parsed.markdownTitle).toBe('Task');
        expect(
          parsed.spans
            .filter((span) => span.kind === 'malformed-known')
            .map((span) => ({
              kind: span.malformedKind,
              text: source.slice(span.from, span.to),
            })),
        ).toEqual([{ kind, text: suffix }]);
        expectPartition(parsed, source);
        expect(
          codec.applyLineEdit(source, {
            type: 'set-status',
            symbol: 'x',
            today: '2026-10-11',
            addCompletionDate: false,
          }),
        ).toEqual({ type: 'changed', content: `- [x] Task ${suffix}${ending}` });
      }),
      parameters,
    );
  });

  it.each([
    { suffix: '📅 2026-10-01 📅 2026-10-02', due: '2026-10-01', priority: 'D', kind: 'due' },
    { suffix: '🔽 🔺', due: undefined, priority: 'A', kind: 'priority' },
    { suffix: '🆔 first 🆔 second', due: undefined, priority: 'D', kind: 'task-id' },
  ] as const)('retains duplicate occurrences in $suffix', (value) => {
    fc.assert(
      fc.property(endings, (ending) => {
        const source = `- [ ] Task ${value.suffix}${ending}`;
        const parsed = expectDefined(codec.parseLine(source, location));
        expect(parsed.markdownTitle).toBe('Task');
        expect(parsed.planning.due).toBe(value.due);
        expect(parsed.priority).toBe(value.priority);
        expect(parsed.occurrences.get(value.kind)).toHaveLength(2);
        if (value.kind === 'task-id') expect(parsed.dependencyId).toBe('first');
        expectPartition(parsed, source);
      }),
      parameters,
    );
  });

  it.each(['🧩 future', '🧭 next'])('keeps the unknown suffix %s in the title', (suffix) => {
    fc.assert(
      fc.property(endings, (ending) => {
        const source = `- [ ] Task ${suffix}${ending}`;
        const parsed = expectDefined(codec.parseLine(source, location));
        expect(parsed.markdownTitle).toBe(`Task ${suffix}`);
        expect(
          parsed.spans
            .filter((span) => span.kind === 'unknown')
            .map((span) => source.slice(span.from, span.to)),
        ).toEqual([suffix.slice(0, 2)]);
        expectPartition(parsed, source);
      }),
      parameters,
    );
  });

  it.each([
    'Task [[Doc|#literal 📅 nope]]',
    'Task [#literal 🆔 bad.id](https://example.test)',
    'Task `#literal ⛔ one,,two`',
    'Task ![[Doc|#literal 📅 nope]]',
  ])('keeps link or code-contained metadata in %s', (title) => {
    fc.assert(
      fc.property(endings, (ending) => {
        const source = `- [ ] ${title} #real 📅 2026-10-11${ending}`;
        const parsed = expectDefined(codec.parseLine(source, location));
        expect(parsed.markdownTitle).toBe(title);
        expect(parsed.tags).toEqual(['#real']);
        expect(parsed.planning.due).toBe('2026-10-11');
        expect(parsed.dependencyId).toBeUndefined();
        expect(parsed.dependsOn).toEqual([]);
        expect(parsed.spans.filter((span) => span.kind === 'malformed-known')).toEqual([]);
        expectPartition(parsed, source);
      }),
      parameters,
    );
  });

  it.each([
    {
      body: String.raw`Task \#literal`,
      title: 'Task \\',
      tags: ['#literal'],
      due: undefined,
      spans: [
        ['title', 'Task'],
        ['separator', ' '],
        ['title', '\\'],
        ['tag', '#literal'],
      ],
    },
    {
      body: String.raw`Task \📅 2026-10-11`,
      title: 'Task \\',
      tags: [],
      due: '2026-10-11',
      spans: [
        ['title', 'Task'],
        ['separator', ' '],
        ['title', '\\'],
        ['due', '📅 2026-10-11'],
      ],
    },
    {
      body: String.raw`Task \#literal \📅 nope #real 📅 2026-10-11`,
      title: 'Task \\ \\',
      tags: ['#literal', '#real'],
      due: '2026-10-11',
      spans: [
        ['title', 'Task'],
        ['separator', ' '],
        ['title', '\\'],
        ['tag', '#literal'],
        ['separator', ' '],
        ['title', '\\'],
        ['malformed-known', '📅 nope'],
        ['separator', ' '],
        ['tag', '#real'],
        ['separator', ' '],
        ['due', '📅 2026-10-11'],
      ],
    },
  ] as const)('retains backslash bytes and the baseline metadata semantics of $body', (value) => {
    fc.assert(
      fc.property(endings, (ending) => {
        const source = `- [ ] ${value.body}${ending}`;
        const parsed = expectDefined(codec.parseLine(source, location));
        expect(parsed.markdownTitle).toBe(value.title);
        expect(parsed.tags).toEqual(value.tags);
        expect(parsed.planning.due).toBe(value.due);
        expect(parsed.spans.map((span) => [span.kind, source.slice(span.from, span.to)])).toEqual([
          ['prefix', '- [ ]'],
          ['separator', ' '],
          ...value.spans,
          ...(ending.length > 0 ? [['separator', ending]] : []),
        ]);
        expectPartition(parsed, source);
        const result = codec.applyLineEdit(source, {
          type: 'set-status',
          symbol: 'x',
          today: '2026-10-11',
          addCompletionDate: false,
        });
        expect(result).toEqual({ type: 'changed', content: `- [x] ${value.body}${ending}` });
      }),
      parameters,
    );
  });
});
