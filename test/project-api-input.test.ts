import { describe, expect, it, vi } from 'vitest';
import { validateProjectMutation } from '../src/integrations/projectValidation';
import { TaskRequestRegistry } from '../src/integrations/TaskRequestRegistry';

describe('project request admission', () => {
  it('normalizes field order and rejects duplicate case aliases', () => {
    const input = {
      name: 'Project',
      requestId: 'one',
      expiresAt: 2000,
      fields: [
        { fieldId: 'property:Z', value: 1 },
        { fieldId: 'start', value: '2026-01-01' },
      ],
    };
    expect(validateProjectMutation('projects.create', input)).toMatchObject({
      ok: true,
      value: {
        fields: [
          { fieldId: 'property:z', value: 1 },
          { fieldId: 'start', value: '2026-01-01' },
        ],
      },
    });
    expect(
      validateProjectMutation('projects.create', {
        ...input,
        fields: [
          { fieldId: 'property:Z', value: 1 },
          { fieldId: 'property:z', value: 2 },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
  it('shares IDs and pending quota with task requests', async () => {
    const registry = new TaskRequestRegistry({
      epoch: 'epoch',
      now: () => 1000,
      maxPendingPerConsumer: 1,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = registry.executeProject(
      'consumer',
      'projects.create',
      { name: 'P', requestId: 'same', expiresAt: 2000 },
      {
        isDisposed: () => false,
        admit: () => ({
          ok: true,
          value: {
            execute: async () => {
              await pending;
              return {
                ok: true,
                receipt: {
                  providerEpoch: 'epoch',
                  requestId: 'same',
                  acceptedAt: 1000,
                  expiresAt: 2000,
                  outcome: 'noop',
                  effects: 'unchanged',
                  recovery: 'none',
                },
              };
            },
            release: () => {},
            unknown: () => ({
              providerEpoch: 'epoch',
              requestId: 'same',
              acceptedAt: 1000,
              expiresAt: 2000,
              outcome: 'failed',
              effects: 'unknown',
              recovery: 'reconcile',
            }),
          },
        }),
      },
    );
    const task = {
      target: 'target',
      expectedRevision: 'revision',
      requestId: 'same',
      expiresAt: 2000,
    };
    const options = {
      isDisposed: () => false,
      admit: () => {
        throw new Error('unexpected');
      },
    };
    expect(await registry.execute('consumer', 'complete', task, options)).toMatchObject({
      ok: false,
      error: { code: 'REQUEST_ID_REUSED' },
    });
    expect(
      await registry.execute(
        'consumer',
        'complete',
        { ...task, requestId: 'other' },
        {
          isDisposed: () => false,
          admit: () => ({
            ok: true,
            value: {
              execute: async () => {
                throw new Error('unexpected');
              },
              release: () => {},
            },
          }),
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
    release();
    await first;
  });
  it('caps aggregate retained project payloads while letting an exact replay join', async () => {
    let now = 1000;
    const registry = new TaskRequestRegistry({
      epoch: 'epoch',
      now: () => now,
      maxProjectBytes: 180,
    });
    const input = { name: 'P', requestId: 'one', expiresAt: 2000 };
    const receipt = {
      providerEpoch: 'epoch',
      requestId: 'one',
      acceptedAt: 1000,
      expiresAt: 2000,
      outcome: 'noop' as const,
      effects: 'unchanged' as const,
      recovery: 'none' as const,
    };
    const options = {
      isDisposed: () => false,
      admit: () => ({
        ok: true as const,
        value: {
          execute: async () => ({ ok: true as const, receipt }),
          release: () => {},
          unknown: () => ({
            ...receipt,
            outcome: 'failed' as const,
            effects: 'unknown' as const,
            recovery: 'reconcile' as const,
          }),
        },
      }),
    };
    expect((await registry.executeProject('consumer', 'projects.create', input, options)).ok).toBe(
      true,
    );
    expect((await registry.executeProject('consumer', 'projects.create', input, options)).ok).toBe(
      true,
    );
    expect(
      await registry.executeProject(
        'consumer',
        'projects.create',
        { ...input, name: 'X'.repeat(100), requestId: 'two' },
        options,
      ),
    ).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
    now = 2000;
    expect(
      (
        await registry.executeProject(
          'consumer',
          'projects.create',
          { ...input, requestId: 'two', expiresAt: 3000 },
          options,
        )
      ).ok,
    ).toBe(true);
  });
  it('rejects oversized and unsafe inputs before admission', () => {
    const input = { name: 'P', requestId: 'one', expiresAt: 2000 };
    expect(
      validateProjectMutation('projects.create', {
        ...input,
        fields: [{ fieldId: 'property:x', value: Array(10).fill('😀'.repeat(5000)) }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateProjectMutation('projects.create', {
        ...input,
        fields: [{ fieldId: 'property:constructor', value: 'x' }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateProjectMutation('projects.create', { ...input, name: 'one\ntwo' }),
    ).toMatchObject({ ok: false });
    expect(
      validateProjectMutation('projects.create', {
        ...input,
        get name() {
          throw new Error('private');
        },
      }),
    ).toMatchObject({ ok: false });
  });
  it('rejects unknown non-enumerable project options', () => {
    const input = Object.defineProperty(
      { name: 'P', requestId: 'one', expiresAt: 2000 },
      'hidden',
      { value: 1 },
    );
    expect(validateProjectMutation('projects.create', input).ok).toBe(false);
  });
  it('retains an immutable project receipt when accepted execution throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1000 });
      const input = { name: 'Private', requestId: 'one', expiresAt: 2000 };
      const execute = vi.fn(async () => {
        throw new Error('private');
      });
      const options = {
        isDisposed: () => false,
        admit: () => ({
          ok: true as const,
          value: {
            execute,
            release: () => {},
            unknown: (acceptedAt: number) => ({
              providerEpoch: 'epoch',
              requestId: 'one',
              acceptedAt,
              expiresAt: 2000,
              outcome: 'failed' as const,
              effects: 'unknown' as const,
              recovery: 'reconcile' as const,
            }),
          },
        }),
      };
      const result = await registry.executeProject('consumer', 'projects.create', input, options);
      expect(result).toMatchObject({
        ok: false,
        effects: 'unknown',
        receipt: { outcome: 'failed', acceptedAt: 1000 },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(await registry.executeProject('consumer', 'projects.create', input, options)).toEqual(
        result,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('Private');
    } finally {
      log.mockRestore();
    }
  });
  it('accepts exactly 65536 normalized JSON bytes and rejects one byte more', () => {
    const make = (size: number) => ({
      name: 'P',
      requestId: 'one',
      expiresAt: 2000,
      fields: [
        ...Array.from({ length: 4 }, (_, i) => ({
          fieldId: `property:${i}`,
          value: 'x'.repeat(16000),
        })),
        { fieldId: 'property:4', value: 'x'.repeat(size) },
      ],
    });
    const empty = make(1);
    const length = new TextEncoder().encode(
      JSON.stringify({
        requestId: empty.requestId,
        expiresAt: empty.expiresAt,
        name: empty.name,
        fields: empty.fields,
      }),
    ).length;
    expect(validateProjectMutation('projects.create', make(1 + 65536 - length)).ok).toBe(true);
    expect(validateProjectMutation('projects.create', make(2 + 65536 - length)).ok).toBe(false);
  });
  it('accepts the exact 64-field boundary including escaped and UTF-8 text', () => {
    const make = (extra: number) => ({
      name: 'p',
      requestId: 'a',
      expiresAt: 2,
      fields: Array.from({ length: 64 }, (_, i) => ({
        fieldId: `property:${i}`,
        value: 'x'.repeat(975 + (i === 0 ? extra : 0)),
      })),
    });
    expect(validateProjectMutation('projects.create', make(725)).ok).toBe(true);
    expect(validateProjectMutation('projects.create', make(726)).ok).toBe(false);
    const escaped = {
      name: 'p',
      requestId: 'a',
      expiresAt: 2,
      fields: [{ fieldId: 'property:x', value: '"😀' }],
    };
    expect(validateProjectMutation('projects.create', escaped).ok).toBe(true);
  });
  it('counts escaped and multibyte JSON exactly at the input boundary', () => {
    const make = (size: number) => ({
      name: 'P',
      requestId: 'one',
      expiresAt: 2000,
      fields: [
        ...Array.from({ length: 4 }, (_, i) => ({
          fieldId: `property:${i}`,
          value: 'x'.repeat(16000),
        })),
        { fieldId: 'property:4', value: `😀"\\${'x'.repeat(size)}` },
      ],
    });
    const sample = make(1);
    const length = new TextEncoder().encode(
      JSON.stringify({
        requestId: sample.requestId,
        expiresAt: sample.expiresAt,
        name: sample.name,
        fields: sample.fields,
      }),
    ).length;
    expect(validateProjectMutation('projects.create', make(1 + 65536 - length)).ok).toBe(true);
    expect(validateProjectMutation('projects.create', make(2 + 65536 - length)).ok).toBe(false);
  });
  it('canonicalizes case aliases and sorts by code units for replay', () => {
    const first = {
      name: 'P',
      requestId: 'one',
      expiresAt: 2000,
      fields: [
        { fieldId: 'property:é', value: 1 },
        { fieldId: 'property:e', value: 2 },
      ],
    };
    const second = {
      ...first,
      fields: [
        { fieldId: 'PROPERTY:E', value: 2 },
        { fieldId: 'PROPERTY:É', value: 1 },
      ],
    };
    expect(validateProjectMutation('projects.create', first)).toEqual(
      validateProjectMutation('projects.create', second),
    );
    expect(validateProjectMutation('projects.create', first)).toMatchObject({
      value: { fields: [{ fieldId: 'property:e' }, { fieldId: 'property:é' }] },
    });
  });
  it('joins a reordered, case-equivalent project request even for distinct collation-equal IDs', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1000 });
    const first = {
      name: 'P',
      requestId: 'one',
      expiresAt: 2000,
      fields: [
        { fieldId: 'property:é', value: 1 },
        { fieldId: 'property:e\u0301', value: 2 },
      ],
    };
    const second = {
      ...first,
      fields: [
        { fieldId: 'PROPERTY:E\u0301', value: 2 },
        { fieldId: 'PROPERTY:É', value: 1 },
      ],
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        providerEpoch: 'epoch',
        requestId: 'one',
        acceptedAt: 1000,
        expiresAt: 2000,
        outcome: 'noop' as const,
        effects: 'unchanged' as const,
        recovery: 'none' as const,
      },
    }));
    const options = {
      isDisposed: () => false,
      admit: () => ({
        ok: true as const,
        value: {
          execute,
          release: () => {},
          unknown: () => ({
            providerEpoch: 'epoch',
            requestId: 'one',
            acceptedAt: 1000,
            expiresAt: 2000,
            outcome: 'failed' as const,
            effects: 'unknown' as const,
            recovery: 'reconcile' as const,
          }),
        },
      }),
    };
    expect(await registry.executeProject('consumer', 'projects.create', first, options)).toEqual(
      await registry.executeProject('consumer', 'projects.create', second, options),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('settles and reclaims if execute, unknown and release throw', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let now = 1000;
      const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => now, maxRetained: 1 });
      const input = {
        target: 'secret',
        expectedRevision: 'r',
        taskTarget: 'task',
        expectedTaskRevision: 'tr',
        requestId: 'one',
        expiresAt: 2000,
      };
      const execute = vi.fn(async () => {
        throw new Error('secret');
      });
      const options = {
        isDisposed: () => false,
        admit: () => ({
          ok: true as const,
          value: {
            execute,
            unknown: () => {
              throw new Error('secret');
            },
            release: () => {
              throw new Error('secret');
            },
          },
        }),
      };
      const result = await registry.executeProject('consumer', 'projects.moveTask', input, options);
      expect(result).toMatchObject({
        ok: false,
        effects: 'unknown',
        receipt: {
          providerEpoch: 'epoch',
          requestId: 'one',
          outcome: 'failed',
          destinationCopy: 'unknown',
          sourceRemoval: 'unknown',
        },
      });
      expect(
        await registry.executeProject('consumer', 'projects.moveTask', input, options),
      ).toEqual(result);
      expect(execute).toHaveBeenCalledTimes(1);
      now = 2000;
      expect(
        await registry.executeProject(
          'consumer',
          'projects.moveTask',
          { ...input, requestId: 'two', expiresAt: 3000 },
          options,
        ),
      ).toHaveProperty('receipt.requestId', 'two');
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  }, 1000);
  it('adds a provider-owned receipt to an accepted failure lacking one', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1000 });
    const result = await registry.executeProject(
      'consumer',
      'projects.create',
      { name: 'P', requestId: 'one', expiresAt: 2000 },
      {
        isDisposed: () => false,
        admit: () => ({
          ok: true,
          value: {
            execute: async () =>
              ({
                ok: false,
                error: { category: 'conflict', code: 'CONFLICT', message: 'Changed.' },
                effects: 'unchanged',
                recovery: 'reread',
              }) as never,
            unknown: () => {
              throw new Error('unused');
            },
            release: () => {},
          },
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      effects: 'unchanged',
      receipt: { requestId: 'one', outcome: 'failed', effects: 'unchanged', recovery: 'reread' },
    });
  });
  it('replays an accepted failure with its original receipt', async () => {
    const registry = new TaskRequestRegistry({ epoch: 'epoch', now: () => 1000 });
    const input = { name: 'P', requestId: 'one', expiresAt: 2000 };
    const receipt = {
      providerEpoch: 'epoch',
      requestId: 'one',
      acceptedAt: 1000,
      expiresAt: 2000,
      outcome: 'failed' as const,
      effects: 'partial' as const,
      recovery: 'reconcile' as const,
    };
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { category: 'io' as const, code: 'FAILED', message: 'Failed.' },
      effects: 'partial' as const,
      recovery: 'reconcile' as const,
      receipt,
    }));
    const options = {
      isDisposed: () => false,
      admit: () => ({
        ok: true as const,
        value: { execute, release: () => {}, unknown: () => receipt },
      }),
    };
    const result = await registry.executeProject('consumer', 'projects.create', input, options);
    expect(result).toMatchObject({ ok: false, effects: 'partial', receipt });
    expect(await registry.executeProject('consumer', 'projects.create', input, options)).toEqual(
      result,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
