import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ProjectCommandService } from '../src/projects/ProjectCommandService';
import type { ProjectLifecycleObservation } from '../src/projects/lifecycle';
import type { ProjectStatus } from '../src/settings/types';
import { createAppWithFiles, flushMicrotasks, useRealMoment } from './helpers';

useRealMoment();

const statuses: ProjectStatus[] = [
  {
    id: 'active',
    label: 'Active',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'tag', tag: 'project/active' },
  },
  {
    id: 'wip',
    label: 'WIP',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'tag', tag: 'project/wip' },
  },
  {
    id: 'hold',
    label: 'Hold',
    behavior: 'regular',
    onLeftPanel: true,
    match: { kind: 'tag', tag: 'project/hold' },
  },
  {
    id: 'dropped',
    label: 'Dropped',
    behavior: 'dropped',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/dropped' },
  },
  {
    id: 'published',
    label: 'Published',
    behavior: 'published',
    onLeftPanel: false,
    match: { kind: 'tag', tag: 'project/published' },
  },
];

function observed(
  path: string,
  statusId: string | null,
  canonicalLifecycleTags: readonly string[],
): ProjectLifecycleObservation {
  return {
    path,
    statusId,
    rawStatus: null,
    ownedField: { kind: 'frontmatter-tags', canonicalLifecycleTags },
  };
}

function fileAt(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`${path} is not a file`);
  return file;
}

async function externalSetStatus(app: App, file: TFile, tag: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter['tags'] = [tag];
  });
  await flushMicrotasks();
}

describe('ProjectCommandService', () => {
  it('changes frontmatter tags without deleting body task tags', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md':
        '---\ntags:\n  - project/active\n  - keepme\n---\n\n- [ ] Keep #project/active in task text\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');

    const result = await service.setStatus(
      observed('Projects/A.md', 'active', ['project/active']),
      'dropped',
    );

    expect(result).toEqual({ type: 'ok', previousStatusId: 'active', nextStatusId: 'dropped' });
    const content = await app.vault.read(file);
    expect(content).toContain('- [ ] Keep #project/active in task text');
    expect(content).toContain('project/dropped');
    expect(content).toContain('keepme');
  });

  it('conditional undo conflicts after an external edit', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ntags:\n  - project/published\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');
    await externalSetStatus(app, file, 'project/hold');

    expect(
      await service.undoStatus(
        observed('Projects/A.md', 'published', ['project/published']),
        'wip',
      ),
    ).toEqual({ type: 'conflict', currentStatusId: 'hold' });
  });

  it('writes nothing when the latest owned frontmatter shape became ambiguous', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ntags:\n  - project/active\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['tags'] = ['project/active', 'project/dropped'];
    });
    const vaultWrites = vi.spyOn(app.vault, 'modify');
    vaultWrites.mockClear();

    const result = await service.setStatus(
      observed('Projects/A.md', 'active', ['project/active']),
      'published',
    );

    expect(result.type).toBe('conflict');
    expect(vaultWrites).not.toHaveBeenCalled();
  });

  it('conflicts when a canonical property appears after observing a legacy body tag', async () => {
    const mixedStatuses: ProjectStatus[] = [
      ...statuses,
      {
        id: 'property-hold',
        label: 'Property hold',
        behavior: 'regular',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'hold' },
      },
    ];
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: hold\n---\n\n#project/active\n',
    });
    const service = new ProjectCommandService(app, () => mixedStatuses);
    const vaultWrites = vi.spyOn(app.vault, 'modify');

    const result = await service.setStatus(observed('Projects/A.md', 'active', []), 'published');

    expect(result).toEqual({ type: 'conflict', currentStatusId: 'property-hold' });
    expect(vaultWrites).not.toHaveBeenCalled();
  });

  it('clears an observed discovered property when changing to a tag status', async () => {
    const mixedStatuses: ProjectStatus[] = [
      ...statuses,
      {
        id: 'known-property',
        label: 'Known property',
        behavior: 'regular',
        onLeftPanel: false,
        match: { kind: 'property', property: 'status', value: 'known' },
      },
    ];
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: archived\ntags:\n  - keepme\n---\n',
    });
    const service = new ProjectCommandService(app, () => mixedStatuses);
    const file = fileAt(app, 'Projects/A.md');
    const discovered: ProjectLifecycleObservation = {
      path: 'Projects/A.md',
      statusId: null,
      rawStatus: 'archived',
      ownedField: { kind: 'property', property: 'status', rawValue: 'archived' },
    };

    expect(await service.setStatus(discovered, 'published')).toEqual({
      type: 'ok',
      previousStatusId: null,
      nextStatusId: 'published',
    });
    const content = await app.vault.read(file);
    expect(content).not.toContain('status: archived');
    expect(content).toContain('project/published');
    expect(content).toContain('keepme');
  });

  it('rejects invalid paths and status ids without opening a transaction', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\ntags: []\n---\n' });
    const service = new ProjectCommandService(app, () => statuses);
    const processFrontMatter = vi.spyOn(app.fileManager, 'processFrontMatter');

    expect(await service.setStatus(observed('Missing.md', null, []), 'active')).toEqual({
      type: 'invalid',
      field: 'path',
    });
    expect(await service.setStatus(observed('Projects/A.md', null, []), 'missing')).toEqual({
      type: 'invalid',
      field: 'status',
    });
    expect(processFrontMatter).not.toHaveBeenCalled();
  });
});
