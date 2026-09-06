import { describe, expect, it, vi } from 'vitest';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { expectDefined } from './../helpers';

function sources(authority: TaskRefAuthority) {
  return ['a.md', 'b.md'].map((filePath) => {
    const before = '- [ ] Before\r\n';
    const after = '- [ ] After\r\n';
    const previousRevision = authority.mintRevision('- [ ] Before');
    return {
      filePath,
      before,
      after,
      predecessors: [{ line: 0, source: '- [ ] Before', revision: previousRevision }],
      roots: [
        {
          line: 0,
          source: '- [ ] After',
          previousRevision,
          revision: expectDefined(authority.successor(previousRevision, '- [ ] After')),
        },
      ],
    };
  });
}

describe('owned exact-source transaction', () => {
  it.each([
    ['forward', '- [ ] External\r\n'],
    ['restore', '- [ ] External\r\n'],
    ['forward', '- [ ] Before\n'],
    ['restore', '- [ ] Before\n'],
  ] as const)(
    'revokes ownership after contrary %s callback bytes %j without an index observation',
    (operation, contrary) => {
      const authority = new TaskRefAuthority('transaction');
      const input = sources(authority);
      const owner = expectDefined(authority.reserveMutation(input));
      expect(owner[operation]('a.md', contrary)).toBeUndefined();
      expect(owner.forward('a.md', '- [ ] Before\r\n')).toBeUndefined();
      expect(owner.restore('a.md', '- [ ] After\r\n')).toBeUndefined();
      expect(owner.restore('b.md', '- [ ] Before\r\n')).toBe('- [ ] Before\r\n');
      expect(owner.complete(new Map(input.map(({ filePath, after }) => [filePath, after])))).toBe(
        false,
      );
      owner.release();
      expectDefined(authority.reserveMutation(input)).release();
    },
  );
  it.each([false, true])(
    'requires live restoration ownership before release (external mutation: %s)',
    (changed) => {
      const authority = new TaskRefAuthority('transaction');
      const input = sources(authority);
      const owner = expectDefined(authority.reserveMutation(input));
      for (const source of input)
        expect(owner.restore(source.filePath, source.after)).toBe('- [ ] Before\r\n');
      if (changed) authority.observeTransition('a.md', '- [ ] External\r\n');
      expect(
        owner.completeRestoration(new Map(input.map(({ filePath, before }) => [filePath, before]))),
      ).toBe(!changed);
      if (changed) expect(authority.observeTransition('a.md', '- [ ] Before\r\n')).toBeUndefined();
      owner.release();
      expectDefined(authority.reserveMutation(input)).release();
    },
  );
  it('revokes forward and restoration authority after contrary observed content', () => {
    const authority = new TaskRefAuthority('transaction');
    const input = sources(authority);
    const owner = expectDefined(authority.reserveMutation(input));
    expect(owner.forward('a.md', '- [ ] Before\r\n')).toBe('- [ ] After\r\n');
    authority.observeTransition('a.md', '- [ ] External\r\n');
    expect(authority.observeTransition('a.md', '- [ ] After\r\n')).toBeUndefined();
    expect(owner.complete(new Map(input.map(({ filePath, after }) => [filePath, after])))).toBe(
      false,
    );
    expect(owner.forward('b.md', '- [ ] Before\r\n')).toBeUndefined();
    expect(owner.restore('a.md', '- [ ] After\r\n')).toBeUndefined();
    expect(owner.restore('b.md', '- [ ] Before\r\n')).toBe('- [ ] Before\r\n');
    owner.release();
    expectDefined(authority.reserveMutation(input)).release();
  });
  it('releases every reservation if capturing predecessor evidence throws', () => {
    const authority = new TaskRefAuthority('transaction');
    const input = sources(authority);
    const retain = authority.retainPredecessors.bind(authority);
    let count = 0;
    vi.spyOn(authority, 'retainPredecessors').mockImplementation((...args) => {
      if (++count === 2) throw new Error('capture failed');
      return retain(...args);
    });
    expect(() => authority.reserveMutation(input)).toThrow('capture failed');
    expectDefined(authority.reserveMutation(input)).release();
  });
  it('reserves both files, rejects competing writers and terminalizes success', () => {
    const authority = new TaskRefAuthority('transaction');
    const input = sources(authority);
    const owner = expectDefined(authority.reserveMutation(input));
    expect(authority.reserveMutation(input)).toBeUndefined();
    expect(owner.forward('a.md', '- [ ] Before\r\n')).toBe('- [ ] After\r\n');
    expect(owner.forward('b.md', '- [ ] Before\r\n')).toBe('- [ ] After\r\n');
    expect(owner.complete(new Map([['a.md', '- [ ] After\r\n']]))).toBe(false);
    expect(owner.complete(new Map(input.map(({ filePath, after }) => [filePath, after])))).toBe(
      true,
    );
    expect(owner.restore('a.md', '- [ ] After\r\n')).toBeUndefined();
    expect(owner.forward('b.md', '- [ ] Before\r\n')).toBeUndefined();
    const next = expectDefined(authority.reserveMutation(input));
    owner.release();
    expect(next.forward('a.md', '- [ ] Before\r\n')).toBe('- [ ] After\r\n');
    next.release();
  });

  it('acquires all or none when a later file is owned or its predecessor proof fails', () => {
    const authority = new TaskRefAuthority('transaction');
    const input = sources(authority);
    const blocker = expectDefined(authority.reserveMutation(input.slice(1)));
    expect(authority.reserveMutation(input)).toBeUndefined();
    const first = expectDefined(authority.reserveMutation(input.slice(0, 1)));
    first.release();
    blocker.release();
    expect(
      authority.reserveMutation(
        input.map((source, i) => (i === 1 ? { ...source, predecessors: [] } : source)),
      ),
    ).toBeUndefined();
    expectDefined(authority.reserveMutation(input)).release();
  });

  it('restores only owned exact bytes and never issues an inverse writable transition', () => {
    const authority = new TaskRefAuthority('transaction');
    const input = sources(authority);
    const owner = expectDefined(authority.reserveMutation(input));
    expect(owner.restore('a.md', '- [ ] After\r\n')).toBe('- [ ] Before\r\n');
    expect(authority.observeTransition('a.md', '- [ ] Before\r\n')).toMatchObject({
      roots: input[0]?.predecessors,
      transitions: [],
      restored: true,
    });
    expect(owner.complete(new Map(input.map(({ filePath, after }) => [filePath, after])))).toBe(
      false,
    );
    expect(owner.forward('b.md', '- [ ] Before\r\n')).toBeUndefined();
    expect(owner.restore('b.md', '- [ ] Before\r\n')).toBe('- [ ] Before\r\n');
    owner.release();
    expect(authority.observeTransition('a.md', '- [ ] Before\r\n')).toBeUndefined();
    expectDefined(authority.reserveMutation(input)).release();
  });

  it('losing either reservation blocks forward writes without taking a later owner', () => {
    const authority = new TaskRefAuthority('transaction');
    const input = sources(authority);
    const owner = expectDefined(authority.reserveMutation(input));
    authority.discard('b.md');
    const later = expectDefined(authority.reserveMutation(input.slice(1)));
    expect(owner.forward('a.md', '- [ ] Before\r\n')).toBeUndefined();
    expect(owner.restore('b.md', '- [ ] After\r\n')).toBeUndefined();
    expect(owner.restore('a.md', '- [ ] After\r\n')).toBe('- [ ] Before\r\n');
    owner.release();
    expect(later.forward('b.md', '- [ ] Before\r\n')).toBe('- [ ] After\r\n');
    later.release();
  });
});

