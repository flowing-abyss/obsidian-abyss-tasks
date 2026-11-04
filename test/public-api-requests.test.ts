import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResultV1, MutationResultV1, StatusMutationV1 } from '../api';
import { TaskRequestRegistry } from '../src/integrations/TaskRequestRegistry';
import { freezeValue } from '../src/integrations/values';
import { flushMicrotasks } from './helpers';

const input: StatusMutationV1 = Object.freeze({
  target: 'target',
  expectedRevision: 'revision',
  requestId: 'request',
  expiresAt: 2_000,
});
const terminal: MutationResultV1 = freezeValue({
  ok: true,
  receipt: {
    providerEpoch: 'epoch',
    requestId: 'request',
    acceptedAt: 1_000,
    expiresAt: 2_000,
    outcome: 'noop',
    effects: 'unchanged',
    recovery: 'none',
    original: { target: 'target', state: 'retained' },
    snapshots: 'unavailable',
    warnings: [],
  },
});
const barriers = new Set<() => void>();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  barriers.add(resolve);
  return { promise, resolve };
}
function ticket(run: (acceptedAt: number) => Promise<MutationResultV1> = async () => terminal) {
  return { execute: vi.fn(run), release: vi.fn() };
}
const live = () => false;
const forbidden = vi.fn((): never => {
  throw new Error('re-admitted');
});
function options(value = ticket()) {
  return { isDisposed: live, admit: () => ({ ok: true as const, value }) };
}
function expectFailure(result: MutationResultV1, code: string, recovery = 'none') {
  expect(result).toMatchObject({ ok: false, error: { code }, effects: 'unchanged', recovery });
  expect(result).not.toHaveProperty('receipt');
}
afterEach(async () => {
  for (const resolve of barriers) resolve();
  barriers.clear();
  await flushMicrotasks();
  vi.restoreAllMocks();
  forbidden.mockClear();
});

