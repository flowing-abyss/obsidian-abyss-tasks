import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { CommandSession } from '../src/ai/CommandSession';
import { TaskApiProvider } from '../src/integrations/TaskApiProvider';
import { expectDefined, useRealMoment } from './helpers';
import { taskCreatePreparationHarness } from './support/taskCreatePreparationHarness';

useRealMoment();
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => {
    dispose();
  });
});
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
async function setup(partial = false) {
  const h = await taskCreatePreparationHarness();
  const now = Date.UTC(2026, 10, 7, 12);
  const provider = new TaskApiProvider({
    reads: h.index.integrationReads(),
    mutations: h.service,
    content: { edits: h.service, creates: h.service, statuses: () => h.catalog.all() },
    pluginVersion: 'test',
    epoch: 'command-refresh',
    now: () => now,
    diagnostic: () => {},
  });
  cleanup.push(() => {
    provider.dispose();
    h.index.destroy();
  });
  const api = ok(provider.getApi(1, { consumerId: 'command-refresh' }));
  let sequence = 0;
  const session: CommandSession = new CommandSession({
    api,
    now: () => now,
    id: () => `refresh-${++sequence}`,
    journal: { save: async () => {} },
    agent: {
      run: async ({ signal, session: state }) => {
        if (partial)
          await session.confirmFromTurn(state.proposal.revision, signal, false, {
            proposalRevision: state.proposal.revision,
            changes: [{ kind: 'change', index: 0 }],
          });
      },
    },
  });
  cleanup.push(() => {
    session.dispose();
  });
  return { ...h, api, session };
}
it('saves three prepared roots in one missing destination using proven creation receipts', async () => {
  const h = await setup();
  const creates = vi.spyOn(h.app.vault, 'create');
  for (const title of ['One', 'Two', 'Three']) {
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: title },
      }),
    );
    h.session.stage({ kind: 'task', plan });
  }
  expect(await h.session.confirm()).toBe(true);
  expect(creates.mock.calls.filter(([path]) => path === 'draft/new.md')).toHaveLength(1);
  expect(
    h.index
      .list()
      .filter((root) => root.ref.filePath === 'draft/new.md')
      .map((root) => root.title),
  ).toEqual(['One', 'Two', 'Three']);
  expect(h.session.snapshot().actual.map((root) => root.markdownTitle)).toEqual([
    'One',
    'Two',
    'Three',
  ]);
  expect(h.session.snapshot().journal).toHaveLength(3);
  expect(
    h.session
      .snapshot()
      .journal.every((entry) => entry.state === 'settled' && entry.effects === 'committed'),
  ).toBe(true);
  expect(await h.session.confirm()).toBe(false);
  expect(creates.mock.calls.filter(([path]) => path === 'draft/new.md')).toHaveLength(1);
});
it('retains later roots on a proven fresh destination after selecting only the first creation', async () => {
  const h = await setup(true);
  for (const title of ['One', 'Two', 'Three']) {
    const plan = ok(
      await expectDefined(h.api.tasks.prepare)({
        kind: 'create',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: title },
      }),
    );
    h.session.stage({ kind: 'task', plan });
  }
  await h.session.submit('Save only the first task');
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(h.session.snapshot().proposal.changes).toHaveLength(2);
  expect(
    h.index
      .list()
      .filter((root) => root.ref.filePath === 'draft/new.md')
      .map((root) => root.title),
  ).toEqual(['One']);
  expect(await h.session.confirm()).toBe(true);
  expect(
    h.index
      .list()
      .filter((root) => root.ref.filePath === 'draft/new.md')
      .map((root) => root.title),
  ).toEqual(['One', 'Two', 'Three']);
});
it('does not treat a successful path match as proof of a different destination basis', async () => {
  const h = await setup();
  const prepare = expectDefined(h.api.tasks.prepare);
  const first = ok(
    await prepare({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'One' },
    }),
  );
  const second = ok(
    await prepare({
      kind: 'create',
      destination: {
        type: 'note',
        path: 'draft/new.md',
        insertion: { type: 'prepend' },
        provision: 'if-missing',
      },
      tree: { markdownTitle: 'Two' },
    }),
  );
  h.session.stage({ kind: 'task', plan: first });
  h.session.stage({ kind: 'task', plan: second });
  expect(await h.session.confirm()).toBe(false);
  expect(
    h.index
      .list()
      .filter((root) => root.ref.filePath === 'draft/new.md')
      .map((root) => root.title),
  ).toEqual(['One']);
  expect(h.session.snapshot().journal).toHaveLength(1);
  expect(h.session.snapshot().blocked).toBe(true);
});
