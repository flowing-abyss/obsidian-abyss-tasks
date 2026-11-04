import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { expectDefined, flushMicrotasks, metadataChangedEmitter } from '../helpers';
import { publicApiHarness, type PublicApiHarness } from '../support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
const source =
  '- [ ] Root\n  - 2026-08-01T10:00:00Z →\n  - [ ] Child\n    - 2026-08-01T11:00:00Z →\n  - [ ] Last\n    - 2026-08-01T11:30:00Z →\n';
async function harness(content = source, options?: Parameters<typeof publicApiHarness>[1]) {
  const h = await publicApiHarness({ 'a.md': content, 'b.md': '' }, options);
  harnesses.push(h);
  return h;
}
function request(h: PublicApiHarness, nested = false) {
  const root = expectDefined(h.index.list()[0]);
  const target = nested
    ? { type: 'subtask' as const, ref: expectDefined(root.subtasks[0]).ref }
    : { type: 'task' as const, ref: root.ref };
  return { root, target, observation: h.reads.capture(), intent: { type: 'complete' as const } };
}
afterEach(() => {
  vi.restoreAllMocks();
  harnesses.splice(0).forEach((h) => {
    h.dispose();
  });
});

describe('strict completion tracking follow-up', () => {
  it('closes all descendants with the captured clock and returns the final proven root', async () => {
    const h = await harness();
    const process = h.app.vault.process.bind(h.app.vault);
    const writes = vi
      .spyOn(h.app.vault, 'process')
      .mockImplementation(async (file, fn, options) => {
        const result = await process(file, fn, options);
        h.clock(Date.UTC(2026, 7, 2));
        return result;
      });
    const outcome = await h.service.mutateStatus(request(h));
    expect(outcome).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true },
      followUp: { closed: 3, unclosed: 0, state: 'complete', discardedShortEntry: false },
    });
    expect(writes).toHaveBeenCalledTimes(4);
    const final = expectDefined(h.index.list()[0]);
    expect(outcome).toMatchObject({
      followUp: { root: final },
      occurrences: {
        original: { state: 'retained', current: { rootRevision: final.ref.revision } },
      },
    });
    expect((await h.read('a.md')).match(/→ 2026-08-01T12:00:00\+00:00/gu)).toHaveLength(3);
  });

  it.each([2, 3])(
    'retains the main and prior timer writes when timer writer %s loses source proof',
    async (at) => {
      const h = await harness();
      const process = h.app.vault.process.bind(h.app.vault);
      let calls = 0;
      const writes = vi
        .spyOn(h.app.vault, 'process')
        .mockImplementation(async (file, fn, options) => {
          calls += 1;
          if (calls === at)
            await h.external('a.md', (await h.read('a.md')).replace('Last', 'Edited'));
          return await process(file, fn, options);
        });
      const outcome = await h.service.mutateStatus(request(h));
      expect(outcome).toMatchObject({
        type: 'result',
        result: { type: 'ok', changed: true },
        followUp: { closed: at - 2, unclosed: 5 - at, state: 'partial' },
        occurrences: { original: { state: 'retained' } },
      });
      if (outcome.type !== 'result') throw new Error('Expected main result');
      expect(outcome.occurrences.original.current).toBeUndefined();
      expect(outcome.followUp?.root?.source.originalBlock).not.toContain('Edited');
      expect(writes).toHaveBeenCalledTimes(at);
      expect(await h.read('a.md')).toContain('- [x] Root');
    },
  );

  it('keeps prior progress when an I/O failure leaves a timer effect unknown', async () => {
    const h = await harness();
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    const writes = vi
      .spyOn(h.app.vault, 'process')
      .mockImplementation(async (file, fn, options) => {
        calls += 1;
        if (calls === 3) throw new Error('disk full');
        return await process(file, fn, options);
      });
    const outcome = await h.service.mutateStatus(request(h));
    expect(outcome).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true },
      followUp: { closed: 1, unclosed: 2, state: 'unknown' },
      occurrences: { original: { state: 'retained' } },
    });
    expect(writes).toHaveBeenCalledTimes(3);
    expect(await h.read('a.md')).toContain('- [x] Root');
  });

  it('accepts unchanged metadata echoes through multiple timer writes', async () => {
    const h = await harness();
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
      h.index.installCommittedContent(file.path, await h.app.vault.read(file));
      return await process(file, fn, options);
    });
    expect(await h.service.mutateStatus(request(h))).toMatchObject({
      type: 'result',
      followUp: { closed: 3, unclosed: 0, state: 'complete' },
    });
  });

  it('stops on a semantics change between timer writes', async () => {
    const h = await harness();
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
      calls += 1;
      if (calls === 3)
        h.index.setStatusCatalog(
          new StatusCatalog([
            { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
            { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
          ]),
        );
      return await process(file, fn, options);
    });
    expect(await h.service.mutateStatus(request(h))).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true },
      followUp: { closed: 1, unclosed: 2, state: 'partial' },
    });
    expect(calls).toBe(3);
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const races = ['policy', 'frontmatter', 'tag', 'semantics', 'health', 'identity', 'bytes'] as const;
async function applyRace(h: PublicApiHarness, race: (typeof races)[number], exclude: () => void) {
  const file = h.app.vault.getAbstractFileByPath('a.md');
  if (!(file instanceof TFile)) throw new Error('Missing source');
  const content = await h.read('a.md');
  if (race === 'policy') exclude();
  if (race === 'semantics') h.index.updateIntegrationSemantics('changed');
  if (race === 'frontmatter') await h.app.vault.modify(file, `---\nprivate: true\n---\n${content}`);
  if (race === 'tag') await h.app.vault.modify(file, content.replace('Root', 'Root #excluded'));
  if (race === 'bytes') await h.app.vault.modify(file, content.replace('Last', 'Edited'));
  if (race === 'identity') {
    await h.app.fileManager.trashFile(file);
    await h.app.vault.create('a.md', content);
  }
  if (race === 'health') {
    const other = h.app.vault.getAbstractFileByPath('b.md');
    if (!(other instanceof TFile)) throw new Error('Missing other source');
    const read = h.app.vault.read.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'read').mockImplementation(async (target) => {
      if (target === other) throw new Error('read failed');
      return await read(target);
    });
    metadataChangedEmitter(h.app)(other, 'unconfirmed', {});
    await flushMicrotasks();
  }
}
for (const at of [2, 3]) {
  it.each(races)(`rejects %s at writer ${at} without losing committed progress`, async (race) => {
    let excluded = false;
    const h = await harness(source, {
      index: {
        excludeSource: (metadata) =>
          excluded ||
          metadata.tags.includes('#excluded') ||
          metadata.frontmatter['private'] === true,
      },
    });
    const entered = gate();
    const resume = gate();
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
      calls += 1;
      if (calls === at) {
        entered.release();
        await resume.promise;
      }
      const current = h.app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile)) throw new Error('Missing current source');
      return await process(current, fn, options);
    });
    const pending = h.service.mutateStatus(request(h));
    await entered.promise;
    const lastProven = expectDefined(h.index.list()[0]);
    try {
      await applyRace(h, race, () => {
        excluded = true;
      });
    } finally {
      resume.release();
    }
    const outcome = await pending;
    expect(outcome).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true },
      followUp: { closed: at - 2, unclosed: 5 - at, state: 'partial' },
      occurrences: { original: { state: 'retained' } },
    });
    expect(calls).toBe(at);
    if (outcome.type !== 'result') throw new Error('Missing main result');
    expect(outcome.followUp?.root).toEqual(lastProven);
    expect(outcome.occurrences.original.current).toBeUndefined();
    expect(await h.read('a.md')).toContain('[x] Root');
  });
}

