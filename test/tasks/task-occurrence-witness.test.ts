import { describe, expect, it, vi } from 'vitest';
import type { TaskAcceptedOccurrenceChange } from '../../src/tasks/application/TaskIntegrationReadApi';
import type { TaskOccurrenceWitness } from '../../src/tasks/domain/taskOccurrence';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { expectDefined, objectMatching } from '../helpers';
import { publicApiHarness } from '../support/publicApiHarness';

function stagedFixture(authority = new TaskRefAuthority('witness')) {
  const before = '- [ ] one\n  - [ ] old';
  const after = '- [x] one\n  - [ ] next';
  const predecessor = authority.revision(before);
  const successor = authority.mintRevision(after);
  const old = { filePath: 'a.md', rootRevision: predecessor, rootLine: 0, nodeOffset: 0 };
  const next = { ...old, rootRevision: successor };
  const occurrences: TaskOccurrenceWitness[] = [
    { kind: 'continued', before: old, after: next },
    { kind: 'removed', before: { ...old, nodeOffset: 1 } },
    { kind: 'created', after: { ...next, nodeOffset: 1 }, reason: 'recurrence' },
  ];
  const operation = {};
  const transition = {
    filePath: 'a.md',
    candidateFingerprint: taskRefContentFingerprint(after),
    candidateLength: after.length,
    expectedRevision: predecessor,
    roots: [{ line: 0, source: after, revision: successor }],
    occurrences,
    operation,
  };
  return {
    authority,
    before,
    after,
    predecessor,
    successor,
    old,
    next,
    occurrences,
    operation,
    transition,
  };
}

describe('occurrence witnesses', () => {
  it('transports frozen semantic evidence and the exact operation through early observation', () => {
    const f = stagedFixture();
    expect(f.authority.stage(f.transition, f.predecessor).type).toBe('staged');
    const observed = f.authority.observeTransition('a.md', f.after);
    expect(observed?.occurrences).toEqual(f.occurrences);
    expect(observed?.operation).toBe(f.operation);
    expect(Object.isFrozen(observed?.occurrences)).toBe(true);
    expect(Object.isFrozen(observed?.occurrences?.[0])).toBe(true);
    expect(
      Object.isFrozen(
        observed?.occurrences?.[0]?.kind === 'continued' && observed.occurrences[0].before,
      ),
    ).toBe(true);
  });

  it.each(['revision', 'offset', 'predecessor', 'successor'] as const)(
    'rejects invalid %s endpoints',
    (fault) => {
      const f = stagedFixture();
      if (fault === 'revision')
        f.occurrences[0] = {
          kind: 'continued',
          before: { ...f.old, rootRevision: 'invented' },
          after: f.next,
        };
      if (fault === 'offset')
        f.occurrences[0] = {
          kind: 'continued',
          before: { ...f.old, nodeOffset: 8 },
          after: f.next,
        };
      if (fault === 'predecessor') f.occurrences.push({ kind: 'removed', before: f.old });
      if (fault === 'successor') f.occurrences.push({ kind: 'created', after: f.next });
      expect(f.authority.stage(f.transition, f.predecessor).type).toBe('conflict');
    },
  );

  it.each(['abort', 'discard'] as const)('revokes evidence on %s', (action) => {
    const f = stagedFixture();
    const staged = f.authority.stage(f.transition, f.predecessor);
    if (staged.type !== 'staged') throw new Error('stage failed');
    if (action === 'abort') f.authority.abort(staged.token);
    else f.authority.discard('a.md');
    expect(f.authority.observeTransition('a.md', f.after)).toBeUndefined();
  });

  it('restoration keeps the operation but revokes forward semantic evidence', () => {
    const f = stagedFixture();
    const staged = f.authority.stage(f.transition, f.predecessor);
    if (staged.type !== 'staged') throw new Error('stage failed');
    expect(
      f.authority.retainPredecessors(staged.token, f.before, [
        { line: 0, source: f.before, revision: f.predecessor },
      ]),
    ).toBe(true);
    f.authority.observeTransition('a.md', f.after);
    expect(f.authority.stageRestoration(staged.token, f.before).type).toBe('staged');
    expect(f.authority.observeTransition('a.md', f.before)).toMatchObject({
      restored: true,
      occurrences: [],
      operation: f.operation,
    });
    expect(f.authority.observeTransition('a.md', f.after)).toBeUndefined();
  });
});

