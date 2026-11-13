import { expect, it } from 'vitest';
import { tree } from './command-live/fixtures';
import { evaluateTurn, type TurnEvidence, type TurnExpectation } from './command-live/oracles';
import { pageCases } from './command-live/pageCases';
import {
  hasSourceAbsenceFacts,
  hasSourceDestination,
  hasSourceFacts,
} from './command-live/sourceOracle';

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
function evaluatePagePreview(secondComment: string): string[] {
  const pageCase = pageCases.find((candidate) => candidate.id === 'project-page-overview-ru');
  const expected = pageCase?.turns[1]?.expect;
  if (expected === undefined) throw new Error('project page expectation missing');
  const url = 'https://example.org/projects/cairn';
  const original = tree('Изучить Cairn', {
    description: 'Оценить для личного использования.',
    tags: ['#keep'],
  });
  const preview = tree('Изучить Cairn', {
    description: 'Оценить для личного использования.',
    tags: ['#keep'],
    comments: [
      { text: `Cairn is an offline CLI task manager for personal Markdown files. ${url}` },
      { text: `${secondComment} ${url}` },
    ],
  });
  return evaluateTurn(expected, {
    ...base([preview]),
    focus: [{ kind: 'task', path: 'projects/Launch.md', line: 5 }],
    taskSources: [{ path: 'projects/Launch.md', line: 5, kind: 'edit', basisValid: true }],
    proposalKinds: ['task'],
    publicTrees: [original],
    freshPreparation: true,
    research: [{ invocation: 1, query: url, sources: [url], action: 'read-page' }],
    writeCount: 0,
  });
}

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

it('rejects same-capability contradiction mutations from fully valid RU and EN page previews', () => {
  const cases = [
    {
      gold: 'Expand recurring tasks; no shared team editing; no cloud sync and calendar export is available.',
      contradiction:
        'Expand recurring tasks; no shared team editing; no cloud sync and calendar export works and cloud sync is available.',
    },
    {
      gold: 'Expand recurring tasks; no shared team editing; no cloud sync and calendar export is available.',
      contradiction:
        'Expand recurring tasks; no shared team editing; cloud sync is available and no cloud sync; calendar export is available.',
    },
    {
      gold: 'Повторяющиеся задачи; совместного редактирования нет; облачной синхронизации нет и экспорт календаря доступен.',
      contradiction:
        'Повторяющиеся задачи; совместного редактирования нет; облачной синхронизации нет и экспорт календаря работает и облачная синхронизация доступна.',
    },
    {
      gold: 'Повторяющиеся задачи; совместного редактирования нет; облачной синхронизации нет и экспорт календаря доступен.',
      contradiction:
        'Повторяющиеся задачи; совместного редактирования нет; облачная синхронизация доступна и облачной синхронизации нет; экспорт календаря доступен.',
    },
  ];
  for (const { gold, contradiction } of cases) {
    expect(evaluatePagePreview(gold)).toEqual([]);
    expect(evaluatePagePreview(contradiction)).toContain('tree-postcondition');
  }
});

it('rejects coordinated opposite polarity cues for one capability in RU and EN page previews', () => {
  const cases = [
    {
      gold: 'Expand recurring tasks; calendar export; no shared team editing; cloud sync is unavailable.',
      mutations: [
        'Expand recurring tasks; calendar export; no shared team editing; cloud sync is unavailable and available.',
        'Expand recurring tasks; calendar export; no shared team editing; cloud sync is available and unavailable.',
      ],
    },
    {
      gold: 'Повторяющиеся задачи; экспорт календаря; совместного редактирования нет; облачная синхронизация недоступна.',
      mutations: [
        'Повторяющиеся задачи; экспорт календаря; совместного редактирования нет; облачная синхронизация недоступна и доступна.',
        'Повторяющиеся задачи; экспорт календаря; совместного редактирования нет; облачная синхронизация доступна и недоступна.',
      ],
    },
  ];
  for (const { gold, mutations } of cases) {
    expect(evaluatePagePreview(gold)).toEqual([]);
    for (const mutation of mutations) {
      expect(evaluatePagePreview(mutation)).toContain('tree-postcondition');
    }
  }
});

