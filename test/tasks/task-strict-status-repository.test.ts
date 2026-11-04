import { describe, expect, it, vi } from 'vitest';
import { expectDefined } from '../helpers';
import { makeRepositoryHarness, revisionPrecondition } from '../support/taskRepositoryHarness';

for (const adapter of ['obsidian', 'in-memory'] as const) {
  describe(`${adapter} strict status repository`, () => {
    it.each([' ', 'x'])('checks a rejecting guard before status %s or a no-op', async (symbol) => {
      const source = '- [ ] Task';
      const h = await makeRepositoryHarness(adapter, source);
      try {
        const root = expectDefined(h.index.list()[0]);
        const target = { type: 'task' as const, ref: root.ref };
        const strictStatus = {
          operation: {},
          check: () => 'semantics-changed' as const,
          expectCommit: vi.fn(),
        };
        const result = await h.repository.edit({
          ...revisionPrecondition(root, target),
          strictStatus,
          command: { type: 'set-status', target, symbol },
        });
        expect(result).toEqual({ type: 'strict-rejected', reason: 'semantics-changed' });
        expect(await h.read()).toBe(source);
        expect(strictStatus.expectCommit).not.toHaveBeenCalled();
      } finally {
        h.index.destroy();
      }
    });
  });
}

import { publicApiHarness } from '../support/publicApiHarness';

describe('operation-owned status read lease', () => {
  it('rejects semantics changes without replacing the captured basis', async () => {
    const h = await publicApiHarness({ 'tasks.md': '- [ ] Task' });
    try {
      const root = expectDefined(h.index.list()[0]);
      const leased = h.index
        .statusReadBasis()
        .lease(root, { type: 'task', ref: root.ref }, h.reads.capture());
      expect(leased.type).toBe('ready');
      if (leased.type !== 'ready') throw new Error('Lease unavailable');
      h.index.updateIntegrationSemantics('changed');
      expect(leased.lease.failure()).toBe('semantics-changed');
      leased.lease.dispose();
    } finally {
      h.dispose();
    }
  });
});

import { TFile } from 'obsidian';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import { taskTreeNodes } from '../../src/tasks/domain/taskSearchProjection';
import { timeEntryRef } from '../../src/tasks/domain/timeTracking';
import type { TaskNodeRef } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { flushMicrotasks } from '../helpers';

function leased(h: Awaited<ReturnType<typeof makeRepositoryHarness>>, nested = false) {
  const root = expectDefined(h.index.list()[0]);
  const target: TaskNodeRef = nested
    ? { type: 'subtask', ref: expectDefined(root.subtasks[0]).ref }
    : { type: 'task', ref: root.ref };
  const result = h.index
    .statusReadBasis()
    .lease(root, target, h.index.integrationReads().capture());
  if (result.type !== 'ready') throw new Error(`Lease rejected: ${result.reason}`);
  return { root, target, lease: result.lease };
}

describe('strict writer races', () => {
  it.each([
    ['root', '- [ ] Changed\n  - [ ] Child', 'revision-changed'],
    ['child', '- [ ] Root\n  - [ ] Changed', 'revision-changed'],
    ['tag', '- [ ] Root #excluded\n  - [ ] Child', 'source-unavailable'],
    ['frontmatter', '---\nprivate: true\n---\n- [ ] Root\n  - [ ] Child', 'source-unavailable'],
    ['semantics', '- [ ] Root\n  - [ ] Child', 'semantics-changed'],
    ['policy', '- [ ] Root\n  - [ ] Child', 'source-unavailable'],
    ['file', '- [ ] Root\n  - [ ] Child', 'source-unavailable'],
  ])(
    'rejects current %s changes inside the writer without editing',
    async (race, content, reason) => {
      const h = await makeRepositoryHarness('obsidian', '- [ ] Root\n  - [ ] Child');
      await h.index.refreshSourceExclusion(
        (metadata) =>
          metadata.tags.includes('#excluded') || metadata.frontmatter['private'] === true,
      );
      const { root, target, lease } = leased(h, true);
      const original = h.app.vault.process.bind(h.app.vault);
      try {
        vi.spyOn(h.app.vault, 'process').mockImplementationOnce(
          async (file, transform, options) => {
            if (race === 'file') {
              await h.app.fileManager.trashFile(file);
              const replacement = await h.app.vault.create('tasks.md', content);
              return original(replacement, transform, options);
            }
            if (race === 'policy') await h.index.refreshSourceExclusion(() => true);
            return original(
              file,
              () => {
                if (race === 'semantics') h.index.updateIntegrationSemantics('changed');
                return transform(content);
              },
              options,
            );
          },
        );
        expect(
          await h.repository.edit({
            ...revisionPrecondition(root, target),
            strictStatus: lease.guard(root, target),
            command: {
              type: 'set-status',
              target,
              symbol: 'x',
              stamp: localDate('2026-08-01'),
              addCompletionDate: false,
            },
          }),
        ).toEqual({ type: 'strict-rejected', reason });
        expect(await h.read()).toBe(content);
      } finally {
        lease.dispose();
        h.index.destroy();
      }
    },
  );
});