describe('accepted occurrence installation', () => {
  it.each(['metadata', 'repository', 'loaded'] as const)(
    'publishes %s semantics synchronously with readable canonical roots',
    async (route) => {
      const h = await publicApiHarness({ 'a.md': '- [ ] one\n  - [ ] old' });
      try {
        h.reads.activateOccurrences();
        const f = stagedFixture(h.authority);
        const accepted: TaskAcceptedOccurrenceChange[] = [];
        const readResults: unknown[] = [];
        h.reads.subscribe((event) => {
          if (event.type !== 'accepted') return;
          accepted.push(event.change);
          readResults.push(h.reads.node(f.next));
        });
        expect(h.authority.stage(f.transition, f.predecessor).type).toBe('staged');
        if (route === 'metadata') await h.external('a.md', f.after);
        else if (route === 'repository') h.index.installCommittedContent('a.md', f.after);
        else {
          vi.spyOn(h.app.vault, 'cachedRead').mockResolvedValue(f.after);
          await h.index.refreshSourceExclusion(undefined);
        }
        expect(accepted.length).toBeGreaterThan(0);
        expect(accepted.filter((change) => change.witnesses.length > 0)).toHaveLength(1);
        for (const result of readResults)
          expect(result).toMatchObject({ type: 'ok', value: { address: f.next } });
        expect(accepted[0]?.witnesses).toEqual(f.occurrences);
        expect(accepted[0]?.operation).toBe(f.operation);
        expect(accepted[0]?.sources[0]).toMatchObject({
          content: f.after,
          fileIdentity: h.app.vault.getFileByPath('a.md'),
        });
      } finally {
        h.dispose();
      }
    },
  );

  it('invalidates unproved changes without claiming removal and preserves unchanged roots', async () => {
    const h = await publicApiHarness({ 'a.md': '- [ ] one' });
    try {
      h.reads.activateOccurrences();
      const page = h.reads.page({}, 5);
      if (page.type !== 'ok') throw new Error('read failed');
      const old = expectDefined(page.value.nodes[0]).address;
      const changes: TaskAcceptedOccurrenceChange[] = [];
      h.reads.subscribe((event) => {
        if (event.type === 'accepted') changes.push(event.change);
      });
      await h.external('a.md', '- [ ] one');
      expect(changes[0]?.invalidated).toEqual([]);
      changes.length = 0;
      await h.external('a.md', '- [ ] other');
      expect(changes.every((change) => change.witnesses.length === 0)).toBe(true);
      expect(changes.flatMap((change) => change.invalidated)).toContainEqual(old);
    } finally {
      h.dispose();
    }
  });
});

it('never republishes a created occurrence on an identical accepted echo', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one' });
  try {
    h.reads.activateOccurrences();
    const before = h.authority.revision('- [ ] one');
    const after = '- [ ] one\n  - [ ] new';
    const revision = h.authority.mintRevision(after);
    const address = { filePath: 'a.md', rootRevision: revision, rootLine: 0, nodeOffset: 1 };
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    expect(
      h.authority.stage(
        {
          filePath: 'a.md',
          candidateFingerprint: taskRefContentFingerprint(after),
          candidateLength: after.length,
          expectedRevision: before,
          roots: [{ line: 0, source: after, revision }],
          occurrences: [{ kind: 'created', after: address }],
        },
        before,
      ).type,
    ).toBe('staged');
    h.index.installCommittedContent('a.md', after);
    h.index.installCommittedContent('a.md', after);
    expect(changes.map((change) => change.witnesses.length)).toEqual([1, 0]);
    expect(changes[1]?.invalidated).toEqual([]);
  } finally {
    h.dispose();
  }
});

