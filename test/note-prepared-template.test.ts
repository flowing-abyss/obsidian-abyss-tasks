import { expect, it, vi } from 'vitest';
import { NoteTemplateService } from '../src/notes/NoteTemplateService';
import { createAppWithFiles, useRealMoment } from './helpers';
useRealMoment();
it('creates the frozen final candidate through its original static plan without restamping', async () => {
  const app = await createAppWithFiles({ 'template.md': '# {{title}}\n{{time}}\n' });
  const notes = new NoteTemplateService(app);
  const plan = await notes.planStaticNote('new.md', 'template.md', 'Frozen');
  if (plan.type !== 'ready') throw new Error('Missing plan');
  const content = `${plan.content}Contact\n`;
  const writes = vi.spyOn(app.vault, 'create');
  const clock = vi.spyOn(window, 'moment').mockImplementation(() => {
    throw new Error('Must not rerender a frozen template');
  });
  const saved = await notes.createStaticNote({
    path: 'new.md',
    plan,
    content,
    validate: async () => true,
    check: () => {},
  });
  expect(saved.content).toBe(content);
  expect(await app.vault.read(saved.file)).toBe(content);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(clock).not.toHaveBeenCalled();
});
