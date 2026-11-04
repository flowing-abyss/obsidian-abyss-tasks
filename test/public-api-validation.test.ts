import { describe, expect, it } from 'vitest';
import {
  validateConsumer,
  validateList,
  validateMutation,
  validateReadOptions,
  validateSelector,
} from '../src/integrations/validation';
import { apiError, freezeValue } from '../src/integrations/values';

const request = {
  target: 'opaque',
  expectedRevision: 'revision',
  requestId: 'r:1',
  expiresAt: 123,
};

describe('public API validation', () => {
  it('rejects traversal and clones normalized filters before caller mutation', () => {
    expect(validateList({ folder: 'a/../b' }).ok).toBe(false);
    const input = { tagsAll: ['#Work', '#work'], limit: 10 };
    const parsed = validateList(input);
    input.tagsAll.push('#secret');
    expect(parsed).toEqual({ ok: true, value: { tagsAll: ['#work'], limit: 10 } });
    if (parsed.ok) expect(Object.isFrozen(parsed.value.tagsAll)).toBe(true);
    expect(Object.isFrozen(input.tagsAll)).toBe(false);
  });

  it.each([' ', 'x', 'X', '/', '?'])(
    'preserves space and normalizes the catalog X symbol: %j',
    (symbol) => {
      expect(validateMutation('setStatus', { ...request, symbol })).toEqual({
        ok: true,
        value: { ...request, symbol: symbol === 'X' ? 'x' : symbol },
      });
    },
  );

  it('normalizes optional undefined fields without inserting defaults', () => {
    expect(validateList(undefined)).toEqual({ ok: true, value: {} });
    expect(
      validateList({ path: undefined, folder: '', statuses: undefined, dates: undefined }),
    ).toEqual({ ok: true, value: { folder: '' } });
    expect(validateReadOptions({ signal: undefined })).toEqual({ ok: true, value: {} });
  });

  it('accepts plain and null-prototype records but rejects class instances', () => {
    expect(validateList(Object.assign(Object.create(null), { path: 'Дела/tasks.md' }))).toEqual({
      ok: true,
      value: { path: 'Дела/tasks.md' },
    });
    class Query {
      limit = 10;
    }
    expect(validateList(new Query()).ok).toBe(false);
  });

  it('rejects accessors without evaluating them', () => {
    let calls = 0;
    const input = Object.defineProperty({}, 'path', {
      enumerable: true,
      get: () => {
        calls += 1;
        return 'secret.md';
      },
    });
    expect(validateList(input).ok).toBe(false);
    expect(validateSelector({ source: input }).ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('does not treat inherited record fields as submitted input', () => {
    Object.defineProperty(Object.prototype, 'path', { configurable: true, value: 'inherited.md' });
    try {
      expect(validateList({})).toEqual({ ok: true, value: {} });
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path');
    }
  });

  it('returns invalid arguments for hostile proxies', () => {
    const input = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('private vault text');
        },
      },
    );
    expect(validateList(input)).toEqual({
      ok: false,
      error: { category: 'validation', code: 'INVALID_ARGUMENT', message: 'Invalid API argument.' },
    });
  });

  it.each([
    null,
    true,
    2,
    'query',
    [],
    { surprise: undefined },
    { [Symbol('key')]: 1 },
    { limit: Symbol('n') },
    { limit: () => 1 },
  ])('rejects malformed request records: %j', (input) => {
    expect(validateList(input).ok).toBe(false);
  });

  it.each(['', '/a.md', 'a.md/', 'a//b.md', './a.md', 'a/../b', 'a\\b', 'a\0b', 'x'.repeat(4097)])(
    'rejects invalid source paths',
    (path) => {
      expect(validateList({ path }).ok).toBe(false);
      expect(validateSelector({ source: { path, line: 0 } }).ok).toBe(false);
    },
  );

  it('preserves valid path spelling and exact boundaries', () => {
    const path = 'Équipe/WORK.md';
    expect(validateList({ path })).toEqual({ ok: true, value: { path } });
    expect(validateList({ path: 'x'.repeat(4096) }).ok).toBe(true);
    expect(validateList({ path, folder: 'Équipe' }).ok).toBe(false);
  });

  it.each([0, -1, 501, 1.5, NaN, Infinity])('rejects out-of-range page sizes: %j', (limit) => {
    expect(validateList({ limit }).ok).toBe(false);
  });

  it('bounds and validates status, tag and date filters', () => {
    for (const input of [
      { statuses: [] },
      { statuses: ['open', 'open'] },
      { statuses: ['waiting'] },
      { statuses: Array(10000).fill('open') },
      { tagsAll: [] },
      { tagsAll: ['work'] },
      { tagsAll: ['#bad tag'] },
      { tagsAll: ['#123'] },
      { tagsAll: Array(21).fill('#work') },
      { dates: [] },
      { dates: [{ field: 'due' }] },
      { dates: [{ field: 'other', from: '2026-11-04' }] },
      { dates: [{ field: 'due', from: '2026-02-29' }] },
      { dates: [{ field: 'due', from: '2026-1-01' }] },
      { dates: [{ field: 'due', from: '2026-11-05', to: '2026-11-04' }] },
      {
        dates: [
          { field: 'due', from: '2026-11-04' },
          { field: 'due', to: '2026-11-05' },
        ],
      },
    ])
      expect(validateList(input).ok).toBe(false);
    expect(
      validateList({
        statuses: ['open', 'in-progress', 'done', 'cancelled'],
        tagsAll: ['#Работа/Next', '#работа/next'],
        dates: [{ field: 'due', from: '2024-02-29', to: '2026-11-04' }],
        limit: 500,
      }).ok,
    ).toBe(true);
  });

  it('detaches and freezes nested query records', () => {
    const input = { dates: [{ field: 'due', from: '2026-11-04' }], statuses: ['open'] };
    const result = validateList(input);
    const first = input.dates[0];
    if (first !== undefined) first.from = '2020-01-01';
    input.statuses.push('done');
    expect(result).toEqual({
      ok: true,
      value: { dates: [{ field: 'due', from: '2026-11-04' }], statuses: ['open'] },
    });
    if (result.ok) expect(Object.isFrozen(result.value.dates?.[0])).toBe(true);
  });

  it('rejects sparse arrays and array accessors without running them', () => {
    let calls = 0;
    const tags = Object.defineProperty(['#ok'], '0', {
      get: () => {
        calls += 1;
        return '#secret';
      },
    });
    expect(validateList({ tagsAll: tags }).ok).toBe(false);
    expect(validateList({ tagsAll: Array(2) }).ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('rejects excessive filters behind a changing proxy length', () => {
    const tags = Array.from({ length: 21 }, (_, index) => `#tag${index}`);
    let reads = 0;
    const proxied = new Proxy(tags, {
      get(target, key, receiver): unknown {
        if (key === 'length' && reads++ < 2) return 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(validateList({ tagsAll: proxied }).ok).toBe(false);
  });

  it.each<[string, unknown[]]>([
    ['tagsAll', ['#one', '#two']],
    ['statuses', ['open', 'done']],
    [
      'dates',
      [
        { field: 'due', from: '2026-11-04' },
        { field: 'start', to: '2026-11-04' },
      ],
    ],
  ])('rejects %s when admitted own length disagrees with array keys', (field, values) => {
    const filters = new Proxy(values, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === 'length' ? { ...descriptor, value: 1 } : descriptor;
      },
    });
    expect(validateList({ [field]: filters }).ok).toBe(false);
  });

  it('validates exact selector unions and source coordinates', () => {
    expect(validateSelector({ source: { path: 'tasks.md', line: 0 } }).ok).toBe(true);
    expect(validateSelector({ authoredId: 'ID-1' })).toEqual({
      ok: true,
      value: { authoredId: 'ID-1' },
    });
    for (const input of [
      {},
      { authoredId: '' },
      { authoredId: 'a'.repeat(257) },
      { authoredId: 'a', source: { path: 'x', line: 0 } },
      { source: { path: 'x', line: -1 } },
      { source: { path: 'x', line: 0.5 } },
      { source: { path: 'x', line: Number.MAX_SAFE_INTEGER + 1 } },
    ])
      expect(validateSelector(input).ok).toBe(false);
  });

  it('bounds opaque tokens and ASCII request namespaces', () => {
    expect(validateConsumer('plugin.ID:1-test_2')).toEqual({
      ok: true,
      value: 'plugin.ID:1-test_2',
    });
    for (const value of ['', 'a b', 'é', 'a'.repeat(129), null]) {
      expect(validateConsumer(value).ok).toBe(false);
      expect(validateMutation('complete', { ...request, requestId: value }).ok).toBe(false);
    }
    expect(validateConsumer('a'.repeat(128)).ok).toBe(true);
    for (const target of ['', 'a'.repeat(513), 1])
      expect(validateMutation('complete', { ...request, target }).ok).toBe(false);
    expect(validateMutation('complete', { ...request, target: 'a'.repeat(512) }).ok).toBe(true);
    expect(validateList({ cursor: 'a'.repeat(513) }).ok).toBe(false);
    expect(validateList({ cursor: '' }).ok).toBe(false);
  });

  it('validates primitive deadlines without applying the admission clock', () => {
    for (const expiresAt of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '123'])
      expect(validateMutation('complete', { ...request, expiresAt }).ok).toBe(false);
    expect(validateMutation('complete', request).ok).toBe(true);
    expect(validateMutation('toggleCompletion', request).ok).toBe(true);
    expect(validateMutation('complete', { ...request, symbol: 'x' }).ok).toBe(false);
    for (const symbol of ['', 'xx', '😀', undefined, 1])
      expect(validateMutation('setStatus', { ...request, symbol }).ok).toBe(false);
  });

  it('retains a live cancellation capability without freezing or cloning it', () => {
    let listener: (() => void) | undefined;
    let dispatched = false;
    const signal = {
      aborted: false,
      addEventListener(_type: 'abort', callback: () => void): void {
        listener = callback;
      },
      removeEventListener(): void {
        listener = undefined;
      },
    };
    const result = validateReadOptions({ signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signal).toBe(signal);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(signal)).toBe(false);
    result.value.signal?.addEventListener('abort', () => {
      dispatched = true;
    });
    signal.aborted = true;
    listener?.();
    expect(result.value.signal?.aborted).toBe(true);
    expect(dispatched).toBe(true);
    expect(validateReadOptions({ signal: new AbortController().signal }).ok).toBe(true);
  });

  it.each([
    null,
    {},
    { aborted: false },
    { aborted: 'false', addEventListener(): void {}, removeEventListener(): void {} },
  ])('rejects invalid cancellation shapes', (signal) => {
    expect(validateReadOptions({ signal }).ok).toBe(false);
  });

  it('freezes newly owned nested data and omits absent diagnostics', () => {
    const data = freezeValue({ nested: [{ code: 'TEST' }] });
    expect(Object.isFrozen(data.nested[0])).toBe(true);
    expect(apiError('internal', 'INTERNAL_ERROR', 'Operation failed.')).toEqual({
      category: 'internal',
      code: 'INTERNAL_ERROR',
      message: 'Operation failed.',
    });
    expect(apiError('internal', 'INTERNAL_ERROR', 'Operation failed.', 'diagnostic:1')).toEqual({
      category: 'internal',
      code: 'INTERNAL_ERROR',
      message: 'Operation failed.',
      diagnosticId: 'diagnostic:1',
    });
  });
});
