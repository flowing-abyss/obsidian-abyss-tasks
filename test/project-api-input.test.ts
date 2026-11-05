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
          { fieldId: 'property:Z', value: 1 },
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
});
