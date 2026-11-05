import { expect, it } from 'vitest';
import { ProjectReadRegistry } from '../src/integrations/ProjectReadRegistry';
import { createProjectApiReads } from '../src/integrations/projectApiReads';
import { createProjectIntegrationReads } from '../src/projects/projectIntegration';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { publicApiHarness } from './support/publicApiHarness';

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
