import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { parseProjectDate } from '../src/projects/projectDates';
import {
  acceptWorkNoteAudit,
  computeWorkNotePresetFingerprint,
} from '../src/projects/work-notes/compatibility';
import type {
  WorkNoteCompatibilityPreset,
  WorkNoteObservedFields,
} from '../src/projects/work-notes/types';
import { WorkNoteCommandService } from '../src/projects/work-notes/WorkNoteCommandService';
import { WorkNoteIndex } from '../src/projects/work-notes/WorkNoteIndex';
import type { ProjectStatus } from '../src/settings/types';
import { createAppWithFiles, flushMicrotasks, useRealMoment } from './helpers';

useRealMoment();

const fields: WorkNoteCompatibilityPreset['fields'] = {
  project: 'Project',
  status: 'Status',
  priority: 'Priority',
  description: 'Description',
  start: 'Start',
  end: 'End',
  created: 'Created',
  updated: 'Updated',
  id: 'ID',
  milestone: 'Milestone',
  blockedBy: 'Blocked by',
  related: 'Related',
};

function enabledPreset(
  over: Partial<WorkNoteCompatibilityPreset> = {},
): WorkNoteCompatibilityPreset {
  const candidate: WorkNoteCompatibilityPreset = {
    revision: 7,
    enabled: true,
    membershipQuery: '#work-note',
    ordinaryKindQuery: '#work-note/task',
    milestoneKindQuery: '#work-note/milestone',
    folder: 'Work Notes',
    fields,
    rawStatusByStatusId: { active: 'Active raw', done: 'Finished raw' },
    creation: {
      folder: 'Work Notes',
      defaultKind: 'ordinary',
      defaultStatusId: 'active',
      kindMarkers: {
        ordinary: { kind: 'frontmatter-tag', value: 'work-note/task' },
        milestone: { kind: 'frontmatter-tag', value: 'work-note/milestone' },
      },
    },
    ...over,
  };
  return acceptWorkNoteAudit(candidate, { update: true, create: true }, '2026-08-27T00:00:00Z');
}

function observed(preset: WorkNoteCompatibilityPreset): WorkNoteObservedFields {
  return {
    path: 'Work Notes/A.md',
    presetRevision: preset.revision,
    presetFingerprint: computeWorkNotePresetFingerprint(preset),
    projectPath: 'Projects/P.md',
    kind: 'ordinary',
    fields: {
      Project: '[[Projects/P]]',
      Status: 'Active raw',
      tags: ['work-note/task'],
    },
  };
}

async function fixture(preset = enabledPreset()) {
  const app = await createAppWithFiles({
    'Projects/P.md': '# P\n',
    'Work Notes/A.md':
      '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags:\n  - work-note/task\nUnknown: keep\n---\n# A\n',
  });
  const provider = { current: preset };
  const index = new WorkNoteIndex(app, () => provider.current);
  const service = new WorkNoteCommandService(app, () => provider.current, index);
  return { app, provider, index, service, observed: observed(preset) };
}

async function fileAt(app: App, path: string): Promise<TFile> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`Expected ${path}`);
  return file;
}

