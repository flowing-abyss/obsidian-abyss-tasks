import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectCommandService } from '../src/projects/ProjectCommandService';
import { ProjectManager } from '../src/projects/ProjectManager';
import { DailyNoteResolver } from '../src/resolvers/DailyNoteResolver';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import type { TaskApplicationApi, TaskCommandResult } from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import { createAppWithFiles, flushMicrotasks, useRealMoment } from './helpers';

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
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fm;
}

describe('ProjectManager.setStatus', () => {
  it('writes the target property status and clears sibling property markers', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\nstatus: active\nother: keep\n---\n\n- [ ] a task\n',
    });
    const settings = clone();
    const doneId = settings.projects.statuses[2]!.id; // Done → status=done
    const pm = new ProjectManager(app as never, settings, {} as never, {} as never);
    await pm.setStatus('P.md', doneId);
    await flushMicrotasks();
    const fm = await readFm(app, 'P.md');
    expect(fm['status']).toBe('done');
    expect(fm['other']).toBe('keep');
  });

  it('preserves an inline body task tag while changing canonical frontmatter status', async () => {
    const app = await createAppWithFiles({
      'P.md': '---\ntags:\n  - todo\n  - keepme\n---\n\n- [ ] Keep #todo in task text\n',
    });
    const settings = clone();
    settings.projects.statuses = [
      {
        id: 'todo',
        label: 'Todo',
        behavior: 'regular',
        onLeftPanel: true,
        match: { kind: 'tag', tag: 'todo' },
      },
      {
        id: 'done',
        label: 'Done',
        behavior: 'completed',
        onLeftPanel: false,
        match: { kind: 'tag', tag: 'done' },
      },
    ];
    const pm = new ProjectManager(app as never, settings, {} as never, {} as never);
    await pm.setStatus('P.md', 'done');
    await flushMicrotasks();
    const file = (
      app as never as { vault: { getAbstractFileByPath(p: string): TFile } }
    ).vault.getAbstractFileByPath('P.md');
    const content = await (
      app as never as { vault: { read(f: TFile): Promise<string> } }
    ).vault.read(file);
    // Body task text is legacy read-only input; only canonical frontmatter tags are owned.
    expect(content).toContain('- [ ] Keep #todo in task text');
    expect(content).toContain('keepme');
    expect(content).toMatch(/done/);
  });

  it('observes the owned frontmatter field and delegates status writes', async () => {
    const app = await createAppWithFiles({ 'P.md': '---\nstatus: active\n---\n' });
    const settings = clone();
    const result = {
      type: 'ok' as const,
      previousStatusId: settings.projects.statuses[0]!.id,
      nextStatusId: settings.projects.statuses[2]!.id,
    };
    const commands = {
      setStatus: vi.fn().mockResolvedValue(result),
      undoStatus: vi.fn(),
    } as unknown as ProjectCommandService;
    const pm = new ProjectManager(app as never, settings, {} as never, {} as never, commands);

    expect(await pm.setStatus('P.md', settings.projects.statuses[2]!.id)).toBe(result);
    expect(commands.setStatus).toHaveBeenCalledWith(
      {
        path: 'P.md',
        statusId: settings.projects.statuses[0]!.id,
        rawStatus: null,
        ownedField: { kind: 'property', property: 'status', rawValue: 'active' },
      },
      settings.projects.statuses[2]!.id,
    );
  });

  it('adds a tag marker and strips sibling tag markers for tag-kind statuses', async () => {
    const app = await createAppWithFiles({ 'P.md': '---\ntags:\n  - todo\n  - keepme\n---\n' });
    const settings = clone();
    settings.projects.statuses = [
      {
        id: 'todo',
        label: 'Todo',
        behavior: 'regular',
        onLeftPanel: true,
        match: { kind: 'tag', tag: 'todo' },
      },
      {
        id: 'wip',
        label: 'WIP',
        behavior: 'regular',
        onLeftPanel: true,
        match: { kind: 'tag', tag: 'wip' },
      },
    ];
    const pm = new ProjectManager(app as never, settings, {} as never, {} as never);
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

function taskApi(
  result: TaskCommandResult,
): TaskApplicationApi & { execute: ReturnType<typeof vi.fn> } {
  return {
    queries: {} as never,
    execute: vi.fn().mockResolvedValue(result),
  } as never;
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
    const pm = new ProjectManager(app as never, settings, {} as never, tasks);

    const result = await pm.moveTaskToProject(ref, 'Projects/Redesign.md');

    expect(result).toBe(ok);
    expect(tasks.execute).toHaveBeenCalledOnce();
    expect(tasks.execute).toHaveBeenCalledWith({
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
    const pm = new ProjectManager(app as never, settings, {} as never, tasks);

    await pm.moveTaskToProject(ref, 'Projects/P.md');

    expect(tasks.execute).toHaveBeenCalledWith({
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
    const pm = new ProjectManager(app as never, clone(), {} as never, tasks);

    const result = await pm.moveTaskToProject(ref, 'Projects/P.md');

    expect(result).toBe(partial);
    expect(tasks.execute).toHaveBeenCalledOnce();
  });
});

describe('ProjectManager.create', () => {
  it('reports file, membership index, and applied default status independently', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    const resolver = new DailyNoteResolver(app as never, settings);
    const index = {
      refresh: vi.fn(),
      get: vi.fn().mockReturnValue({ path: 'Projects/My Project.md' }),
    };
    const pm = new ProjectManager(app as never, settings, resolver, {} as never, undefined, index);
    const result = await pm.create('My Project');
    await flushMicrotasks();
    expect(result).toEqual({
      type: 'file-created',
      path: 'Projects/My Project.md',
      indexed: true,
      status: 'applied',
    });
    expect(index.refresh).toHaveBeenCalledOnce();
    const fm = await readFm(app, 'Projects/My Project.md');
    expect(fm['status']).toBe('active');
  });

  it('dedupes the path when a note already exists', async () => {
    const app = await createAppWithFiles({ 'Projects/Dup.md': '# existing\n' });
    const settings = clone();
    const resolver = new DailyNoteResolver(app as never, settings);
    const pm = new ProjectManager(app as never, settings, resolver, {} as never);
    const result = await pm.create('Dup');
    expect(result).toMatchObject({ type: 'file-created', path: 'Projects/Dup 2.md' });
  });

  it('reports an empty name as failed before creation', async () => {
    const app = await createAppWithFiles({});
    const pm = new ProjectManager(app as never, clone(), {} as never, {} as never);
    expect(await pm.create('   ')).toEqual({
      type: 'failed-before-create',
      reason: 'Project name is required.',
    });
  });

  it('keeps a created file when default status conflicts and reports the partial outcome', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    const resolver = new DailyNoteResolver(app as never, settings);
    const commands = {
      setStatus: vi.fn().mockResolvedValue({ type: 'conflict', currentStatusId: null }),
      undoStatus: vi.fn(),
    } as unknown as ProjectCommandService;
    const index = { refresh: vi.fn(), get: vi.fn().mockReturnValue(undefined) };
    const pm = new ProjectManager(app as never, settings, resolver, {} as never, commands, index);

    const result = await pm.create('Partial');

    expect(result).toEqual({
      type: 'file-created',
      path: 'Projects/Partial.md',
      indexed: false,
      status: 'conflict',
    });
    expect(
      (
        app as never as { vault: { getAbstractFileByPath(path: string): unknown } }
      ).vault.getAbstractFileByPath('Projects/Partial.md'),
    ).toBeInstanceOf(TFile);
  });

  it('reports no requested status independently when no default exists', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    settings.projects.defaultStatusId = '';
    settings.projects.statuses = [];
    const resolver = new DailyNoteResolver(app as never, settings);
    const index = { refresh: vi.fn(), get: vi.fn().mockReturnValue({}) };
    const pm = new ProjectManager(app as never, settings, resolver, {} as never, undefined, index);

    expect(await pm.create('Unstaged')).toEqual({
      type: 'file-created',
      path: 'Projects/Unstaged.md',
      indexed: true,
      status: 'not-requested',
    });
  });

  it('reports terminal file-created when template expansion throws after creating the note', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    const resolver = {
      createNoteFromTemplate: vi.fn(async (path: string) => {
        await (
          app as never as { vault: { create(p: string, body: string): Promise<TFile> } }
        ).vault.create(path, '');
        throw new Error('Templater expansion failed');
      }),
    };
    const index = { refresh: vi.fn(), get: vi.fn().mockReturnValue(undefined) };
    const pm = new ProjectManager(
      app as never,
      settings,
      resolver as never,
      {} as never,
      undefined,
      index,
    );

    const result = await pm.create('Template partial');

    expect(result).toMatchObject({
      type: 'file-created',
      path: 'Projects/Template partial.md',
      indexed: false,
    });
    expect(index.refresh).toHaveBeenCalledOnce();
  });

  it('keeps a created note terminal when index refresh or lookup throws', async () => {
    const app = await createAppWithFiles({});
    const settings = clone();
    const resolver = new DailyNoteResolver(app as never, settings);
    const index = {
      refresh: vi.fn(() => {
        throw new Error('index unavailable');
      }),
      get: vi.fn(() => {
        throw new Error('index unavailable');
      }),
    };
    const pm = new ProjectManager(app as never, settings, resolver, {} as never, undefined, index);

    await expect(pm.create('Index partial')).resolves.toMatchObject({
      type: 'file-created',
      path: 'Projects/Index partial.md',
      indexed: false,
    });
  });
});