it('rejects plausible staging coordinates that do not match canonical predecessors', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one\n  - [ ] old' });
  try {
    h.reads.activateOccurrences();
    const f = stagedFixture(h.authority);
    f.occurrences[0] = { kind: 'continued', before: { ...f.old, rootLine: 9 }, after: f.next };
    expect(h.authority.stage(f.transition, f.predecessor).type).toBe('staged');
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    h.index.installCommittedContent('a.md', f.after);
    expect(changes[0]?.witnesses).toEqual([]);
    expect(changes[0]?.invalidated).toContainEqual(f.old);
    expect(h.reads.node(f.next).type).toBe('ok');
  } finally {
    h.dispose();
  }
});

it('installs a whole batch and semantic evidence before held health or UI callbacks', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] a', 'b.md': '- [ ] b' });
  try {
    h.reads.activateOccurrences();
    const order: string[] = [];
    const views: unknown[] = [];
    const revisions: number[] = [];
    const coherent: boolean[] = [];
    const health: string[] = [];
    const searchOrder: string[][] = [];
    h.index.searchSource().subscribe(() => {
      searchOrder.push([...order]);
      views.push(h.reads.page({}, 10));
    });
    h.reads.subscribe((event) => {
      order.push(event.type);
      revisions.push(event.observation.revision);
      coherent.push(JSON.stringify(event.observation) === JSON.stringify(h.reads.capture()));
      if (event.type === 'health') health.push(event.change.phase);
      views.push(h.reads.page({}, 10));
    });
    h.index.installCommittedBatch(
      new Map([
        ['a.md', '- [x] a'],
        ['b.md', '- [x] b'],
      ]),
      (roots) => {
        expect(roots.map((root) => root.statusSymbol)).toEqual(['x', 'x']);
        expect(h.index.list().map((root) => root.statusSymbol)).toEqual([' ', ' ']);
      },
    );
    expect(order[0]).toBe('accepted');
    expect(searchOrder.length).toBeGreaterThan(0);
    for (const observed of searchOrder) expect(observed).toContain('accepted');
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(health).toEqual(['pending', 'pending', 'settled', 'settled']);
    expect(coherent.every(Boolean)).toBe(true);
    expect(order.filter((type) => type === 'accepted')).toHaveLength(1);
    for (const view of views)
      expect(view).toMatchObject({
        type: 'ok',
        value: { nodes: [{ status: 'done' }, { status: 'done' }] },
      });
  } finally {
    h.dispose();
  }
});

it('a rejected batch proof and preview cannot publish accepted semantics', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one\n  - [ ] old' });
  try {
    h.reads.activateOccurrences();
    const f = stagedFixture(h.authority);
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    expect(h.authority.stage(f.transition, f.predecessor).type).toBe('staged');
    h.index.previewContent('a.md', f.after);
    expect(changes).toEqual([]);
    expect(() =>
      h.index.installCommittedBatch(new Map([['a.md', f.after]]), () => {
        throw new Error('reject');
      }),
    ).toThrow('reject');
    expect(changes).toEqual([]);
    expect(h.index.list()[0]?.ref.revision).toBe(f.predecessor);
  } finally {
    h.dispose();
  }
});

it('failed restoration revokes forward observations without fabricating an inverse map', () => {
  const f = stagedFixture();
  const staged = f.authority.stage(f.transition, f.predecessor);
  if (staged.type !== 'staged') throw new Error('stage failed');
  f.authority.retainPredecessors(staged.token, f.before, [
    { line: 0, source: f.before, revision: f.predecessor },
  ]);
  expect(f.authority.stageRestoration(staged.token, 'wrong original').type).toBe('conflict');
  expect(f.authority.observeTransition('a.md', f.after)).toBeUndefined();
});

