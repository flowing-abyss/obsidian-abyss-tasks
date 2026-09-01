import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptWorkNoteAudit,
  computeWorkNotePresetFingerprint,
} from '../src/projects/work-notes/compatibility';
import type {
  RelationWriteCommand,
  WorkNoteCompatibilityPreset,
} from '../src/projects/work-notes/types';
import { WorkNoteIndex } from '../src/projects/work-notes/WorkNoteIndex';
import { WorkNoteRelationCommandService } from '../src/projects/work-notes/WorkNoteRelationCommandService';
import { createAppWithFiles, flushMicrotasks, useRealMoment } from './helpers';

useRealMoment();

const fields: WorkNoteCompatibilityPreset['fields'] = {
  project: 'Owner',
  status: 'State',
  priority: 'Priority',
  description: 'Description',
  start: 'Start',
  end: 'End',
  created: 'Created',
  updated: 'Updated',
  id: 'ID',
  milestone: 'Milestone link',
  blockedBy: 'Waits for',
  related: 'See also',
};

function acceptedPreset(
  over: Partial<WorkNoteCompatibilityPreset> = {},
): WorkNoteCompatibilityPreset {
  const preset: WorkNoteCompatibilityPreset = {
    revision: 7,
    enabled: true,
    membershipQuery: '#work-note',
    ordinaryKindQuery: '#work-note/task',
    milestoneKindQuery: '#work-note/milestone',
    folder: 'Work Notes',
    fields,
    rawStatusByStatusId: { active: 'Active' },
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
  return acceptWorkNoteAudit(preset, { update: true, create: true }, '2026-09-01T00:00:00Z');
}

function note(project = 'Projects/P', kind: 'task' | 'milestone' = 'task', extra = ''): string {
  return `---\nOwner: "[[${project}]]"\nState: Active\ntags:\n  - work-note/${kind}\n${extra}Keep:\n  nested:\n    - exact\n---\n# Note\n`;
}

async function fileAt(app: App, path: string): Promise<TFile> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`Expected ${path}`);
  return file;
}

async function fixture(additions: Record<string, string> = {}, initialPreset = acceptedPreset()) {
  const app = await createAppWithFiles({
    'Projects/P.md': '# P\n',
    'Projects/Q.md': '# Q\n',
    'Work Notes/A.md': note(),
    'Work Notes/B.md': note(),
    'Work Notes/M.md': note('Projects/P', 'milestone'),
    'Work Notes/QM.md': note('Projects/Q', 'milestone'),
    ...additions,
  });
  const provider = { current: initialPreset };
  const index = new WorkNoteIndex(app, () => provider.current);
  index.initialize();
  const service = new WorkNoteRelationCommandService(app, () => provider.current, index);
  const command = <T>(
    notePath: string,
    expectedRaw: unknown,
    value: T,
  ): RelationWriteCommand<T> => ({
    notePath,
    expectedRaw,
    expectedPresetRevision: String(initialPreset.revision),
    expectedPresetFingerprint: computeWorkNotePresetFingerprint(initialPreset),
    value,
  });
  return { app, provider, index, service, command };
}

