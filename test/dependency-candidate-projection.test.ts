import { describe, expect, it } from 'vitest';
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
});
