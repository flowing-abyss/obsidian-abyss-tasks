import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectLifecycleObservation } from '../src/projects/lifecycle';
import { ProjectCommandService } from '../src/projects/ProjectCommandService';
import { parseProjectDate } from '../src/projects/projectDates';
import type { ProjectDateValue } from '../src/projects/types';
import type { ProjectStatus } from '../src/settings/types';
import { clockFrom } from '../src/tasks/domain/clock';
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
  it('observes the exact raw Project endpoints used by a timeline command', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '# A\n' });
    const service = new ProjectCommandService(app, () => statuses);

    expect(
      service.observeRange({
        path: 'Projects/A.md',
        frontmatter: {
          start: '2026-08-20',
          end: '2026-08-26T14:30:00+07:00',
          unrelated: 'keep',
        },
      }),
    ).toEqual({
      path: 'Projects/A.md',
      start: '2026-08-20',
      end: '2026-08-26T14:30:00+07:00',
    });
  });

  it('observes each editable Project metadata field without coercion', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '# A\n' });
    const service = new ProjectCommandService(app, () => statuses, clockFrom(0, 0));

    expect(
      service.observeMetadata({
        path: 'Projects/A.md',
        frontmatter: {
          priority: ['B'],
          description: 3,
          comments: ['old'],
          start: '2026-08-20',
          end: null,
        },
        observed: {
          priority: ['B'],
          description: 3,
          comments: ['old'],
          start: '2026-08-20',
          end: null,
        },
      }),
    ).toEqual({
      path: 'Projects/A.md',
      priority: ['B'],
      description: 3,
      comments: ['old'],
      start: '2026-08-20',
      end: null,
    });
  });

  it('updates only its observed priority field while preserving external fields and note body', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md':
        '---\npriority: C\ndescription: original\nunknown:\n  nested: keep\n---\n\nProject body\n',
    });
    const service = new ProjectCommandService(app, () => statuses, clockFrom(0, 0));
    const file = fileAt(app, 'Projects/A.md');
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['description'] = 'external';
    });

    expect(await service.setPriority({ path: 'Projects/A.md', value: 'C' }, 'A')).toEqual({
      type: 'ok',
      priority: 'A',
    });
    const content = await app.vault.read(file);
    expect(content).toContain('priority: A');
    expect(content).toContain('description: external');
    expect(content).toContain('nested: keep');
    expect(content).toContain('Project body');
  });

  it('independently compares start, end, and description observations', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstart: 2026-08-20\nend: 2026-08-26\ndescription: before\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses, clockFrom(0, 0));
    const file = fileAt(app, 'Projects/A.md');
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['end'] = '2026-08-28';
    });

    expect(
      await service.setRange(
        { path: 'Projects/A.md', start: '2026-08-20', end: '2026-08-26' },
        { start: parseProjectDate('2026-08-21')! },
      ),
    ).toMatchObject({ type: 'ok', range: { start: { raw: '2026-08-21' } } });
    expect(
      await service.setDescription({ path: 'Projects/A.md', value: 'before' }, 'after'),
    ).toEqual({ type: 'ok', description: 'after' });
    expect(
      await service.setDescription({ path: 'Projects/A.md', value: 'before' }, 'lost'),
    ).toEqual({ type: 'conflict', current: 'after' });
    const content = await app.vault.read(file);
    expect(content).toContain('start: 2026-08-21');
    expect(content).toContain('end: 2026-08-28');
  });

  it('refuses to overwrite a read-only non-scalar description', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ndescription:\n  nested: keep\n---\n\nBody\n',
    });
    const service = new ProjectCommandService(app, () => statuses, clockFrom(0, 0));
    const file = fileAt(app, 'Projects/A.md');
    const writes = vi.spyOn(app.vault, 'modify');

    expect(
      await service.setDescription({ path: file.path, value: { nested: 'keep' } }, 'replacement'),
    ).toEqual({ type: 'unsupported', field: 'description' });
    expect(writes).not.toHaveBeenCalled();
    expect(await app.vault.read(file)).toContain('nested: keep');
  });

  it('sets one observed range field without changing the other endpoint precision', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md':
        '---\nstart: 2026-08-20\nend: 2026-08-26T14:30:00+07:00\ntags:\n  - project/active\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');

    const result = await service.setRange(
      { path: 'Projects/A.md', start: '2026-08-20', end: '2026-08-26T14:30:00+07:00' },
      { start: parseProjectDate('2026-08-21')! },
    );

    expect(result).toMatchObject({
      type: 'ok',
      range: {
        start: { raw: '2026-08-21' },
        end: { raw: '2026-08-26T14:30:00+07:00', precision: 'datetime' },
      },
    });
    const content = await app.vault.read(file);
    expect(content).toContain('start: 2026-08-21');
    expect(content).toContain('end: 2026-08-26T14:30:00+07:00');
  });

  it('rejects invalid or reversed target ranges without opening a transaction', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstart: 2026-08-20\nend: 2026-08-26\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const processFrontMatter = vi.spyOn(app.fileManager, 'processFrontMatter');

    expect(
      await service.setRange(
        { path: 'Projects/A.md', start: '2026-08-20', end: '2026-08-26' },
        { start: parseProjectDate('2026-08-30')! },
      ),
    ).toEqual({ type: 'invalid', issue: 'reversed' });
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it('reports the invalid patched endpoint without opening a transaction', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstart: 2026-08-20\nend: 2026-08-26\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const processFrontMatter = vi.spyOn(app.fileManager, 'processFrontMatter');
    const invalidEnd = {
      ...parseProjectDate('2026-08-27')!,
      raw: 'not-a-date',
    } as ProjectDateValue;

    expect(
      await service.setRange(
        { path: 'Projects/A.md', start: '2026-08-20', end: '2026-08-26' },
        { end: invalidEnd },
      ),
    ).toEqual({ type: 'invalid', issue: 'invalid-end' });
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it('conflicts when an observed range endpoint changed externally', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstart: 2026-08-20\nend: 2026-08-26\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['end'] = '2026-08-28';
    });
    const vaultWrites = vi.spyOn(app.vault, 'modify');
    vaultWrites.mockClear();

    const result = await service.setRange(
      { path: 'Projects/A.md', start: '2026-08-20', end: '2026-08-26' },
      { end: parseProjectDate('2026-08-29')! },
    );

    expect(result).toMatchObject({
      type: 'conflict',
      current: { start: { raw: '2026-08-20' }, end: { raw: '2026-08-28' } },
    });
    expect(vaultWrites).not.toHaveBeenCalled();
  });

  it('status commands never invent an end date', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstart: 2026-08-20\ntags:\n  - project/active\n---\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');

    await service.setStatus(observed('Projects/A.md', 'active', ['project/active']), 'published');

    const content = await app.vault.read(file);
    expect(content).toContain('start: 2026-08-20');
    expect(content).not.toContain('\nend:');
  });

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

  it('conditional undo restores the exact observed previous lifecycle status', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md':
        '---\ntags:\n  - project/active\n  - keep\n---\n\nProject body\n- [ ] Keep #project/active task text\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');

    const moved = await service.setStatus(
      observed('Projects/A.md', 'active', ['project/active']),
      'published',
    );
    expect(moved).toEqual({
      type: 'ok',
      previousStatusId: 'active',
      nextStatusId: 'published',
    });
    const undone = await service.undoStatus(
      observed('Projects/A.md', 'published', ['project/published']),
      'active',
    );

    expect(undone.type).toBe('ok');
    const content = await app.vault.read(file);
    expect(content).toContain('project/active');
    expect(content).not.toContain('project/published');
    expect(content).toContain('  - keep');
    expect(content).toContain('Project body');
    expect(content).toContain('- [ ] Keep #project/active task text');
  });

  it('conditional undo restores a null previous lifecycle without touching body tags or text', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\ntags:\n  - keep\n---\n\nBody #project/published\n- [ ] Task\n',
    });
    const service = new ProjectCommandService(app, () => statuses);
    const file = fileAt(app, 'Projects/A.md');

    const moved = await service.setStatus(observed('Projects/A.md', null, []), 'published');
    expect(moved).toEqual({
      type: 'ok',
      previousStatusId: null,
      nextStatusId: 'published',
    });
    const undone = await service.undoStatus(
      observed('Projects/A.md', 'published', ['project/published']),
      null,
    );

    expect(undone.type).toBe('ok');
    const content = await app.vault.read(file);
    expect(content).toContain('  - keep');
    expect(content).not.toContain('  - project/published');
    expect(content).toContain('Body #project/published');
    expect(content).toContain('- [ ] Task');
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
