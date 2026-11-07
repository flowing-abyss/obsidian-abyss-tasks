import { TFile, type Vault } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

async function prepared() {
  const h = await taskEditPreparationHarness('- [ ] Root\n- [ ] Sibling\n');
  const p = ready(
    await h.service.prepare(h.root, [
      {
        type: 'patch',
        target: { type: 'task', ref: h.root.ref },
        patch: { markdownTitle: { type: 'set', value: 'Changed' } },
      },
    ]),
  );
  return { ...h, p };
}

describe('strict prepared root commit', () => {
  it.each(['root', 'sibling'])(
    'rejects concurrent %s edits inside the write callback',
    async (target) => {
      const h = await prepared();
      const process = h.process;
      const external =
        target === 'root' ? '- [ ] External\n- [ ] Sibling\n' : '- [ ] Root\n- [ ] External\n';
      h.writes.mockImplementationOnce(async (file, callback) => {
        await h.app.vault.modify(file, external);
        return process(file, callback);
      });
      expect((await h.p.commit()).type).not.toBe('ok');
      expect(await h.read()).toBe(external);
    },
  );

  it('rejects a replacement file even with the same bytes', async () => {
    const h = await prepared();
    await h.app.vault.rename(h.file, 'old.md');
    const replacement = await h.app.vault.create('tasks.md', '- [ ] Root\n- [ ] Sibling\n');
    expect((await h.p.commit()).type).not.toBe('ok');
    expect(await h.app.vault.read(replacement)).toBe('- [ ] Root\n- [ ] Sibling\n');
  });

  it('rejects semantics changes after preparation', async () => {
    const h = await prepared();
    h.writes.mockImplementationOnce(async (file, callback) => {
      h.index.updateIntegrationSemantics('changed');
      return h.process(file, callback);
    });
    expect((await h.p.commit()).type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Root\n- [ ] Sibling\n');
  });

  it('rejects a candidate that would move the source outside permitted scope', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n', {
      index: {
        excludeSource: (source) => source.tags.includes('#excluded'),
      },
    });
    const p = ready(
      await h.service.prepare(h.root, [
        {
          type: 'patch',
          target: { type: 'task', ref: h.root.ref },
          patch: { tags: { add: ['#excluded'] } },
        },
      ]),
    );
    expect((await p.commit()).type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Root\n');
  });

  it('rejects a scope change inside the writer even when bytes are unchanged', async () => {
    const h = await prepared();
    h.writes.mockImplementationOnce(async (file, callback) => {
      await h.index.refreshSourceExclusion(() => true);
      return h.process(file, callback);
    });
    expect((await h.p.commit()).type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Root\n- [ ] Sibling\n');
  });

  it.each([false, true])(
    'never retries or reports saved after a rejected write (effect=%s)',
    async (effect) => {
      const h = await prepared();
      const process = h.process;
      h.writes.mockImplementationOnce(async (file, callback) => {
        if (effect) await process(file, callback);
        throw new Error('write failed');
      });
      const receipt = await h.p.commit();
      expect(receipt).toMatchObject({
        type: 'io-error',
        contentState: effect ? 'unknown' : 'unchanged',
      });
      expect(await h.p.commit()).toEqual(receipt);
      expect(h.writes).toHaveBeenCalledTimes(1);
    },
  );
});

type PreparationHarness = Awaited<ReturnType<typeof taskEditPreparationHarness>>;
async function preparationRequest(
  h: PreparationHarness,
  kind: 'edit' | 'create',
  refresh: boolean,
) {
  if (kind === 'edit') {
    if (!refresh) return () => h.service.prepare(h.root, []);
    const previous = ready(await h.service.prepare(h.root, []));
    return () => previous.refresh(h.root);
  }
  const input = {
    destination: {
      type: 'explicit' as const,
      destination: { filePath: 'tasks.md', insertion: { type: 'append' as const } },
    },
    tree: { markdownTitle: 'New' },
  };
  if (!refresh) return () => h.service.prepareCreateTree(input);
  const previous = await h.service.prepareCreateTree(input);
  if (previous.type !== 'ready') throw new Error('Missing creation');
  return () => previous.refresh();
}

it.each(['edit', 'create'] as const)(
  'retains original %s acquisition proof through the caller continuation',
  async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const run = await preparationRequest(h, kind, false);
    const acquire = h.sources.acquire.bind(h.sources);
    vi.spyOn(h.sources, 'acquire').mockImplementationOnce(async (path) => {
      const result = await acquire(path);
      queueMicrotask(() => {
        queueMicrotask(() => {
          h.index.updateIntegrationSemantics('review-race');
        });
      });
      return result;
    });
    const result = await run();
    expect(result.type).toBe('invalid');
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Root\n');
    h.index.destroy();
  },
);

