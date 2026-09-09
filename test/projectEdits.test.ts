import { getFrontMatterInfo, parseYaml, TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectNativePropertySnapshot,
  ProjectPropertyCatalog,
} from '../src/projects/ObsidianProjectProperties';
import { ProjectManager } from '../src/projects/ProjectManager';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import {
  normalizeProjectLinkInput,
  projectCellSourceValue,
  projectFieldWithOwnedClear,
  type ProjectCellChange,
} from '../src/projects/projectEdits';
import type { ProjectField, ProjectPropertyInfo } from '../src/projects/projectFields';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { createAppWithFiles, expectDefined, flushMicrotasks } from './helpers';

function cloneSettings(): CalendarSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CalendarSettings;
}

function catalog(properties: readonly ProjectPropertyInfo[] | null): ProjectPropertyCatalog {
  return {
    list: () => properties,
    inspect: (property) => {
      if (properties === null) return { kind: 'unavailable' };
      const matches = properties.filter(
        ({ name }) => name.localeCompare(property, undefined, { sensitivity: 'accent' }) === 0,
      );
      if (matches.length > 1) return { kind: 'unavailable' };
      return { kind: 'available', property: matches[0], assignment: { kind: 'none' } };
    },
    values: () => [],
    onChange: () => () => {},
  };
}

function inspectingCatalog(snapshot: () => ProjectNativePropertySnapshot): ProjectPropertyCatalog {
  return {
    list: () => {
      const current = snapshot();
      if (current.kind === 'unavailable') return null;
      return current.property === undefined ? [] : [current.property];
    },
    inspect: () => snapshot(),
    values: () => [],
    onChange: () => () => {},
  };
}

function manager(
  app: App,
  settings: CalendarSettings,
  properties: readonly ProjectPropertyInfo[] | null,
): ProjectManager {
  return new ProjectManager(app, settings, {} as never, {} as never, catalog(properties));
}

async function frontmatter(app: App, path: string): Promise<Record<string, unknown>> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`Missing ${path}`);
  const source = await app.vault.read(file);
  const info = getFrontMatterInfo(source);
  if (!info.exists) return {};
  return (parseYaml(info.frontmatter) ?? {}) as Record<string, unknown>;
}

const status: ProjectField = { id: 'status', property: 'status', label: 'Status', type: 'status' };
const start: ProjectField = { id: 'start', property: 'start', label: 'Start', type: 'date' };
const end: ProjectField = { id: 'end', property: 'end', label: 'End', type: 'date' };
const title: ProjectField = {
  id: 'property:Title',
  property: 'Title',
  label: 'Title',
  type: 'text',
};
const owners: ProjectField = {
  id: 'property:Owners',
  property: 'Owners',
  label: 'Owners',
  type: 'list',
};
const budget: ProjectField = {
  id: 'property:Budget',
  property: 'Budget',
  label: 'Budget',
  type: 'number',
};
const approved: ProjectField = {
  id: 'property:Approved',
  property: 'Approved',
  label: 'Approved',
  type: 'checkbox',
};

describe('project edit source values', () => {
  const project: Project = {
    path: 'A.md',
    name: 'A',
    frontmatter: { STATUS: 'active', Empty: '', Owners: ['Ada'], Approved: false },
    tags: [],
    statusId: 'status-id',
    rawStatus: null,
    stats: { total: 2, done: 1, cancelled: 0, inProgress: 0 },
  };

  it('reads the raw configured status value rather than its logical status id', () => {
    const settings = cloneSettings();
    expect(projectCellSourceValue(project, status, settings.projects)).toBe('active');
  });

  it('preserves absent, empty, list and checkbox source values', () => {
    const settings = cloneSettings();
    expect(projectCellSourceValue(project, title, settings.projects)).toBeUndefined();
    expect(
      projectCellSourceValue(
        project,
        { id: 'property:Empty', property: 'Empty', label: 'Empty', type: 'text' },
        settings.projects,
      ),
    ).toBe('');
    expect(projectCellSourceValue(project, owners, settings.projects)).toEqual(['Ada']);
    expect(projectCellSourceValue(project, approved, settings.projects)).toBe(false);
  });
});

