import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ProjectManager } from '../src/projects/ProjectManager';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import type { ProjectField } from '../src/projects/projectFields';
import { DailyNoteResolver } from '../src/resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import type { TaskApplicationApi, TaskCommandResult } from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import {
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  methodOf,
  useRealMoment,
} from './helpers';

useRealMoment();

function clone(): CalendarSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CalendarSettings;
}

async function readFm(app: unknown, path: string): Promise<Record<string, unknown>> {
  const a = app as {
    vault: { getAbstractFileByPath(p: string): unknown; read(f: TFile): Promise<string> };
  };
  const file = a.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`${path} is not a TFile`);
  const content = await a.vault.read(file);
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  const fm: Record<string, unknown> = {};
  if (m != null) {
    for (const line of expectDefined(m[1]).split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fm;
}

describe('ProjectManager.setStatus', () => {
  it('rejects missing project files and unknown statuses', async () => {
    const app = await createAppWithFiles({ 'P.md': '# Project\n' });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);

    await expect(pm.setStatus('Missing.md', 'status-1')).rejects.toThrow(/Project file not found/u);
    await expect(pm.setStatus('P.md', 'missing-status')).rejects.toThrow(/Unknown project status/u);
  });

  it('writes the target property status and clears sibling property markers', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\nstatus: active\nother: keep\n---\n\n- [ ] a task\n',
    });
    const settings = clone();
    const doneId = expectDefined(settings.projects.statuses[2]).id; // Done → status=done
    const pm = new ProjectManager(app, settings, {} as never, {} as never);
    await pm.setStatus('P.md', doneId);
    await flushMicrotasks();
    const fm = await readFm(app, 'P.md');
    expect(fm['status']).toBe('done');
    expect(fm['other']).toBe('keep');
  });

  it('strips an inline body status tag so status resolution does not stick', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\ntags:\n  - keepme\n---\n\nProject notes #todo here.\n',
    });
    const settings = clone();
    settings.projects.statuses = [
      { id: 'todo', label: 'Todo', onLeftPanel: true, match: { kind: 'tag', tag: 'todo' } },
      { id: 'done', label: 'Done', onLeftPanel: false, match: { kind: 'tag', tag: 'done' } },
    ];
    const pm = new ProjectManager(app, settings, {} as never, {} as never);
    await pm.setStatus('P.md', 'done');
    await flushMicrotasks();
    const file = (
      app as never as { vault: { getAbstractFileByPath(p: string): TFile } }
    ).vault.getAbstractFileByPath('P.md');
    const content = await (
      app as never as { vault: { read(f: TFile): Promise<string> } }
    ).vault.read(file);
    // The inline task tag is removed from the body; #done is applied via frontmatter.
    expect(content).not.toMatch(/#todo\b/);
    expect(content).toContain('keepme');
    expect(content).toMatch(/done/);
    expect(content).toContain('Project notes  here.');
  });

  it('adds a tag marker and strips sibling tag markers for tag-kind statuses', async () => {
    const app = await createAppWithFiles({ 'P.md': '---\ntags:\n  - todo\n  - keepme\n---\n' });
    const settings = clone();
    settings.projects.statuses = [
      { id: 'todo', label: 'Todo', onLeftPanel: true, match: { kind: 'tag', tag: 'todo' } },
      { id: 'wip', label: 'WIP', onLeftPanel: true, match: { kind: 'tag', tag: 'wip' } },
    ];
    const pm = new ProjectManager(app, settings, {} as never, {} as never);
    await pm.setStatus('P.md', 'wip');
    await flushMicrotasks();
    const file = (
      app as never as { vault: { getAbstractFileByPath(p: string): TFile } }
    ).vault.getAbstractFileByPath('P.md');
    const content = await (
      app as never as { vault: { read(f: TFile): Promise<string> } }
    ).vault.read(file);
    expect(content).toContain('wip');
    expect(content).toContain('keepme');
    expect(content).not.toMatch(/- todo\b/);
  });
});