it.each(['before', 'after'] as const)(
  'advances both unprojected nested Keep roles through discarded and closed timers (%s)',
  async (placement) => {
    const h = await harness(
      '- [ ] Root\n  - [ ] Repeat 🔁 every day 📅 2026-08-01\n    - 2026-08-01T11:59:30Z →\n    - 2026-08-01T11:00:00Z →\n  - [ ] Sibling\n',
      {
        behaviorSettings: () => ({
          ...DEFAULT_SETTINGS,
          recurrence: { ...DEFAULT_SETTINGS.recurrence, newOccurrencePlacement: placement },
        }),
      },
    );
    // No read projection of the selected or future active node is needed for role seeding.
    const outcome = await h.service.mutateStatus(request(h, true));
    expect(outcome).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true, outcome: { type: 'recurrence' } },
      followUp: { closed: 2, unclosed: 0, state: 'complete', discardedShortEntry: true },
    });
    if (outcome.type !== 'result') throw new Error('Missing main result');
    const root = expectDefined(h.index.list()[0]);
    expect(outcome.occurrences).toMatchObject({
      original: {
        state: 'retained',
        current: {
          rootRevision: root.ref.revision,
          nodeOffset: placement === 'before' ? 2 : 1,
        },
      },
      next: {
        state: 'retained',
        current: { rootRevision: root.ref.revision, nodeOffset: placement === 'before' ? 1 : 3 },
      },
    });
    expect(outcome.occurrences.original.current?.rootRevision).not.toBe(
      outcome.occurrences.original.origin.rootRevision,
    );
    expect(outcome.occurrences.next?.current?.rootRevision).not.toBe(
      outcome.occurrences.next?.origin.rootRevision,
    );
    expect(await h.read('a.md')).not.toContain('11:59:30');
    expect(await h.read('a.md')).toContain('11:00:00Z → 2026-08-01T12:00:00+00:00');
  },
);

