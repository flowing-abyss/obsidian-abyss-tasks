import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { TaskSearchRuntime } from '../../src/tasks/infrastructure/search/TaskSearchRuntime';
import { expectDefined } from '../helpers';
import {
  assertNoRevision,
  createCanonicalSearchHarness,
  nodeDocuments,
} from '../support/taskSearchHarness';

async function ready() {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  await runtime.mutate({ type: 'begin', path: 'a.md' });
  await runtime.mutate({ type: 'add', documents: nodeDocuments(95) });
  await runtime.mutate({ type: 'commit', path: 'a.md' });
  await runtime.mutate({ type: 'publish', generation: 1 });
  return runtime;
}
const request = (kind: 'roots' | 'nodes') => ({
  kind,
  query: prepareSearchQuery('needle', fallbackSearchWords),
  includeSourcePath: false,
});
describe('owned search runtime', () => {
  it('keeps final random page alive and isolates another cursor', async () => {
    const r = await ready();
    const a = await r.open(request('nodes'), 1);
    const b = await r.open(request('roots'), 1);
    expect((await r.read(a, 90, 30)).hits).toHaveLength(5);
    expect((await r.read(a, 60, 30)).hits).toHaveLength(30);
    r.release(b);
    expect((await r.read(a, 0, 30)).hits).toHaveLength(30);
    r.dispose();
  });
  it('forward last batch releases', async () => {
    const r = await ready();
    const a = await r.open(request('roots'), 1);
    await expect(r.read(a, 1, 30)).rejects.toMatchObject({ code: 'invalid-request' });
    expect((await r.read(a, 0, 200)).done).toBe(true);
    await expect(r.read(a, 0, 30)).rejects.toMatchObject({ code: 'cursor-expired' });
    r.dispose();
  });
  it('fifth vector evicts least recent and no requery', async () => {
    const r = await ready();
    const cursors = await Promise.all(Array.from({ length: 4 }, () => r.open(request('nodes'), 1)));
    const first = expectDefined(cursors[0]);
    const second = expectDefined(cursors[1]);
    await r.read(first, 0, 1);
    await r.open(request('nodes'), 1);
    await expect(r.read(second, 0, 1)).rejects.toMatchObject({ code: 'cursor-expired' });
    expect((await r.read(first, 0, 1)).hits).toHaveLength(1);
    await r.mutate({ type: 'publish', generation: 2 });
    await expect(r.read(first, 0, 1)).rejects.toMatchObject({ code: 'stale' });
    r.dispose();
  });
});

it('twenty churn cycles and vacuum parity', async () => {
  const r = await ready();
  for (let cycle = 0; cycle < 20; cycle++) {
    const docs = nodeDocuments(cycle + 1).map((d) => ({
      ...d,
      id: d.id + (cycle + 1) * 100,
      rootId: d.rootId + (cycle + 1) * 100,
    }));
    await r.mutate({ type: 'begin', path: 'a.md' });
    await expect(r.open(request('nodes'), cycle + 1)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await r.mutate({ type: 'add', documents: docs });
    await r.mutate({ type: 'commit', path: 'a.md' });
    await r.mutate({ type: 'publish', generation: cycle + 2 });
    const c = await r.open(request('nodes'), cycle + 2);
    expect((await r.read(c, 0, 200)).hits.map((hit) => hit.id)).toEqual(docs.map((d) => d.id));
    r.release(c);
  }
  r.dispose();
});

it('publishes accepted replacements without waiting for maintenance vacuum', async () => {
  const engine = createMiniSearchTaskEngine(fallbackSearchWords);
  const original = engine.vacuum.bind(engine);
  let finish: (() => void) | undefined;
  engine.vacuum = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await original();
  };
  const r = new TaskSearchRuntime(engine);
  await r.mutate({ type: 'begin', path: 'a.md' });
  await r.mutate({ type: 'add', documents: nodeDocuments(2) });
  await r.mutate({ type: 'commit', path: 'a.md' });
  let published = false;
  const publishing = r.mutate({ type: 'publish', generation: 1 }).then(() => {
    published = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  const publishedBeforeMaintenance = published;
  finish?.();
  await publishing;
  expect(publishedBeforeMaintenance).toBe(true);
  expect((await r.open(request('roots'), 1)).total).toBe(2);
  r.dispose();
});

it('actual compact runtime vectors exclude canonical source-bearing revisions', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': `- [ ] needle\n  - > ${'x'.repeat(1_048_576)}` },
    DEFAULT_SETTINGS,
  );
  const root = expectDefined(h.index.list()[0]);
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(fallbackSearchWords));
  for (const file of h.index.searchSource().files()) {
    await runtime.mutate({ type: 'begin', path: file.path });
    await runtime.mutate({ type: 'add', documents: [...h.index.searchSource().documents(file)] });
    await runtime.mutate({ type: 'commit', path: file.path });
  }
  await runtime.mutate({ type: 'publish', generation: 1 });
  await runtime.open(request('nodes'), 1);
  const vectors = (runtime as unknown as { vectors: Map<string, unknown> }).vectors;
  expect(vectors.size).toBe(1);
  assertNoRevision(structuredClone([...vectors.values()]), root.ref.revision);
  runtime.dispose();
  h.close();
});