for (const adapter of ['obsidian', 'in-memory'] as const) {
  describe(`${adapter} lease acceptance`, () => {
    it('advances two owned writes through accepted roots and tolerates the commit echo', async () => {
      const h = await makeRepositoryHarness(
        adapter,
        '- [ ] Root\n  - 2026-08-01T10:00:00Z →\n  - [ ] Child',
      );
      const { root, target, lease } = leased(h);
      try {
        const result = await h.repository.edit({
          ...revisionPrecondition(root, target),
          strictStatus: lease.guard(root, target),
          command: {
            type: 'set-status',
            target,
            symbol: 'x',
            stamp: localDate('2026-08-01'),
            addCompletionDate: false,
          },
        });
        expect(result).toMatchObject({ type: 'committed' });
        expect(lease.failure()).toBeUndefined();
        const current = expectDefined(h.index.list()[0]);
        expect(lease.occurrences().original.current?.rootRevision).toBe(current.ref.revision);
        const currentTarget = { type: 'task' as const, ref: current.ref };
        const second = await h.repository.edit({
          ...revisionPrecondition(current, currentTarget),
          strictStatus: lease.guard(current, currentTarget),
          command: {
            type: 'close-time-entry',
            entry: timeEntryRef(currentTarget, expectDefined(current.timeEntries[0])),
            stamp: atomDateTime('2026-08-01T10:00:01Z'),
            endMs: Date.parse('2026-08-01T10:00:01Z'),
            minimumMs: 60_000,
          },
        });
        expect(second.type).toBe('committed');
        expect(await h.read()).toBe('- [x] Root\n  - [ ] Child');
        expect(lease.failure()).toBeUndefined();
        expect(lease.occurrences().original.current?.rootRevision).toBe(
          h.index.list()[0]?.ref.revision,
        );
        h.index.installCommittedContent('tasks.md', await h.read());
        expect(lease.failure()).toBeUndefined();
      } finally {
        lease.dispose();
        h.index.destroy();
      }
    });

    it('tracks unprojected recurrence roles independently through a discarded timer line', async () => {
      const source =
        '- [ ] Root\n  - [ ] Repeat 🔁 every day 📅 2026-08-01\n    - 2026-08-01T10:00:00Z →\n  - [ ] Sibling';
      const h = await makeRepositoryHarness(adapter, source);
      const { root, target, lease } = leased(h, true);
      try {
        const result = await h.repository.completeRecurrence({
          ...revisionPrecondition(root, target),
          strictStatus: lease.guard(root, target),
          baseOwnedDescendants: '\n    - 2026-08-01T10:00:00Z →',
          command: {
            target,
            doneSymbol: 'x',
            today: localDate('2026-08-01'),
            todoSymbol: ' ',
            addCreatedDate: false,
            addCompletionDate: false,
            placement: 'after',
            policy: { removeScheduledDate: false },
          },
        });
        expect(result).toMatchObject({ type: 'committed' });
        expect(lease.failure()).toBeUndefined();
        const roles = lease.occurrences();
        expect(roles.original).toMatchObject({ state: 'retained', current: { nodeOffset: 1 } });
        expect(roles.next).toMatchObject({ state: 'retained', current: { nodeOffset: 3 } });
        const current = expectDefined(h.index.list()[0]);
        const done = expectDefined(
          [...taskTreeNodes(current)].find((node) => node.node.statusSymbol === 'x'),
        );
        await h.repository.edit({
          ...revisionPrecondition(current, done.target),
          strictStatus: lease.guard(current, done.target),
          command: {
            type: 'close-time-entry',
            entry: timeEntryRef(done.target, expectDefined(done.node.timeEntries[0])),
            stamp: atomDateTime('2026-08-01T10:00:01Z'),
            endMs: Date.parse('2026-08-01T10:00:01Z'),
            minimumMs: 60_000,
          },
        });
        expect(lease.failure()).toBeUndefined();
        expect(lease.occurrences().original.current?.nodeOffset).toBe(1);
        expect(lease.occurrences().next?.current?.nodeOffset).toBe(2);
        expect(lease.occurrences().next?.origin).toEqual(roles.next?.origin);
      } finally {
        lease.dispose();
        h.index.destroy();
      }
    });
  });
}