it('keeps both known recurrence roles after an unproved edit between timer closures', async () => {
  const h = await harness(
    '- [ ] Root\n  - [ ] Repeat 🔁 every day 📅 2026-08-01\n    - 2026-08-01T11:59:30Z →\n    - 2026-08-01T11:00:00Z →\n',
  );
  const process = h.app.vault.process.bind(h.app.vault);
  let calls = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
    calls += 1;
    if (calls === 3) await h.external('a.md', (await h.read('a.md')).replace('Root', 'Edited'));
    return await process(file, fn, options);
  });
  const outcome = await h.service.mutateStatus(request(h, true));
  expect(outcome).toMatchObject({
    type: 'result',
    result: { type: 'ok', changed: true },
    followUp: { closed: 1, unclosed: 1, state: 'partial', discardedShortEntry: true },
    occurrences: { original: { state: 'retained' }, next: { state: 'retained' } },
  });
  if (outcome.type !== 'result') throw new Error('Missing main result');
  expect(outcome.occurrences.original.current).toBeUndefined();
  expect(outcome.occurrences.next?.current).toBeUndefined();
  expect(outcome.occurrences.next?.origin).toBeDefined();
  expect(calls).toBe(3);
});

it('accepts early trusted metadata before each timer writer returns', async () => {
  const h = await harness();
  h.index.installCommittedContent('a.md', source);
  const emit = metadataChangedEmitter(h.app);
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn) => {
    const candidate = fn(await h.app.vault.read(file));
    emit(file, candidate, {
      listItems: [
        {
          task: 'x',
          parent: -1,
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: 10, offset: 10 },
          },
        },
      ],
    });
    await h.app.vault.modify(file, candidate);
    await flushMicrotasks();
    return candidate;
  });
  expect(await h.service.mutateStatus(request(h))).toMatchObject({
    type: 'result',
    result: { type: 'ok', changed: true },
    followUp: { closed: 3, unclosed: 0, state: 'complete' },
  });
  expect(await h.read('a.md')).toContain('11:30:00Z → 2026-08-01T12:00:00+00:00');
});

it('preserves unaffected current proof and never starts a timer writer after lease failure', async () => {
  const h = await harness();
  h.index.installCommittedContent('a.md', source);
  h.index.installCommittedContent('b.md', '');
  const other = h.app.vault.getAbstractFileByPath('b.md');
  if (!(other instanceof TFile)) throw new Error('Missing other source');
  const read = h.app.vault.read.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
    if (file === other) throw new Error('read failed');
    return await read(file);
  });
  let started = false;
  const subscription = h.reads.subscribe((event) => {
    if (started || event.type !== 'accepted') return;
    started = true;
    metadataChangedEmitter(h.app)(other, '', {});
  });
  const writes = vi.spyOn(h.app.vault, 'process');
  try {
    const outcome = await h.service.mutateStatus(request(h));
    expect(outcome).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true },
      followUp: { closed: 0, unclosed: 3, state: 'partial' },
      occurrences: { original: { state: 'retained', current: { filePath: 'a.md' } } },
    });
    expect(writes).toHaveBeenCalledTimes(1);
  } finally {
    await flushMicrotasks();
    subscription.unsubscribe();
  }
});

it('retains a discarded short timer in strict details when the second timer has an I/O failure', async () => {
  const h = await harness('- [ ] Root\n  - 2026-08-01T11:59:30Z →\n  - 2026-08-01T11:00:00Z →\n');
  const process = h.app.vault.process.bind(h.app.vault);
  let writes = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, fn, options) => {
    writes += 1;
    if (writes === 3) throw new Error('disk full');
    return await process(file, fn, options);
  });
  expect(await h.service.mutateStatus(request(h))).toMatchObject({
    type: 'result',
    result: { type: 'ok', changed: true },
    followUp: { closed: 1, unclosed: 1, state: 'unknown', discardedShortEntry: true },
    occurrences: { original: { state: 'retained' } },
  });
  expect(await h.read('a.md')).not.toContain('11:59:30');
  expect(await h.read('a.md')).toContain('- [x] Root');
  expect(writes).toBe(3);
});

