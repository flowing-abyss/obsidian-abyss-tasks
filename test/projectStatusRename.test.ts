import { getFrontMatterInfo, parseYaml, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectManager } from '../src/projects/ProjectManager';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { createAppWithFiles, expectDefined } from './helpers';

function clone(): CalendarSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CalendarSettings;
}

async function frontmatterValue(
  app: Awaited<ReturnType<typeof createAppWithFiles>>,
  path: string,
): Promise<unknown> {
  const file = expectDefined(app.vault.getAbstractFileByPath(path));
  if (!(file instanceof TFile)) throw new Error(`${path} is not a file`);
  const source = await app.vault.read(file);
  const info = getFrontMatterInfo(source);
  const frontmatter = parseYaml(info.frontmatter) as Record<string, unknown>;
  return frontmatter['status'];
}

function manager(app: Awaited<ReturnType<typeof createAppWithFiles>>, settings: CalendarSettings) {
  const properties: ProjectPropertyCatalog = {
    list: () => [{ name: 'status', type: 'text' }],
    inspect: (property) => ({
      kind: 'available',
      property: { name: property, type: 'text' },
      assignment: { kind: 'none' },
    }),
    values: () => [],
    onChange: () => () => {},
  };
  return new ProjectManager(app, settings, {} as never, {} as never, properties);
}