it('accepts early trusted metadata exactly once before the final commit echo', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  const { root, target, lease } = leased(h);
  let early: unknown;
  try {
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
      const candidate = transform(await h.app.vault.read(file));
      h.fireChanged(file, candidate, {
        listItems: [
          {
            task: 'x',
            parent: -1,
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 0, col: candidate.length, offset: candidate.length },
            },
          },
        ],
      });
      await h.app.vault.modify(file, candidate);
      await flushMicrotasks();
      early = { failure: lease.failure(), occurrence: lease.occurrences() };
      return candidate;
    });
    expect(
      await h.repository.edit({
        ...revisionPrecondition(root, target),
        strictStatus: lease.guard(root, target),
        command: {
          type: 'set-status',
          target,
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: false,
        },
      }),
    ).toMatchObject({ type: 'committed' });
    expect(early).toEqual({ failure: undefined, occurrence: lease.occurrences() });
    expect(lease.failure()).toBeUndefined();
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('rejects substituting another selected node under the same strict root', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root\n  - [ ] Child');
  const { root, target, lease } = leased(h);
  try {
    const child = { type: 'subtask' as const, ref: expectDefined(root.subtasks[0]).ref };
    expect(
      await h.repository.edit({
        ...revisionPrecondition(root, target),
        strictStatus: lease.guard(root, target),
        command: {
          type: 'set-status',
          target: child,
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: false,
        },
      }),
    ).toEqual({ type: 'strict-rejected', reason: 'revision-changed' });
    expect(await h.read()).toBe('- [ ] Root\n  - [ ] Child');
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('rejects identical candidate bytes without trusted operation ownership', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  const { root, target, lease } = leased(h);
  try {
    const file = expectDefined(h.app.vault.getAbstractFileByPath('tasks.md'));
    lease
      .guard(root, target)
      .expectCommit(
        { fileIdentity: file, filePath: 'tasks.md', content: '- [ ] Root', root, target },
        '- [x] Root',
      );
    h.index.installCommittedContent('tasks.md', '- [x] Root');
    expect(lease.failure()).toBe('revision-changed');
    expect(lease.occurrences().original.current).toBeUndefined();
    lease.markMainUnknown();
    expect(lease.occurrences().original.state).toBe('unproven');
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('advances inward facts before an ordinary listener registered before the lease', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  let currentRevision: string | undefined;
  const observed: Array<string | undefined> = [];
  const subscription = h.index.integrationReads().subscribe((event) => {
    if (event.type === 'accepted') {
      currentRevision = lease.occurrences().original.current?.rootRevision;
      observed.push(currentRevision);
    }
  });
  const { root, target, lease } = leased(h);
  try {
    await h.repository.edit({
      ...revisionPrecondition(root, target),
      strictStatus: lease.guard(root, target),
      command: {
        type: 'set-status',
        target,
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: false,
      },
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((value) => value === h.index.list()[0]?.ref.revision)).toBe(true);
  } finally {
    subscription.unsubscribe();
    lease.dispose();
    h.index.destroy();
  }
});

it('invalidates on an unrelated failed empty file and preserves the known main effect', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root', {
    extraFiles: { 'empty.md': '' },
  });
  const { root, target, lease } = leased(h);
  try {
    await h.repository.edit({
      ...revisionPrecondition(root, target),
      strictStatus: lease.guard(root, target),
      command: {
        type: 'set-status',
        target,
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: false,
      },
    });
    const confirmed = lease.occurrences().original.current;
    const file = h.app.vault.getAbstractFileByPath('empty.md');
    if (!(file instanceof TFile)) throw new Error('Missing empty fixture');
    const read = h.app.vault.read.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'read').mockImplementation(async (target) => {
      if (target === file) throw new Error('read failed');
      return read(target);
    });
    h.fireChanged(file, '', {});
    await flushMicrotasks();
    expect(lease.failure()).toBe('incomplete-read');
    lease.markMainUnknown();
    expect(lease.occurrences().original.state).toBe('retained');
    expect(lease.occurrences().original.current).toEqual(confirmed);
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('disposes the pending candidate and subscription before later acceptance', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  const { root, target, lease } = leased(h);
  try {
    const file = expectDefined(h.app.vault.getAbstractFileByPath('tasks.md'));
    const guard = lease.guard(root, target);
    guard.expectCommit(
      { fileIdentity: file, filePath: 'tasks.md', content: '- [ ] Root', root, target },
      '- [x] Root',
    );
    const captured = lease.occurrences();
    lease.dispose();
    h.index.installCommittedContent('tasks.md', '- [x] Root');
    h.index.updateIntegrationSemantics('after-dispose');
    expect(lease.failure()).toBeUndefined();
    expect(lease.occurrences()).toEqual(captured);
    expect(Object.isFrozen(captured.original.origin)).toBe(true);
    expect(
      guard.check({
        fileIdentity: file,
        filePath: 'tasks.md',
        content: '- [ ] Root',
        root,
        target,
      }),
    ).toBe('source-unavailable');
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('rejects a newer unconfirmed read even after the operation has accepted its candidate', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  const { root, target, lease } = leased(h);
  let release: (() => void) | undefined;
  let started = false;
  const subscription = h.index.integrationReads().subscribe((event) => {
    if (event.type !== 'accepted' || started) return;
    started = true;
    vi.spyOn(h.app.vault, 'read').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('- [ ] Unconfirmed');
          };
        }),
    );
    const file = h.app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('Missing source');
    h.fireChanged(file, '- [ ] Unconfirmed', {});
  });
  try {
    await h.repository.edit({
      ...revisionPrecondition(root, target),
      strictStatus: lease.guard(root, target),
      command: {
        type: 'set-status',
        target,
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: false,
      },
    });
    expect(started).toBe(true);
    expect(lease.failure()).toBe('incomplete-read');
    expect(lease.occurrences().original.current).toBeUndefined();
  } finally {
    release?.();
    await flushMicrotasks();
    subscription.unsubscribe();
    lease.dispose();
    h.index.destroy();
  }
});