it('transports batch and structural witnesses while isolating replacement operation tokens', () => {
  const f = stagedFixture();
  const roots = f.transition.roots.map((root) => ({ ...root, previousRevision: f.predecessor }));
  const batch = f.authority.stageBatch({ ...f.transition, roots }, [f.predecessor]);
  if (batch.type !== 'staged') throw new Error('stage failed');
  expect(f.authority.observeTransition('a.md', f.after)?.occurrences).toEqual(f.occurrences);
  f.authority.discard('a.md');
  const replacement = {};
  const owner = f.authority.reserveStructuralMutation(
    [
      {
        filePath: 'a.md',
        before: f.before,
        after: f.after,
        predecessors: [{ line: 0, source: f.before, revision: f.predecessor }],
        roots,
        transitions: roots,
        occurrences: f.occurrences,
        operation: replacement,
      },
    ],
    () => [{ line: 0, source: f.before, revision: f.predecessor }],
  );
  expect(owner).toBeDefined();
  expect(f.authority.stageRestoration(batch.token, f.before).type).toBe('conflict');
  expect(owner?.forward('a.md', f.before)).toBe(f.after);
  expect(f.authority.observeTransition('a.md', f.after)?.operation).toBe(replacement);
  owner?.release();
});

it('activates semantic collection synchronously without changing ordinary read behavior', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one' });
  try {
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    h.index.installCommittedContent('a.md', '- [x] one');
    expect(changes).toEqual([]);
    h.reads.activateOccurrences();
    h.reads.activateOccurrences();
    h.index.installCommittedContent('a.md', '- [ ] one');
    expect(changes).toHaveLength(1);
    expect(Object.isFrozen(changes[0]?.before)).toBe(true);
    expect(Object.isFrozen(changes[0]?.sources)).toBe(true);
  } finally {
    h.dispose();
  }
});

it('accepts proven rename continuity before any health, Search, or UI callback reads relocated roots', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one' });
  try {
    h.reads.activateOccurrences();
    const page = h.reads.page({}, 1);
    if (page.type !== 'ok') throw new Error('read failed');
    const old = expectDefined(page.value.nodes[0]).address;
    let accepted = false;
    const callbacks: boolean[] = [];
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') {
        accepted = true;
        changes.push(event.change);
      } else callbacks.push(accepted);
    });
    h.index.searchSource().subscribe(() => {
      callbacks.push(accepted);
    });
    h.index.subscribe(() => {
      callbacks.push(accepted);
    });
    await h.app.vault.rename(expectDefined(h.app.vault.getFileByPath('a.md')), 'renamed.md');
    expect(changes[0]?.invalidated).toEqual([]);
    expect(changes[0]?.witnesses).toContainEqual({
      kind: 'continued',
      before: old,
      after: objectMatching({ filePath: 'renamed.md', nodeOffset: 0 }),
    });
    expect(changes[0]?.sources[0]?.fileIdentity).toBe(h.app.vault.getFileByPath('renamed.md'));
    expect(callbacks.length).toBeGreaterThan(0);
    expect(callbacks.every(Boolean)).toBe(true);
    expect(h.reads.resolve({ source: { path: 'renamed.md', line: 0 } })).toMatchObject({
      type: 'ok',
      value: { nodes: [{ address: { filePath: 'renamed.md' } }] },
    });
  } finally {
    h.dispose();
  }
});

it('restored acceptance invalidates forward addresses and never grants inverse continuation', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one\n  - [ ] old' });
  try {
    h.reads.activateOccurrences();
    const f = stagedFixture(h.authority);
    const staged = h.authority.stage(f.transition, f.predecessor);
    if (staged.type !== 'staged') throw new Error('stage failed');
    h.authority.retainPredecessors(staged.token, f.before, [
      { line: 0, source: f.before, revision: f.predecessor },
    ]);
    h.index.installCommittedContent('a.md', f.after);
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    expect(h.authority.stageRestoration(staged.token, f.before).type).toBe('staged');
    h.index.installCommittedContent('a.md', f.before);
    expect(changes[0]).toMatchObject({ witnesses: [], restored: true, operation: f.operation });
    expect(changes[0]?.invalidated).toContainEqual(f.next);
    expect(h.reads.node(f.old).type).toBe('ok');
  } finally {
    h.dispose();
  }
});

