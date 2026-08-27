import { describe, expect, it } from 'vitest';
import {
  acceptWorkNoteAudit,
  auditWorkNotes,
  computeWorkNotePresetFingerprint,
  isAuditAccepted,
  suggestWorkNotePreset,
  type WorkNoteAuditSource,
} from '../src/projects/work-notes/compatibility';
import type { WorkNoteCompatibilityPreset } from '../src/projects/work-notes/types';
import { PROJECTS_SCALE_FIXTURE } from './fixtures/projects-scale';

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

function preset(overrides: Partial<WorkNoteCompatibilityPreset> = {}): WorkNoteCompatibilityPreset {
  return {
    revision: 1,
    enabled: true,
    membershipQuery: '#work-note',
    ordinaryKindQuery: '#work-note/task',
    milestoneKindQuery: '#work-note/milestone',
    folder: 'Tasks',
    fields,
    rawStatusByStatusId: { active: 'Active', done: 'Done' },
    creation: {
      folder: 'Tasks',
      templatePath: 'Templates/Work note.md',
      defaultKind: 'ordinary',
      kindMarkers: {
        ordinary: { kind: 'frontmatter-tag', value: '#work-note/task' },
        milestone: { kind: 'frontmatter-tag', value: '#work-note/milestone' },
      },
      defaultStatusId: 'active',
    },
    ...overrides,
  };
}

function source(
  files: WorkNoteAuditSource['files'] extends () => infer T ? T : never,
  links: Readonly<Record<string, string | null>> = {},
  existing = new Set(['Templates/Work note.md']),
): WorkNoteAuditSource {
  return {
    files: () => files,
    resolveLink: (linkpath, fromPath) => links[`${fromPath}\0${linkpath}`] ?? null,
    fileExists: (path) => existing.has(path),
  };
}

