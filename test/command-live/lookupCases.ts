import type { EvalCase, EvalTurn } from './corpus';
import { files, tree } from './fixtures';

// Find and find-then-delete start with the same vault. Only the requested effect changes.
export const lookupCases: readonly EvalCase[] = (['ru', 'en'] as const).flatMap((language) => {
  const ru = language === 'ru';
  const title = ru ? 'Сделать домашнюю работу' : 'Do the homework';
  const children = ru
    ? ['Убраться на втором этаже', 'Подмести на улице']
    : ['Clean the second floor', 'Sweep outside'];
  const sibling = ru ? 'Полить цветы' : 'Water the plants';
  const kept = `- [ ] ${sibling} #keep\n`;
  const childLines = children.map((name) => `  - [ ] ${name}\n`).join('');
  const source = `- [ ] ${title}\n${childLines}${kept}`;
  const duplicate = `${source}- [ ] ${title}\n`;
  const original = [
    tree(title, { children: children.map((name) => tree(name)) }),
    tree(sibling, { tags: ['#keep'] }),
  ];
  const deletion = ru
    ? 'У меня есть задача, связанная с сделать домашнюю работу. Не мог бы ты её удалить целиком?'
    : 'I have a task about doing the homework. Could you find it and remove the whole thing?';
  const show = ru
    ? 'Найди задачу «Сделать домашнюю работу» и покажи её с подзадачами.'
    : 'Find “Do the homework” and show me the task with its subtasks.';
  function scenario(action: string, text: string, turns: EvalTurn[]): EvalCase {
    return {
      id: `lookup-${action}-${language}`,
      family: 'compound-lookup',
      split: 'held-out',
      files: files(text),
      turns,
    };
  }
  return [
    scenario('remove', source, [
      {
        text: deletion,
        expect: {
          status: 'ready',
          trees: [],
          publicTrees: original,
          taskSources: [{ path: 'a.md', line: 0, kind: 'edit' }],
          proposalKinds: ['task'],
          freshPreparation: true,
          writeCount: 0,
          files: { 'a.md': source },
        },
      },
      {
        text: ru ? 'Да, сохрани изменение.' : 'Yes, save the change.',
        expect: {
          status: 'saved',
          publicTrees: [tree(sibling, { tags: ['#keep'] })],
          proposalKinds: [],
          writeCount: 1,
          files: { 'a.md': kept },
        },
      },
    ]),
    scenario('show', source, [
      {
        text: show,
        expect: {
          status: 'ready',
          publicTrees: original,
          focus: [{ kind: 'task', path: 'a.md', line: 0 }],
          proposalKinds: [],
          writeCount: 0,
          files: { 'a.md': source },
        },
      },
    ]),
    scenario('ambiguous', duplicate, [
      {
        text: deletion,
        expect: {
          status: 'question',
          proposalKinds: [],
          writeCount: 0,
          files: { 'a.md': duplicate },
        },
      },
    ]),
  ];
});