describe('WorkNoteCommandService', () => {
  it('captures the exact owned raw fields used by a guarded UI command', async () => {
    const h = await fixture();
    const snapshot = h.index.list()[0] ?? (await h.index.audit()).snapshots[0]!;

    expect(h.service.observe(snapshot)).toEqual(h.observed);
    expect(h.service.capabilities()).toEqual({ update: true, create: true });
  });

  it('exposes the accepted Work Note status IDs instead of unrelated Project status IDs', async () => {
    const h = await fixture();

    expect(h.service.statuses()).toEqual([
      { id: 'active', label: 'Active raw' },
      { id: 'done', label: 'Finished raw' },
    ]);
  });

  it('presents mapped Project labels in Project order, appends unmatched raw statuses, and writes the exact mapped raw value', async () => {
    const candidate = enabledPreset({
      rawStatusByStatusId: {
        'raw-active': 'Active raw',
        'raw-planned': 'Planned raw',
        unmatched: 'Review raw',
      },
      creation: {
        folder: 'Work Notes',
        defaultKind: 'ordinary',
        defaultStatusId: 'raw-active',
        kindMarkers: {
          ordinary: { kind: 'frontmatter-tag', value: 'work-note/task' },
          milestone: { kind: 'frontmatter-tag', value: 'work-note/milestone' },
        },
      },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags:\n  - work-note/task\n---\n# A\n',
    });
    const statuses: readonly ProjectStatus[] = [
      {
        id: 'raw-planned',
        label: 'Planned',
        onLeftPanel: true,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'planned' },
      },
      {
        id: 'raw-active',
        label: 'In progress',
        onLeftPanel: true,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'active' },
      },
    ];
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index, () => statuses);
    const snapshot = (await index.audit()).snapshots[0]!;

    expect(service.statuses()).toEqual([
      { id: 'raw-planned', label: 'Planned' },
      { id: 'raw-active', label: 'In progress' },
      { id: 'unmatched', label: 'Review raw' },
    ]);
    const observation = service.observe(snapshot)!;
    expect(await service.setStatus(observation, 'raw-planned')).toEqual({
      type: 'ok',
      path: 'Work Notes/A.md',
    });
    expect(await app.vault.cachedRead(await fileAt(app, 'Work Notes/A.md'))).toContain(
      'Status: Planned raw',
    );
  });

  it.each(['membership', 'project', 'kind', 'preset'] as const)(
    'writes nothing when %s changes after observation',
    async (change) => {
      const h = await fixture();
      if (change === 'preset') {
        h.provider.current = {
          ...h.provider.current,
          membershipQuery: '#changed',
          acceptedAudit: h.provider.current.acceptedAudit,
        };
      } else {
        const file = await fileAt(h.app, h.observed.path);
        await h.app.fileManager.processFrontMatter(file, (frontmatter) => {
          if (change === 'membership') frontmatter['tags'] = ['not-a-work-note'];
          if (change === 'project') frontmatter['Project'] = '[[Projects/Else]]';
          if (change === 'kind') frontmatter['tags'] = ['work-note/milestone'];
        });
        await flushMicrotasks();
      }
      const vaultWrites = vi.spyOn(h.app.vault, 'modify');
      vaultWrites.mockClear();

      expect((await h.service.setStatus(h.observed, 'done')).type).toBe('compatibility-conflict');
      expect(vaultWrites).not.toHaveBeenCalled();
    },
  );

  it.each(['query', 'field', 'status-map', 'kind-marker', 'creation'] as const)(
    'writes nothing after audited %s changes',
    async (change) => {
      const h = await fixture();
      const preset = h.provider.current;
      let next: WorkNoteCompatibilityPreset = structuredClone(preset);
      if (change === 'query') next = { ...next, ordinaryKindQuery: '#different' };
      if (change === 'field') next = { ...next, fields: { ...next.fields, status: 'State' } };
      if (change === 'status-map') {
        next = {
          ...next,
          rawStatusByStatusId: { ...next.rawStatusByStatusId, done: 'Done' },
        };
      }
      if (change === 'kind-marker') {
        next = {
          ...next,
          creation: {
            ...next.creation!,
            kindMarkers: {
              ...next.creation!.kindMarkers,
              ordinary: { kind: 'frontmatter-tag', value: 'different' },
            },
          },
        };
      }
      if (change === 'creation') {
        next = { ...next, creation: { ...next.creation!, folder: 'Other' } };
      }
      next = { ...next, acceptedAudit: preset.acceptedAudit };
      h.provider.current = next;
      const vaultWrites = vi.spyOn(h.app.vault, 'modify');
      vaultWrites.mockClear();

      expect((await h.service.setStatus(h.observed, 'done')).type).toBe('compatibility-conflict');
      expect(vaultWrites).not.toHaveBeenCalled();
    },
  );

  it('writes nothing when a different preset is reaccepted at the same revision', async () => {
    const h = await fixture();
    const staleSnapshot = (await h.index.audit()).snapshots[0]!;
    const changed = {
      ...h.provider.current,
      rawStatusByStatusId: { active: 'Active raw', done: 'New finished raw' },
      acceptedAudit: undefined,
    };
    h.provider.current = acceptWorkNoteAudit(
      changed,
      { update: true, create: true },
      '2026-08-27T01:00:00Z',
    );
    const writes = vi.spyOn(h.app.vault, 'modify');
    writes.mockClear();
    const staleObservation = h.service.observe(staleSnapshot)!;

    expect(await h.service.setStatus(staleObservation, 'done')).toEqual({
      type: 'compatibility-conflict',
      reason: 'preset-fingerprint-changed',
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('revalidates inline membership from latest markdown instead of stale metadata cache', async () => {
    const candidate = enabledPreset();
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\n---\n# A\n#work-note/task\n',
    });
    const file = await fileAt(app, 'Work Notes/A.md');
    const staleCache = app.metadataCache.getFileCache(file);
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index);
    const snapshot = (await index.audit()).snapshots[0]!;
    const latestObserved = service.observe(snapshot)!;
    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue(staleCache);
    await app.vault.modify(
      file,
      '---\nProject: "[[Projects/P]]"\nStatus: Active raw\n---\n# A\nMembership removed\n',
    );
    const writes = vi.spyOn(app.vault, 'modify');
    writes.mockClear();

    expect((await service.setStatus(latestObserved, 'done')).type).toBe('compatibility-conflict');
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    'Only code remains: ``#work-note/task``\n',
    '````md\n```\n#work-note/task\n````\n',
    '%% #work-note/task %%\n',
    '[Membership link](#work-note/task)\n',
    '[[#work-note/task]]\n',
  ])('does not treat tags inside Markdown code as latest membership', async (codedMembership) => {
    const candidate = enabledPreset();
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\n---\n# A\n#work-note/task\n',
    });
    const file = await fileAt(app, 'Work Notes/A.md');
    const staleCache = app.metadataCache.getFileCache(file);
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index);
    const snapshot = (await index.audit()).snapshots[0]!;
    const latestObserved = service.observe(snapshot)!;
    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue(staleCache);
    await app.vault.modify(
      file,
      `---\nProject: "[[Projects/P]]"\nStatus: Active raw\n---\n# A\n${codedMembership}`,
    );
    const writes = vi.spyOn(app.vault, 'modify');
    writes.mockClear();

    expect((await service.setStatus(latestObserved, 'done')).type).toBe('compatibility-conflict');
    expect(writes).not.toHaveBeenCalled();
  });

  it('validates inline eligibility inside the same atomic content transform as the write', async () => {
    const candidate = enabledPreset();
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\n---\n# A\n#work-note/task\n',
    });
    const file = await fileAt(app, 'Work Notes/A.md');
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index);
    const snapshot = (await index.audit()).snapshots[0]!;
    const latestObserved = service.observe(snapshot)!;
    const originalProcess = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation((target, update, options) =>
      originalProcess(
        target,
        (markdown) => update(markdown.replace('#work-note/task', 'membership removed')),
        options,
      ),
    );
    const writes = vi.spyOn(app.vault, 'modify');
    writes.mockClear();

    expect((await service.setStatus(latestObserved, 'done')).type).toBe('compatibility-conflict');
    expect(writes).not.toHaveBeenCalled();
  });

  it('writes the configured raw status and preserves unrelated frontmatter', async () => {
    const h = await fixture();

    expect(await h.service.setStatus(h.observed, 'done')).toEqual({
      type: 'ok',
      path: 'Work Notes/A.md',
    });

    const content = await h.app.vault.read(await fileAt(h.app, h.observed.path));
    expect(content).toContain('Status: Finished raw');
    expect(content).not.toContain('Status: done');
    expect(content).toContain('Unknown: keep');
  });

  it('guards configured date fields and preserves the exact untouched datetime endpoint', async () => {
    const candidate = enabledPreset();
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\nStart: 2026-08-26T14:30:00+07:00\nEnd: 2026-08-30\ntags: [work-note/task]\n---\n',
    });
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index);
    const snapshot = (await index.audit()).snapshots[0]!;
    const latestObserved = service.observe(snapshot)!;

    expect(latestObserved.fields).toMatchObject({
      Start: '2026-08-26T14:30:00+07:00',
      End: '2026-08-30',
    });
    expect(
      await service.setRange(latestObserved, { end: parseProjectDate('2026-09-01')! }),
    ).toEqual({ type: 'ok', path: 'Work Notes/A.md' });

    const content = await app.vault.read(await fileAt(app, 'Work Notes/A.md'));
    expect(content).toContain('Start: 2026-08-26T14:30:00+07:00');
    expect(content).toContain('End: 2026-09-01');
  });

  it('writes nothing when an observed Work Note range endpoint changed externally', async () => {
    const candidate = enabledPreset();
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\nStart: 2026-08-26\nEnd: 2026-08-30\ntags: [work-note/task]\n---\n',
    });
    const file = await fileAt(app, 'Work Notes/A.md');
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index);
    const snapshot = (await index.audit()).snapshots[0]!;
    const latestObserved = service.observe(snapshot)!;
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['Start'] = '2026-08-27';
    });
    await flushMicrotasks();
    const writes = vi.spyOn(app.vault, 'modify');
    writes.mockClear();

    expect(
      await service.setRange(latestObserved, { end: parseProjectDate('2026-09-01')! }),
    ).toEqual({ type: 'conflict', field: 'start' });
    expect(writes).not.toHaveBeenCalled();
  });

  it('writes milestone start without treating updated as a scheduling guard', async () => {
    const candidate = enabledPreset();
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/M.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\nUpdated: 2026-08-26T14:30:00+07:00\ntags: [work-note/milestone]\n---\n',
    });
    const file = await fileAt(app, 'Work Notes/M.md');
    const index = new WorkNoteIndex(app, candidate);
    const service = new WorkNoteCommandService(app, candidate, index);
    const snapshot = (await index.audit()).snapshots[0]!;
    const latestObserved = service.observe(snapshot)!;
    expect(latestObserved.fields['Updated']).toBe('2026-08-26T14:30:00+07:00');
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['Updated'] = '2026-08-27T14:30:00+07:00';
    });
    await flushMicrotasks();
    expect(
      await service.setRange(latestObserved, { start: parseProjectDate('2026-09-01')! }),
    ).toEqual({ type: 'ok', path: 'Work Notes/M.md' });
    const content = await app.vault.read(file);
    expect(content).toContain('Start: 2026-09-01');
    expect(content).toContain('Updated: 2026-08-27T14:30:00+07:00');
  });

  it('repairs an unknown scalar status but conflicts on the latest non-scalar shape', async () => {
    const h = await fixture();
    const file = await fileAt(h.app, h.observed.path);
    await h.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['Status'] = 'Review';
    });
    await flushMicrotasks();
    const unknown = { ...h.observed, fields: { ...h.observed.fields, Status: 'Review' } };
    expect((await h.service.setStatus(unknown, 'done')).type).toBe('ok');

    await h.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter['Status'] = ['Finished raw'];
    });
    await flushMicrotasks();
    const writes = vi.spyOn(h.app.vault, 'modify');
    writes.mockClear();
    expect(
      (
        await h.service.setStatus(
          { ...unknown, fields: { ...unknown.fields, Status: ['Finished raw'] } },
          'active',
        )
      ).type,
    ).toBe('compatibility-conflict');
    expect(writes).not.toHaveBeenCalled();
  });

  it('creates a note with generated project link, kind marker, and raw default status', async () => {
    const h = await fixture();
    const generateMarkdownLink = vi
      .spyOn(h.app.fileManager, 'generateMarkdownLink')
      .mockReturnValue('[[Projects/P|P]]');

    expect(await h.service.create({ title: 'Fresh note', projectPath: 'Projects/P.md' })).toEqual({
      type: 'ok',
      path: 'Work Notes/Fresh note.md',
    });

    const created = await fileAt(h.app, 'Work Notes/Fresh note.md');
    const content = await h.app.vault.read(created);
    expect(generateMarkdownLink).toHaveBeenCalledWith(
      expect.any(TFile),
      'Work Notes/Fresh note.md',
    );
    expect(content).toContain('Project: "[[Projects/P|P]]"');
    expect(content).toContain('Status: Active raw');
    expect(content).toContain('work-note/task');
  });

  it('does not write stale owned fields after a different preset is reaccepted mid-creation', async () => {
    const h = await fixture();
    const originalCreate = h.app.vault.create.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'create').mockImplementation(async (path, content, options) => {
      const file = await originalCreate(path, content, options);
      const changed = {
        ...h.provider.current,
        fields: { ...h.provider.current.fields, status: 'State' },
        acceptedAudit: undefined,
      };
      h.provider.current = acceptWorkNoteAudit(
        changed,
        { update: true, create: true },
        '2026-08-27T02:00:00Z',
      );
      return file;
    });

    expect(await h.service.create({ title: 'Raced', projectPath: 'Projects/P.md' })).toEqual({
      type: 'partial',
      path: 'Work Notes/Raced.md',
      reason: 'preset-changed-after-create',
    });
    const content = await h.app.vault.read(await fileAt(h.app, 'Work Notes/Raced.md'));
    expect(content).not.toContain('Status:');
    expect(content).not.toContain('Project:');
  });

  it('reports a filename collision without overwriting the existing note', async () => {
    const h = await fixture();
    const before = await h.app.vault.read(await fileAt(h.app, h.observed.path));

    expect(await h.service.create({ title: 'A', projectPath: 'Projects/P.md' })).toEqual({
      type: 'conflict',
      field: 'path',
    });
    expect(await h.app.vault.read(await fileAt(h.app, h.observed.path))).toBe(before);
  });

  it('reports a missing configured template before creating any destination', async () => {
    const candidate = enabledPreset({
      creation: { ...enabledPreset().creation!, templatePath: 'Templates/Missing.md' },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n',
    });
    const service = new WorkNoteCommandService(app, candidate, new WorkNoteIndex(app, candidate));
    const create = vi.spyOn(app.vault, 'create');
    create.mockClear();

    expect(await service.create({ title: 'Missing', projectPath: 'Projects/P.md' })).toEqual({
      type: 'compatibility-conflict',
      reason: 'missing-template',
    });
    expect(create).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath('Work Notes/Missing.md')).toBeNull();
  });

  it('does not raw-render a Templater template when Templater is unavailable', async () => {
    const candidate = enabledPreset({
      creation: { ...enabledPreset().creation!, templatePath: 'Templates/Templater.md' },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Templates/Templater.md':
        '<%* const secret = await tp.system.prompt("Value") %>\n# <% tp.file.title %>\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n',
    });
    const service = new WorkNoteCommandService(app, candidate, new WorkNoteIndex(app, candidate));
    const create = vi.spyOn(app.vault, 'create');
    create.mockClear();

    expect(
      await service.create({ title: 'Needs Templater', projectPath: 'Projects/P.md' }),
    ).toEqual({
      type: 'compatibility-conflict',
      reason: 'templater-unavailable',
    });
    expect(create).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath('Work Notes/Needs Templater.md')).toBeNull();
  });

  it('preserves the partial destination when Templater rejects', async () => {
    const candidate = enabledPreset({
      creation: { ...enabledPreset().creation!, templatePath: 'Templates/Work note.md' },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Templates/Work note.md': '# Template\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n',
    });
    (app as unknown as { plugins: { getPlugin(id: string): unknown } }).plugins = {
      getPlugin: () => ({
        templater: { write_template_to_file: () => Promise.reject(new Error('Templater')) },
      }),
    };
    const service = new WorkNoteCommandService(app, candidate, new WorkNoteIndex(app, candidate));

    expect(await service.create({ title: 'Rejected', projectPath: 'Projects/P.md' })).toEqual({
      type: 'partial',
      path: 'Work Notes/Rejected.md',
      reason: 'templater-failure',
    });
    expect(app.vault.getAbstractFileByPath('Work Notes/Rejected.md')).toBeInstanceOf(TFile);
  });

  it.each([
    {
      name: 'project-replaced',
      output:
        '---\nProject: "[[Projects/Other]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n# User output\n',
    },
    {
      name: 'status-replaced',
      output:
        '---\nProject: "[[Projects/P]]"\nStatus: User status\ntags: [work-note/task]\n---\n# User output\n',
    },
  ] as const)('preserves partial output for $name', async ({ name, output }) => {
    const candidate = enabledPreset({
      creation: { ...enabledPreset().creation!, templatePath: 'Templates/Work note.md' },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Projects/Other.md': '# Other\n',
      'Templates/Work note.md': '# Template\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n',
    });
    (app as unknown as { plugins: { getPlugin(id: string): unknown } }).plugins = {
      getPlugin: () => ({
        templater: {
          write_template_to_file: async (_template: TFile, file: TFile) => {
            await app.vault.modify(file, output);
            await flushMicrotasks();
          },
        },
      }),
    };
    const service = new WorkNoteCommandService(app, candidate, new WorkNoteIndex(app, candidate));

    expect(await service.create({ title: name, projectPath: 'Projects/P.md' })).toEqual({
      type: 'partial',
      path: `Work Notes/${name}.md`,
      reason: name,
    });
    expect(await app.vault.read(await fileAt(app, `Work Notes/${name}.md`))).toContain(
      'User output',
    );
  });

  it('preserves raw-template frontmatter and list tags while adding its owned marker', async () => {
    const candidate = enabledPreset({
      creation: {
        ...enabledPreset().creation!,
        templatePath: 'Templates/Work note.md',
      },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Templates/Work note.md': '---\ntags:\n  - research\nUnknown: keep\n---\n# {{title}}\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n',
    });
    const service = new WorkNoteCommandService(
      app,
      () => candidate,
      new WorkNoteIndex(app, candidate),
    );

    expect(await service.create({ title: 'Templated', projectPath: 'Projects/P.md' })).toEqual({
      type: 'ok',
      path: 'Work Notes/Templated.md',
    });
    const content = await app.vault.read(await fileAt(app, 'Work Notes/Templated.md'));
    expect(content).toContain('Unknown: keep');
    expect(content).toContain('research');
    expect(content).toContain('work-note/task');
    expect(content).toContain('# Templated');
  });

  it('reports partial and preserves the file when Templater removes the membership marker', async () => {
    const candidate = enabledPreset({
      creation: {
        ...enabledPreset().creation!,
        templatePath: 'Templates/Work note.md',
      },
    });
    const app = await createAppWithFiles({
      'Projects/P.md': '# P\n',
      'Templates/Work note.md': '# Template\n',
      'Work Notes/A.md':
        '---\nProject: "[[Projects/P]]"\nStatus: Active raw\ntags: [work-note/task]\n---\n',
    });
    const templater = {
      templater: {
        write_template_to_file: async (_template: TFile, file: TFile) => {
          await app.vault.modify(file, '---\ntags: [not-a-work-note]\n---\n# User output\n');
          await flushMicrotasks();
        },
      },
    };
    (app as unknown as { plugins: { getPlugin(id: string): unknown } }).plugins = {
      getPlugin: (id) => (id === 'templater-obsidian' ? templater : null),
    };
    const service = new WorkNoteCommandService(
      app,
      () => candidate,
      new WorkNoteIndex(app, candidate),
    );

    expect(await service.create({ title: 'Partial', projectPath: 'Projects/P.md' })).toEqual({
      type: 'partial',
      path: 'Work Notes/Partial.md',
      reason: 'membership-marker-replaced',
    });
    expect(app.vault.getAbstractFileByPath('Work Notes/Partial.md')).toBeInstanceOf(TFile);
    expect(await app.vault.read(await fileAt(app, 'Work Notes/Partial.md'))).toContain(
      'User output',
    );
  });

  it('requires exact accepted fingerprint, revision, enabled state, and capability', async () => {
    const h = await fixture();
    for (const preset of [
      { ...h.provider.current, enabled: false },
      {
        ...h.provider.current,
        acceptedAudit: { ...h.provider.current.acceptedAudit!, acceptedRevision: 6 },
      },
      {
        ...h.provider.current,
        acceptedAudit: {
          ...h.provider.current.acceptedAudit!,
          presetFingerprint: computeWorkNotePresetFingerprint({
            ...h.provider.current,
            folder: 'Other',
          }),
        },
      },
      {
        ...h.provider.current,
        acceptedAudit: {
          ...h.provider.current.acceptedAudit!,
          capabilities: { update: false, create: true },
        },
      },
    ]) {
      h.provider.current = preset;
      expect((await h.service.setStatus(h.observed, 'done')).type).toBe('compatibility-conflict');
    }
  });
});