describe('TaskRefAuthority', () => {
  it('restores proven predecessor revisions without issuing writable forward or inverse transitions', () => {
    const authority = new TaskRefAuthority('restore');
    const source = '- [ ] Same';
    const content = `${source}\n${source}\n`;
    const roots = [0, 1].map((line) => ({
      line,
      source,
      revision: authority.mintRevision(source),
    }));
    const staged = authority.stage(
      {
        filePath: 'tasks.md',
        candidateFingerprint: taskRefContentFingerprint('candidate'),
        candidateLength: 9,
        expectedRevision: expectDefined(roots[0]).revision,
        roots: [],
      },
      expectDefined(roots[0]).revision,
    );
    if (staged.type !== 'staged') throw new Error('missing transaction');
    expect(authority.retainPredecessors(staged.token, content, roots)).toBe(true);
    const restored = authority.stageRestoration(staged.token, content);
    expect(restored.type).toBe('staged');
    expect(authority.observeTransition('tasks.md', content)).toEqual({
      roots,
      transitions: [],
      restored: true,
    });
    if (restored.type !== 'staged') throw new Error('missing restoration');
    authority.abort(restored.token);
    expect(authority.observe('tasks.md', content)).toEqual([]);
    expect(authority.stageRestoration(staged.token, content)).toEqual({ type: 'conflict' });
  });

  it.each([
    'foreign',
    'aborted',
    'committed',
    'tampered',
    'partial',
    'reordered',
    'wrong revision',
  ] as const)('rejects %s restoration ownership or predecessor proof', (fault) => {
    const authority = new TaskRefAuthority('restore');
    const content = '- [ ] Same\n- [ ] Same\n- [ ] Other\n- [ ] Other\n';
    const roots = [0, 1, 2, 3].map((line) => ({
      line,
      source: line < 2 ? '- [ ] Same' : '- [ ] Other',
      revision: authority.mintRevision(line < 2 ? '- [ ] Same' : '- [ ] Other'),
    }));
    const revision = expectDefined(roots[0]).revision;
    const staged = authority.stage(
      {
        filePath: 'tasks.md',
        candidateFingerprint: taskRefContentFingerprint('candidate'),
        candidateLength: 9,
        expectedRevision: revision,
        roots: [],
      },
      revision,
    );
    if (staged.type !== 'staged') throw new Error('missing transaction');
    let claimed = roots;
    if (fault === 'partial') claimed = roots.slice(1);
    if (fault === 'reordered') claimed = [...roots].reverse();
    if (fault === 'wrong revision') claimed = roots.map((root) => ({ ...root, revision }));
    expect(authority.retainPredecessors(staged.token, content, claimed)).toBe(
      !['partial', 'reordered', 'wrong revision'].includes(fault),
    );
    if (fault === 'aborted') authority.abort(staged.token);
    if (fault === 'committed') authority.commit(staged.token);
    expect(
      authority.stageRestoration(
        fault === 'foreign' ? {} : staged.token,
        fault === 'tampered' ? `${content}text` : content,
      ),
    ).toEqual({ type: 'conflict' });
    authority.abort(staged.token);
    authority.acknowledge('tasks.md', 'candidate');
    expect(authority.observe('tasks.md', content)).toEqual([]);
    expect(authority.observe('tasks.md', 'candidate')).toEqual([]);
  });

  it('cannot release a later same-file owner by reusing an aborted token', () => {
    const authority = new TaskRefAuthority('ownership');
    const revision = authority.revision('- [ ] Same');
    const transition = {
      filePath: 'tasks.md',
      candidateFingerprint: taskRefContentFingerprint('candidate'),
      candidateLength: 9,
      expectedRevision: revision,
      roots: [{ line: 0, source: '- [ ] Same', revision }],
    };
    const first = authority.stage(transition, revision);
    if (first.type !== 'staged') throw new Error('missing first');
    authority.abort(first.token);
    const second = authority.stage(transition, revision);
    if (second.type !== 'staged') throw new Error('missing second');
    authority.abort(first.token);
    authority.commit(first.token);
    expect(authority.stageRestoration(first.token, '- [ ] Same')).toEqual({ type: 'conflict' });
    expect(authority.observe('tasks.md', 'candidate')).toEqual(transition.roots);
    authority.abort(second.token);
  });

  it('publishes distinct predecessors for a multi-root batch and removes them on abort', () => {
    const authority = new TaskRefAuthority('batch');
    const first = authority.revision('- [ ] First');
    const second = authority.revision('- [ ] Second');
    const candidate = '- [ ] First 🆔 first\n- [ ] Second ⛔ first\n';
    const roots = [
      {
        line: 0,
        source: '- [ ] First 🆔 first',
        previousRevision: first,
        revision: expectDefined(authority.successor(first, '- [ ] First 🆔 first')),
      },
      {
        line: 1,
        source: '- [ ] Second ⛔ first',
        previousRevision: second,
        revision: expectDefined(authority.successor(second, '- [ ] Second ⛔ first')),
      },
    ];
    const transition = {
      filePath: 'tasks.md',
      candidateFingerprint: taskRefContentFingerprint(candidate),
      candidateLength: candidate.length,
      roots,
    };

    expect(authority.stageBatch(transition, [first, first])).toEqual({ type: 'conflict' });
    expect(authority.observeTransition('tasks.md', candidate)).toBeUndefined();
    const staged = authority.stageBatch(transition, [first, second]);
    expect(staged.type).toBe('staged');
    expect(authority.observeTransition('tasks.md', candidate)?.transitions).toEqual(roots);
    if (staged.type !== 'staged') throw new Error('missing batch token');
    authority.abort(staged.token);
    expect(authority.observeTransition('tasks.md', candidate)).toBeUndefined();
    const retried = authority.stageBatch(transition, [first, second]);
    if (retried.type !== 'staged') throw new Error('missing retry token');
    authority.commit(retried.token);
    expect(authority.observeTransition('tasks.md', candidate)?.transitions).toEqual(roots);
    authority.acknowledge('tasks.md', candidate);
    expect(authority.observeTransition('tasks.md', candidate)).toBeUndefined();
  });

  it('keeps ordinary revisions deterministic within one session and rejects foreign evidence', () => {
    const authority = new TaskRefAuthority('session-a');
    const source = '- [ ] task\n';
    const revision = authority.revision(source);

    expect(authority.revision(source)).toBe(revision);
    expect(authority.evidence(revision)).toEqual({
      source,
      session: 'session-a',
      generation: '0',
    });
    expect(new TaskRefAuthority('session-b').evidence(revision)).toBeUndefined();
    expect(authority.evidence('block:not-authority-evidence')).toBeUndefined();
  });

  it('creates a fresh foreign session for each default authority', () => {
    const source = '- [ ] task\n';
    const first = new TaskRefAuthority();
    const second = new TaskRefAuthority();

    expect(second.evidence(first.revision(source))).toBeUndefined();
    expect(first.evidence(second.revision(source))).toBeUndefined();
  });

  it('mints a distinct successor for byte-identical source without retaining generation history', () => {
    const authority = new TaskRefAuthority('session-a');
    const source = '- [ ] task\n';
    let revision = authority.revision(source);

    for (let index = 0; index < 10_000; index++) {
      const successor = authority.successor(revision, source);
      expect(successor).toBeDefined();
      expect(successor).not.toBe(revision);
      revision = expectDefined(successor);
    }

    expect(authority.evidence(revision)).toMatchObject({ source, session: 'session-a' });
    expect(authority.observe('tasks.md', source)).toEqual([]);
    expect(
      authority.successor(new TaskRefAuthority('session-b').revision(source), source),
    ).toBeUndefined();
  });

  it('mints a fresh observed incarnation without retaining a path history', () => {
    const authority = new TaskRefAuthority('session-a');
    const source = '- [ ] task\n';
    const initial = authority.revision(source);
    const recreated = authority.mintRevision(source);

    expect(recreated).not.toBe(initial);
    expect(authority.evidence(recreated)).toMatchObject({
      source,
      session: 'session-a',
      generation: '1',
    });
    expect(authority.mintRevision(source)).not.toBe(recreated);
  });

  it('exposes staged publication to an early event without letting it destroy the transaction', () => {
    const authority = new TaskRefAuthority('session-a');
    const expectedRevision = authority.revision('- [ ] original\n');
    const first = {
      filePath: 'tasks.md',
      candidateFingerprint: taskRefContentFingerprint('- [ ] first\n'),
      candidateLength: '- [ ] first\n'.length,
      expectedRevision,
      roots: [
        {
          line: 0,
          source: '- [ ] first\n',
          revision: authority.revision('- [ ] first\n'),
        },
      ],
    } as const;
    const aborted = authority.stage(first, expectedRevision);

    expect(aborted.type).toBe('staged');
    expect(authority.observe(first.filePath, '- [ ] first\n')).toEqual(first.roots);
    expect(authority.observe(first.filePath, '- [ ] first\n')).toEqual(first.roots);
    if (aborted.type !== 'staged') throw new Error('missing aborted token');
    authority.abort(aborted.token);
    expect(authority.observe(first.filePath, '- [ ] first\n')).toEqual([]);

    const committed = authority.stage(first, expectedRevision);
    if (committed.type !== 'staged') throw new Error('missing committed token');
    authority.commit(committed.token);
    expect(authority.observe(first.filePath, '- [ ] first\n')).toEqual(first.roots);
    authority.acknowledge(first.filePath, '- [ ] first\n');
    expect(authority.observe(first.filePath, '- [ ] first\n')).toEqual([]);
  });

  it('keeps early-observed staging through commit until acknowledgement and rejects concurrent CAS', () => {
    const authority = new TaskRefAuthority('session-a');
    const source = '- [ ] task\n';
    const expectedRevision = authority.revision(source);
    const successor = authority.successor(expectedRevision, source);
    if (successor === undefined) throw new Error('missing successor');
    const transition = {
      filePath: 'tasks.md',
      candidateFingerprint: taskRefContentFingerprint(source),
      candidateLength: source.length,
      expectedRevision,
      roots: [{ line: 0, source, revision: successor }],
    } as const;
    const token = authority.stage(transition, expectedRevision);

    expect(token.type).toBe('staged');
    expect(authority.stage(transition, expectedRevision)).toEqual({ type: 'conflict' });
    expect(authority.observe('tasks.md', source)).toEqual(transition.roots);
    if (token.type !== 'staged') throw new Error('missing token');
    authority.commit(token.token);
    expect(authority.observe('tasks.md', source)).toEqual(transition.roots);
    authority.acknowledge('tasks.md', source);
    expect(authority.observe('tasks.md', source)).toEqual([]);
  });

  it('keeps only the latest transition for a file across many commit and abort cycles', () => {
    const authority = new TaskRefAuthority('session-a');
    for (let index = 0; index < 10_000; index++) {
      const source = `- [ ] task ${index}\n`;
      const transition = {
        filePath: 'tasks.md',
        candidateFingerprint: taskRefContentFingerprint(source),
        candidateLength: source.length,
        expectedRevision: authority.revision(`- [ ] previous ${index}\n`),
        roots: [{ line: 0, source, revision: authority.revision(source) }],
      } as const;
      const token = authority.stage(transition, transition.expectedRevision);
      if (token.type !== 'staged') throw new Error(`missing token ${index}`);
      if (index % 2 === 0) {
        authority.commit(token.token);
        authority.observe('tasks.md', source);
        authority.acknowledge('tasks.md', source);
      } else authority.abort(token.token);
    }

    expect(authority.observe('tasks.md', '- [ ] task 0\n')).toEqual([]);
    expect(authority.observe('tasks.md', '- [ ] task 9998\n')).toEqual([]);
    expect(authority.observe('tasks.md', '- [ ] task 9999\n')).toEqual([]);
    expect(authority.observe('unrelated.md', '- [ ] unrelated\n')).toEqual([]);
  });
});