describe('Work Note compatibility audit', () => {
  it('excludes a service note with project and status that fails membership query', () => {
    const fixture = source(
      [
        {
          path: 'Aggregates/Service.md',
          tags: [],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { 'Aggregates/Service.md\0Projects/A': 'Projects/A.md' },
    );

    expect(auditWorkNotes(fixture, preset()).eligiblePaths).not.toContain('Aggregates/Service.md');
  });

  it('audits update and create independently and rejects unsafe creation contracts', () => {
    const fixture = source(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { 'Tasks/A.md\0Projects/A': 'Projects/A.md' },
    );

    expect(auditWorkNotes(fixture, preset()).capabilities).toEqual({ update: true, create: true });
    expect(auditWorkNotes(fixture, preset({ creation: undefined })).capabilities).toEqual({
      update: true,
      create: false,
    });
    expect(
      auditWorkNotes(
        fixture,
        preset({ creation: { ...preset().creation!, defaultStatusId: 'missing' } }),
      ).capabilities,
    ).toEqual({ update: true, create: false });
    expect(
      auditWorkNotes(
        fixture,
        preset({
          creation: {
            ...preset().creation!,
            kindMarkers: {
              ...preset().creation!.kindMarkers,
              ordinary: { kind: 'property', property: 'Kind', value: 'ordinary' },
            },
          },
        }),
      ).capabilities,
    ).toEqual({ update: true, create: false });
    expect(
      auditWorkNotes(
        source(fixture.files(), { 'Tasks/A.md\0Projects/A': 'Projects/A.md' }, new Set()),
        preset(),
      ).capabilities,
    ).toEqual({ update: true, create: false });
  });

  it('does not claim update safety when a queried Work Note is structurally incompatible', () => {
    const fixture = source([
      {
        path: 'Tasks/Broken.md',
        tags: ['#work-note/task'],
        frontmatter: { Project: '[[Projects/Missing]]', Status: 'Active' },
      },
    ]);

    expect(auditWorkNotes(fixture, preset()).capabilities).toEqual({
      update: false,
      create: true,
    });
  });

  it('rejects a duplicate bare basename even when the metadata resolver selects one', () => {
    const fixture = source(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Project]]', Status: 'Active' },
        },
        { path: 'Projects/Project.md', tags: [], frontmatter: {} },
        { path: 'Archive/Project.md', tags: [], frontmatter: {} },
      ],
      { 'Tasks/A.md\0Project': 'Projects/Project.md' },
    );

    const audit = auditWorkNotes(fixture, preset());
    expect(audit.eligiblePaths).not.toContain('Tasks/A.md');
    expect(audit.diagnosticsByPath['Tasks/A.md']).toContainEqual(
      expect.objectContaining({ type: 'ambiguous-project' }),
    );
  });

  it('treats scalar unknown status as repairable and audits create independently', () => {
    const unknown = source(
      [
        {
          path: 'Tasks/Unknown.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Review' },
        },
      ],
      { 'Tasks/Unknown.md\0P': 'Projects/P.md' },
    );
    expect(auditWorkNotes(unknown, preset()).capabilities).toEqual({
      update: true,
      create: true,
    });

    const nonScalar = source(
      [
        {
          path: 'Tasks/List.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: ['Active'] },
        },
      ],
      { 'Tasks/List.md\0P': 'Projects/P.md' },
    );
    expect(auditWorkNotes(nonScalar, preset()).capabilities).toEqual({
      update: false,
      create: true,
    });
  });

  it('rejects creation outside the audited Work Note folder', () => {
    const creation = { ...preset().creation!, folder: 'Generated' };
    expect(auditWorkNotes(source([]), preset({ creation })).capabilities.create).toBe(false);
  });

  it('rejects empty and ambiguous reverse status mappings', () => {
    const fixture = source([]);
    expect(auditWorkNotes(fixture, preset({ rawStatusByStatusId: {} })).issues).toContainEqual(
      expect.objectContaining({ type: 'invalid-status-mapping' }),
    );
    expect(
      auditWorkNotes(fixture, preset({ rawStatusByStatusId: { active: '' } })).issues,
    ).toContainEqual(expect.objectContaining({ type: 'invalid-status-mapping' }));
    expect(
      auditWorkNotes(fixture, preset({ rawStatusByStatusId: { active: 'Same', done: 'Same' } }))
        .issues,
    ).toContainEqual(expect.objectContaining({ type: 'ambiguous-status-mapping' }));
  });

  it('fingerprints every audited setting and invalidates changed or disabled acceptance', () => {
    const accepted = acceptWorkNoteAudit(
      preset(),
      { update: true, create: true },
      '2026-08-26T00:00:00.000Z',
    );
    expect(isAuditAccepted(accepted)).toBe(true);

    const variants: WorkNoteCompatibilityPreset[] = [
      { ...accepted, enabled: false },
      { ...accepted, revision: accepted.revision + 1 },
      { ...accepted, membershipQuery: '#different' },
      { ...accepted, ordinaryKindQuery: '#ordinary' },
      { ...accepted, milestoneKindQuery: '#milestone' },
      { ...accepted, folder: 'Elsewhere' },
      { ...accepted, fields: { ...accepted.fields, status: 'State' } },
      { ...accepted, rawStatusByStatusId: { active: 'Open', done: 'Done' } },
      {
        ...accepted,
        creation: {
          ...accepted.creation!,
          kindMarkers: {
            ...accepted.creation!.kindMarkers,
            ordinary: { kind: 'frontmatter-tag', value: '#changed' },
          },
        },
      },
      { ...accepted, creation: { ...accepted.creation!, folder: 'Elsewhere' } },
      {
        ...accepted,
        creation: { ...accepted.creation!, templatePath: 'Templates/Different.md' },
      },
      { ...accepted, creation: { ...accepted.creation!, defaultKind: 'milestone' } },
      { ...accepted, creation: { ...accepted.creation!, defaultStatusId: 'done' } },
    ];
    for (const variant of variants) expect(isAuditAccepted(variant)).toBe(false);
    expect(computeWorkNotePresetFingerprint(accepted)).toBe(
      accepted.acceptedAudit?.presetFingerprint,
    );
  });

  it('does not accept a distinct preset that collides under the legacy 32-bit fingerprint', () => {
    const legacyCollisionShape: Partial<WorkNoteCompatibilityPreset> = {
      ordinaryKindQuery: '#ordinary',
      milestoneKindQuery: '#milestone',
      folder: 'Work Notes',
      rawStatusByStatusId: { active: 'Active' },
      creation: undefined,
    };
    const first = preset({ ...legacyCollisionShape, membershipQuery: '#17opwv0kycq4r' });
    const second = preset({ ...legacyCollisionShape, membershipQuery: '#jux0fg1j3i3tn' });
    const accepted = acceptWorkNoteAudit(
      first,
      { update: true, create: true },
      '2026-08-26T00:00:00.000Z',
    );

    expect(computeWorkNotePresetFingerprint(first)).not.toBe(
      computeWorkNotePresetFingerprint(second),
    );
    expect(computeWorkNotePresetFingerprint(first)).toMatch(/^work-note-preset:v2:/u);
    expect(isAuditAccepted({ ...second, acceptedAudit: accepted.acceptedAudit })).toBe(false);
  });

  it('scopes a named folder to descendants without admitting its sibling note', () => {
    const fixture = source(
      [
        {
          path: 'Work Notes.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
        {
          path: 'Work Notes/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
        {
          path: 'Root.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
      ],
      {
        'Work Notes.md\0P': 'Projects/P.md',
        'Work Notes/A.md\0P': 'Projects/P.md',
        'Root.md\0P': 'Projects/P.md',
      },
    );

    expect(
      auditWorkNotes(fixture, preset({ folder: 'Work Notes', creation: undefined })).eligiblePaths,
    ).toEqual(['Work Notes/A.md']);
    expect(
      auditWorkNotes(fixture, preset({ folder: '', creation: undefined })).eligiblePaths,
    ).toEqual(['Root.md', 'Work Notes.md', 'Work Notes/A.md']);
  });

  it('diagnoses multiple Milestone candidates while preserving the raw singular field', () => {
    const rawMilestones = ['[[Milestones/M1]]', '[[Milestones/M2]]'];
    const fixture = source(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: {
            Project: '[[P]]',
            Status: 'Active',
            Milestone: rawMilestones,
          },
        },
      ],
      {
        'Tasks/A.md\0P': 'Projects/P.md',
        'Tasks/A.md\0Milestones/M1': 'Milestones/M1.md',
        'Tasks/A.md\0Milestones/M2': 'Milestones/M2.md',
      },
    );

    const snapshot = auditWorkNotes(fixture, preset()).snapshots[0];
    expect(snapshot?.milestonePath).toBeUndefined();
    expect(snapshot?.diagnostics).toContainEqual(
      expect.objectContaining({
        type: 'multiple-milestones',
        field: 'milestone',
        rawValue: rawMilestones,
      }),
    );
  });

  it('rejects a structurally malformed persisted acceptance record', () => {
    const malformed = {
      ...preset(),
      acceptedAudit: {
        presetFingerprint: computeWorkNotePresetFingerprint(preset()),
        acceptedRevision: 1,
        acceptedAt: '2026-08-26T00:00:00.000Z',
      },
    } as WorkNoteCompatibilityPreset;

    expect(isAuditAccepted(malformed)).toBe(false);
  });

  it('suggests a disabled aggregate-only candidate from observed metadata', () => {
    const suggestion = suggestWorkNotePreset(
      source(
        [
          {
            path: 'Notes/A.md',
            tags: ['#work-note/task'],
            frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
          },
          {
            path: 'Notes/B.md',
            tags: ['#work-note/milestone'],
            frontmatter: { Project: '[[Projects/B]]', Status: 'Done' },
          },
        ],
        {
          'Notes/A.md\0Projects/A': 'Projects/A.md',
          'Notes/B.md\0Projects/B': 'Projects/B.md',
        },
      ),
    );

    expect(suggestion.preset.enabled).toBe(false);
    expect(suggestion.preset.membershipQuery).toBe('#work-note');
    expect(suggestion.preset.acceptedAudit).toBeUndefined();
    expect(suggestion.observations).toEqual(
      expect.objectContaining({ fileCount: 2, folderCounts: { Notes: 2 } }),
    );
    expect(JSON.stringify(suggestion)).not.toContain('/Users/');
    expect(suggestion).not.toHaveProperty('paths');
    expect(suggestion.preview).toMatchObject({ eligibleCount: 2, rejectedCandidateCount: 0 });
  });

  it('derives candidate field spelling from observed properties', () => {
    const suggestion = suggestWorkNotePreset(
      source([
        {
          path: 'Notes/A.md',
          tags: ['#work-note/task'],
          frontmatter: {
            project: '[[Projects/A]]',
            status: 'Active',
            blocked_by: ['[[Notes/B]]'],
          },
        },
      ]),
    );

    expect(suggestion.preset.fields).toMatchObject({
      project: 'project',
      status: 'status',
      blockedBy: 'blocked_by',
    });
  });

  it('infers a single-kind work-note cluster from structural fields instead of vault-wide noise', () => {
    const suggestion = suggestWorkNotePreset(
      source(
        [
          {
            path: 'Journal/Day 1.md',
            tags: ['#note/basic'],
            frontmatter: { Up: '[[Journal/Month]]' },
          },
          {
            path: 'Journal/Day 2.md',
            tags: ['#note/basic'],
            frontmatter: { Up: '[[Journal/Month]]' },
          },
          {
            path: 'Work/Action.md',
            tags: ['#mark/scene'],
            frontmatter: { Up: ['[[Projects/A]]'], Status: 'Idea' },
          },
          {
            path: 'Work/Review.md',
            tags: ['#mark/scene'],
            frontmatter: { Up: ['[[Projects/A]]'], Status: 'Review' },
          },
        ],
        {
          'Work/Action.md\0Projects/A': 'Projects/A.md',
          'Work/Review.md\0Projects/A': 'Projects/A.md',
        },
      ),
    );

    expect(suggestion.preset).toMatchObject({
      enabled: false,
      folder: 'Work',
      membershipQuery: '#mark/scene',
      ordinaryKindQuery: '#mark/scene',
      milestoneKindQuery: '',
      fields: { project: 'Up', status: 'Status' },
    });
    expect(suggestion.preview).toMatchObject({
      eligibleCount: 2,
      rejectedCandidateCount: 0,
    });
    expect(suggestion.preset.acceptedAudit).toBeUndefined();
  });

  it('ranks structural field pairs before vault-wide aliases and ranks candidate tags deterministically', () => {
    const suggestion = suggestWorkNotePreset(
      source(
        [
          {
            path: 'Reference/One.md',
            tags: ['#reference'],
            frontmatter: { Project: '[[Reference/Root]]' },
          },
          {
            path: 'Reference/Two.md',
            tags: ['#reference'],
            frontmatter: { Project: '[[Reference/Root]]' },
          },
          {
            path: 'Reference/Three.md',
            tags: ['#reference'],
            frontmatter: { Project: '[[Reference/Root]]', State: 'Filed' },
          },
          {
            path: 'Work/First.md',
            tags: ['#context/first', '#mark/scene'],
            frontmatter: { Up: ['[[Projects/A]]'], Status: 'Idea' },
          },
          {
            path: 'Work/Second.md',
            tags: ['#mark/scene', '#context/second'],
            frontmatter: { Up: ['[[Projects/A]]'], Status: 'Review' },
          },
        ],
        {
          'Work/First.md\0Projects/A': 'Projects/A.md',
          'Work/Second.md\0Projects/A': 'Projects/A.md',
        },
      ),
    );

    expect(suggestion.preset).toMatchObject({
      folder: 'Work',
      membershipQuery: '#mark/scene',
      ordinaryKindQuery: '#mark/scene',
      milestoneKindQuery: '',
      fields: { project: 'Up', status: 'Status' },
    });
    expect(suggestion.observations.tagCounts).toEqual({
      '#context/first': 1,
      '#mark/scene': 2,
      '#context/second': 1,
    });
    expect(suggestion.preview).toMatchObject({ eligibleCount: 2, rejectedCandidateCount: 0 });
  });
});