describe('bounded mutation requests', () => {
  it('does not admit after a lifecycle capability synchronously disposes the provider', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    expectFailure(
      await registry.execute('consumer', 'complete', input, {
        isDisposed: () => {
          registry.dispose();
          return false;
        },
        admit: forbidden,
      }),
      'DISPOSED',
    );
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('snapshots the request before admission can mutate caller input', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const mutable = { ...input };
    await registry.execute('consumer', 'complete', mutable, {
      isDisposed: live,
      admit: () => {
        mutable.target = 'other';
        mutable.expiresAt = 5_000;
        return { ok: true, value: ticket() };
      },
    });
    expect(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
    ).toEqual(terminal);
    expectFailure(
      await registry.execute('consumer', 'complete', mutable, {
        isDisposed: live,
        admit: forbidden,
      }),
      'REQUEST_ID_REUSED',
    );
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('validates shape before replaying a retained ID', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    await registry.execute('consumer', 'complete', input, options());
    expectFailure(
      await registry.execute(
        'consumer',
        'complete',
        { ...input, expiresAt: NaN },
        { isDisposed: live, admit: forbidden },
      ),
      'INVALID_ARGUMENT',
    );
    expectFailure(
      await registry.execute('consumer', 'setStatus', input, {
        isDisposed: live,
        admit: forbidden,
      }),
      'INVALID_ARGUMENT',
    );
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([
    ['conflict', 'REVISION_CONFLICT', 'reread'],
    ['unavailable', 'INCOMPLETE_READ', 'reread'],
    ['lifecycle', 'NOT_READY', 'reread'],
    ['unsupported', 'UNSUPPORTED_STATUS', 'none'],
    ['resource', 'RESOURCE_LIMIT', 'retry-same-request'],
  ] as const)('keeps rejected admission unaccepted: %s %s', async (category, code, recovery) => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    expectFailure(
      await registry.execute('consumer', 'complete', input, {
        isDisposed: live,
        admit: () => ({ ok: false, error: { category, code, message: 'Unavailable.' } }),
      }),
      code,
      recovery,
    );
    expect(await registry.execute('consumer', 'complete', input, options())).toEqual(terminal);
  });

  it('reserves before execution, joins in-flight duplicates and retains the original timestamp', async () => {
    let now = 1_000;
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now });
    const barrier = deferred();
    let nested: Promise<MutationResultV1> | undefined;
    const accepted = ticket(async (acceptedAt) => {
      nested = registry.execute('consumer', 'complete', input, {
        isDisposed: live,
        admit: forbidden,
      });
      await barrier.promise;
      return freezeValue({ ...terminal, receipt: { ...terminal.receipt, acceptedAt } });
    });
    const first = registry.execute('consumer', 'complete', input, options(accepted));
    const second = registry.execute('consumer', 'complete', input, {
      isDisposed: live,
      admit: forbidden,
    });
    expect(accepted.execute).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(accepted.release).not.toHaveBeenCalled();
    now = 3_000;
    barrier.resolve();
    expect(await first).toEqual(terminal);
    expect(await second).toEqual(terminal);
    expect(await nested).toEqual(terminal);
    expect(accepted.release).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([
    ['toggleCompletion', {}],
    ['complete', { target: 'other' }],
    ['complete', { expectedRevision: 'other' }],
    ['complete', { expiresAt: 2_001 }],
  ] as const)('rejects retained ID reuse: %s %j', async (method, changes) => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    await registry.execute('consumer', 'complete', input, options());
    expectFailure(
      await registry.execute(
        'consumer',
        method,
        { ...input, ...changes },
        { isDisposed: live, admit: forbidden },
      ),
      'REQUEST_ID_REUSED',
    );
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('normalizes X without a catalog and rejects a different normalized symbol', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    await registry.execute('consumer', 'setStatus', { ...input, symbol: 'X' }, options());
    expect(
      await registry.execute(
        'consumer',
        'setStatus',
        { ...input, symbol: 'x' },
        { isDisposed: live, admit: forbidden },
      ),
    ).toEqual(terminal);
    expectFailure(
      await registry.execute(
        'consumer',
        'setStatus',
        { ...input, symbol: ' ' },
        { isDisposed: live, admit: forbidden },
      ),
      'REQUEST_ID_REUSED',
    );
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([
    'UNSUPPORTED_STATUS',
    'INITIALIZATION_FAILED',
    'NOT_READY',
    'REVISION_CONFLICT',
    'INCOMPLETE_READ',
  ])('replays before current admission could reject with %s', async (code) => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    await registry.execute('consumer', 'setStatus', { ...input, symbol: 'x' }, options());
    const admit = vi.fn(() => ({
      ok: false as const,
      error: { category: 'unavailable' as const, code, message: 'Changed state.' },
    }));
    expect(
      await registry.execute(
        'consumer',
        'setStatus',
        { ...input, symbol: 'X' },
        { isDisposed: live, admit },
      ),
    ).toEqual(terminal);
    expect(admit).not.toHaveBeenCalled();
  });

  it('isolates consumer namespaces and shares requests across client lifetimes', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const a = ticket();
    const b = ticket();
    let disposed = false;
    const first = registry.execute('a', 'complete', input, {
      ...options(a),
      isDisposed: () => disposed,
    });
    disposed = true;
    expect(await first).toEqual(terminal);
    expectFailure(
      await registry.execute('a', 'complete', input, { ...options(), isDisposed: () => disposed }),
      'DISPOSED',
    );
    expect(
      await registry.execute('a', 'complete', input, { isDisposed: live, admit: forbidden }),
    ).toEqual(terminal);
    await registry.execute('b', 'complete', input, options(b));
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(b.execute).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('honors pre-admission abort but an aborted duplicate still joins', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const controller = new AbortController();
    controller.abort();
    expectFailure(
      await registry.execute('consumer', 'complete', input, {
        isDisposed: live,
        admit: forbidden,
        signal: controller.signal,
      }),
      'ABORTED',
      'retry-same-request',
    );
    expect(forbidden).not.toHaveBeenCalled();
    const barrier = deferred();
    const accepted = ticket(async () => {
      await barrier.promise;
      return terminal;
    });
    const first = registry.execute('consumer', 'complete', input, options(accepted));
    const second = registry.execute('consumer', 'complete', input, {
      isDisposed: live,
      admit: forbidden,
      signal: controller.signal,
    });
    barrier.resolve();
    expect(await first).toEqual(terminal);
    expect(await second).toEqual(terminal);
    expect(accepted.execute).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'observes abort=%s from the lifecycle callback after ticket acquisition',
    async (abort) => {
      const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
      const controller = new AbortController();
      let acquired = false;
      const accepted = ticket();
      const result = await registry.execute('consumer', 'complete', input, {
        signal: controller.signal,
        isDisposed: () => {
          if (acquired && abort) controller.abort();
          return false;
        },
        admit: () => {
          acquired = true;
          return { ok: true, value: accepted };
        },
      });
      expect(controller.signal.aborted).toBe(abort);
      if (abort) expectFailure(result, 'ABORTED', 'retry-same-request');
      else expect(result).toEqual(terminal);
      expect(accepted.execute).toHaveBeenCalledTimes(abort ? 0 : 1);
      expect(accepted.release).toHaveBeenCalledTimes(1);
    },
  );

  it('replays an accepted request before an abort raised by the final lifecycle callback', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const controller = new AbortController();
    let acquired = false;
    let inner: Promise<MutationResultV1> | undefined;
    const committed: MutationResultV1 = freezeValue({
      ok: true,
      receipt: { ...terminal.receipt, outcome: 'changed', effects: 'committed' },
    });
    const accepted = ticket(async () => committed);
    const duplicate = ticket();
    const outer = registry.execute('consumer', 'complete', input, {
      signal: controller.signal,
      isDisposed: () => {
        if (acquired) {
          acquired = false;
          inner = registry.execute('consumer', 'complete', input, options(accepted));
          controller.abort();
        }
        return false;
      },
      admit: () => {
        acquired = true;
        return { ok: true, value: duplicate };
      },
    });
    expect(await outer).toEqual(committed);
    expect(await inner).toEqual(committed);
    expect(accepted.execute).toHaveBeenCalledTimes(1);
    expect(accepted.release).toHaveBeenCalledTimes(1);
    expect(duplicate.execute).not.toHaveBeenCalled();
    expect(duplicate.release).toHaveBeenCalledTimes(1);
  });

  it.each([true, false, 'throw'] as const)(
    'joins accepted work created by a signal getter returning %s',
    async (aborted) => {
      const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
      const committed: MutationResultV1 = freezeValue({
        ok: true,
        receipt: { ...terminal.receipt, outcome: 'changed', effects: 'committed' },
      });
      const accepted = ticket(async () => committed);
      const outerAdmission = vi.fn(options().admit);
      let inner: Promise<MutationResultV1> | undefined;
      const outer = registry.execute('consumer', 'complete', input, {
        isDisposed: live,
        admit: outerAdmission,
        signal: {
          get aborted() {
            inner = registry.execute('consumer', 'complete', input, options(accepted));
            if (aborted === 'throw') throw new Error('private signal');
            return aborted;
          },
          addEventListener() {},
          removeEventListener() {},
        },
      });
      expect(await outer).toEqual(committed);
      expect(await inner).toEqual(committed);
      expect(outerAdmission).not.toHaveBeenCalled();
      expect(accepted.execute).toHaveBeenCalledExactlyOnceWith(1_000);
      expect(accepted.release).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes a throwing signal getter when no request was accepted', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const result = await registry.execute('consumer', 'complete', input, {
      isDisposed: live,
      admit: forbidden,
      signal: {
        get aborted(): boolean {
          throw new Error('private signal');
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    expectFailure(result, 'INTERNAL_ERROR');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([result, log.mock.calls])).not.toContain('private signal');
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([
    ['client-dispose', 'DISPOSED'],
    ['provider-dispose', 'DISPOSED'],
    ['expire', 'REQUEST_EXPIRED'],
  ] as const)('preserves %s precedence when a signal getter returns true', async (change, code) => {
    let now = 1_000;
    let disposed = false;
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now });
    const result = await registry.execute('consumer', 'complete', input, {
      isDisposed: () => disposed,
      admit: forbidden,
      signal: {
        get aborted() {
          if (change === 'client-dispose') disposed = true;
          if (change === 'provider-dispose') registry.dispose();
          if (change === 'expire') now = 2_000;
          return true;
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    expectFailure(result, code);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('does not evict live terminal results and frees pending capacity at settlement', async () => {
    const registry = new TaskRequestRegistry({
      epoch: 'epoch',
      now: () => 1_000,
      maxPendingPerConsumer: 1,
      maxRetainedPerConsumer: 2,
    });
    await registry.execute('consumer', 'complete', input, options());
    expect(
      (await registry.execute('consumer', 'complete', { ...input, requestId: 'second' }, options()))
        .ok,
    ).toBe(true);
    expectFailure(
      await registry.execute('consumer', 'complete', { ...input, requestId: 'third' }, options()),
      'RESOURCE_LIMIT',
      'retry-same-request',
    );
    expect(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
    ).toEqual(terminal);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('reclaims already-settled expired records when admitting new work', async () => {
    let now = 1_000;
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now, maxRetained: 1 });
    await registry.execute('consumer', 'complete', input, options());
    now = 2_000;
    const accepted = ticket();
    expect(
      (
        await registry.execute(
          'consumer',
          'complete',
          { ...input, requestId: 'fresh', expiresAt: 3_000 },
          options(accepted),
        )
      ).ok,
    ).toBe(true);
    expect(accepted.execute).toHaveBeenCalledTimes(1);
    expectFailure(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
      'REQUEST_EXPIRED',
    );
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('preserves a known committed result when cleanup throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const committed: MutationResultV1 = freezeValue({
      ok: true,
      receipt: { ...terminal.receipt, outcome: 'changed', effects: 'committed' },
    });
    const accepted = ticket(async () => committed);
    accepted.release.mockImplementation(() => {
      throw new Error('private cleanup');
    });
    expect(await registry.execute('consumer', 'complete', input, options(accepted))).toEqual(
      committed,
    );
    expect(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
    ).toEqual(committed);
    expect(accepted.release).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private cleanup');
  });

  it('does not roll effective time back across synchronous clock reentry', async () => {
    let wall = 1_000;
    let reenter = false;
    let inner: Promise<MutationResultV1> | undefined;
    const registry = new TaskRequestRegistry({
      epoch: 'epoch',
      now: () => {
        if (reenter) {
          reenter = false;
          wall = 5_000;
          inner = registry.execute(
            'consumer',
            'complete',
            { ...input, requestId: 'inner', expiresAt: 6_000 },
            options(),
          );
          return 1_000;
        }
        return wall;
      },
    });
    await registry.execute('consumer', 'complete', input, options());
    reenter = true;
    expectFailure(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
      'REQUEST_EXPIRED',
    );
    await inner;
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each(['abort', 'client-dispose', 'provider-dispose', 'throw', 'expire'] as const)(
    'releases the acquired ticket if %s occurs before reservation',
    async (change) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let now = 1_000;
      let disposed = false;
      let acquired = false;
      const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now });
      const controller = new AbortController();
      const accepted = ticket();
      const result = await registry.execute('consumer', 'complete', input, {
        signal: controller.signal,
        isDisposed: () => {
          if (change === 'throw' && acquired) throw new Error('private');
          return disposed;
        },
        admit: () => {
          acquired = true;
          if (change === 'abort') controller.abort();
          if (change === 'client-dispose') disposed = true;
          if (change === 'provider-dispose') registry.dispose();
          if (change === 'expire') now = 2_000;
          return { ok: true, value: accepted };
        },
      });
      expect(result.ok).toBe(false);
      expect(accepted.execute).not.toHaveBeenCalled();
      expect(accepted.release).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(change === 'throw' ? 1 : 0);
    },
  );

  it('rechecks reservation after synchronous same-request admission reentry', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const inner = ticket();
    const outer = ticket();
    let joined: Promise<MutationResultV1> | undefined;
    const result = registry.execute('consumer', 'complete', input, {
      isDisposed: live,
      admit: () => {
        joined = registry.execute('consumer', 'complete', input, options(inner));
        return { ok: true, value: outer };
      },
    });
    expect(await result).toEqual(terminal);
    expect(await joined).toEqual(terminal);
    expect(inner.execute).toHaveBeenCalledTimes(1);
    expect(inner.release).toHaveBeenCalledTimes(1);
    expect(outer.execute).not.toHaveBeenCalled();
    expect(outer.release).toHaveBeenCalledTimes(1);
  });

  it.each(['maxPendingPerConsumer', 'maxRetainedPerConsumer', 'maxRetained'] as const)(
    'rejects %s overflow and releases only the unaccepted ticket',
    async (limit) => {
      const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000, [limit]: 1 });
      const barrier = deferred();
      const firstTicket = ticket(async () => {
        await barrier.promise;
        return terminal;
      });
      const first = registry.execute('consumer', 'complete', input, options(firstTicket));
      const rejected = ticket();
      expectFailure(
        await registry.execute(
          limit === 'maxRetained' ? 'other' : 'consumer',
          'complete',
          { ...input, requestId: 'second' },
          options(rejected),
        ),
        'RESOURCE_LIMIT',
        'retry-same-request',
      );
      expect(rejected.execute).not.toHaveBeenCalled();
      expect(rejected.release).toHaveBeenCalledTimes(1);
      const duplicate = registry.execute('consumer', 'complete', input, {
        isDisposed: live,
        admit: forbidden,
      });
      barrier.resolve();
      await first;
      expect(await duplicate).toEqual(terminal);
      expect(firstTicket.release).toHaveBeenCalledTimes(1);
      expect(forbidden).not.toHaveBeenCalled();
    },
  );

  it('pins expired in-flight records, evicts expired terminal records and prevents clock rollback revival', async () => {
    let now = 1_000;
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now, maxRetained: 1 });
    const barrier = deferred();
    const first = registry.execute(
      'consumer',
      'complete',
      input,
      options(
        ticket(async () => {
          await barrier.promise;
          return terminal;
        }),
      ),
    );
    now = 2_000;
    expectFailure(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
      'REQUEST_EXPIRED',
    );
    const fresh = { ...input, requestId: 'fresh', expiresAt: 3_000 };
    expectFailure(
      await registry.execute('consumer', 'complete', fresh, options()),
      'RESOURCE_LIMIT',
      'retry-same-request',
    );
    barrier.resolve();
    await first;
    expect((await registry.execute('consumer', 'complete', fresh, options())).ok).toBe(true);
    now = 1_000;
    expectFailure(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
      'REQUEST_EXPIRED',
    );
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('checks the five-minute window for new requests and captures reservation time after admission', async () => {
    let now = 1_000;
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now });
    expectFailure(
      await registry.execute(
        'consumer',
        'complete',
        { ...input, expiresAt: 301_001 },
        { isDisposed: live, admit: forbidden },
      ),
      'INVALID_ARGUMENT',
    );
    const accepted = ticket();
    await registry.execute(
      'consumer',
      'complete',
      { ...input, expiresAt: 301_000 },
      {
        isDisposed: live,
        admit: () => {
          now = 1_500;
          return { ok: true, value: accepted };
        },
      },
    );
    expect(accepted.execute).toHaveBeenCalledExactlyOnceWith(1_500);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('retains accepted failures without rerunning them', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const failed: MutationResultV1 = freezeValue<MutationResultV1>({
      ok: false,
      error: { category: 'conflict', code: 'REVISION_CONFLICT', message: 'Changed.' },
      effects: 'unchanged',
      recovery: 'reread',
      receipt: { ...terminal.receipt, outcome: 'failed', recovery: 'reread' },
    });
    const accepted = ticket(async () => failed);
    expect(await registry.execute('consumer', 'complete', input, options(accepted))).toEqual(
      failed,
    );
    expect(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
    ).toEqual(failed);
    expect(accepted.execute).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('retains sanitized unknown receipts for unexpected accepted execution rejection', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const accepted = ticket(async () => {
      throw new Error('private source');
    });
    const first = await registry.execute('consumer', 'complete', input, options(accepted));
    expect(first).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
      effects: 'unknown',
      recovery: 'reconcile',
      receipt: {
        providerEpoch: 'epoch',
        requestId: 'request',
        acceptedAt: 1_000,
        expiresAt: 2_000,
        outcome: 'failed',
        effects: 'unknown',
        recovery: 'reconcile',
        original: { target: 'target', state: 'unproven' },
        snapshots: 'unavailable',
      },
    });
    expect(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
    ).toEqual(first);
    expect(JSON.stringify([first, log.mock.calls])).not.toContain('private source');
    expect(log).toHaveBeenCalledTimes(1);
    expect(accepted.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a throwing admission unaccepted and permits a subsequent admission', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    let pins = 0;
    expectFailure(
      await registry.execute('consumer', 'complete', input, {
        isDisposed: live,
        admit: (): ApiResultV1<never> => {
          pins++;
          try {
            throw new Error('ticket construction');
          } finally {
            pins--;
          }
        },
      }),
      'INTERNAL_ERROR',
    );
    expect(pins).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await registry.execute('consumer', 'complete', input, options())).toEqual(terminal);
  });

  it('lets accepted work settle after provider disposal and refuses later calls', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1_000 });
    const barrier = deferred();
    const accepted = ticket(async () => {
      await barrier.promise;
      return terminal;
    });
    const first = registry.execute('consumer', 'complete', input, options(accepted));
    registry.dispose();
    registry.dispose();
    expect(accepted.release).not.toHaveBeenCalled();
    expectFailure(
      await registry.execute('consumer', 'complete', input, { isDisposed: live, admit: forbidden }),
      'DISPOSED',
    );
    barrier.resolve();
    expect(await first).toEqual(terminal);
    expect(accepted.release).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
