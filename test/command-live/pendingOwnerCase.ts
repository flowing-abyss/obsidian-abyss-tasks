import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

const title = 'Inspect the Nacre receiver';
const path = 'Field archive.md';
const comment = 'Проверить кабельный ввод перед тестом.';
const source = [
  '# Field archive',
  `- [ ] ${title} #radio 🛫 2027-06-02 📅 2027-06-06`,
  '  - Retain the copper seal until the test.',
  '- [ ] Keep the spare antenna wrapped #inventory 📅 2027-06-11',
  '  - Do not remove its protective sleeve.',
  '',
].join('\n');
const archive = '---\nrecord: NAC-204\n---\n# Archive register\nKeep this file unchanged.\n';
const fixtureFiles = files('', { [path]: source, 'Archive register.md': archive });
const owner = (due: string, comments = ['Retain the copper seal until the test.']) =>
  tree(title, {
    tags: ['#radio'],
    dates: { start: '2027-06-02', due },
    comments: comments.map((text) => ({ text })),
  });
const savedOwner = tree(title, {
  ...owner('2027-06-13', ['Retain the copper seal until the test.', comment]),
  source: { path, line: 1 },
});
const neighbor = tree('Keep the spare antenna wrapped', {
  tags: ['#inventory'],
  dates: { due: '2027-06-11' },
  comments: [{ text: 'Do not remove its protective sleeve.' }],
  source: { path, line: 3 },
});
const savedNeighbor = tree('Keep the spare antenna wrapped', {
  tags: ['#inventory'],
  dates: { due: '2027-06-11' },
  comments: [{ text: 'Do not remove its protective sleeve.' }],
  source: { path, line: 4 },
});

export const pendingOwnerFollowupCase: EvalCase = {
  id: 'prospective-pending-owner-comment-ru',
  family: 'prospective-pending-owner-followup',
  split: 'development',
  profile: 'owner',
  files: fixtureFiles,
  turns: [
    {
      text: `В файле «${path}» измени только срок выполнения существующей задачи «${title}» на 13 июня 2027 года и покажи черновик. Сохрани дату начала, тег и комментарий, соседнюю задачу, файл Archive register.md и ничего не сохраняй.`,
      expect: {
        status: 'ready',
        trees: [owner('2027-06-13')],
        publicTrees: [
          tree(title, {
            ...owner('2027-06-06'),
            source: { path, line: 1 },
          }),
          neighbor,
        ],
        taskSources: [{ path, line: 1, kind: 'edit' }],
        proposalKinds: ['task'],
        freshPreparation: true,
        researchCalls: 0,
        writeCount: 0,
        files: fixtureFiles,
      },
    },
    {
      text: `Найди снова именно «${title}» в файле «${path}» по этому неизменному названию и добавь к ней ровно такой комментарий: «${comment}». Сохрани срок 13 июня в черновике, прежний комментарий, тег, дату начала, соседнюю задачу и Archive register.md. Пока не сохраняй.`,
      expect: {
        status: 'ready',
        trees: [owner('2027-06-13', ['Retain the copper seal until the test.', comment])],
        publicTrees: [
          tree(title, {
            ...owner('2027-06-06'),
            source: { path, line: 1 },
          }),
          neighbor,
        ],
        taskSources: [{ path, line: 1, kind: 'edit' }],
        pendingTaskStates: [
          {
            path,
            line: 1,
            tree: owner('2027-06-13', ['Retain the copper seal until the test.', comment]),
          },
        ],
        proposalKinds: ['task'],
        writeCount: 0,
        files: fixtureFiles,
      },
    },
    {
      text: 'Сохрани этот черновик.',
      expect: {
        status: 'saved',
        publicTrees: [savedOwner, savedNeighbor],
        proposalKinds: [],
        createdFiles: [],
        writeCount: 1,
        files: { 'Archive register.md': archive },
      },
    },
  ],
};
