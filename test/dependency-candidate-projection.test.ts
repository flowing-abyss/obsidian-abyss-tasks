import { describe, expect, it, vi } from 'vitest';
import {
  projectDependencyCandidates,
  type DependencyCandidate,
} from '../src/tasks/application/DependencyCandidateProjection';
import { task } from './helpers';

describe('DependencyCandidateProjection', () => {
  it('returns a flat project-ranked candidate list without the dependent or an existing prerequisite', () => {
    const dependent = task({
      title: 'Ship',
      source: { filePath: 'Projects/A.md', line: 3 },
      dependency: { dependsOn: ['prepare'] },
    });
    const existing = task({
      title: 'Prepare',
      source: { filePath: 'Projects/A.md', line: 1 },
      dependency: { id: 'prepare', dependsOn: [] },
    });
    const project = task({
      title: 'Design',
      source: { filePath: 'Projects/A.md', line: 2 },
      dependency: { id: 'design', dependsOn: [] },
    });
    const outside = task({
      title: 'Review',
      source: { filePath: 'Inbox.md', line: 0 },
      dependency: { id: 'review', dependsOn: [] },
    });

    const candidates = projectDependencyCandidates({
      dependent,
      tasks: [outside, existing, dependent, project],
      projectTasks: [dependent, existing, project],
      validateLink: () => ({ type: 'allowed' }),
    });

    expect(candidates.map(({ task: candidate }) => candidate.title)).toEqual(['Design', 'Review']);
    expect(candidates.every(({ task: candidate }) => candidate !== dependent)).toBe(true);
    expect(candidates.every(({ task: candidate }) => candidate !== existing)).toBe(true);
    expect(candidates.map(({ rank }) => rank)).toEqual([0, 1]);
  });

  it('retains a graph-rejected candidate as disabled preflight feedback', () => {
    const dependent = task({
      title: 'Dependent',
      source: { filePath: 'Tasks.md', line: 0 },
      dependency: { id: 'dependent', dependsOn: [] },
    });
    const transitiveCycle = task({
      title: 'Transitive cycle',
      source: { filePath: 'Tasks.md', line: 2 },
      dependency: { id: 'cycle', dependsOn: ['dependent'] },
    });

    const candidates = projectDependencyCandidates({
      dependent,
      tasks: [dependent, transitiveCycle],
      projectTasks: [],
      validateLink: () => ({
        type: 'invalid',
        diagnostics: [{ type: 'cycle', ids: ['cycle', 'dependent'] }],
      }),
    });

    expect(candidates).toEqual<readonly DependencyCandidate[]>([
      {
        task: transitiveCycle,
        rank: 1,
        availability: { type: 'disabled', reason: 'Would create a cycle' },
      },
    ]);
  });

  it('never presents a missing or duplicate dependency ID as available', () => {
    const dependent = task({ title: 'Dependent', dependency: { id: 'dependent', dependsOn: [] } });
    const missingId = task({ title: 'Missing ID', source: { filePath: 'Tasks.md', line: 1 } });
    const duplicateId = task({
      title: 'Duplicate ID',
      source: { filePath: 'Tasks.md', line: 2 },
      dependency: { id: 'duplicate', dependsOn: [] },
    });

    const candidates = projectDependencyCandidates({
      dependent,
      tasks: [missingId, duplicateId],
      projectTasks: [],
      validateLink: () => ({
        type: 'invalid',
        diagnostics: [{ type: 'duplicate-id', id: 'duplicate', candidates: [] }],
      }),
    });

    expect(candidates.map(({ availability }) => availability)).toEqual([
      { type: 'id-required' },
      { type: 'disabled', reason: 'Duplicate ID' },
    ]);
  });

  it('reports an identity-safe ID-less candidate as ID-required without allocating', () => {
    const dependent = task({ title: 'Dependent', dependency: { id: 'dependent', dependsOn: [] } });
    const idless = task({
      title: 'Candidate without ID',
      source: { filePath: 'Tasks.md', line: 1 },
    });
    const validateLink = vi.fn(() => ({ type: 'allowed' as const }));
    const preflightIdentityLink = vi.fn(() => ({ type: 'allowed' as const }));

    const candidates = projectDependencyCandidates({
      dependent,
      tasks: [idless],
      projectTasks: [],
      validateLink,
      preflightIdentityLink,
    });

    expect(candidates[0]?.availability).toEqual({ type: 'id-required' });
    expect(preflightIdentityLink).toHaveBeenCalledWith(idless, dependent);
    expect(validateLink).not.toHaveBeenCalled();
  });

  it('keeps an identity-safe ID-less candidate ID-required without allocating during projection', () => {
    const dependent = task({ title: 'Dependent', dependency: { id: 'dependent', dependsOn: [] } });
    const idless = task({
      title: 'Candidate without ID',
      source: { filePath: 'Tasks.md', line: 1 },
    });
    const validateLink = vi.fn(() => ({ type: 'allowed' as const }));

    const candidates = projectDependencyCandidates({
      dependent,
      tasks: [idless],
      projectTasks: [],
      validateLink,
    });

    expect(candidates[0]?.availability).toEqual({ type: 'id-required' });
    expect(validateLink).not.toHaveBeenCalled();
  });

  it('keeps an ID-less candidate disabled when identity preflight finds a cycle', () => {
    const dependent = task({ title: 'Dependent', dependency: { id: 'dependent', dependsOn: [] } });
    const idless = task({
      title: 'Candidate without ID',
      source: { filePath: 'Tasks.md', line: 1 },
    });

    const candidates = projectDependencyCandidates({
      dependent,
      tasks: [idless],
      projectTasks: [],
      preflightIdentityLink: () => ({
        type: 'invalid',
        diagnostics: [{ type: 'cycle', ids: ['dependent'] }],
      }),
      validateLink: () => ({
        type: 'allowed',
      }),
    });

    expect(candidates[0]?.availability).toEqual({
      type: 'disabled',
      reason: 'Would create a cycle',
    });
  });
});