it.each(['x', '-'] as const)(
  'retains strict timer progress when %s becomes unfinished after main acceptance',
  async (symbol) => {
    const catalog = new StatusCatalog([
      { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
      { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
      { id: 'cancelled', symbol: '-', type: 'cancelled', defaultForType: true },
    ]);
    const content = '- [ ] Root\n  - 2026-08-01T11:00:00Z →\n';
    const h = await harness(content, { index: { statusCatalog: catalog } });
    h.index.installCommittedContent('a.md', content);
    let changed = false;
    let mainRoot = request(h).root;
    const subscription = h.reads.subscribe((event) => {
      if (changed || event.type !== 'accepted') return;
      changed = true;
      mainRoot = expectDefined(event.change.after[0]);
      catalog.replace(
        catalog
          .all()
          .map((rule) =>
            rule.symbol === symbol ? { ...rule, type: 'todo', defaultForType: false } : rule,
          ),
      );
      h.index.setStatusCatalog(catalog);
    });
    const writes = vi.spyOn(h.app.vault, 'process');
    try {
      const outcome = await h.service.mutateStatus({
        ...request(h),
        intent: symbol === 'x' ? { type: 'complete' } : { type: 'set-status', symbol },
      });
      expect(outcome).toMatchObject({
        type: 'result',
        result: { type: 'ok', changed: true },
        followUp: { root: mainRoot, closed: 0, unclosed: 1, state: 'partial' },
        occurrences: { original: { state: 'retained' } },
      });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await h.read('a.md')).toContain(`- [${symbol}] Root`);
      expect(await h.read('a.md')).toContain('11:00:00Z →\n');
    } finally {
      subscription.unsubscribe();
    }
  },
);

it.each([false, true])(
  'leaves strict unfinished transitions without timer work (catalog changes=%s)',
  async (changeCatalog) => {
    const catalog = new StatusCatalog([
      { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
      { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
    ]);
    const content = '- [x] Root\n  - 2026-08-01T11:00:00Z →\n';
    const h = await harness(content, { index: { statusCatalog: catalog } });
    h.index.installCommittedContent('a.md', content);
    let changed = false;
    const subscription = h.reads.subscribe((event) => {
      if (!changeCatalog || changed || event.type !== 'accepted') return;
      changed = true;
      catalog.replace([
        { id: 'open', symbol: ' ', type: 'done', defaultForType: true },
        { id: 'done', symbol: 'x', type: 'todo', defaultForType: true },
      ]);
      h.index.setStatusCatalog(catalog);
    });
    const writes = vi.spyOn(h.app.vault, 'process');
    try {
      expect(
        await h.service.mutateStatus({
          ...request(h),
          intent: { type: 'set-status', symbol: ' ' },
        }),
      ).toMatchObject({
        type: 'result',
        result: { type: 'ok', changed: true },
        followUp: { closed: 0, unclosed: 0, state: 'complete' },
      });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await h.read('a.md')).toBe(content.replace('[x]', '[ ]'));
    } finally {
      subscription.unsubscribe();
    }
  },
);

it('preserves ordinary live-catalog eligibility after main acceptance', async () => {
  const catalog = new StatusCatalog([
    { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
    { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
  ]);
  const content = '- [ ] Root\n  - 2026-08-01T11:00:00Z →\n';
  const h = await harness(content, { index: { statusCatalog: catalog } });
  h.index.installCommittedContent('a.md', content);
  h.reads.activateOccurrences();
  let changed = false;
  const subscription = h.reads.subscribe((event) => {
    if (changed || event.type !== 'accepted') return;
    changed = true;
    catalog.replace([
      { id: 'open', symbol: ' ', type: 'todo', defaultForType: true },
      { id: 'done', symbol: 'x', type: 'todo', defaultForType: false },
    ]);
    h.index.setStatusCatalog(catalog);
  });
  const writes = vi.spyOn(h.app.vault, 'process');
  try {
    const outcome = await h.service.execute({
      type: 'set-status',
      target: request(h).target,
      symbol: 'x',
    });
    expect(outcome).toMatchObject({ type: 'ok', changed: true });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await h.read('a.md')).toContain('- [x] Root');
    expect(await h.read('a.md')).toContain('11:00:00Z →\n');
  } finally {
    subscription.unsubscribe();
  }
});
