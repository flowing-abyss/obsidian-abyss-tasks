import { expect, it } from 'vitest';
import { tree } from './command-live/fixtures';
import { evaluateTurn, type TurnEvidence, type TurnExpectation } from './command-live/oracles';
import { pageCases } from './command-live/pageCases';

const source = 'https://example.org/offline-backup';
const base = (trees: readonly unknown[]): TurnEvidence => ({
  status: 'ready',
  question: null,
  trees,
  before: { 'control.md': 'keep\r\n' },
  after: { 'control.md': 'keep\r\n' },
  journal: [],
  admissions: [],
  complete: true,
});
const sourceExpectation: TurnExpectation = {
  status: 'ready',
  trees: [
    {
      markdownTitle: 'Backup',
      comments: [
        {
          text: {
            sourceText: source,
            facts: [
              ['offline', 'без сети'],
              ['3 copies', '3 копии'],
            ],
            excludes: ['cloud upload required', 'обязательно загрузить в облако'],
          },
        },
      ],
    },
  ],
};

it.each([`Keep 3 copies offline. ${source}`, `Хранить 3 копии без сети. [Источник](${source})`])(
  'accepts independently specified source facts in either language: %s',
  (text) => {
    expect(
      evaluateTurn(sourceExpectation, base([{ markdownTitle: 'Backup', comments: [{ text }] }])),
    ).toEqual([]);
  },
);

it.each([
  `A cloud upload required; keep 3 copies online. ${source}`,
  `Keep 30 copies offline. ${source}`,
  `Подходит другой продукт. ${source}`,
  `Хранить 3 копии без сети; обязательно загрузить в облако. ${source}`,
])('rejects a correct citation and correct structure carrying wrong source facts: %s', (text) => {
  expect(
    evaluateTurn(sourceExpectation, base([{ markdownTitle: 'Backup', comments: [{ text }] }])),
  ).toContain('tree-postcondition');
});

it('rejects source-shaped empty output when no research result was returned', () => {
  expect(
    evaluateTurn({ status: 'ready', researchSource: source }, { ...base([]), research: [] }),
  ).toContain('research-source');
});

it('accepts varied open-goal decompositions but rejects empty, duplicate and invented scheduling', () => {
  const expected: TurnExpectation = {
    status: 'ready',
    decomposition: { minChildren: 3, maxChildren: 6, maxDepth: 2, noInventedSchedule: true },
  };
  const good = [
    {
      markdownTitle: 'Prepare the move',
      children: [
        { markdownTitle: 'Inventory fragile items', children: [] },
        { markdownTitle: 'Compare carriers', children: [{ markdownTitle: 'Get a written quote' }] },
        { markdownTitle: 'Pack and label boxes', children: [] },
      ],
    },
  ];
  expect(evaluateTurn(expected, base(good))).toEqual([]);
  expect(
    evaluateTurn(expected, base([{ markdownTitle: 'Prepare the move', children: [] }])),
  ).toContain('decomposition:child-count');
  expect(
    evaluateTurn(
      expected,
      base([
        {
          markdownTitle: 'Move',
          children: [
            { markdownTitle: 'Do it' },
            { markdownTitle: 'do it' },
            { markdownTitle: '  ' },
          ],
        },
      ]),
    ),
  ).toEqual(expect.arrayContaining(['decomposition:duplicate-title', 'decomposition:empty-title']));
  const scheduled = structuredClone(good);
  Object.assign(scheduled[0]?.children[0] ?? {}, { dates: { due: '2026-11-11' } });
  expect(evaluateTurn(expected, base(scheduled))).toContain('decomposition:invented-schedule');
});

it('requires whole numeric facts and excludes citation destinations from fact text', () => {
  const citation = 'https://example.org/Atlas/offline/3/20';
  const expected: TurnExpectation = {
    status: 'ready',
    trees: [
      {
        comments: [
          {
            text: {
              sourceText: citation,
              facts: [['Atlas'], ['offline'], ['3'], ['20']],
            },
          },
        ],
      },
    ],
  };
  const check = (text: string) => evaluateTurn(expected, base([{ comments: [{ text }] }]));
  expect(check(`Atlas has 3 copies, 20 minutes, offline. ${citation}`)).toEqual([]);
  expect(check(`Atlas has 30 copies, 20 minutes, offline. ${citation}`)).toContain(
    'tree-postcondition',
  );
  expect(check(`Read the source. ${citation}`)).toContain('tree-postcondition');
});

