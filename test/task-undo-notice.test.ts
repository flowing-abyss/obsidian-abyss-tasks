import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { taskRemovalInverse } from '../src/ui/taskUndoNotice';
import { configuredTaskApplication, createAppWithFiles, expectDefined } from './helpers';

describe('committed removal recovery', () => {
  it.each(['missing', 'ambiguous'] as const)(
    'restores exact authored %s dependency bytes',
    async (kind) => {
      const blockers = kind === 'ambiguous' ? '- [ ] One 🆔 raw\n- [ ] Two 🆔 raw\n' : '';
      const markdown = `\n${blockers}- [ ] Current ⛔ first, raw, raw, last\n`;
      const app = await createAppWithFiles({ 'tasks.md': markdown });
      const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await h.index.initialize();
      try {
        const current = expectDefined(
          h.index.listNodes().find(({ node }) => node.title === 'Current'),
        );
        const removed = await h.tasks.execute({
          type: 'remove-dependency',
          dependent: current.target,
          dependencyId: 'raw',
        });
        const inverse = expectDefined(taskRemovalInverse(removed));
        expect((await h.tasks.execute(inverse)).type).toBe('ok');
        const file = app.vault.getAbstractFileByPath('tasks.md');
        if (!(file instanceof TFile)) throw new Error('Missing fixture');
        expect(await app.vault.read(file)).toBe(markdown);
      } finally {
        h.index.destroy();
      }
    },
  );

  it('offers no local inverse for additions or a no-op', async () => {
    const app = await createAppWithFiles({ 'tasks.md': '\n- [ ] Blocker\n- [ ] Current\n' });
    const h = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await h.index.initialize();
    try {
      const [blocker, current] = h.index.listNodes();
      const result = await h.tasks.execute({
        type: 'add-dependency',
        blocker: expectDefined(blocker).target,
        dependent: expectDefined(current).target,
      });
      expect(result.type).toBe('ok');
      expect(taskRemovalInverse(result)).toBeUndefined();
      if (result.type !== 'ok') throw new Error('Add failed');
      expect(taskRemovalInverse({ ...result, changed: false })).toBeUndefined();
    } finally {
      h.index.destroy();
    }
  });
});
