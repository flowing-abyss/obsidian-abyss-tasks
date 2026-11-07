import { NoteTemplateService } from '../../src/notes/NoteTemplateService';
import { ObsidianTaskDestinationProvider } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { taskEditPreparationHarness } from './taskEditPreparationHarness';

export async function taskCreatePreparationHarness(
  options: Parameters<typeof taskEditPreparationHarness>[1] = {},
) {
  const configuration = {
    taskFilePath: 'draft/new.md',
    taskTemplatePath: 'template.md',
    capturedToday: '2026-11-07',
    insertion: { type: 'append' as const },
  };
  const h = await taskEditPreparationHarness('- [ ] Existing\n', {
    ...options,
    files: { 'template.md': '# {{title}}\n{{date}} {{time}}\n', ...options.files },
    destination: (app) => {
      const notes = new NoteTemplateService(app);
      return new ObsidianTaskDestinationProvider(
        () => configuration,
        (path, template, title) => notes.ensureNote(path, template, title),
        () => false,
        {
          canonicalize: (path) => path,
          planNote: (path, template, title) => notes.planStaticNote(path, template, title),
        },
      );
    },
  });
  return { ...h, configuration };
}
