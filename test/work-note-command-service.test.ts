import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
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

  it('reports a filename collision without overwriting the existing note', async () => {
    const h = await fixture();
    const before = await h.app.vault.read(await fileAt(h.app, h.observed.path));

    expect(await h.service.create({ title: 'A', projectPath: 'Projects/P.md' })).toEqual({
      type: 'conflict',
      field: 'path',
    });
    expect(await h.app.vault.read(await fileAt(h.app, h.observed.path))).toBe(before);
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
