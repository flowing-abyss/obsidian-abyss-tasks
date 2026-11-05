import { expect, it, vi } from 'vitest';
import { ProjectReadRegistry } from '../src/integrations/ProjectReadRegistry';
import { createProjectApiReads } from '../src/integrations/projectApiReads';
import { createProjectIntegrationReads } from '../src/projects/projectIntegration';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { flushMicrotasks } from './helpers';
import { publicApiHarness } from './support/publicApiHarness';

it('keeps reserved capacity and pinned expiry separate from public project lookup', async () => {
  const h = await publicApiHarness({ 'a.md': '#project' });
  try {
    const port = createProjectIntegrationReads(h.index.projectSources(), () => ({
      ...DEFAULT_SETTINGS.projects,
      membershipQuery: '#project',
    }));
    let now = 100;
    const registry = new ProjectReadRegistry(port, {
      epoch: 'epoch',
      now: () => now,
      maxTargets: 1,
    });
    const summary = port.summary('a.md');
    if (summary.type !== 'ok' || summary.value === undefined) throw new Error('Missing project');
    const reservation = registry.reserve();
    if (!reservation.ok) throw new Error('Missing reservation');
    expect(registry.project(summary.value)).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    reservation.value();
    reservation.value();
    const issued = registry.project(summary.value);
    if (!issued.ok) throw new Error('Missing handle');
    const target = issued.value.target;
    const pin = registry.pin(target);
    if (!pin.ok) throw new Error('Missing pin');
    now += 1_800_001;
    expect(registry.acquire(target).ok).toBe(false);
    expect(registry.reserve().ok).toBe(false);
    now = 100;
    expect(registry.acquire(target).ok).toBe(false);
    pin.value();
    expect(registry.reserve().ok).toBe(true);
  } finally {
    h.dispose();
  }
});

it('releases the reverse project identity on rollback, expiry and disposal and preserves a newer target', async () => {
  const h = await publicApiHarness({ 'a.md': '#project' });
  try {
    const port = createProjectIntegrationReads(h.index.projectSources(), () => ({
      ...DEFAULT_SETTINGS.projects,
      membershipQuery: '#project',
    }));
    const read = port.summary('a.md');
    if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing project');
    const summary = read.value;
    let now = 0;
    const registry = new ProjectReadRegistry(port, { epoch: 'epoch', now: () => now });
    const removed = vi.spyOn(WeakMap.prototype, 'delete');
    try {
      const checkpoint = registry.checkpoint();
      expect(registry.project(summary).ok).toBe(true);
      registry.rollback(checkpoint);
      expect(removed).toHaveBeenCalledWith(summary.identity);
      removed.mockClear();
      expect(registry.project(summary).ok).toBe(true);
      now++;
      const renamed = { ...summary, path: 'b.md' };
      const next = registry.project(renamed);
      now = 1_800_000;
      registry.clean();
      expect(removed).not.toHaveBeenCalledWith(summary.identity);
      expect(registry.project(renamed)).toEqual(next);
      now += 1_800_000;
      registry.clean();
      expect(removed).toHaveBeenCalledWith(summary.identity);
      removed.mockClear();
      expect(registry.project(renamed).ok).toBe(true);
      registry.dispose();
      expect(removed).toHaveBeenCalledWith(summary.identity);
    } finally {
      removed.mockRestore();
    }
  } finally {
    h.dispose();
  }
});

it('paginates projects with opaque identities and expires a cursor when sources change', async () => {
  const h = await publicApiHarness({
    'a.md': '---\nkind: project\n---\n# A',
    'b.md': '---\nkind: project\n---\n# B',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const reads = createProjectApiReads(
      {
        reads: h.reads,
        observation: (o) => ({ ...o, providerEpoch: 'epoch' }),
        check: () => undefined,
        internal: () => {
          throw new Error('internal');
        },
      },
      port,
      new ProjectReadRegistry(port, { epoch: 'epoch', now: () => 1, maxTargets: 1 }),
    );
    const first = await reads.api.list({ limit: 1 });
    expect(first).toMatchObject({ ok: true, value: { items: [{ path: 'a.md' }] } });
    if (!first.ok || first.value.nextCursor === undefined) throw new Error('Missing cursor');
    const second = await reads.api.list({ limit: 1, cursor: first.value.nextCursor });
    expect(second).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
    const target = first.value.items[0]?.target;
    if (target === undefined) throw new Error('Missing target');
    expect(await reads.api.get(target)).toMatchObject({ ok: true, value: { path: 'a.md' } });
    const revision = first.value.items[0]?.revision;
    if (revision === undefined) throw new Error('Missing revision');
    await h.external('a.md', '---\nkind: project\n---\n# Changed');
    expect(reads.acquire(target, revision)).toMatchObject({
      ok: false,
      error: { code: 'STALE_REVISION' },
    });
    expect(await reads.api.list({ limit: 1, cursor: first.value.nextCursor })).toMatchObject({
      ok: false,
      error: { code: 'STALE_CURSOR' },
    });
    const file = h.app.vault.getFileByPath('a.md');
    if (file === null) throw new Error('Missing source');
    await h.app.vault.rename(file, 'renamed.md');
    expect(await reads.api.get(target)).toMatchObject({
      ok: false,
      error: { code: 'STALE_TARGET' },
    });
  } finally {
    h.dispose();
  }
});

it('keeps oversized detail out of a bounded summary page', async () => {
  const h = await publicApiHarness({
    'large.md': `---\nkind: project\ndescription: ${'x'.repeat(270_000)}\n---\n`,
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const reads = createProjectApiReads(
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
    );
    const page = await reads.api.list();
    expect(page).toMatchObject({ ok: true, value: { items: [{ path: 'large.md' }] } });
    if (!page.ok || page.value.items[0] === undefined) throw new Error('Missing project');
    expect(await reads.api.get(page.value.items[0].target)).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_LIMIT' },
    });
  } finally {
    h.dispose();
  }
});