it('a committed witness is detached from its staging input and ends at acknowledgement', () => {
  const f = stagedFixture();
  const staged = f.authority.stage(f.transition, f.predecessor);
  if (staged.type !== 'staged') throw new Error('stage failed');
  const expected = structuredClone(f.occurrences);
  f.occurrences.splice(0);
  f.old.rootLine = 9;
  f.authority.commit(staged.token);
  expect(f.authority.observeTransition('a.md', f.after)?.occurrences).toEqual(expected);
  f.authority.acknowledge('a.md', f.after);
  expect(f.authority.observeTransition('a.md', f.after)).toBeUndefined();
});

it('invalidates identical addresses when a different owned file object replaces the source', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one', 'replacement.md': '- [ ] one' });
  try {
    h.reads.activateOccurrences();
    const page = h.reads.page({ path: 'a.md' }, 1);
    if (page.type !== 'ok') throw new Error('read failed');
    const old = expectDefined(page.value.nodes[0]).address;
    const replacement = expectDefined(h.app.vault.getFileByPath('replacement.md'));
    replacement.path = 'a.md';
    const lookup = h.app.vault.getAbstractFileByPath.bind(h.app.vault);
    // Simulate a host replacement becoming current before its old delete event arrives.
    vi.spyOn(h.app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
      path === 'a.md' ? replacement : lookup(path),
    );
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    h.index.installCommittedContent('a.md', '- [ ] one');
    expect(changes[0]?.sources[0]?.fileIdentity).toBe(replacement);
    expect(changes[0]?.invalidated).toContainEqual(old);
    expect(changes[0]?.witnesses).toEqual([]);
  } finally {
    h.dispose();
  }
});

it('cannot claim removal while the exact predecessor remains installed', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one' });
  try {
    h.reads.activateOccurrences();
    const content = '- [ ] one';
    const revision = h.authority.revision(content);
    const address = { filePath: 'a.md', rootRevision: revision, rootLine: 0, nodeOffset: 0 };
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    expect(
      h.authority.stage(
        {
          filePath: 'a.md',
          candidateFingerprint: taskRefContentFingerprint(content),
          candidateLength: content.length,
          expectedRevision: revision,
          roots: [{ line: 0, source: content, revision }],
          occurrences: [{ kind: 'removed', before: address }],
        },
        revision,
      ).type,
    ).toBe('staged');
    h.index.installCommittedContent('a.md', content);
    expect(changes[0]?.witnesses).toEqual([]);
    expect(changes[0]?.invalidated).toEqual([]);
    expect(h.reads.node(address).type).toBe('ok');
  } finally {
    h.dispose();
  }
});

it('finishes accepted delivery before publishing reentrant state changes to other subscribers', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] one' });
  try {
    h.reads.activateOccurrences();
    h.reads.subscribe((event) => {
      if (event.type === 'accepted')
        h.index.updateIntegrationSemantics('changed during acceptance');
    });
    const events: string[] = [];
    h.reads.subscribe((event) => {
      events.push(event.type);
    });
    h.index.installCommittedContent('a.md', '- [x] one');
    expect(events[0]).toBe('accepted');
    expect(events).toContain('changed');
  } finally {
    h.dispose();
  }
});