it('requires an attributed page read when search snippets contain the same facts', () => {
  const expected: TurnExpectation = {
    status: 'ready',
    researchPage: 'https://example.org/projects/cairn',
  };
  const search = {
    invocation: 1,
    query: 'https://example.org/projects/cairn',
    sources: ['https://example.org/projects/cairn'],
  };
  expect(evaluateTurn(expected, { ...base([]), research: [search] })).toContain('research-page');
  expect(
    evaluateTurn(expected, { ...base([]), research: [{ ...search, action: 'read-page' }] }),
  ).toEqual([]);
});

it('rejects overlong source comments even when their facts and citation are correct', () => {
  const expected: TurnExpectation = {
    status: 'ready',
    trees: [
      {
        comments: [
          {
            text: {
              sourceText: source,
              facts: [['offline']],
              maxLength: 100,
            },
          },
        ],
      },
    ],
  };
  const comment = (text: string) => base([{ comments: [{ text }] }]);
  expect(evaluateTurn(expected, comment(`Works offline. ${source}`))).toEqual([]);
  expect(
    evaluateTurn(expected, comment(`Works offline. ${'filler '.repeat(30)}${source}`)),
  ).toContain('tree-postcondition');
});

it('accepts the offline paraphrase and rejects contradicted offline or team-editing claims', () => {
  const pageCase = pageCases.find((candidate) => candidate.id === 'project-page-overview-ru');
  const expected = pageCase?.turns[1]?.expect;
  expect(expected).toBeDefined();
  const expectation = expected as TurnExpectation;
  const evaluate = (comments: readonly string[]) =>
    evaluateTurn(
      expectation,
      base([
        tree('Изучить Cairn', {
          description: 'Оценить для личного использования.',
          tags: ['#keep'],
          comments: comments.map((text) => ({ text })),
        }),
      ]),
    );
  const source = 'https://example.org/projects/cairn';
  const valid = [
    `Cairn рассчитан на тех, кто ведёт задачи в локальных Markdown-файлах: это автономный консольный менеджер, которым управляют из командной строки. Задачи хранятся у вас в этих локальных файлах. Может подойти для личных дел, если вам удобен такой способ работы. Источник: ${source}`,
    `Возможности: списки и фильтры локальных задач, разворачивание повторяющихся задач и экспорт календарного файла. Экспорт — только файл, не двусторонняя связь с календарём. Облачной синхронизации и совместного редактирования командой нет. Источник: ${source}`,
  ];
  const english = [
    `Cairn is an offline CLI task manager for personal Markdown files. ${source}`,
    `Expand recurring tasks and export a calendar file; no cloud sync or shared team editing. ${source}`,
  ];
  expect(evaluate(valid)).not.toContain('tree-postcondition');
  expect(evaluate(english)).not.toContain('tree-postcondition');
  expect(
    evaluate([
      `Cairn is not offline and requires an internet connection, despite its offline command line and Markdown files. ${source}`,
      valid[1] ?? '',
    ]),
  ).toContain('tree-postcondition');
  expect(
    evaluate([
      valid[0] ?? '',
      `It expands recurring tasks and exports a calendar file. Cloud sync is unavailable, but no shared team editing is false: team editing is available. ${source}`,
    ]),
  ).toContain('tree-postcondition');
  expect(
    evaluate([
      valid[0] ?? '',
      `Облачной синхронизации и совместного редактирования командой нет, но облачная синхронизация поддерживается. ${source}`,
    ]),
  ).toContain('tree-postcondition');
  expect(evaluate([`${valid[0] ?? ''} ${'лишние слова '.repeat(20)}`, valid[1] ?? ''])).toContain(
    'tree-postcondition',
  );
});
