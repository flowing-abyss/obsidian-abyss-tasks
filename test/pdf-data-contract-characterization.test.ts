import { TFile, type App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { ProjectCommandService } from '../src/projects/ProjectCommandService';
import type { ProjectStatus } from '../src/settings/types';
import { clockFrom } from '../src/tasks/domain/clock';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, createAppWithFiles } from './helpers';

const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
const location = { filePath: 'Projects/Atlas.md', line: 0 };

const statuses: readonly ProjectStatus[] = [
  {
    id: 'active',
    label: 'Active',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'property', property: 'status', value: 'active' },
  },
];

function projectTask(source: string) {
  const task = codec.parseLine(source, location);
  if (!task) throw new Error('Expected valid Task Markdown');
  return task;
}

function fileAt(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`${path} is not a file`);
  return file;
}

describe('PDF data-contract characterization', () => {
  it('retains every existing prerequisite relation', () => {
    const snapshot = projectTask('- [ ] Dependent 🆔 child ⛔ first, second');

    expect(snapshot.dependency.dependsOn).toEqual(['first', 'second']);
  });

  it('preserves unknown Project frontmatter through a guarded owned-field write', async () => {
    const app = await createAppWithFiles({
      'Projects/Atlas.md':
        '---\nstatus: active\npriority: C\nunknown:\n  nested:\n    - exactly\n---\n\nProject body\n',
    });
    const project = fileAt(app, 'Projects/Atlas.md');
    const commands = new ProjectCommandService(app, () => statuses, clockFrom(0, 0));

    await expect(commands.setPriority({ path: project.path, value: 'C' }, 'A')).resolves.toEqual({
      type: 'ok',
      priority: 'A',
    });

    let frontmatter: Record<string, unknown> | undefined;
    await app.fileManager.processFrontMatter(project, (current) => {
      frontmatter = structuredClone(current) as Record<string, unknown>;
    });
    expect(frontmatter?.['unknown']).toEqual({ nested: ['exactly'] });
  });
});