describe('ProjectManager.setProperty', () => {
  const budget: ProjectField = {
    id: 'property:Budget',
    property: 'Budget',
    label: 'Budget',
    type: 'number',
  };

  it('writes through the current case-insensitive property key and preserves unrelated fields', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\nBUDGET: 12\nother: keep\n---\n',
    });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);

    await pm.setProperty('P.md', budget, 20, 12);
    await flushMicrotasks();

    const fm = await readFm(app, 'P.md');
    expect(fm['BUDGET']).toBe('20');
    expect(fm['Budget']).toBeUndefined();
    expect(fm['other']).toBe('keep');
  });

  it('removes only the edited property when clearing it', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\nBudget: 12\nother: keep\n---\n',
    });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);

    await pm.setProperty('P.md', budget, null, 12);
    await flushMicrotasks();

    const fm = await readFm(app, 'P.md');
    expect(fm['Budget']).toBeUndefined();
    expect(fm['other']).toBe('keep');
  });

  it('rejects a stale expected value without overwriting the external edit', async () => {
    const app = await createAppWithFiles({ 'P.md': '---\nBudget: 30\n---\n' });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);

    await expect(pm.setProperty('P.md', budget, 20, 12)).rejects.toThrow(/changed externally/u);

    const fm = await readFm(app, 'P.md');
    expect(fm['Budget']).toBe('30');
  });

  it('checks a start update against the latest end value', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\nstart: 2026-09-01\nend: 2026-09-20\n---\n',
    });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);
    const start: ProjectField = {
      id: 'start',
      property: 'start',
      label: 'Start',
      type: 'date',
    };

    await expect(pm.setProperty('P.md', start, '2026-09-25', '2026-09-01')).rejects.toThrow(
      /Start date must be on or before end date/u,
    );
  });

  it('checks an end update against the latest start value', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\nstart: 2026-09-10\nend: 2026-09-20\n---\n',
    });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);
    const end: ProjectField = {
      id: 'end',
      property: 'end',
      label: 'End',
      type: 'date',
    };

    const write = pm.setProperty('P.md', end, '2026-09-05', '2026-09-20');

    await expect(write).rejects.toThrow(/End date must be on or after start date/u);
    await expect(write).rejects.toBeInstanceOf(ProjectEditValidationError);
    expect((await readFm(app, 'P.md'))['end']).toBe('2026-09-20');
  });

  it('rejects invalid values, missing files and generic writes to semantic properties', async () => {
    const app = await createAppWithFiles({ 'P.md': '---\nstatus: active\n---\n' });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);
    const statusAlias: ProjectField = {
      id: 'property:STATUS',
      property: 'STATUS',
      label: 'Status raw',
      type: 'text',
    };

    await expect(pm.setProperty('P.md', budget, Number.NaN, undefined)).rejects.toThrow(
      /finite number/u,
    );
    await expect(pm.setProperty('Missing.md', budget, 1, undefined)).rejects.toThrow(
      /Project file not found/u,
    );
    await expect(pm.setProperty('P.md', statusAlias, 'done', 'active')).rejects.toThrow(
      /semantic project property/u,
    );
  });

  it.each([
    [{ id: 'property:Text', property: 'Text', label: 'Text', type: 'text' }, 4, /string/u],
    [
      { id: 'property:List', property: 'List', label: 'List', type: 'list' },
      ['ok', false],
      /text or numbers/u,
    ],
    [{ id: 'property:Flag', property: 'Flag', label: 'Flag', type: 'checkbox' }, 'yes', /boolean/u],
    [{ id: 'property:Date', property: 'Date', label: 'Date', type: 'date' }, '2026-02-30', /date/u],
    [
      { id: 'property:When', property: 'When', label: 'When', type: 'datetime' },
      '2026-09-01',
      /date and time/u,
    ],
    [{ id: 'property:Tags', property: 'Tags', label: 'Tags', type: 'tags' }, '#one', /strings/u],
  ] as const)('validates %s values before writing', async (field, value, message) => {
    const app = await createAppWithFiles({ 'P.md': '# Project\n' });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);

    await expect(pm.setProperty('P.md', field, value, undefined)).rejects.toThrow(message);
  });

  it('preserves supported numeric and text list scalars without coercion', async () => {
    const app = await createAppWithFiles({ 'P.md': '# Project\n' });
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);
    const field: ProjectField = {
      id: 'property:Links',
      property: 'Links',
      label: 'Links',
      type: 'list',
    };

    await pm.setProperty('P.md', field, [7, '[[Related note]]'], undefined);

    const file = (
      app as never as { vault: { getAbstractFileByPath(p: string): TFile } }
    ).vault.getAbstractFileByPath('P.md');
    const cache = (
      app as never as {
        metadataCache: { getFileCache(f: TFile): { frontmatter?: Record<string, unknown> } | null };
      }
    ).metadataCache.getFileCache(file);
    expect(cache?.frontmatter?.['Links']).toEqual([7, '[[Related note]]']);
  });
});