it('keeps unrelated positive capabilities and conservative negation controls calibrated', () => {
  const pageCase = pageCases.find((candidate) => candidate.id === 'project-page-overview-ru');
  const expected = pageCase?.turns[1]?.expect;
  expect(expected).toBeDefined();
  const evaluate = (comment: string) =>
    evaluateTurn(
      expected as TurnExpectation,
      base([
        tree('Изучить Cairn', {
          description: 'Оценить для личного использования.',
          tags: ['#keep'],
          comments: [
            {
              text: 'Cairn is an offline CLI task manager for personal Markdown files. https://example.org/projects/cairn',
            },
            {
              text: `Expand recurring tasks and export a calendar file; no cloud sync or shared team editing. ${comment} https://example.org/projects/cairn`,
            },
          ],
        }),
      ]),
    );
  const absenceFacts = [
    [
      ['облачн', 'синхронизац'],
      ['синхронизац', 'облак'],
      ['cloud', 'sync'],
      ['cloud', 'synchronization'],
    ],
  ] as const;
  expect(evaluate('Calendar export is available.')).not.toContain('tree-postcondition');
  expect(hasSourceAbsenceFacts('No cloud sync. Calendar export is available.', absenceFacts)).toBe(
    true,
  );
  expect(hasSourceAbsenceFacts('Cloud sync is not unavailable.', absenceFacts)).toBe(false);
  expect(hasSourceAbsenceFacts('No cloud sync. Cloud sync is not unavailable.', absenceFacts)).toBe(
    false,
  );
  expect(hasSourceAbsenceFacts('Cloud sync is not required.', absenceFacts)).toBe(false);
  expect(hasSourceAbsenceFacts('Облачная синхронизация не требуется.', absenceFacts)).toBe(false);
});