describe('WorkNoteRelationCommandService', () => {
  it('preserves scalar/list carriers and unrelated frontmatter while adding and removing relations', async () => {
    const h = await fixture({
      'Work Notes/A.md': note('Projects/P', 'task', 'See also: "[[Work Notes/B]]"\n'),
    });

    expect(
      await h.service.addRelated(
        h.command('Work Notes/A.md', '[[Work Notes/B]]', 'Work Notes/M.md'),
      ),
    ).toMatchObject({ type: 'ok' });
    let markdown = await h.app.vault.cachedRead(await fileAt(h.app, 'Work Notes/A.md'));
    expect(markdown).toContain('See also:\n  - "[[Work Notes/B]]"\n  - "[[Work Notes/M]]"');
    expect(markdown).toContain('Keep:\n  nested:\n    - exact');

    expect(
      await h.service.removeRelated(
        h.command('Work Notes/A.md', ['[[Work Notes/B]]', '[[Work Notes/M]]'], 'Work Notes/B.md'),
      ),
    ).toMatchObject({ type: 'ok' });
    markdown = await h.app.vault.cachedRead(await fileAt(h.app, 'Work Notes/A.md'));
    expect(markdown).toContain('See also:\n  - "[[Work Notes/M]]"');
  });

  it('keeps the observed milestone carrier shape and enforces one milestone', async () => {
    const scalar = await fixture();
    expect(
      await scalar.service.setMilestone(
        scalar.command('Work Notes/A.md', undefined, 'Work Notes/M.md'),
      ),
    ).toMatchObject({ type: 'ok' });
    expect(
      await scalar.app.vault.cachedRead(await fileAt(scalar.app, 'Work Notes/A.md')),
    ).toContain('Milestone link: "[[Work Notes/M]]"');

    const list = await fixture({
      'Work Notes/A.md': note('Projects/P', 'task', 'Milestone link:\n  - "[[Work Notes/M]]"\n'),
    });
    expect(
      await list.service.setMilestone(
        list.command('Work Notes/A.md', ['[[Work Notes/M]]'], 'Work Notes/M.md'),
      ),
    ).toMatchObject({ type: 'unchanged' });
    expect(
      await list.service.setMilestone(list.command('Work Notes/A.md', ['[[Work Notes/M]]'], null)),
    ).toMatchObject({ type: 'ok' });
    expect(await list.app.vault.cachedRead(await fileAt(list.app, 'Work Notes/A.md'))).toContain(
      'Milestone link: []',
    );
  });

  it('rejects stale raw values and changed preset identity without writing', async () => {
    const h = await fixture({
      'Work Notes/A.md': note('Projects/P', 'task', 'Waits for: "[[Work Notes/B]]"\n'),
    });
    const writes = vi.spyOn(h.app.vault, 'modify');

    expect(
      await h.service.addBlockedBy(h.command('Work Notes/A.md', undefined, 'Work Notes/M.md')),
    ).toEqual({ type: 'conflict', field: 'blockedBy' });
    h.provider.current = { ...h.provider.current, revision: 8 };
    expect(
      await h.service.addRelated(h.command('Work Notes/A.md', undefined, 'Work Notes/B.md')),
    ).toEqual({ type: 'compatibility-conflict', reason: 'preset-revision-changed' });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects a missing target and cross-Project or non-Milestone milestone targets', async () => {
    const h = await fixture();

    await expect(
      h.service.addRelated(h.command('Work Notes/A.md', undefined, 'Work Notes/Missing.md')),
    ).resolves.toMatchObject({ type: 'invalid', reason: 'missing-target' });
    await expect(
      h.service.setMilestone(h.command('Work Notes/A.md', undefined, 'Work Notes/QM.md')),
    ).resolves.toMatchObject({ type: 'invalid', reason: 'cross-project' });
    await expect(
      h.service.setMilestone(h.command('Work Notes/A.md', undefined, 'Work Notes/B.md')),
    ).resolves.toMatchObject({ type: 'invalid', reason: 'wrong-kind' });
  });

  it('rejects self blocking and a cycle against the authoritative relation graph', async () => {
    const h = await fixture({
      'Work Notes/B.md': note('Projects/P', 'task', 'Waits for: "[[Work Notes/A]]"\n'),
    });

    await expect(
      h.service.addBlockedBy(h.command('Work Notes/A.md', undefined, 'Work Notes/A.md')),
    ).resolves.toMatchObject({ type: 'invalid', reason: 'self' });
    await expect(
      h.service.addBlockedBy(h.command('Work Notes/A.md', undefined, 'Work Notes/B.md')),
    ).resolves.toMatchObject({ type: 'invalid', reason: 'cycle' });
  });

  it('rejects ambiguous source ownership and unsupported relation raw shapes without normalizing them', async () => {
    const h = await fixture({
      'Work Notes/A.md':
        '---\nOwner:\n  - "[[Projects/P]]"\n  - "[[Projects/Q]]"\nState: Active\ntags:\n  - work-note/task\nSee also:\n  nested: keep\nKeep: exact\n---\n# Note\n',
    });
    const before = await h.app.vault.cachedRead(await fileAt(h.app, 'Work Notes/A.md'));

    await expect(
      h.service.addRelated(h.command('Work Notes/A.md', { nested: 'keep' }, 'Work Notes/B.md')),
    ).resolves.toMatchObject({ type: 'compatibility-conflict', reason: 'ambiguous-ownership' });
    expect(await h.app.vault.cachedRead(await fileAt(h.app, 'Work Notes/A.md'))).toBe(before);

    const supportedOwner = await fixture({
      'Work Notes/A.md': note('Projects/P', 'task', 'See also:\n  nested: keep\n'),
    });
    await expect(
      supportedOwner.service.addRelated(
        supportedOwner.command('Work Notes/A.md', { nested: 'keep' }, 'Work Notes/B.md'),
      ),
    ).resolves.toMatchObject({ type: 'invalid', reason: 'unsupported-shape' });
  });

  it('publishes the authoritative relation through the existing index before resolving', async () => {
    const h = await fixture();

    expect(h.index.get('Work Notes/A.md')?.relatedPaths).toEqual([]);
    expect(
      await h.service.addRelated(h.command('Work Notes/A.md', undefined, 'Work Notes/B.md')),
    ).toMatchObject({ type: 'ok' });
    expect(h.index.get('Work Notes/A.md')?.relatedPaths).toEqual(['Work Notes/B.md']);
    await flushMicrotasks();
  });
});