describe('frozen projects scale fixture', () => {
  it('contains exact-once expected Work Notes and Tasks at the required scale', () => {
    expect(PROJECTS_SCALE_FIXTURE.workNotes).toHaveLength(250);
    expect(
      PROJECTS_SCALE_FIXTURE.workNotes.filter((note) => note.kind === 'milestone'),
    ).toHaveLength(25);
    expect(PROJECTS_SCALE_FIXTURE.expectedTaskKeys).toHaveLength(1_000);
    expect(new Set(PROJECTS_SCALE_FIXTURE.expectedTaskKeys).size).toBe(1_000);
    expect(
      PROJECTS_SCALE_FIXTURE.workNotes.filter((note) => note.taskCount === 0).length,
    ).toBeGreaterThan(125);
    expect(PROJECTS_SCALE_FIXTURE.serviceFalsePositives.length).toBeGreaterThan(0);
    expect(PROJECTS_SCALE_FIXTURE.expectedWorkNotePaths).toEqual(
      PROJECTS_SCALE_FIXTURE.workNotes
        .filter(
          ({ anomaly }) => anomaly !== 'broken-project' && anomaly !== 'duplicate-project-basename',
        )
        .map(({ path }) => path),
    );
    expect(PROJECTS_SCALE_FIXTURE.workNotes[0]?.tasks).toHaveLength(20);
    expect(PROJECTS_SCALE_FIXTURE.workNotes[249]?.tasks).toEqual([]);
    expect(Object.isFrozen(PROJECTS_SCALE_FIXTURE)).toBe(true);
  });

  it('audits concrete scale records into separate exact-once eligible and excluded sets', () => {
    const files = [
      ...PROJECTS_SCALE_FIXTURE.workNotes,
      ...PROJECTS_SCALE_FIXTURE.serviceFalsePositives,
      ...PROJECTS_SCALE_FIXTURE.projectFiles,
    ];
    const paths = new Set(files.map(({ path }) => path));
    const fixture: WorkNoteAuditSource = {
      files: () => files,
      allPaths: () => [...paths],
      resolveLink: (linkpath) => {
        const exact = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
        return paths.has(exact) ? exact : null;
      },
      fileExists: (path) => paths.has(path),
    };

    const audit = auditWorkNotes(fixture, preset({ folder: 'Work Notes', creation: undefined }));

    expect(audit.eligiblePaths).toEqual(PROJECTS_SCALE_FIXTURE.expectedEligibleWorkNotePaths);
    expect(audit.eligiblePaths).toHaveLength(248);
    expect(PROJECTS_SCALE_FIXTURE.expectedExcludedWorkNotes).toEqual([
      { path: 'Work Notes/Work note 232.md', reason: 'broken-project' },
      { path: 'Work Notes/Work note 233.md', reason: 'duplicate-project-basename' },
    ]);
    expect(Object.values(PROJECTS_SCALE_FIXTURE.expectedEligibleCounts)).toEqual(
      Array.from({ length: 248 }, () => 1),
    );
  });
});
