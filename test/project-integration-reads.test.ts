import { expect, it } from 'vitest';
import { ProjectReadRegistry } from '../src/integrations/ProjectReadRegistry';
import { createProjectApiReads } from '../src/integrations/projectApiReads';
import {
  createProjectIntegrationReads,
  projectSemantics,
} from '../src/projects/projectIntegration';
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

it('uses configured definitions independently of view aliases and exposes scalar presets', async () => {
  const h = await publicApiHarness({ 'project.md': '---\nkind: project\n---\n' });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = {
      'property:Colors': {
        type: 'list',
        presets: [{ value: 'red', displayName: 'Red' }],
      },
    };
    Reflect.set(settings.propertyDefinitions['property:Colors'] ?? {}, 'presetsEnabled', false);
    settings.table.columns.push({ id: 'property:colors', visible: true });
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    expect(port.schema().fields).toContainEqual({
      id: 'property:Colors',
      label: 'Colors',
      kind: 'field',
      type: 'list',
      writable: true,
      suggestions: [{ value: 'red', displayName: 'Red' }],
    });
  } finally {
    h.dispose();
  }
});

it('reads curated offset timestamps but rejects offset custom datetimes', async () => {
  const h = await publicApiHarness({
    'project.md':
      '---\nkind: project\nstart: "2026-11-05T12:00:00Z"\nmeeting: "2026-11-05T12:00:00Z"\n---\n',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    settings.startProperty = 'start';
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = { 'property:meeting': { type: 'datetime' } };
    const read = createProjectIntegrationReads(h.index.projectSources(), () => settings).get(
      'project.md',
    );
    if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing project');
    expect(read.value.fields).toContainEqual({
      fieldId: 'start',
      state: 'value',
      value: '2026-11-05T12:00:00Z',
    });
    expect(read.value.fields).toContainEqual({ fieldId: 'property:meeting', state: 'unsupported' });
  } finally {
    h.dispose();
  }
});

it('does not change semantic identity for presentation-only preset settings', async () => {
  const h = await publicApiHarness({});
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = {
      'property:color': {
        type: 'text',
        presets: [{ value: 'red', displayName: 'Red', color: '#fff', display: 'badge' }],
      },
    };
    Reflect.set(settings.propertyDefinitions['property:color'] ?? {}, 'presetsEnabled', true);
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const before = port.semantics();
    settings.propertyDefinitions['property:color'] = {
      type: 'text',
      presets: [{ value: 'red', displayName: 'Red', color: '#000', display: 'dot' }],
    };
    Reflect.set(settings.propertyDefinitions['property:color'] ?? {}, 'presetsEnabled', false);
    expect(port.semantics()).toBe(before);
  } finally {
    h.dispose();
  }
});

it('detaches valid status choices from malformed persisted values and hides ambiguous choices', async () => {
  const h = await publicApiHarness({});
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    const invalidDisplay = { secret: 'private' };
    settings.statuses = [
      {
        id: 'good',
        name: 'Ready',
        displayName: invalidDisplay as unknown as string,
        onLeftPanel: true,
      },
      { id: 'dup', name: 'One', onLeftPanel: true },
      { id: 'dup', name: 'Two', onLeftPanel: true },
    ];
    settings.defaultStatusId = 'dup';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const api = createProjectApiReads(
      {
        reads: h.reads,
        observation: (o) => ({ ...o, providerEpoch: 'epoch' }),
        check: () => undefined,
        internal: () => {
          throw new Error('internal');
        },
      },
      port,
      new ProjectReadRegistry(port, { epoch: 'epoch', now: () => 1 }),
    ).api;
    const schema = await api.schema();
    expect(schema).toMatchObject({
      ok: true,
      value: { statuses: [{ id: 'good', name: 'Ready' }] },
    });
    if (!schema.ok) throw new Error('Missing schema');
    expect(schema.value.defaultStatusId).toBeUndefined();
    expect(Object.isFrozen(invalidDisplay)).toBe(false);
  } finally {
    h.dispose();
  }
});

