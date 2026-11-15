import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

const url = 'https://manual.emberline.example/kiln-log';
const path = 'projects/Kiln Lab.md';
const title = 'Review Emberline for studio firing records';
const originalComment = 'Ask the technician whether the controller CSV uses Celsius.';
const siblingComment = 'Leave the blue shelf markers in place.';
const originalFile = [
  '---',
  'start: 2027-03-01',
  'end: 2027-03-31',
  '---',
  '# Kiln Lab',
  `- [ ] ${title} #studio 📅 2027-03-14`,
  '  - > Keep glaze sample K-14 below 980°C.',
  `  - ${originalComment}`,
  '- [ ] Label the archived kiln shelves #inventory 📅 2027-03-21',
  `  - ${siblingComment}`,
  '',
].join('\n');
const studioNotes =
  '# Studio notes\nKeep the ash-test observation: 18 minutes to first hairline check.\n';
const unchangedFiles = {
  'projects/Kiln Lab.md': originalFile,
  'Studio notes.md': studioNotes,
};
const source = (line: number) => ({ path, line });
const sourceComment = (
  facts: ReadonlyArray<readonly string[]>,
  absenceFacts?: ReadonlyArray<ReadonlyArray<readonly string[]>>,
) => ({
  text: {
    sourceText: url,
    maxLength: 240,
    facts,
    ...(absenceFacts === undefined ? {} : { absenceFacts }),
  },
});
const existingTask = () =>
  tree(title, {
    tags: ['#studio'],
    dates: { due: '2027-03-14' },
    description: 'Keep glaze sample K-14 below 980°C.',
    comments: [{ text: originalComment }],
  });
const siblingTask = () =>
  tree('Label the archived kiln shelves', {
    tags: ['#inventory'],
    dates: { due: '2027-03-21' },
    comments: [{ text: siblingComment }],
  });
const firstAddition = sourceComment([
  ['Emberline'],
  ['community studios', 'community pottery studios'],
  ['firing logs', 'firing records', 'records firings'],
  ['temperature curves', 'temperature curve'],
  ['controller CSV', 'controller CSV files'],
]);
const secondAddition = sourceComment(
  [
    ['firing summaries', 'firing summary'],
    ['PDF'],
    ['manual import', 'manually import', 'import readings manually'],
  ],
  [
    [
      ['direct', 'connection', 'kiln', 'controllers'],
      ['direct', 'connection', 'controllers'],
    ],
  ],
);

export const freshSourceCommentCase: EvalCase = {
  id: 'r8-source-comment-utility-en',
  family: 'held-out-source-comment-utility-en',
  split: 'held-out',
  profile: 'project',
  files: files('# Inbox\n', {
    [path]: originalFile,
    'Studio notes.md': studioNotes,
  }),
  pageFixture: {
    url,
    title: 'Emberline kiln firing log',
    content: [
      'Emberline is an offline desktop utility for recording kiln firings at community pottery studios.',
      'It plots temperature curves from imported controller CSV files and exports firing summaries as PDF.',
      'It has no direct connection to kiln controllers; staff import readings manually.',
    ].join('\n'),
  },
  limitations: [
    'The pageFixture is fixed synthetic harness evidence at a reserved test URL; passing this case does not show that a live page was fetched or is current.',
    'The existing source predicates check fixture-authored facts, citation, length and the stated controller-connection limitation mechanically. Independent semantic review must assess whether both comments are useful, concise, source-faithful and free of unsupported claims.',
  ],
  turns: [
    {
      text: `In “${path}”, select the existing task “${title}” and read the full page at ${url}. Add exactly two concise comments to that task, each no longer than 240 characters including its citation: one describing Emberline’s purpose and its temperature-curve capability, and one describing its PDF summaries and the controller-connection limitation. Cite the page in both comments. Keep the task’s description, #studio tag, due date, and existing comment, along with the sibling task and its comment. Leave “Studio notes.md” unchanged. Show me the draft only; do not save yet.`,
      expect: {
        status: 'ready',
        trees: [
          tree(title, {
            tags: ['#studio'],
            dates: { due: '2027-03-14' },
            description: 'Keep glaze sample K-14 below 980°C.',
            comments: [{ text: originalComment }, firstAddition, secondAddition],
          }),
        ],
        publicTrees: [
          { ...existingTask(), source: source(5) },
          { ...siblingTask(), source: source(8) },
        ],
        taskSources: [{ path, line: 5, kind: 'edit' }],
        focus: [{ kind: 'task', path, line: 5 }],
        taskPlanKinds: ['edit'],
        proposalKinds: ['task'],
        researchCalls: 1,
        researchPage: url,
        freshPreparation: true,
        writeCount: 0,
        files: { ...unchangedFiles },
      },
    },
    {
      text: 'Yes, save those two comments to that task.',
      expect: {
        status: 'saved',
        publicTrees: [
          {
            ...tree(title, {
              tags: ['#studio'],
              dates: { due: '2027-03-14' },
              description: 'Keep glaze sample K-14 below 980°C.',
              comments: [{ text: originalComment }, firstAddition, secondAddition],
            }),
            source: source(5),
          },
          { ...siblingTask(), source: source(10) },
        ],
        focus: [{ kind: 'task', path, line: 5 }],
        proposalKinds: [],
        retainPreviousTasks: true,
        createdFiles: [],
        writeCount: 1,
        files: { 'Studio notes.md': studioNotes },
        contains: {
          [path]: [
            title,
            '#studio',
            '📅 2027-03-14',
            'Keep glaze sample K-14 below 980°C.',
            originalComment,
            'Label the archived kiln shelves #inventory 📅 2027-03-21',
            siblingComment,
          ],
        },
      },
    },
  ],
};
