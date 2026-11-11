import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskReadNode,
  TaskReadResult,
} from '../../src/tasks/application/TaskIntegrationReadApi';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskStatusRule } from '../../src/tasks/domain/types';
import { publicApiHarness, type PublicApiHarness } from '../support/publicApiHarness';

function requireReadNode(
  result: TaskReadResult<{ readonly nodes: readonly TaskReadNode[] }>,
): TaskReadNode {
  if (
    result.type !== 'ok' ||
    result.value.nodes.length !== 1 ||
    result.value.nodes[0] === undefined
  )
    throw new Error('Expected exactly one current node');
  return result.value.nodes[0];
}
const rules: readonly TaskStatusRule[] = [
  { id: 'todo', symbol: ' ', type: 'todo', defaultForType: true },
  { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
  { id: 'other-done', symbol: 'D', type: 'done', defaultForType: false },
  { id: 'cancelled', symbol: '-', type: 'cancelled', defaultForType: true },
];
const harnesses: PublicApiHarness[] = [];
async function harness(source: string, statuses = rules): Promise<PublicApiHarness> {
  const h = await publicApiHarness(
    { 'a.md': source },
    { index: { statusCatalog: new StatusCatalog(statuses) } },
  );
  harnesses.push(h);
  return h;
}
function row(h: PublicApiHarness, line = 0): TaskReadNode {
  return requireReadNode(h.reads.resolve({ source: { path: 'a.md', line } }));
}
function request(h: PublicApiHarness, line = 0) {
  const value = row(h, line).value;
  return { root: value.root, target: value.target, observation: h.reads.capture() };
}
afterEach(() => {
  vi.restoreAllMocks();
  harnesses.splice(0).forEach((h) => {
    h.dispose();
  });
});

describe('guarded desired-state status', () => {
  it('complete on a custom done symbol is an exact guarded noop', async () => {
    const source = '- [D] already done 🔁 every day\n';
    const h = await harness(source);
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } });
    expect(result).toMatchObject({ type: 'result', result: { type: 'ok', changed: false } });
    expect(await h.read('a.md')).toBe(source);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('already done bypasses missing defaults, new blockers and running timers', async () => {
    const source =
      '- [D] done 🆔 done ⛔ blocker\n  - 2026-08-01T11:00:00+00:00 →\n- [ ] blocker 🆔 blocker\n';
    const h = await harness(
      source,
      rules.filter((r) => r.id !== 'done'),
    );
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: false } });
    expect(await h.read('a.md')).toBe(source);
  });

  it('applies completion blockers to a newly completed task', async () => {
    const source = '- [ ] task ⛔ blocker\n- [ ] blocker 🆔 blocker\n';
    const h = await harness(source);
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } }),
    ).toMatchObject({ type: 'result', result: { type: 'blocked' } });
    expect(await h.read('a.md')).toBe(source);
  });

  it('exact configured same-symbol setStatus bypasses cancellation semantics and blockers', async () => {
    const source = '- [x] cancelled ❌ 2026-07-01 ⛔ blocker\n- [ ] blocker 🆔 blocker\n';
    const h = await harness(source);
    expect(row(h).status).toBe('cancelled');
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'set-status', symbol: 'x' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: false } });
    expect(await h.read('a.md')).toBe(source);
  });

  it.each(['complete', 'toggle-completion'] as const)(
    '%s agrees with reads when cancellation overrides a done checkbox',
    async (type) => {
      const h = await harness('- [x] cancelled ❌ 2026-07-01\n');
      expect(row(h).status).toBe('cancelled');
      expect(await h.service.mutateStatus({ ...request(h), intent: { type } })).toMatchObject({
        type: 'result',
        result: { type: 'ok', changed: true },
      });
      expect(await h.read('a.md')).toBe('- [x] cancelled ✅ 2026-08-01\n');
      expect(row(h).status).toBe('done');
    },
  );

  it('set-status to a different done symbol clears an overriding cancellation', async () => {
    const h = await harness('- [D] cancelled ❌ 2026-07-01\n');
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'set-status', symbol: 'x' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: true } });
    expect(await h.read('a.md')).toBe('- [x] cancelled ✅ 2026-08-01\n');
  });

  it.each([
    ['- [-] cancelled ❌ 2026-07-01\n', '- [x] cancelled ✅ 2026-08-01\n'],
    ['- [D] done ✅ 2026-07-01\n', '- [ ] done\n'],
  ])('toggle selects a semantic default for %s', async (source, expected) => {
    const h = await harness(source);
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'toggle-completion' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: true } });
    expect(await h.read('a.md')).toBe(expected);
  });

  it('normalizes X through the configured catalog while preserving an exact existing X', async () => {
    const h = await harness('- [ ] open\n- [X] done\n');
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'set-status', symbol: 'X' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: true } });
    expect(await h.read('a.md')).toBe('- [x] open ✅ 2026-08-01\n- [X] done\n');
    expect(
      await h.service.mutateStatus({
        ...request(h, 1),
        intent: { type: 'set-status', symbol: 'x' },
      }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: false } });
  });

  it('changes a different symbol with the same semantic state without replacing its date or recurring', async () => {
    const h = await harness('- [D] done 🔁 every day ✅ 2026-07-01\n');
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'set-status', symbol: 'x' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: true } });
    expect(await h.read('a.md')).toBe('- [x] done 🔁 every day ✅ 2026-07-01\n');
  });

  it.each([
    ['complete', rules.filter((r) => r.id !== 'done'), '- [ ] open\n'],
    ['toggle-completion', rules.filter((r) => r.id !== 'todo'), '- [x] done\n'],
    ['complete', rules.filter((r) => r.id !== 'todo'), '- [ ] repeat 🔁 every day\n'],
  ] as const)('rejects a missing needed default for %s', async (type, statuses, source) => {
    const h = await harness(source, statuses);
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.service.mutateStatus({ ...request(h), intent: { type } })).toEqual({
      type: 'rejected',
      reason: 'missing-default-status',
    });
    expect(process).not.toHaveBeenCalled();
    expect(await h.read('a.md')).toBe(source);
  });

  it('rejects an unsupported symbol without writing', async () => {
    const h = await harness('- [ ] open\n');
    const process = vi.spyOn(h.app.vault, 'process');
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'set-status', symbol: '?' } }),
    ).toEqual({ type: 'rejected', reason: 'unsupported-status' });
    expect(process).not.toHaveBeenCalled();
  });

  it('preserves invalid recurrence and needs no todo default', async () => {
    const h = await harness(
      '- [ ] open 🔁 tomorrow\n',
      rules.filter((r) => r.id !== 'todo'),
    );
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok', changed: true } });
    expect(await h.read('a.md')).toBe('- [x] open 🔁 tomorrow ✅ 2026-08-01\n');
  });

  it.each(['complete', 'toggle-completion'] as const)(
    '%s recurs a cancelled done checkbox',
    async (type) => {
      const h = await harness('- [x] repeat 🔁 every day 📅 2026-08-01 ❌ 2026-07-01\n');
      expect(row(h).status).toBe('cancelled');
      const result = await h.service.mutateStatus({ ...request(h), intent: { type } });
      expect(result).toMatchObject({
        type: 'result',
        result: { type: 'ok', changed: true, outcome: { type: 'recurrence' } },
        occurrences: {
          original: { state: 'retained', current: { rootLine: 1 } },
          next: { state: 'retained', current: { rootLine: 0 } },
        },
      });
      expect(await h.read('a.md')).toBe(
        '- [ ] repeat 🔁 every day ➕ 2026-08-01 📅 2026-08-02\n- [x] repeat 🔁 every day 📅 2026-08-01 ✅ 2026-08-01\n',
      );
    },
  );

  it('recurs when set-status changes a cancelled done checkbox to another done symbol', async () => {
    const h = await harness('- [D] repeat 🔁 every day 📅 2026-08-01 ❌ 2026-07-01\n');
    const result = await h.service.mutateStatus({
      ...request(h),
      intent: { type: 'set-status', symbol: 'x' },
    });
    expect(result).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true, outcome: { type: 'recurrence' } },
      occurrences: { original: { state: 'retained' }, next: { state: 'retained' } },
    });
    expect(await h.read('a.md')).toContain('- [x] repeat 🔁 every day 📅 2026-08-01 ✅ 2026-08-01');
  });

  it('retains both nested occurrence roles when a cancelled done checkbox recurs', async () => {
    const h = await harness(
      '- [ ] root\n  - [x] repeat 🔁 every day 📅 2026-08-01 ❌ 2026-07-01\n',
    );
    const result = await h.service.mutateStatus({ ...request(h, 1), intent: { type: 'complete' } });
    expect(result).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true, outcome: { type: 'recurrence' } },
      occurrences: {
        original: { state: 'retained', current: { rootLine: 0, nodeOffset: 2 } },
        next: { state: 'retained', current: { rootLine: 0, nodeOffset: 1 } },
      },
    });
    expect(await h.read('a.md')).toContain(
      '  - [x] repeat 🔁 every day 📅 2026-08-01 ✅ 2026-08-01',
    );
  });

  it('returns explicit original and next occurrences from a recurring completion', async () => {
    const h = await harness('- [ ] repeat 🔁 every day 📅 2026-08-01\n');
    const result = await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } });
    expect(result).toMatchObject({
      type: 'result',
      result: { type: 'ok', outcome: { type: 'recurrence' } },
      occurrences: {
        original: { state: 'retained', current: { rootLine: 1 } },
        next: { state: 'retained', current: { rootLine: 0 } },
      },
    });
  });

  it.each([
    ['- [ ] remove 🏁 delete\n', 0, ''],
    ['- [ ] root\n  - [ ] remove 🏁 delete\n', 1, '- [ ] root\n'],
  ] as const)('proves removal on completion for %s', async (source, line, expected) => {
    const h = await harness(source);
    expect(
      await h.service.mutateStatus({ ...request(h, line), intent: { type: 'complete' } }),
    ).toMatchObject({
      type: 'result',
      result: { type: 'ok', changed: true },
      occurrences: { original: { state: 'removed' } },
    });
    expect(await h.read('a.md')).toBe(expected);
  });

  it('runs one strict follow-up without duplicating the status writer', async () => {
    const h = await harness('- [ ] task\n  - 2026-08-01T11:00:00+00:00 →\n');
    const process = vi.spyOn(h.app.vault, 'process');
    expect(
      await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } }),
    ).toMatchObject({ type: 'result', result: { type: 'ok' } });
    expect(await h.read('a.md')).toContain('→ 2026-08-01T12:00:00+00:00');
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('rejects a source changed inside the writer without retrying', async () => {
    const h = await harness('- [ ] original\n');
    const original = h.app.vault.process.bind(h.app.vault);
    const process = vi
      .spyOn(h.app.vault, 'process')
      .mockImplementationOnce(
        async (file, transform, options) =>
          await original(file, () => transform('- [ ] changed\n'), options),
      );
    expect(await h.service.mutateStatus({ ...request(h), intent: { type: 'complete' } })).toEqual({
      type: 'rejected',
      reason: 'revision-changed',
    });
    expect(process).toHaveBeenCalledTimes(1);
    expect(await h.read('a.md')).toBe('- [ ] changed\n');
  });

  it('rejects globally incomplete permitted coverage before a new strict write', async () => {
    const h = await publicApiHarness({ 'a.md': '- [ ] open\n', 'b.md': '' });
    harnesses.push(h);
    const submitted = request(h);
    vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValueOnce(new Error('read failed'));
    await h.index.refreshSourceExclusion(undefined);
    expect(
      await h.service.mutateStatus({
        ...submitted,
        observation: h.reads.capture(),
        intent: { type: 'complete' },
      }),
    ).toEqual({ type: 'rejected', reason: 'incomplete-read' });
    expect(await h.read('a.md')).toBe('- [ ] open\n');
  });
});