it('checks sibling source bytes as part of the complete dependency read basis', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root\n- [ ] Sibling');
  const { root, target, lease } = leased(h);
  const process = h.app.vault.process.bind(h.app.vault);
  try {
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce((file, transform, options) =>
      process(file, () => transform('- [ ] Root\n- [x] Sibling'), options),
    );
    expect(
      await h.repository.edit({
        ...revisionPrecondition(root, target),
        strictStatus: lease.guard(root, target),
        command: {
          type: 'set-status',
          target,
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: false,
        },
      }),
    ).toEqual({ type: 'strict-rejected', reason: 'revision-changed' });
    expect(await h.read()).toBe('- [ ] Root\n- [x] Sibling');
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

for (const adapter of ['obsidian', 'in-memory'] as const) {
  it(`${adapter} rejects strict preconditions on unsupported batch writers`, async () => {
    const h = await makeRepositoryHarness(adapter, '- [ ] Root');
    const { root, target, lease } = leased(h);
    try {
      expect(
        await h.repository.editBatch({
          filePath: 'tasks.md',
          outcomeTarget: target,
          edits: [
            {
              ...revisionPrecondition(root, target),
              strictStatus: lease.guard(root, target),
              command: { type: 'set-dependency-id', target, id: 'id' },
            },
          ],
        }),
      ).toEqual({ type: 'strict-rejected', reason: 'unsupported-precondition' });
      expect(await h.read()).toBe('- [ ] Root');
    } finally {
      lease.dispose();
      h.index.destroy();
    }
  });
}

it('rejects unresolved candidate coverage at the next guard', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  const { root, target, lease } = leased(h);
  try {
    const fileIdentity = expectDefined(h.app.vault.getAbstractFileByPath('tasks.md'));
    const current = { fileIdentity, filePath: 'tasks.md', content: '- [ ] Root', root, target };
    const guard = lease.guard(root, target);
    guard.expectCommit(current, '- [x] Root');
    expect(guard.check(current)).toBe('incomplete-read');
    h.index.installCommittedContent('tasks.md', '- [x] Root');
    expect(lease.occurrences().original.current).toBeUndefined();
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('invalidates an early candidate when the writer rejects and restores its original source', async () => {
  const source = '- [ ] Root';
  const h = await makeRepositoryHarness('obsidian', source);
  const { root, target, lease } = leased(h);
  try {
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
      const candidate = transform(await h.app.vault.read(file));
      await h.app.vault.modify(file, candidate);
      await flushMicrotasks();
      await h.app.vault.modify(file, source);
      throw new Error('writer rejected');
    });
    expect(
      await h.repository.edit({
        ...revisionPrecondition(root, target),
        strictStatus: lease.guard(root, target),
        command: {
          type: 'set-status',
          target,
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: false,
        },
      }),
    ).toMatchObject({ type: 'io-error', contentState: 'unknown' });
    expect(await h.read()).toBe(source);
    expect(lease.failure()).toBeDefined();
    expect(lease.occurrences().original.current).toBeUndefined();
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

it('rejects a newly excluded source when acquiring the lease before policy refresh', async () => {
  let excluded = false;
  const h = await publicApiHarness(
    { 'tasks.md': '- [ ] Root' },
    { index: { excludeSource: () => excluded } },
  );
  try {
    const root = expectDefined(h.index.list()[0]);
    excluded = true;
    expect(
      h.statusReadBasis.lease(root, { type: 'task', ref: root.ref }, h.reads.capture()),
    ).toEqual({ type: 'rejected', reason: 'source-unavailable' });
  } finally {
    h.dispose();
  }
});

it('enforces the prepared node even when a supplied guard accepts current semantics', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root\n  - [ ] Child');
  try {
    const root = expectDefined(h.index.list()[0]);
    const target = { type: 'task' as const, ref: root.ref };
    const child = { type: 'subtask' as const, ref: expectDefined(root.subtasks[0]).ref };
    expect(
      await h.repository.edit({
        ...revisionPrecondition(root, target),
        strictStatus: { operation: {}, check: () => undefined, expectCommit: () => undefined },
        command: {
          type: 'set-status',
          target: child,
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: false,
        },
      }),
    ).toEqual({ type: 'strict-rejected', reason: 'revision-changed' });
    expect(await h.read()).toBe('- [ ] Root\n  - [ ] Child');
  } finally {
    h.index.destroy();
  }
});

it('provides exact effects to an accepting guard without a public read projection', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  try {
    const root = expectDefined(h.index.list()[0]);
    const target = { type: 'task' as const, ref: root.ref };
    const effects: unknown[] = [];
    const result = await h.repository.edit({
      ...revisionPrecondition(root, target),
      strictStatus: {
        operation: {},
        check: () => undefined,
        expectCommit: (_current, _next, effect) => {
          effects.push(effect);
        },
      },
      command: {
        type: 'set-status',
        target,
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: false,
      },
    });
    expect(result).toMatchObject({ type: 'committed', changed: true });
    expect(effects).toMatchObject([
      {
        original: {
          before: { rootRevision: root.ref.revision, nodeOffset: 0 },
          after: { nodeOffset: 0 },
        },
      },
    ]);
  } finally {
    h.index.destroy();
  }
});

it('keeps both recurrence proofs after an unrelated failure, then clears only source proof on its own failure', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Repeat 🔁 every day 📅 2026-08-01', {
    extraFiles: { 'empty.md': '' },
  });
  const { root, target, lease } = leased(h);
  try {
    await h.repository.completeRecurrence({
      ...revisionPrecondition(root, target),
      strictStatus: lease.guard(root, target),
      baseOwnedDescendants: '',
      command: {
        target,
        doneSymbol: 'x',
        today: localDate('2026-08-01'),
        todoSymbol: ' ',
        addCreatedDate: false,
        addCompletionDate: false,
        placement: 'after',
        policy: { removeScheduledDate: false },
      },
    });
    const proven = lease.occurrences();
    expect(proven.original.current).toBeDefined();
    expect(proven.next?.current).toBeDefined();
    const bytes = await h.read();
    const current = expectDefined(h.index.list()[0]);
    const currentTarget = { type: 'task' as const, ref: current.ref };
    const own = h.app.vault.getAbstractFileByPath('tasks.md');
    const empty = h.app.vault.getAbstractFileByPath('empty.md');
    if (!(own instanceof TFile) || !(empty instanceof TFile)) throw new Error('Missing fixture');
    vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('unavailable source'));
    h.fireChanged(empty, '', {});
    await flushMicrotasks();
    expect(lease.failure()).toBe('incomplete-read');
    expect(lease.occurrences()).toEqual(proven);
    expect(
      lease.guard(current, currentTarget).check({
        fileIdentity: own,
        filePath: 'tasks.md',
        content: bytes,
        root: current,
        target: currentTarget,
      }),
    ).toBe('incomplete-read');
    expect(lease.occurrences()).toEqual(proven);
    h.fireChanged(own, 'unconfirmed', {});
    await flushMicrotasks();
    expect(lease.occurrences()).toEqual({
      original: { origin: proven.original.origin, state: 'retained' },
      next: { origin: proven.next?.origin, state: 'retained' },
    });
    lease.markMainUnknown();
    expect(lease.occurrences().next?.origin).toEqual(proven.next?.origin);
  } finally {
    lease.dispose();
    h.index.destroy();
  }
});