it.each(['edit', 'create'] as const)(
  'rejects a permitted-scope change after %s acquisition validation',
  async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const run = await preparationRequest(h, kind, false);
    const acquire = h.sources.acquire.bind(h.sources);
    let changed: Promise<void> | undefined;
    vi.spyOn(h.sources, 'acquire').mockImplementationOnce(async (path) => {
      const result = await acquire(path);
      queueMicrotask(() => {
        queueMicrotask(() => {
          changed = h.index.refreshSourceExclusion(() => false);
        });
      });
      return result;
    });
    const result = await run();
    await changed;
    expect(h.sources.get('tasks.md').type).toBe('ok');
    expect(result.type).toBe('invalid');
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Root\n');
    h.index.destroy();
  },
);

it('rejects a post-acquisition same-byte replacement with a current accepted creation source', async () => {
  const content = '- [ ] Root\n',
    h = await taskEditPreparationHarness(content);
  const acquire = h.sources.acquire.bind(h.sources);
  const replacement = (
    TFile as unknown as { create__(vault: Vault, path: string): TFile }
  ).create__(h.app.vault, 'tasks.md');
  replacement.stat = { ...h.file.stat };
  let currentProof = false;
  vi.spyOn(h.sources, 'acquire').mockImplementationOnce(async (path) => {
    const result = await acquire(path);
    queueMicrotask(() => {
      queueMicrotask(() => {
        // The mock's documented registration hook performs one atomic native-incarnation swap.
        (
          h.app.vault as unknown as { setVaultAbstractFile__(path: string, file: TFile): void }
        ).setVaultAbstractFile__('tasks.md', replacement);
        h.index.installCommittedContent('tasks.md', content);
        const accepted = h.sources.get('tasks.md');
        currentProof =
          accepted.type === 'ok' &&
          accepted.value !== undefined &&
          h.sources.matchesFile(accepted.value, replacement);
      });
    });
    return result;
  });
  const run = await preparationRequest(h, 'create', false),
    result = await run();
  expect(currentProof).toBe(true);
  expect(result.type).toBe('invalid');
  expect(h.writes).not.toHaveBeenCalled();
  expect(await h.app.vault.read(replacement)).toBe(content);
  h.index.destroy();
});

it.each(['edit', 'create'] as const)(
  'keeps original %s proof across acquisition during refresh',
  async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const run = await preparationRequest(h, kind, true),
      acquire = h.sources.acquire.bind(h.sources);
    vi.spyOn(h.sources, 'acquire').mockImplementationOnce(async (path) => {
      const result = await acquire(path);
      queueMicrotask(() => {
        queueMicrotask(() => {
          h.index.updateIntegrationSemantics('refresh-gap');
        });
      });
      return result;
    });
    expect((await run()).type).toBe('invalid');
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Root\n');
    h.index.destroy();
  },
);

it.each([
  ['create', 'semantics'],
  ['edit-refresh', 'semantics'],
  ['create-refresh', 'semantics'],
  ['create', 'scope'],
  ['edit-refresh', 'scope'],
  ['create-refresh', 'scope'],
] as const)('rechecks %s original %s proof after the last read await', async (kind, change) => {
  const h = await taskEditPreparationHarness('- [ ] Root\n');
  const run = await preparationRequest(
    h,
    kind === 'edit-refresh' ? 'edit' : 'create',
    kind !== 'create',
  );
  const read = h.app.vault.read.bind(h.app.vault);
  let changed: Promise<void> | undefined;
  vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
    const result = await read(file);
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (change === 'scope') changed = h.index.refreshSourceExclusion(() => false);
        else h.index.updateIntegrationSemantics('last-read-gap');
      });
    });
    return result;
  });
  expect((await run()).type).toBe('invalid');
  await changed;
  expect(h.writes).not.toHaveBeenCalled();
  expect(await h.read()).toBe('- [ ] Root\n');
  h.index.destroy();
});

it.each(['edit', 'create'] as const)(
  'prepares unchanged %s acquisition after the helper continuation',
  async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const run = await preparationRequest(h, kind, false),
      acquire = h.sources.acquire.bind(h.sources);
    let continued = false;
    vi.spyOn(h.sources, 'acquire').mockImplementationOnce(async (path) => {
      const result = await acquire(path);
      queueMicrotask(() => {
        queueMicrotask(() => {
          continued = true;
        });
      });
      return result;
    });
    expect((await run()).type).toBe('ready');
    expect(continued).toBe(true);
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Root\n');
    h.index.destroy();
  },
);

it.each(['edit', 'create'] as const)(
  'rejects %s destruction after helper acquisition validation',
  async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const run = await preparationRequest(h, kind, false),
      acquire = h.sources.acquire.bind(h.sources);
    vi.spyOn(h.sources, 'acquire').mockImplementationOnce(async (path) => {
      const result = await acquire(path);
      queueMicrotask(() => {
        queueMicrotask(() => {
          h.index.destroy();
        });
      });
      return result;
    });
    expect((await run()).type).toBe('invalid');
    expect(h.writes).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Root\n');
  },
);