it('recognizes only terminal comma-linked ellipsis for configured source capabilities', () => {
  const pageCase = pageCases.find((candidate) => candidate.id === 'project-page-overview-ru');
  const expected = pageCase?.turns[1]?.expect;
  expect(expected).toBeDefined();
  const url = 'https://example.org/projects/cairn';
  const actualFirst =
    'Cairn — офлайн-менеджер задач для командной строки, для тех, кто хранит задачи в локальных Markdown-файлах. Им управляют через командную строку, а задачи остаются в локальных файлах на вашем устройстве.';
  const firstComment = `${actualFirst} [Страница Cairn](${url})`;
  const secondPrefix =
    'Возможности: Cairn умеет показывать и фильтровать локальные задачи, разворачивать повторяющиеся задачи и экспортировать календарный файл. Экспорт — только файл, не двусторонняя связь с календарём.';
  const secondComment = (claim: string) => `${secondPrefix} ${claim} [Страница Cairn](${url})`;
  const evaluateComplete = (claim: string) =>
    evaluateTurn(expected as TurnExpectation, {
      ...base([
        tree('Изучить Cairn', {
          description: 'Оценить для личного использования.',
          tags: ['#keep'],
          comments: [{ text: firstComment }, { text: secondComment(claim) }],
        }),
      ]),
      focus: [{ kind: 'task', path: 'projects/Launch.md', line: 5 }],
      taskSources: [{ path: 'projects/Launch.md', line: 5, kind: 'edit', basisValid: true }],
      proposalKinds: ['task'],
      publicTrees: [
        tree('Изучить Cairn', {
          description: 'Оценить для личного использования.',
          tags: ['#keep'],
        }),
      ],
      freshPreparation: true,
      research: [
        {
          invocation: 1,
          query: url,
          sources: [url],
          action: 'read-page',
        },
      ],
      writeCount: 0,
    });
  const actualGold = 'Облачной синхронизации нет, совместного редактирования командой тоже.';
  const expectsAbsence = [
    actualGold,
    'Совместного редактирования командой нет, облачной синхронизации тоже.',
    'Облачной синхронизации нет, совместного редактирования командой также.',
    'Облачной синхронизации нет, совместного редактирования командой тоже нет.',
  ];
  for (const claim of expectsAbsence) expect.soft(evaluateComplete(claim)).toEqual([]);

  const absenceFacts = [
    [
      ['облачн', 'синхронизац'],
      ['синхронизац', 'облак'],
      ['cloud', 'sync'],
      ['cloud', 'synchronization'],
    ],
    [
      ['совместн', 'командн', 'редактирован'],
      ['совместн', 'редактирован'],
      ['совместн', 'редактирован', 'команд'],
      ['shared', 'team', 'edit'],
      ['team', 'edit'],
      ['collaborat'],
    ],
  ] as const;
  const pageFacts = [['повтор'], ['экспорт'], ['календар']] as const;
  const pageExcludes = [
    'supports cloud',
    'cloud synchronization is supported',
    'облачная синхронизация поддерживается',
    'shared team editing is supported',
    'team editing is available',
    'совместное редактирование командой доступно',
    'поддерживает совместную работу команды',
  ];
  const actualComment = secondComment(actualGold);
  expect(actualComment.length).toBeLessThanOrEqual(400);
  expect(hasSourceDestination(actualComment, url)).toBe(true);
  expect(hasSourceFacts(actualComment, pageFacts, pageExcludes)).toBe(true);
  expect(hasSourceAbsenceFacts(actualComment, absenceFacts)).toBe(true);
  expect(evaluateComplete(actualGold)).toEqual([]);

  const reject = [
    'Облачной синхронизации нет. Совместного редактирования командой тоже.',
    'Облачной синхронизации нет; совместного редактирования командой тоже.',
    'Облачной синхронизации нет\nсовместного редактирования командой тоже.',
    'Облачной синхронизации нет, но совместного редактирования командой тоже.',
    'Облачной синхронизации нет, а совместного редактирования командой тоже.',
    'Регистрации нет, облачной синхронизации нет. Совместного редактирования командой тоже.',
    'Облачной синхронизации нет, совместного редактирования командой тоже доступно.',
    'Облачной синхронизации нет, совместное редактирование работает тоже.',
    'Облачной синхронизации нет, совместное редактирование не требуется тоже.',
    'Облачной синхронизации нет, совместное редактирование для всех участников одной команды в каждом проекте доступно тоже.',
    'Облачной синхронизации нет, совместное редактирование работает для всех участников одной команды в каждом проекте тоже.',
    'Облачной синхронизации нет, совместного редактирования командой тоже, совместной работы также.',
    'Облачной синхронизации нет, совместного редактирования командой, хотя доступно тоже.',
  ];
  for (const claim of reject) {
    const comment = secondComment(claim);
    expect(comment.length).toBeLessThanOrEqual(400);
    expect(hasSourceDestination(comment, url)).toBe(true);
    expect(hasSourceFacts(comment, pageFacts, pageExcludes)).toBe(true);
    expect.soft(hasSourceAbsenceFacts(comment, absenceFacts), claim).toBe(false);
    expect.soft(evaluateComplete(claim), claim).toContain('tree-postcondition');
  }

  const contradictions = [
    'Облачная синхронизация доступна, облачной синхронизации нет, совместного редактирования командой тоже.',
    'Облачной синхронизации нет, облачная синхронизация доступна, совместного редактирования командой тоже.',
    'Совместное редактирование командой доступно, облачной синхронизации нет, совместного редактирования командой тоже.',
    'Облачной синхронизации нет, совместное редактирование командой доступно, совместного редактирования командой тоже.',
    'Облачной синхронизации нет, совместного редактирования командой тоже. Совместное редактирование доступно.',
    'Облачной синхронизации нет, совместного редактирования командой тоже. Облачная синхронизация поддерживается.',
    'Облачная синхронизация не отсутствует, совместного редактирования командой тоже.',
    'Облачной синхронизации нет, совместное редактирование командой не отсутствует.',
  ];
  for (const claim of contradictions) {
    const comment = secondComment(claim);
    expect(comment.length).toBeLessThanOrEqual(400);
    expect(hasSourceDestination(comment, url)).toBe(true);
    expect(hasSourceFacts(comment, pageFacts, [])).toBe(true);
    expect(hasSourceAbsenceFacts(comment, absenceFacts)).toBe(false);
    expect(evaluateComplete(claim)).toContain('tree-postcondition');
  }

  const alternateVocabulary = [[['remote', 'backup']], [['local', 'scheduling']]] as const;
  expect(
    hasSourceAbsenceFacts(
      'Remote backup is unavailable, local scheduling тоже. https://example.net/guide',
      alternateVocabulary,
    ),
  ).toBe(true);
  expect(
    hasSourceAbsenceFacts(
      'Remote backup is unavailable. Local scheduling тоже. https://example.net/guide',
      alternateVocabulary,
    ),
  ).toBe(false);
  expect
    .soft(
      hasSourceAbsenceFacts(
        'Remote backup is unavailable, local scheduling works тоже. https://example.net/guide',
        alternateVocabulary,
      ),
      'unmatched predicate under alternate capability vocabulary',
    )
    .toBe(false);
});
