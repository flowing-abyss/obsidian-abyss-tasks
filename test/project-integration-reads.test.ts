import { expect, it } from 'vitest';
import { createProjectIntegrationReads } from '../src/projects/projectIntegration';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { publicApiHarness } from './support/publicApiHarness';

it('projects accepted notes with physical root statistics and typed configured fields', async () => {
  const h = await publicApiHarness({
    'one/Same.md': '---\nkind: project\nstatus: Active\nscore: 0\n---\n- [ ] Root\n  - [x] Child\n',
    'two/Same.md': '---\nkind: project\nscore: false\n---\n',
    'ordinary.md': 'ordinary',
    'tagged.md': '---\nkind: project\n---\n#Mixed #mixed',
  });
  try {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.membershipQuery = 'kind=project';
    projects.statusProperty = 'status';
    projects.statuses = [{ id: 'active', name: 'Active', onLeftPanel: true }];
    projects.propertyDefinitionsVersion = 1;
    projects.propertyDefinitions = { 'property:score': { type: 'number' } };
    const reads = createProjectIntegrationReads(h.index.projectSources(), () => projects);
    const one = reads.get('one/Same.md');
    expect(one).toMatchObject({
      type: 'ok',
      value: {
        name: 'Same',
        status: { state: 'configured', id: 'active' },
        stats: { total: 1, done: 0 },
        fields: expect.arrayContaining([
          { fieldId: 'property:score', state: 'value', value: 0 },
        ]) as unknown,
      },
    });
    expect(reads.get('two/Same.md')).toMatchObject({
      type: 'ok',
      value: {
        fields: expect.arrayContaining([
          { fieldId: 'property:score', state: 'unsupported' },
        ]) as unknown,
      },
    });
    expect(reads.get('tagged.md')).toMatchObject({ type: 'ok', value: { tags: ['#mixed'] } });
    expect(reads.get('ordinary.md')).toMatchObject({ type: 'ok', value: undefined });
  } finally {
    h.dispose();
  }
});

it('guards the current incarnation, semantics and candidate membership before a writer commits', async () => {
  const h = await publicApiHarness({ 'project.md': '---\nkind: project\n---\n' });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const reads = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const read = reads.get('project.md');
    if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing project');
    expect(
      reads.guard(read.value, '---\nkind: project\n---\n', '---\nkind: ordinary\n---\n'),
    ).toMatchObject({ type: 'error' });
    expect(
      reads.guard(read.value, '---\nkind: project\n---\n', '---\nkind: project\n---\n'),
    ).toMatchObject({ type: 'ok' });
    expect(reads.guard(read.value, 'unobserved bytes', '---\nkind: project\n---\n')).toMatchObject({
      type: 'error',
    });
    settings.membershipQuery = 'kind=other';
    expect(
      reads.guard(read.value, '---\nkind: project\n---\n', '---\nkind: project\n---\n'),
    ).toMatchObject({ type: 'error' });
  } finally {
    h.dispose();
  }
});

it('invalidates semantic guards on relevant settings changes, but not presentation-only changes', async () => {
  const h = await publicApiHarness({ 'project.md': '---\nkind: project\n---\n' });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const reads = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const before = reads.semantics();
    settings.table.showDescription = !settings.table.showDescription;
    expect(reads.semantics()).toBe(before);
    settings.taskInsertionSection = 'Next';
    expect(reads.semantics()).not.toBe(before);
  } finally {
    h.dispose();
  }
});

it('fails closed on ambiguous authored and configured property aliases and structured statuses', async () => {
  const h = await publicApiHarness({
    'project.md': '---\nkind: project\nstatus: [Active]\nscore: 0\nScore: 1\n---\n',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    settings.statusProperty = 'status';
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = { 'property:score': { type: 'number' } };
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const read = port.get('project.md');
    expect(read).toMatchObject({ type: 'ok', value: { status: { state: 'unsupported' } } });
    if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing project');
    expect(read.value.fields).toContainEqual({ fieldId: 'property:score', state: 'unsupported' });
    settings.propertyDefinitionsVersion = 999;
    expect(port.schema().fields.some((field) => field.id === 'property:score')).toBe(false);
  } finally {
    h.dispose();
  }
});

it('does not expose a rebound status or reserved custom property as writable', async () => {
  const h = await publicApiHarness({ 'project.md': '---\nkind: project\nstatus: Active\n---\n' });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    settings.statusProperty = 'status';
    settings.startProperty = 'status';
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = { 'property:constructor': { type: 'text' } };
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    expect(port.get('project.md')).toMatchObject({
      type: 'ok',
      value: { status: { state: 'unsupported' } },
    });
    expect(port.schema().fields.some((field) => field.id === 'property:constructor')).toBe(false);
  } finally {
    h.dispose();
  }
});