it('reclaims undisclosed targets and cursors after oversized results', async () => {
  const longA = `${'a'.repeat(66_000)}.md`,
    longB = `${'b'.repeat(66_000)}.md`;
  const content = '---\nkind: project\n---\n';
  const h = await publicApiHarness({ [longA]: content, [longB]: content, 'z.md': content });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const registry = new ProjectReadRegistry(port, {
      epoch: 'epoch',
      now: () => 1,
      maxTargets: 2,
      maxCursors: 1,
    });
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
      registry,
    ).api;
    expect(await api.list({ limit: 2 })).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_LIMIT' },
    });
    expect(await api.resolve({ path: 'z.md' })).toMatchObject({
      ok: true,
      value: { type: 'found' },
    });
    expect(await api.list({ limit: 1 })).toMatchObject({
      ok: true,
      value: { items: [{ path: longA }] },
    });
  } finally {
    h.dispose();
  }
});

it('shares identities and project cursors across clients while rejecting task cursors', async () => {
  const h = await publicApiHarness({
    'a.md': '---\nkind: project\n---\n- [ ] A',
    'b.md': '---\nkind: project\n---\n- [ ] B',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const registry = new ProjectReadRegistry(port, { epoch: 'epoch', now: () => 1 });
    const context = {
      reads: h.reads,
      observation: (o: ReturnType<typeof h.reads.capture>) => ({ ...o, providerEpoch: 'epoch' }),
      check: () => undefined,
      internal: () => {
        throw new Error('internal');
      },
    };
    const first = createProjectApiReads(context, port, registry).api,
      second = createProjectApiReads(context, port, registry).api;
    const page = await first.list({ limit: 1 });
    if (!page.ok || page.value.nextCursor === undefined || page.value.items[0] === undefined)
      throw new Error('Missing first page');
    expect(await second.get(page.value.items[0].target)).toMatchObject({
      ok: true,
      value: { path: 'a.md' },
    });
    expect(await second.list({ limit: 1, cursor: page.value.nextCursor })).toMatchObject({
      ok: true,
      value: { items: [{ path: 'b.md' }] },
    });
    const tasks = await h.client().tasks.list({ limit: 1 });
    if (!tasks.ok || tasks.value.nextCursor === undefined) throw new Error('Missing task cursor');
    expect(await second.list({ limit: 1, cursor: tasks.value.nextCursor })).toMatchObject({
      ok: false,
      error: { code: 'STALE_CURSOR' },
    });
    expect(await h.client().tasks.list({ limit: 1, cursor: page.value.nextCursor })).toMatchObject({
      ok: false,
      error: { code: 'STALE_CURSOR' },
    });
  } finally {
    h.dispose();
  }
});

it('expires an old target when a note is recreated with identical bytes', async () => {
  const content = '---\nkind: project\n---\n';
  const h = await publicApiHarness({ 'project.md': content });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const registry = new ProjectReadRegistry(port, { epoch: 'epoch', now: () => 1 });
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
      registry,
    ).api;
    const old = await api.resolve({ path: 'project.md' });
    if (!old.ok || old.value.type !== 'found') throw new Error('Missing project');
    const file = h.app.vault.getFileByPath('project.md');
    if (file === null) throw new Error('Missing file');
    await h.app.fileManager.trashFile(file);
    await h.app.vault.create('project.md', content);
    await flushMicrotasks();
    expect(await api.get(old.value.project.target)).toMatchObject({
      ok: false,
      error: { code: 'STALE_TARGET' },
    });
    const fresh = await api.resolve({ path: 'project.md' });
    if (!fresh.ok || fresh.value.type !== 'found') throw new Error('Missing replacement');
    expect(fresh.value.project.target).not.toBe(old.value.project.target);
  } finally {
    h.dispose();
  }
});

it('hydrates only the requested page and one qualifying lookahead', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `${String(i).padStart(3, '0')}.md`,
      '---\nkind: project\n---\n',
    ]),
  );
  const h = await publicApiHarness(files);
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const source = h.index.projectSources(),
      get = vi.fn((path: string) => source.get(path));
    const port = createProjectIntegrationReads({ ...source, get }, () => settings);
    const registry = new ProjectReadRegistry(port, { epoch: 'epoch', now: () => 1 });
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
      registry,
    ).api;
    expect(await api.list({ limit: 1 })).toMatchObject({ ok: true });
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
  }
});

it('reclaims a target after an oversized detail is not delivered', async () => {
  const h = await publicApiHarness({
    'large.md': `---\nkind: project\ndescription: ${'x'.repeat(270_000)}\n---\n`,
    'small.md': '---\nkind: project\n---\n',
  });
  try {
    const settings = structuredClone(DEFAULT_SETTINGS.projects);
    settings.membershipQuery = 'kind=project';
    const port = createProjectIntegrationReads(h.index.projectSources(), () => settings);
    const registry = new ProjectReadRegistry(port, { epoch: 'epoch', now: () => 1, maxTargets: 1 });
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
      registry,
    ).api;
    expect(await api.resolve({ path: 'large.md' })).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_LIMIT' },
    });
    expect(await api.resolve({ path: 'small.md' })).toMatchObject({
      ok: true,
      value: { type: 'found' },
    });
  } finally {
    h.dispose();
  }
});