it('uses project-property collation for ambiguous authored aliases', async () => {
  const h = await publicApiHarness({
    'project.md': '---\nkind: project\nfield: 1\nﬁeld: 2\n---\n',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = { 'property:field': { type: 'number' } };
    const read = createProjectIntegrationReads(h.index.projectSources(), () => settings).get(
      'project.md',
    );
    if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing project');
    expect(read.value.fields).toContainEqual({ fieldId: 'property:field', state: 'unsupported' });
  } finally {
    h.dispose();
  }
});

it('does not expose preset extensions attached to curated fields', async () => {
  const h = await publicApiHarness({});
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = {
      description: { type: 'text', presets: [{ value: 'secret' }] },
    };
    const schema = createProjectIntegrationReads(h.index.projectSources(), () => settings).schema();
    expect(schema.fields.find((field) => field.id === 'description')).toEqual({
      id: 'description',
      label: 'Description',
      kind: 'field',
      type: 'text',
      writable: true,
    });
  } finally {
    h.dispose();
  }
});

it('exposes a separately configured status property when the curated binding is Stage', async () => {
  const h = await publicApiHarness({});
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.statusProperty = 'Stage';
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = { 'property:status': { type: 'text' } };
    const fields = createProjectIntegrationReads(h.index.projectSources(), () => settings).schema()
      .fields;
    expect(fields).toContainEqual({
      id: 'property:status',
      label: 'status',
      kind: 'field',
      type: 'text',
      writable: true,
    });
    settings.statusProperty = 'status';
    expect(
      createProjectIntegrationReads(h.index.projectSources(), () => settings)
        .schema()
        .fields.some((field) => field.id === 'property:status' && field.writable),
    ).toBe(false);
  } finally {
    h.dispose();
  }
});

it('marks prototype-name curated bindings unavailable without exposing their values', async () => {
  const h = await publicApiHarness({
    'project.md': '---\nkind: project\nconstructor: secret\n---\n',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    settings.statusProperty = 'constructor';
    settings.statuses = [{ id: 'active', name: 'Active', onLeftPanel: true }];
    settings.defaultStatusId = 'active';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    expect(port.schema().defaultStatusId).toBeUndefined();
    expect(port.schema().fields).toContainEqual({
      id: 'status',
      label: 'Status',
      kind: 'unavailable',
      type: 'status',
      writable: false,
    });
    expect(port.get('project.md')).toMatchObject({
      type: 'ok',
      value: { status: { state: 'unsupported' } },
    });
  } finally {
    h.dispose();
  }
});

it('enumerates authoritative definitions once per project settings fingerprint', () => {
  const settings = structuredClone(DEFAULT_SETTINGS.projects);
  const fields = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`property:f${i}`, { type: 'text' as const }]),
  );
  let enumerations = 0;
  settings.propertyDefinitionsVersion = 1;
  settings.propertyDefinitions = new Proxy(fields, {
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  expect(projectSemantics(settings)).toContain('property:f31');
  expect(enumerations).toBe(1);
});

it('groups collated definition aliases before checking canonical prefixes and preserves authored field order', async () => {
  const h = await publicApiHarness({});
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.propertyDefinitionsVersion = 1;
    settings.propertyDefinitions = {
      'property:z': { type: 'number' },
      'property:field': { type: 'text' },
      'PROPERTY:ﬁeld': { type: 'text' },
      'property:féld': { type: 'text' },
      'property:a': { type: 'text' },
    };
    const reads = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    expect(
      reads
        .schema()
        .fields.filter((f) => f.id.startsWith('property:'))
        .map((f) => f.id),
    ).toEqual(['property:z', 'property:féld', 'property:a']);
    delete settings.propertyDefinitionsVersion;
    expect(reads.schema().fields.some((f) => f.id.startsWith('property:'))).toBe(false);
  } finally {
    h.dispose();
  }
});
