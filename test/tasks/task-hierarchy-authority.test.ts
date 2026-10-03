import { describe, expect, it } from 'vitest';
import {
  TaskRefAuthority,
  type StructuralSourceMutation,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { expectDefined } from '../helpers';

function fixture(before = '- [ ] A\n- [ ] B\n', after = '- [ ] B\n    - [ ] A\n') {
  const authority = new TaskRefAuthority('hierarchy');
  const predecessors = [
    { line: 0, source: '- [ ] A', revision: authority.mintRevision('- [ ] A') },
    { line: 1, source: '- [ ] B', revision: authority.mintRevision('- [ ] B') },
  ];
  const roots = [
    {
      line: 0,
      source: '- [ ] B\n    - [ ] A',
      revision: authority.mintRevision('- [ ] B\n    - [ ] A'),
    },
  ];
  const source: StructuralSourceMutation = {
    filePath: 'a.md',
    before,
    after,
    predecessors,
    roots,
    transitions: [
      { ...expectDefined(roots[0]), previousRevision: expectDefined(predecessors[1]).revision },
    ],
  };
  const current = () => predecessors;
  return { authority, source, current };
}
describe('structural population authority', () => {
  it('reserves fewer roots, exposes only surviving transitions, and restores exact predecessors', () => {
    const { authority, source, current } = fixture();
    const owner = authority.reserveStructuralMutation([source], current);
    expect(owner?.forward('a.md', source.before)).toBe(source.after);
    expect(authority.observeTransition('a.md', source.after)?.transitions).toHaveLength(1);
    expect(owner?.restore('a.md', source.after)).toBe(source.before);
    expect(authority.observeTransition('a.md', source.before)?.roots).toEqual(source.predecessors);
    expect(owner?.completeRestoration(new Map([['a.md', source.before]]))).toBe(true);
  });
  it('reserves an empty successor population without reauthorizing removed roots', () => {
    const { authority, source, current } = fixture();
    const empty = { ...source, after: '', roots: [], transitions: [] };
    const owner = authority.reserveStructuralMutation([empty], current);
    expect(owner?.forward('a.md', source.before)).toBe('');
    expect(authority.observeTransition('a.md', '')).toMatchObject({ roots: [], transitions: [] });
    expect(owner?.complete(new Map([['a.md', '']]))).toBe(true);
  });
  it('reserves an extra promoted root with fresh authority and no invented predecessor', () => {
    const { authority, source, current } = fixture();
    const promoted = { line: 2, source: '- [ ] C', revision: authority.mintRevision('- [ ] C') };
    const extra = {
      ...source,
      after: `${source.before}- [ ] C\n`,
      roots: [...source.predecessors, promoted],
      transitions: source.predecessors.map((root) => ({
        ...root,
        previousRevision: root.revision,
      })),
    };
    expect(
      authority.reserveStructuralMutation([extra], current)?.forward('a.md', source.before),
    ).toBe(extra.after);
  });
  it.each([
    'missing-before',
    'missing-after',
    'duplicate-revision',
    'forged-transition',
    'stale-population',
    'extra-indexed-root',
    'duplicate-path',
  ] as const)('rejects %s before granting ownership', (fault) => {
    const { authority, source, current } = fixture();
    let candidate = source;
    let population = current;
    if (fault === 'missing-before')
      candidate = { ...source, predecessors: source.predecessors.slice(1) };
    if (fault === 'missing-after') candidate = { ...source, roots: [] };
    if (fault === 'duplicate-revision')
      candidate = {
        ...source,
        predecessors: source.predecessors.map((root) => ({
          ...root,
          revision: expectDefined(source.predecessors[0]).revision,
        })),
      };
    if (fault === 'forged-transition')
      candidate = {
        ...source,
        transitions: [
          {
            ...expectDefined(source.roots[0]),
            previousRevision: authority.mintRevision('unowned'),
          },
        ],
      };
    if (fault === 'stale-population') population = () => source.predecessors.slice(1);
    if (fault === 'extra-indexed-root')
      population = () => [
        ...source.predecessors,
        { line: 2, source: '- [ ] Extra', revision: authority.mintRevision('- [ ] Extra') },
      ];
    expect(
      authority.reserveStructuralMutation(
        fault === 'duplicate-path' ? [candidate, candidate] : [candidate],
        population,
      ),
    ).toBeUndefined();
    expect(authority.observeTransition('a.md', source.after)).toBeUndefined();
  });
});

it('rejects an unminted promoted successor and recycled predecessor authority', () => {
  for (const kind of ['unminted', 'recycled'] as const) {
    const { authority, source, current } = fixture();
    const root =
      kind === 'unminted'
        ? { line: 0, source: '- [ ] A', revision: authority.revision('- [ ] A') }
        : expectDefined(source.predecessors[0]);
    expect(
      authority.reserveStructuralMutation(
        [{ ...source, after: '- [ ] A\n', roots: [root], transitions: [] }],
        current,
      ),
    ).toBeUndefined();
  }
});