describe('ProjectManager.renameStatusDefinition', () => {
  it.each(['📘', '🟦', '👩🏽‍💻', '#done', 'a: b', '[done]', '"quoted"'])(
    'roundtrips the status literal %s through serialized project YAML',
    async (literal) => {
      const app = await createAppWithFiles({
        'Projects/A.md': '---\nstatus: active\n---\n',
      });
      const settings = clone();
      const active = expectDefined(settings.projects.statuses[0]);

      await manager(app, settings).renameStatusDefinition(
        active.id,
        literal,
        'active',
        vi.fn().mockResolvedValue(undefined),
      );

      expect(active.name).toBe(literal);
      expect(await frontmatterValue(app, 'Projects/A.md')).toBe(literal);
    },
  );

  it('skips invalid YAML outside project membership while renaming valid projects', async () => {
    const malformed = '---\nbroken: [unterminated\n---\n';
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
      'Notes/Broken.md': 'valid before the cached projection\n',
    });
    await app.vault.adapter.write('Notes/Broken.md', malformed);
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const persist = vi.fn().mockResolvedValue(undefined);

    await manager(app, settings).renameStatusDefinition(active.id, '📘', 'active', persist);

    expect(active.name).toBe('📘');
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('📘');
    expect(await app.vault.adapter.read('Notes/Broken.md')).toBe(malformed);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('rejects invalid YAML in a recognized project before writing and names its path', async () => {
    const malformed = '---\nbroken: [unterminated\n---\n';
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
      'Projects/Broken.md': 'valid before the cached projection\n',
    });
    await app.vault.adapter.write('Projects/Broken.md', malformed);
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const persist = vi.fn().mockResolvedValue(undefined);
    const process = vi.spyOn(app.vault, 'process');

    await expect(
      manager(app, settings).renameStatusDefinition(active.id, 'running', 'active', persist),
    ).rejects.toThrow(/Project frontmatter in Projects\/Broken\.md is not valid YAML/u);

    expect(active.name).toBe('active');
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('active');
    expect(await app.vault.adapter.read('Projects/Broken.md')).toBe(malformed);
    expect(process).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'cached tags',
      membershipQuery: '#project',
      source: '---\nstatus: active\ntags: [project]\n---\n',
    },
    {
      label: 'cached frontmatter properties',
      membershipQuery: 'kind=project',
      source: '---\nstatus: active\nkind: project\n---\n',
    },
  ])('uses $label to classify malformed project source', async ({ membershipQuery, source }) => {
    const malformed = '---\nbroken: [unterminated\n---\n';
    const app = await createAppWithFiles({ 'Notes/Cached.md': source });
    await app.vault.adapter.write('Notes/Cached.md', malformed);
    const settings = clone();
    settings.projects.membershipQuery = membershipQuery;
    const active = expectDefined(settings.projects.statuses[0]);
    const persist = vi.fn().mockResolvedValue(undefined);

    await expect(
      manager(app, settings).renameStatusDefinition(active.id, 'running', 'active', persist),
    ).rejects.toThrow(/Project frontmatter in Notes\/Cached\.md is not valid YAML/u);

    expect(active.name).toBe('active');
    expect(await app.vault.adapter.read('Notes/Cached.md')).toBe(malformed);
    expect(persist).not.toHaveBeenCalled();
  });

  it('uses valid fresh membership instead of a stale cached projection', async () => {
    const app = await createAppWithFiles({
      'Notes/WasProject.md': '---\nstatus: active\nkind: project\n---\n',
      'Notes/BecameProject.md': '---\nstatus: active\nkind: reference\n---\n',
    });
    await app.vault.adapter.write(
      'Notes/WasProject.md',
      '---\nstatus: active\nkind: reference\n---\n',
    );
    await app.vault.adapter.write(
      'Notes/BecameProject.md',
      '---\nstatus: active\nkind: project\n---\n',
    );
    const settings = clone();
    settings.projects.membershipQuery = 'kind=project';
    const active = expectDefined(settings.projects.statuses[0]);

    await manager(app, settings).renameStatusDefinition(
      active.id,
      'running',
      'active',
      vi.fn().mockResolvedValue(undefined),
    );

    expect(await frontmatterValue(app, 'Notes/WasProject.md')).toBe('active');
    expect(await frontmatterValue(app, 'Notes/BecameProject.md')).toBe('running');
  });

  it('names the project whose YAML becomes invalid during write revalidation', async () => {
    const malformed = '---\nbroken: [unterminated\n---\n';
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
    });
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const persist = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(app.vault, 'process').mockImplementation(async (_file, callback) => {
      return callback(malformed);
    });

    await expect(
      manager(app, settings).renameStatusDefinition(active.id, 'running', 'active', persist),
    ).rejects.toThrow(/Project frontmatter in Projects\/A\.md is not valid YAML/u);

    expect(active.name).toBe('active');
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('active');
    expect(persist).not.toHaveBeenCalled();
  });

  it('renames fresh assigned projects while leaving nonprojects and externally changed values alone', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
      'Projects/B.md': '---\nstatus: active\n---\n',
      'Projects/Changed.md': '---\nstatus: planned\n---\n',
      'Notes/Reference.md': '---\nstatus: active\n---\n',
    });
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const persist = vi.fn().mockResolvedValue(undefined);

    await manager(app, settings).renameStatusDefinition(active.id, 'running', 'active', persist);

    expect(active.name).toBe('running');
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('running');
    expect(await frontmatterValue(app, 'Projects/B.md')).toBe('running');
    expect(await frontmatterValue(app, 'Projects/Changed.md')).toBe('planned');
    expect(await frontmatterValue(app, 'Notes/Reference.md')).toBe('active');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('validates the expected definition and unique nonempty literal before writing', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\nstatus: active\n---\n' });
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const pm = manager(app, settings);

    await expect(pm.renameStatusDefinition(active.id, ' ', 'active', vi.fn())).rejects.toThrow(
      /cannot be empty/u,
    );
    await expect(
      pm.renameStatusDefinition(active.id, 'planned', 'active', vi.fn()),
    ).rejects.toThrow(/already exists/u);
    await expect(pm.renameStatusDefinition(active.id, 'running', 'stale', vi.fn())).rejects.toThrow(
      /changed externally/u,
    );
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('active');
  });

  it('compensates its first owned write when the second project write fails', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
      'Projects/B.md': '---\nstatus: active\n---\n',
    });
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const originalProcess = app.vault.process.bind(app.vault);
    let calls = 0;
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback) => {
      calls += 1;
      if (calls === 2) throw new Error('injected second write failure');
      return originalProcess(file, callback);
    });

    await expect(
      manager(app, settings).renameStatusDefinition(
        active.id,
        'running',
        'active',
        vi.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toThrow(/injected second write failure.*recovered/u);

    expect(active.name).toBe('active');
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('active');
    expect(await frontmatterValue(app, 'Projects/B.md')).toBe('active');
  });

  it('restores the definition and owned note values when settings persistence fails', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
      'Projects/B.md': '---\nstatus: active\n---\n',
    });
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('injected settings save failure'))
      .mockResolvedValueOnce(undefined);

    await expect(
      manager(app, settings).renameStatusDefinition(active.id, 'running', 'active', persist),
    ).rejects.toThrow(/injected settings save failure.*recovered/u);

    expect(active.name).toBe('active');
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('active');
    expect(await frontmatterValue(app, 'Projects/B.md')).toBe('active');
  });

  it('preserves an external edit during compensation and reports its unresolved path', async () => {
    const app = await createAppWithFiles({
      'Projects/A.md': '---\nstatus: active\n---\n',
      'Projects/B.md': '---\nstatus: active\n---\n',
    });
    const settings = clone();
    const active = expectDefined(settings.projects.statuses[0]);
    const originalProcess = app.vault.process.bind(app.vault);
    let calls = 0;
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, callback) => {
      calls += 1;
      if (calls === 2) {
        const first = expectDefined(app.vault.getAbstractFileByPath('Projects/A.md'));
        if (!(first instanceof TFile)) throw new Error('missing first project');
        await originalProcess(first, (source) =>
          source.replace('status: running', 'status: planned'),
        );
        throw new Error('injected batch failure');
      }
      return originalProcess(file, callback);
    });

    const operation = manager(app, settings).renameStatusDefinition(
      active.id,
      'running',
      'active',
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(operation).rejects.toThrow(/Projects\/A\.md/u);
    expect(await frontmatterValue(app, 'Projects/A.md')).toBe('planned');
    expect(active.name).toBe('active');
  });
});