it.each(['repository', 'metadata'] as const)(
  'orders nested %s acceptance and blocks hydration until the corresponding evidence is delivered',
  async (route) => {
    const h = await publicApiHarness({ 'a.md': '- [ ] first' });
    try {
      h.reads.activateOccurrences();
      const initial = h.authority.revision('- [ ] first');
      const middle = h.authority.mintRevision('- [x] second');
      const final = h.authority.mintRevision('- [-] third');
      const address = (rootRevision: string) => ({
        filePath: 'a.md',
        rootRevision,
        rootLine: 0,
        nodeOffset: 0,
      });
      const firstWitness = {
        kind: 'continued' as const,
        before: address(initial),
        after: address(middle),
      };
      const secondWitness = {
        kind: 'continued' as const,
        before: address(middle),
        after: address(final),
      };
      const stage = (content: string, witness: typeof firstWitness) =>
        h.authority.stage(
          {
            filePath: 'a.md',
            candidateFingerprint: taskRefContentFingerprint(content),
            candidateLength: content.length,
            expectedRevision: witness.before.rootRevision,
            roots: [{ line: 0, source: content, revision: witness.after.rootRevision }],
            occurrences: [witness],
          },
          witness.before.rootRevision,
        );
      const install = (content: string): void => {
        if (route === 'repository') h.index.installCommittedContent('a.md', content);
        else
          h.app.metadataCache.trigger(
            'changed',
            expectDefined(h.app.vault.getFileByPath('a.md')),
            content,
            {},
          );
      };
      const first = stage('- [x] second', firstWitness);
      if (first.type !== 'staged') throw new Error('first stage failed');
      const seenA: TaskOccurrenceWitness[][] = [];
      const seenB: TaskOccurrenceWitness[][] = [];
      const nestedReads: unknown[] = [];
      const laterReads: unknown[] = [];
      let nested = false;
      h.reads.subscribe((event) => {
        if (event.type !== 'accepted') return;
        seenA.push([...event.change.witnesses]);
        if (nested) return;
        nested = true;
        h.authority.commit(first.token);
        h.authority.acknowledge('a.md', '- [x] second');
        const next = stage('- [-] third', secondWitness);
        if (next.type !== 'staged') throw new Error('second stage failed');
        install('- [-] third');
        nestedReads.push(h.reads.node(address(final)));
      });
      h.reads.subscribe((event) => {
        if (event.type !== 'accepted') return;
        seenB.push([...event.change.witnesses]);
        laterReads.push(h.reads.node(address(final)));
      });
      install('- [x] second');
      expect(seenA).toEqual([[firstWitness], [secondWitness]]);
      expect(seenB).toEqual([[firstWitness], [secondWitness]]);
      expect(nestedReads).toEqual([{ type: 'error', reason: 'incomplete' }]);
      expect(laterReads[0]).toEqual({ type: 'error', reason: 'incomplete' });
      expect(laterReads[1]).toMatchObject({ type: 'ok', value: { address: address(final) } });
      expect(h.reads.node(address(final)).type).toBe('ok');
    } finally {
      h.dispose();
    }
  },
);

it('rejects continuation into an unchanged exact occurrence and preserves its identity', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] A\n\n- [ ] B' });
  try {
    h.reads.activateOccurrences();
    const page = h.reads.page({}, 2);
    if (page.type !== 'ok') throw new Error('read failed');
    const a = expectDefined(page.value.nodes[0]).address;
    const b = expectDefined(page.value.nodes[1]).address;
    const content = '\n\n- [ ] B';
    expect(
      h.authority.stage(
        {
          filePath: 'a.md',
          candidateFingerprint: taskRefContentFingerprint(content),
          candidateLength: content.length,
          expectedRevision: a.rootRevision,
          roots: [{ line: 2, source: '- [ ] B', revision: b.rootRevision }],
          occurrences: [{ kind: 'continued', before: a, after: b }],
        },
        a.rootRevision,
      ).type,
    ).toBe('staged');
    const changes: TaskAcceptedOccurrenceChange[] = [];
    h.reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    h.index.installCommittedContent('a.md', content);
    expect(changes[0]?.witnesses).toEqual([]);
    expect(changes[0]?.invalidated).toEqual([a]);
    expect(h.reads.node(b)).toMatchObject({ type: 'ok', value: { address: b } });
  } finally {
    h.dispose();
  }
});