describe('normalizeProjectLinkInput', () => {
  it('unwraps only one recognized wiki or Markdown link', () => {
    expect(normalizeProjectLinkInput('"[[People/Anna|Anna]]"')).toBe('[[People/Anna|Anna]]');
    expect(normalizeProjectLinkInput("'[[People/Anna]]'")).toBe('[[People/Anna]]');
    expect(normalizeProjectLinkInput("'[Anna](People/Anna.md)'")).toBe('[Anna](People/Anna.md)');
  });

  it('keeps ordinary quoted text and multiple links intact', () => {
    expect(normalizeProjectLinkInput('"quoted prose"')).toBe('"quoted prose"');
    expect(normalizeProjectLinkInput('"[[One]] [[Two]]"')).toBe('"[[One]] [[Two]]"');
  });
});

describe('ProjectManager.applyEdits', () => {
  it('broadcasts literal status names and replaces text and list values', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nstatus: active\nTitle: Old\nOwners:\n  - Ada\n---\n',
      'B.md': '---\nstatus: active\n---\n',
    });
    const settings = cloneSettings();
    const pm = manager(app, settings, [
      { name: 'status', type: 'text' },
      { name: 'Title', type: 'text' },
      { name: 'Owners', type: 'list' },
    ]);

    const result = await pm.applyEdits([
      { path: 'A.md', field: status, value: 'done', expectedValue: 'active' },
      { path: 'B.md', field: status, value: 'done', expectedValue: 'active' },
      { path: 'A.md', field: title, value: 'New', expectedValue: 'Old' },
      { path: 'A.md', field: owners, value: ['Ada', 'Ben'], expectedValue: ['Ada'] },
    ]);

    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(4);
    expect(await frontmatter(app, 'A.md')).toMatchObject({
      status: 'done',
      Title: 'New',
      Owners: ['Ada', 'Ben'],
    });
    expect((await frontmatter(app, 'B.md'))['status']).toBe('done');
  });

  it('writes number and checkbox values and clears an empty value', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nBudget: 10\nApproved: false\nTitle: old\n---\n',
    });
    const settings = cloneSettings();
    const pm = manager(app, settings, [
      { name: 'Budget', type: 'number' },
      { name: 'Approved', type: 'checkbox' },
      { name: 'Title', type: 'text' },
    ]);

    await pm.applyEdits([
      { path: 'A.md', field: budget, value: 20, expectedValue: 10 },
      { path: 'A.md', field: approved, value: true, expectedValue: false },
      { path: 'A.md', field: title, value: '', expectedValue: 'old' },
    ]);

    expect(await frontmatter(app, 'A.md')).toEqual({ Budget: 20, Approved: true });
  });

  it('normalizes one quoted link wrapper during an ordinary write', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nTitle: old\n---\n' });
    const pm = manager(app, cloneSettings(), [{ name: 'Title', type: 'text' }]);

    await pm.applyEdits([
      { path: 'A.md', field: title, value: '"[[People/Anna|Anna]]"', expectedValue: 'old' },
    ]);

    expect((await frontmatter(app, 'A.md'))['Title']).toBe('[[People/Anna|Anna]]');
  });

  it('validates the final paired date range instead of an intermediate half-update', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nstart: 2026-09-05\nend: 2026-09-10\n---\n',
    });
    const pm = manager(app, cloneSettings(), [
      { name: 'start', type: 'date' },
      { name: 'end', type: 'date' },
    ]);

    await expect(
      pm.applyEdits([
        { path: 'A.md', field: start, value: '2026-09-20', expectedValue: '2026-09-05' },
        { path: 'A.md', field: end, value: '2026-09-25', expectedValue: '2026-09-10' },
      ]),
    ).resolves.toMatchObject({ failed: [] });
    expect(await frontmatter(app, 'A.md')).toMatchObject({
      start: '2026-09-20',
      end: '2026-09-25',
    });
  });

  it('rejects an invalid final date range before writing either field', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nstart: 2026-09-05\nend: 2026-09-10\n---\n',
    });
    const pm = manager(app, cloneSettings(), [
      { name: 'start', type: 'date' },
      { name: 'end', type: 'date' },
    ]);

    await expect(
      pm.applyEdits([
        { path: 'A.md', field: start, value: '2026-09-30', expectedValue: '2026-09-05' },
        { path: 'A.md', field: end, value: '2026-09-25', expectedValue: '2026-09-10' },
      ]),
    ).rejects.toThrow(/Start date must be on or before end date/u);
    expect(await frontmatter(app, 'A.md')).toMatchObject({
      start: '2026-09-05',
      end: '2026-09-10',
    });
  });

  it('deduplicates repeated physical cells and rejects contradictory duplicates', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nBudget: 10\n---\n' });
    const pm = manager(app, cloneSettings(), [{ name: 'Budget', type: 'number' }]);
    const repeated: ProjectCellChange = {
      path: 'A.md',
      field: budget,
      value: 20,
      expectedValue: 10,
    };

    const result = await pm.applyEdits([repeated, { ...repeated }]);
    expect(result.applied).toHaveLength(1);

    await expect(
      pm.applyEdits([
        { ...repeated, expectedValue: 20, value: 30 },
        { ...repeated, expectedValue: 20, value: 40 },
      ]),
    ).rejects.toThrow(/contradictory edits/u);
    expect((await frontmatter(app, 'A.md'))['Budget']).toBe(20);
  });

  it('deduplicates case variants of the same physical source key', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nBUDGET: 10\n---\n' });
    const pm = manager(app, cloneSettings(), [{ name: 'Budget', type: 'number' }]);
    const lowerBudget: ProjectField = {
      id: 'property:budget',
      property: 'budget',
      label: 'Budget alias',
      type: 'number',
    };

    const result = await pm.applyEdits([
      { path: 'A.md', field: budget, value: 20, expectedValue: 10 },
      { path: 'A.md', field: lowerBudget, value: 20, expectedValue: 10 },
    ]);

    expect(result.applied).toHaveLength(1);
    expect(await frontmatter(app, 'A.md')).toEqual({ BUDGET: 20 });
  });

  it('rejects an empty physical property name before writing', async () => {
    const app = await createAppWithFiles({ 'A.md': '# A\n' });
    const emptyField: ProjectField = {
      id: 'property:   ',
      property: '   ',
      label: 'Empty',
      type: 'text',
    };
    const pm = manager(app, cloneSettings(), [{ name: '   ', type: 'text' }]);

    await expect(
      pm.applyEdits([{ path: 'A.md', field: emptyField, value: 'x', expectedValue: undefined }]),
    ).rejects.toThrow(/property name cannot be empty/u);
    expect(await frontmatter(app, 'A.md')).toEqual({});
  });

  it('rejects colliding curated source bindings even when the native catalog is empty', async () => {
    const app = await createAppWithFiles({ 'A.md': '# A\n' });
    const settings = cloneSettings();
    settings.projects.startProperty = 'When';
    settings.projects.endProperty = 'when';
    const collidingStart: ProjectField = {
      id: 'start',
      property: 'When',
      label: 'Start',
      type: 'date',
    };
    const pm = manager(app, settings, []);

    await expect(
      pm.applyEdits([
        {
          path: 'A.md',
          field: collidingStart,
          value: '2026-09-01',
          expectedValue: undefined,
        },
      ]),
    ).rejects.toThrow(/distinct project Status, Start, and End properties/u);
  });

  it('rejects ambiguous keys, stale fields, unknown types/statuses and readonly fields', async () => {
    const ambiguousApp = await createAppWithFiles({
      'A.md': '---\nBudget: 10\nBUDGET: 11\n---\n',
    });
    const ambiguous = manager(ambiguousApp, cloneSettings(), [{ name: 'Budget', type: 'number' }]);
    await expect(
      ambiguous.applyEdits([{ path: 'A.md', field: budget, value: 20, expectedValue: 10 }]),
    ).rejects.toThrow(/ambiguous Budget properties/u);

    const app = await createAppWithFiles({ 'A.md': '# A\n' });
    const settings = cloneSettings();
    const pm = manager(app, settings, [{ name: 'Budget', type: null }]);
    settings.projects.startProperty = 'Begins';
    await expect(
      pm.applyEdits([
        { path: 'A.md', field: start, value: '2026-09-01', expectedValue: undefined },
      ]),
    ).rejects.toThrow(/configured project property/u);
    await expect(
      pm.applyEdits([{ path: 'A.md', field: budget, value: 20, expectedValue: undefined }]),
    ).rejects.toThrow(/native type/u);
    await expect(
      pm.applyEdits([
        { path: 'A.md', field: status, value: 'status-done', expectedValue: undefined },
      ]),
    ).rejects.toThrow(/Unknown project status/u);
    for (const field of [
      { id: 'name', label: 'Name', type: 'name' },
      { id: 'progress', label: 'Progress', type: 'progress' },
    ] as ProjectField[]) {
      await expect(
        pm.applyEdits([{ path: 'A.md', field, value: 'x', expectedValue: undefined }]),
      ).rejects.toBeInstanceOf(ProjectEditValidationError);
    }
  });

  it('reports a real second-file I/O failure with only the first receipt applied', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nBudget: 10\n---\n',
      'B.md': '---\nBudget: 10\n---\n',
    });
    const pm = manager(app, cloneSettings(), [{ name: 'Budget', type: 'number' }]);
    const originalProcess = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
      if (file.path === 'B.md') throw new Error('disk full');
      return originalProcess(file, fn, options);
    });

    const result = await pm.applyEdits([
      { path: 'A.md', field: budget, value: 20, expectedValue: 10 },
      { path: 'B.md', field: budget, value: 20, expectedValue: 10 },
    ]);

    expect(result.applied.map(({ path }) => path)).toEqual(['A.md']);
    expect(result.failed).toEqual([{ path: 'B.md', message: 'disk full' }]);
    expect((await frontmatter(app, 'A.md'))['Budget']).toBe(20);
    expect((await frontmatter(app, 'B.md'))['Budget']).toBe(10);
  });

  it('rechecks native types for each file write and rejects unavailable catalogs on every edit path', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nBudget: 10\nstatus: active\n---\n' });
    const settings = cloneSettings();
    let currentType: ProjectPropertyInfo['type'] = 'number';
    const inspect = vi.fn<ProjectPropertyCatalog['inspect']>(() => ({
      kind: 'available',
      property: { name: 'Budget', type: currentType },
      assignment: { kind: 'none' },
    }));
    const changing = new ProjectManager(app, settings, {} as never, {} as never, {
      list: () => [{ name: 'Budget', type: currentType }],
      inspect,
      values: () => [],
      onChange: () => () => {},
    });
    const originalProcess = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
      currentType = 'text';
      return originalProcess(file, fn, options);
    });

    const changedType = await changing.applyEdits([
      { path: 'A.md', field: budget, value: 20, expectedValue: 10 },
    ]);
    expect(changedType.applied).toEqual([]);
    expect(changedType.failed).toHaveLength(1);
    expect(changedType.failed[0]?.path).toBe('A.md');
    expect(changedType.failed[0]?.message).toMatch(/native type changed/u);
    expect((await frontmatter(app, 'A.md'))['Budget']).toBe(10);
    expect(inspect).toHaveBeenCalledTimes(2);

    const unavailable = manager(app, settings, null);
    await expect(
      unavailable.applyEdits([{ path: 'A.md', field: budget, value: 20, expectedValue: 10 }]),
    ).rejects.toThrow(/temporarily unavailable/u);
    await expect(unavailable.setProperty('A.md', budget, 20, 10)).rejects.toThrow(
      /temporarily unavailable/u,
    );
    await expect(
      unavailable.setStatus('A.md', settings.projects.statuses[2]?.id ?? ''),
    ).rejects.toThrow(/temporarily unavailable/u);
  });

  it.each([
    { label: 'unavailable', properties: null, message: /temporarily unavailable/u },
    {
      label: 'incompatible',
      properties: [{ name: 'status', type: 'number' }] as const,
      message: /native type changed/u,
    },
  ])(
    'rejects a status rename when the native catalog is $label',
    async ({ properties, message }) => {
      const app = await createAppWithFiles({
        'Projects/A.md': '---\nstatus: active\n---\n',
      });
      const settings = cloneSettings();
      const active = expectDefined(settings.projects.statuses[0]);
      const pm = manager(app, settings, properties);

      await expect(
        pm.renameStatusDefinition(active.id, 'running', 'active', vi.fn()),
      ).rejects.toThrow(message);
      expect(active.name).toBe('active');
      expect((await frontmatter(app, 'Projects/A.md'))['status']).toBe('active');
    },
  );

  it('serializes batches from separate managers through the shared per-App coordinator', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nBudget: 10\n---\n',
      'B.md': '---\nBudget: 10\n---\n',
    });
    const settings = cloneSettings();
    const properties = catalog([{ name: 'Budget', type: 'number' }]);
    const firstManager = new ProjectManager(app, settings, {} as never, {} as never, properties);
    const secondManager = new ProjectManager(app, settings, {} as never, {} as never, properties);
    const originalProcess = app.vault.process.bind(app.vault);
    let processCalls = 0;
    let enteredFirst: () => void = () => {};
    let releaseFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
      processCalls += 1;
      if (processCalls === 1) {
        enteredFirst();
        await firstReleased;
      }
      return originalProcess(file, fn, options);
    });

    const first = firstManager.applyEdits([
      { path: 'A.md', field: budget, value: 20, expectedValue: 10 },
    ]);
    await firstEntered;
    const second = secondManager.applyEdits([
      { path: 'B.md', field: budget, value: 30, expectedValue: 10 },
    ]);
    await flushMicrotasks(1);
    expect(processCalls).toBe(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ failed: [] }),
      expect.objectContaining({ failed: [] }),
    ]);
    expect(processCalls).toBe(2);
  });

  it('undo refuses an external value conflict and a changed configured source', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nstart: 2026-09-05\n---\n' });
    const settings = cloneSettings();
    const pm = manager(app, settings, [{ name: 'start', type: 'date' }]);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    const result = await pm.applyEdits([
      { path: 'A.md', field: start, value: '2026-09-06', expectedValue: '2026-09-05' },
    ]);
    history.record(result);
    const file = expectDefined(app.vault.getAbstractFileByPath('A.md'));
    if (!(file instanceof TFile)) throw new Error('Missing A.md');
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm['start'] = '2026-09-07';
    });

    await expect(history.undo()).rejects.toThrow(/changed externally/u);
    expect(history.canUndo).toBe(true);

    const restored = await pm.applyEdits([
      { path: 'A.md', field: start, value: '2026-09-06', expectedValue: '2026-09-07' },
    ]);
    const sourceHistory = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    sourceHistory.record(restored);
    settings.projects.startProperty = 'Begins';
    await expect(sourceHistory.undo()).rejects.toThrow(/source property changed/u);
    expect((await frontmatter(app, 'A.md'))['start']).toBe('2026-09-06');
  });

  it('undo restores unknown statuses, explicit nulls and absent properties exactly', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nstatus: mystery\nTitle:\n---\n',
      'B.md': '# B\n',
    });
    const pm = manager(app, cloneSettings(), [
      { name: 'status', type: 'text' },
      { name: 'Title', type: 'text' },
    ]);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    history.record(
      await pm.applyEdits([
        { path: 'A.md', field: status, value: 'active', expectedValue: 'mystery' },
        { path: 'A.md', field: title, value: 'filled', expectedValue: null },
        { path: 'B.md', field: title, value: 'filled', expectedValue: undefined },
      ]),
    );

    await history.undo();

    const restoredA = await frontmatter(app, 'A.md');
    const restoredB = await frontmatter(app, 'B.md');
    expect(restoredA['status']).toBe('mystery');
    expect(Object.prototype.hasOwnProperty.call(restoredA, 'Title')).toBe(true);
    expect(restoredA['Title']).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(restoredB, 'Title')).toBe(false);
  });

  it('undo preserves an old quoted-link literal and rejects a changed exact source key', async () => {
    const app = await createAppWithFiles({
      'A.md': `---\nTITLE: '"[[People/Anna]]"'\n---\n`,
    });
    const pm = manager(app, cloneSettings(), [{ name: 'Title', type: 'text' }]);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    history.record(
      await pm.applyEdits([
        { path: 'A.md', field: title, value: 'new', expectedValue: '"[[People/Anna]]"' },
      ]),
    );

    await history.undo();
    expect((await frontmatter(app, 'A.md'))['TITLE']).toBe('"[[People/Anna]]"');

    history.record(
      await pm.applyEdits([
        { path: 'A.md', field: title, value: 'new', expectedValue: '"[[People/Anna]]"' },
      ]),
    );
    const file = expectDefined(app.vault.getAbstractFileByPath('A.md'));
    if (!(file instanceof TFile)) throw new Error('Missing A.md');
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm['title'] = fm['TITLE'];
      delete fm['TITLE'];
    });

    await expect(history.undo()).rejects.toThrow(/source key changed/u);
    expect((await frontmatter(app, 'A.md'))['title']).toBe('new');
  });

  it('undo and redo preserve an owned case-variant key after clearing it', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nTITLE: old\n---\n' });
    const pm = manager(app, cloneSettings(), [{ name: 'Title', type: 'text' }]);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    history.record(
      await pm.applyEdits([{ path: 'A.md', field: title, value: '', expectedValue: 'old' }]),
    );

    expect(await frontmatter(app, 'A.md')).toEqual({});
    await history.undo();
    expect(await frontmatter(app, 'A.md')).toEqual({ TITLE: 'old' });
    await history.redo();
    expect(await frontmatter(app, 'A.md')).toEqual({});
  });

  it.each([
    {
      label: 'text',
      field: title,
      source: '---\nTITLE: old\n---\n',
      sourceKey: 'TITLE',
      previous: 'old',
      type: 'text',
    },
    {
      label: 'number',
      field: budget,
      source: '---\nBudget: 10\n---\n',
      sourceKey: 'Budget',
      previous: 10,
      type: 'number',
    },
    {
      label: 'list',
      field: owners,
      source: '---\nOwners:\n  - Ada\n---\n',
      sourceKey: 'Owners',
      previous: ['Ada'],
      type: 'list',
    },
  ] as const)(
    'restores and re-clears a sole inferred $label property after native disappearance',
    async ({ field, source, sourceKey, previous, type }) => {
      const app = await createAppWithFiles({ 'A.md': source });
      let nativePresent = true;
      const native = inspectingCatalog(() => ({
        kind: 'available',
        property: nativePresent ? { name: field.property ?? '', type } : undefined,
        assignment: { kind: 'none' },
      }));
      const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);
      const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
      const clearResult = await pm.applyEdits([
        { path: 'A.md', field, value: '', expectedValue: previous },
      ]);
      history.record(clearResult);
      nativePresent = false;

      expect(history.ownedClear('A.md', field)).toMatchObject({
        path: 'A.md',
        sourceProperty: field.property,
        sourceKey,
        type,
        nativeSource: 'inferred',
      });
      await history.undo();
      expect((await frontmatter(app, 'A.md'))[sourceKey]).toEqual(previous);
      expect(history.ownedClear('A.md', field)).toBeUndefined();

      nativePresent = true;
      await history.redo();
      nativePresent = false;
      expect(await frontmatter(app, 'A.md')).toEqual({});
      expect(history.ownedClear('A.md', field)?.type).toBe(type);
    },
  );

  it('uses an owned clear context for ordinary validated refill and effective field projection', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nBudget: 10\n---\n' });
    const nativeState: { snapshot: ProjectNativePropertySnapshot } = {
      snapshot: {
        kind: 'available',
        property: { name: 'Budget', type: 'number' },
        assignment: { kind: 'none' },
      },
    };
    const setNativeSnapshot = (value: ProjectNativePropertySnapshot): void => {
      nativeState.snapshot = value;
    };
    const native = inspectingCatalog(() => nativeState.snapshot);
    const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    const clear = await pm.applyEdits([
      { path: 'A.md', field: budget, value: '', expectedValue: 10 },
    ]);
    history.record(clear);
    setNativeSnapshot({
      kind: 'available',
      property: undefined,
      assignment: { kind: 'none' },
    });
    const ownedClear = expectDefined(history.ownedClear('A.md', budget));
    const unavailableBudget = {
      id: budget.id,
      property: 'Budget',
      label: budget.label,
      type: null,
    } as const;
    const project: Project = {
      path: 'A.md',
      name: 'A',
      frontmatter: {},
      tags: [],
      statusId: null,
      rawStatus: null,
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
    };

    expect(
      projectFieldWithOwnedClear(project, unavailableBudget, nativeState.snapshot, ownedClear),
    ).toEqual(budget);
    expect(
      projectFieldWithOwnedClear(project, unavailableBudget, { kind: 'unavailable' }, ownedClear),
    ).toBe(unavailableBudget);
    expect(
      projectFieldWithOwnedClear(
        { ...project, path: 'B.md' },
        unavailableBudget,
        nativeState.snapshot,
        ownedClear,
      ),
    ).toBe(unavailableBudget);
    const refill = await pm.applyEdits([
      {
        path: 'A.md',
        field: budget,
        value: 20,
        expectedValue: undefined,
        expectedExists: false,
        ownedClear,
      },
    ]);
    history.record(refill);

    expect((await frontmatter(app, 'A.md'))['Budget']).toBe(20);
    expect(history.ownedClear('A.md', budget)).toBeUndefined();

    setNativeSnapshot({
      kind: 'available',
      property: { name: 'Budget', type: 'number' },
      assignment: { kind: 'none' },
    });
    await history.undo();
    setNativeSnapshot({
      kind: 'available',
      property: undefined,
      assignment: { kind: 'none' },
    });
    expect(await frontmatter(app, 'A.md')).toEqual({});
    expect(history.ownedClear('A.md', budget)?.type).toBe('number');

    await history.redo();
    expect((await frontmatter(app, 'A.md'))['Budget']).toBe(20);
    expect(history.ownedClear('A.md', budget)).toBeUndefined();
  });

  it('keeps provenance when Undo removes the final inferred occurrence', async () => {
    const app = await createAppWithFiles({
      'A.md': '# A\n',
      'B.md': '---\nOwners:\n  - Bea\n---\n',
    });
    let nativePresent = true;
    const native = inspectingCatalog(() => ({
      kind: 'available',
      property: nativePresent ? { name: 'Owners', type: 'list' } : undefined,
      assignment: { kind: 'none' },
    }));
    const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    history.record(
      await pm.applyEdits([
        { path: 'A.md', field: owners, value: ['Ada'], expectedValue: undefined },
      ]),
    );
    const other = expectDefined(app.vault.getAbstractFileByPath('B.md'));
    if (!(other instanceof TFile)) throw new Error('Missing B.md');
    await app.fileManager.processFrontMatter(other, (frontmatter: Record<string, unknown>) => {
      delete frontmatter['Owners'];
    });

    await history.undo();
    nativePresent = false;
    expect(history.ownedClear('A.md', owners)?.type).toBe('list');

    await history.redo();
    expect((await frontmatter(app, 'A.md'))['Owners']).toEqual(['Ada']);
    expect(history.ownedClear('A.md', owners)).toBeUndefined();
  });

  it.each([
    {
      label: 'same supported assignment',
      assignment: { kind: 'assigned', nativeType: 'number', type: 'number' },
      succeeds: true,
    },
    {
      label: 'incompatible assignment',
      assignment: { kind: 'assigned', nativeType: 'text', type: 'text' },
      succeeds: false,
    },
    {
      label: 'unsupported assignment',
      assignment: { kind: 'assigned', nativeType: 'formula', type: null },
      succeeds: false,
    },
  ] as const)(
    'treats an absent custom property with $label as authoritative',
    async ({ assignment, succeeds }) => {
      const app = await createAppWithFiles({ 'A.md': '# A\n' });
      const native = inspectingCatalog(() => ({
        kind: 'available',
        property: undefined,
        assignment,
      }));
      const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);
      const edit = pm.applyEdits([
        { path: 'A.md', field: budget, value: 20, expectedValue: undefined },
      ]);

      if (succeeds) await expect(edit).resolves.toMatchObject({ failed: [] });
      else await expect(edit).rejects.toThrow(/native type/u);
    },
  );

  it('does not treat pasted receipt-shaped JSON as an owned clear capability', async () => {
    const app = await createAppWithFiles({ 'A.md': '# A\n' });
    const native = inspectingCatalog(() => ({
      kind: 'available',
      property: undefined,
      assignment: { kind: 'none' },
    }));
    const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);

    await expect(
      pm.applyEdits([
        {
          path: 'A.md',
          field: budget,
          value: 20,
          expectedValue: undefined,
          expectedExists: false,
          ownedClear: {
            path: 'A.md',
            fieldId: budget.id,
            sourceProperty: 'Budget',
            sourceKey: 'Budget',
            type: 'number',
            nativeSource: 'inferred',
          } as never,
        },
      ]),
    ).rejects.toThrow(/known native type/u);
  });

  it('rejects unavailable or changed native provenance instead of trusting an owned clear', async () => {
    const app = await createAppWithFiles({ 'A.md': '---\nBUDGET: 10\n---\n' });
    let snapshot: ProjectNativePropertySnapshot = {
      kind: 'available',
      property: { name: 'Budget', type: 'number' },
      assignment: { kind: 'none' },
    };
    const native = inspectingCatalog(() => snapshot);
    const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    const clear = await pm.applyEdits([
      { path: 'A.md', field: budget, value: '', expectedValue: 10 },
    ]);
    history.record(clear);

    snapshot = { kind: 'unavailable' };
    await expect(history.undo()).rejects.toThrow(/temporarily unavailable/u);
    snapshot = {
      kind: 'available',
      property: { name: 'Budget', type: 'text' },
      assignment: { kind: 'none' },
    };
    await expect(history.undo()).rejects.toThrow(/native type/u);

    snapshot = { kind: 'available', property: undefined, assignment: { kind: 'none' } };
    const file = expectDefined(app.vault.getAbstractFileByPath('A.md'));
    if (!(file instanceof TFile)) throw new Error('Missing A.md');
    await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter['budget'] = 11;
    });
    await expect(history.undo()).rejects.toThrow(/source key changed/u);
  });

  it('mints owned clear contexts only for files whose clear committed', async () => {
    const app = await createAppWithFiles({
      'A.md': '---\nBudget: 10\n---\n',
      'B.md': '---\nBudget: 20\n---\n',
    });
    const native = inspectingCatalog(() => ({
      kind: 'available',
      property: { name: 'Budget', type: 'number' },
      assignment: { kind: 'none' },
    }));
    const pm = new ProjectManager(app, cloneSettings(), {} as never, {} as never, native);
    const originalProcess = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, fn, options) => {
      if (file.path === 'B.md') throw new Error('disk full');
      return originalProcess(file, fn, options);
    });
    const result = await pm.applyEdits([
      { path: 'A.md', field: budget, value: '', expectedValue: 10 },
      { path: 'B.md', field: budget, value: '', expectedValue: 20 },
    ]);
    const history = new ProjectEditHistory((changes) => pm.applyEdits(changes));
    history.record(result);

    expect(history.ownedClear('A.md', budget)?.type).toBe('number');
    expect(history.ownedClear('B.md', budget)).toBeUndefined();
  });
});
