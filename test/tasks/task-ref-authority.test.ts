import { describe, expect, it } from 'vitest';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
} from '../../src/tasks/infrastructure/TaskRefAuthority';

describe('TaskRefAuthority', () => {
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
      revision = successor!;
    }

    expect(authority.evidence(revision)).toMatchObject({ source, session: 'session-a' });
    expect(authority.observe('tasks.md', source)).toEqual([]);
    expect(authority.successor(new TaskRefAuthority('session-b').revision(source), source)).toBe(
      undefined,
    );
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
    if (!successor) throw new Error('missing successor');
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
