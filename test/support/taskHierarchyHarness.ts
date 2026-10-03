import { TFile } from 'obsidian';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import { clockFrom } from '../../src/tasks/domain/clock';
import type { TaskHierarchyCommand } from '../../src/tasks/domain/taskHierarchy';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
} from '../helpers';

export async function hierarchyHarness(
  files = { 'source.md': '- [ ] Move\n  - [ ] Child ^child\n', 'target.md': '- [ ] Parent\n' },
) {
  const app = await createAppWithFiles(files);
  const statusCatalog = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('hierarchy-test');
  const index = new TaskIndex(app, { statusCatalog, refAuthority: authority });
  await index.initialize();
  await flushMicrotasks();
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(() => '    '),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    refAuthority: authority,
    snapshotState: index,
  });
  const service = new TaskApplicationService(
    index,
    repository,
    statusCatalog,
    clockFrom(Date.UTC(2026, 9, 3), 0),
  );
  const source = expectDefined(index.list({ filePath: 'source.md' })[0]);
  const parent = expectDefined(index.list({ filePath: 'target.md' })[0]);
  const command: TaskHierarchyCommand = {
    type: 'reparent-task',
    source: { type: 'task', ref: source.ref },
    parent: { type: 'task', ref: parent.ref },
  };
  const file = (path: string) => {
    const value = app.vault.getAbstractFileByPath(path);
    if (!(value instanceof TFile)) throw new Error('Missing file');
    return value;
  };
  const read = async (path: string) => app.vault.read(file(path));
  const publications: string[][] = [];
  index.subscribe((event) => {
    if (event.type === 'changed')
      publications.push(index.list().map((root) => `${root.ref.filePath}:${root.markdownTitle}`));
  });
  return {
    app,
    index,
    authority,
    repository,
    service,
    source,
    parent,
    command,
    read,
    file,
    publications,
  };
}