import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { preparedRevisionResult } from '../../src/tasks/infrastructure/preparedRevisionResult';

it('never turns a strict revision precondition into an authority rebase', async () => {
  const h = await makeRepositoryHarness('obsidian', '- [ ] Root');
  try {
    const root = expectDefined(h.index.list()[0]);
    const target = { type: 'task' as const, ref: root.ref };
    const block = expectDefined(new TaskBlockEditor().rootBlocks('- [ ] Root')[0]);
    const revision = expectDefined(h.authority.successor(root.ref.revision, '- [ ] Root'));
    const successor = { ...root, ref: { ...root.ref, revision } };
    expect(
      preparedRevisionResult({
        prepared: {
          ...revisionPrecondition(root, target),
          strictStatus: { operation: {}, check: () => undefined, expectCommit: () => undefined },
        },
        located: { type: 'exact', block },
        authorityCurrent: successor.ref,
        locateAuthorityCurrent: () => ({ type: 'exact', block }),
        snapshot: () => successor,
      }),
    ).toEqual({ type: 'strict-rejected', reason: 'revision-changed' });
  } finally {
    h.index.destroy();
  }
});

for (const adapter of ['obsidian', 'in-memory'] as const) {
  it(`${adapter} retains proven original removal independently from a new recurrence owner`, async () => {
    const h = await makeRepositoryHarness(
      adapter,
      '- [ ] Repeat 🔁 every day 🏁 delete 📅 2026-08-01',
    );
    const { root, target, lease } = leased(h);
    try {
      expect(
        await h.repository.completeRecurrence({
          ...revisionPrecondition(root, target),
          strictStatus: lease.guard(root, target),
          baseOwnedDescendants: '',
          command: {
            target,
            doneSymbol: 'x',
            today: localDate('2026-08-01'),
            todoSymbol: ' ',
            addCreatedDate: false,
            addCompletionDate: false,
            placement: 'after',
            policy: { removeScheduledDate: false },
          },
        }),
      ).toMatchObject({ type: 'committed' });
      expect(lease.failure()).toBeUndefined();
      expect(lease.occurrences().original).toEqual({
        origin: {
          filePath: 'tasks.md',
          rootRevision: root.ref.revision,
          rootLine: 0,
          nodeOffset: 0,
        },
        state: 'removed',
      });
      expect(lease.occurrences().next).toMatchObject({
        state: 'retained',
        current: { rootLine: 0, nodeOffset: 0 },
      });
      lease.markMainUnknown();
      expect(lease.occurrences().original.state).toBe('removed');
      expect(lease.occurrences().next?.current).toBeDefined();
    } finally {
      lease.dispose();
      h.index.destroy();
    }
  });

  it(`${adapter} records an ordinary delete-on-completion as proven removal`, async () => {
    const h = await makeRepositoryHarness(adapter, '- [ ] Root 🏁 delete');
    const { root, target, lease } = leased(h);
    try {
      expect(
        await h.repository.edit({
          ...revisionPrecondition(root, target),
          strictStatus: lease.guard(root, target),
          command: {
            type: 'set-status',
            target,
            symbol: 'x',
            stamp: localDate('2026-08-01'),
            addCompletionDate: false,
          },
        }),
      ).toMatchObject({ type: 'committed' });
      expect(await h.read()).toBe('');
      expect(lease.failure()).toBeUndefined();
      expect(lease.occurrences().original.state).toBe('removed');
      expect(lease.occurrences().original.current).toBeUndefined();
    } finally {
      lease.dispose();
      h.index.destroy();
    }
  });
}