function taskApi(
  result: TaskCommandResult,
): TaskApplicationApi & { execute: ReturnType<typeof vi.fn> } {
  return {
    queries: {} as never,
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe('ProjectManager.moveTaskToProject', () => {
  const ref: TaskRef = { filePath: 'Daily/2026-07-01.md', line: 0, revision: 'revision' };
  const ok: TaskCommandResult = {
    type: 'ok',
    changed: true,
    outcome: { type: 'task', task: {} as never },
  };

  it('delegates append-mode relocation to the shared semantic API', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    settings.projects.taskInsertionMode = 'append';
    const tasks = taskApi(ok);
    const pm = new ProjectManager(app, settings, {} as never, tasks);

    const result = await pm.moveTaskToProject(ref, 'Projects/Redesign.md');

    expect(result).toBe(ok);
    expect(methodOf(tasks, 'execute')).toHaveBeenCalledOnce();
    expect(methodOf(tasks, 'execute')).toHaveBeenCalledWith({
      type: 'move',
      ref,
      destination: { filePath: 'Projects/Redesign.md', insertion: { type: 'append' } },
    });
  });

  it('translates the section insertion setting without writing Markdown itself', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    settings.projects.taskInsertionMode = 'section';
    settings.projects.taskInsertionSection = '## Tasks';
    const tasks = taskApi(ok);
    const pm = new ProjectManager(app, settings, {} as never, tasks);

    await pm.moveTaskToProject(ref, 'Projects/P.md');

    expect(methodOf(tasks, 'execute')).toHaveBeenCalledWith({
      type: 'move',
      ref,
      destination: {
        filePath: 'Projects/P.md',
        insertion: { type: 'section', heading: '## Tasks' },
      },
    });
  });

  it('returns partial unchanged so presentation can offer recovery without retrying', async () => {
    const app = await createAppWithFiles({});
    const partial: TaskCommandResult = {
      type: 'partial',
      operation: 'move',
      recovery: {
        source: ref,
        targetPath: 'Projects/P.md',
        copiedTask: {} as never,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    };
    const tasks = taskApi(partial);
    const pm = new ProjectManager(app, clone(), {} as never, tasks);

    const result = await pm.moveTaskToProject(ref, 'Projects/P.md');

    expect(result).toBe(partial);
    expect(methodOf(tasks, 'execute')).toHaveBeenCalledOnce();
  });
});

describe('ProjectManager.create', () => {
  it('builds a path under createFolder, applies default status, opens the note', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    const resolver = new DailyNoteResolver(app, settings);
    const pm = new ProjectManager(app, settings, resolver, {} as never);
    const file = await pm.create('My Project');
    await flushMicrotasks();
    expect(file).not.toBeNull();
    expect(expectDefined(file).path).toBe('Projects/My Project.md');
    const fm = await readFm(app, 'Projects/My Project.md');
    expect(fm['status']).toBe('active');
  });

  it('dedupes the path when a note already exists', async () => {
    const app = await createAppWithFiles({ 'Projects/Dup.md': '# existing\n' });
    const settings = clone();
    const resolver = new DailyNoteResolver(app, settings);
    const pm = new ProjectManager(app, settings, resolver, {} as never);
    const file = await pm.create('Dup');
    expect(expectDefined(file).path).toBe('Projects/Dup 2.md');
  });

  it('returns null for an empty name', async () => {
    const app = await createAppWithFiles({});
    const pm = new ProjectManager(app, clone(), {} as never, {} as never);
    expect(await pm.create('   ')).toBeNull();
  });
});
