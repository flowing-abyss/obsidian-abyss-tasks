import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskQueryApi } from '../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import type { TaskRepository, TaskRepositoryResult } from '../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { TaskRef, TaskSnapshot } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import { taskQueryApi } from './helpers';

const ref: TaskRef = { filePath: 'source.md', line: 3, revision: 'source-revision' };
const destination = {
  filePath: 'Projects/P.md',
  insertion: { type: 'section' as const, heading: '## Tasks' },
};

function snapshot(filePath: string): TaskSnapshot {
  return {
    ref: { filePath, line: 1, revision: `${filePath}:revision` },
    title: 'task',
    markdownTitle: 'task',
    status: 'open',
    statusSymbol: ' ',
    priority: 'C',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    source: {
      filePath,
      line: 1,
      originalMarkdown: '- [ ] task',
      originalBlock: '- [ ] task',
    },
    presentation: { linkCount: 0 },
  };
}

function service(move: TaskRepository['move']): TaskApplicationService {
  const current: TaskSnapshot = {
    ...snapshot(ref.filePath),
    ref,
    source: {
      filePath: ref.filePath,
      line: ref.line,
      originalMarkdown: '- [ ] task',
      originalBlock: '- [ ] task',
    },
  };
  const queries: TaskQueryApi = {
    ...taskQueryApi(),
    resolve: () => ({
      type: 'exact',
      task: current,
      basis: { observed: current },
    }),
  };
  return new TaskApplicationService(
    queries,
    {
      edit: vi.fn(),
      completeRecurrence: vi.fn(),
      create: vi.fn(),
      move,
    },
    new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
    { today: () => localDate('2026-07-14') },
  );
}

describe('TaskApplicationService move command', () => {
  it('delegates the semantic command once and maps committed target snapshot to ok', async () => {
    const moved = snapshot(destination.filePath);
    const move = vi.fn<TaskRepository['move']>().mockResolvedValue({
      type: 'committed',
      outcome: { type: 'task', task: moved },
      changed: true,
    });

    await expect(service(move).execute({ type: 'move', ref, destination })).resolves.toEqual({
      type: 'ok',
      outcome: { type: 'task', task: moved },
      changed: true,
    });
    expect(move).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith(ref, destination);
  });

  it('passes a partial result through without retrying or converting it to success', async () => {
    const partial: TaskRepositoryResult = {
      type: 'partial',
      operation: 'move',
      recovery: {
        source: ref,
        targetPath: destination.filePath,
        copiedTask: snapshot(destination.filePath),
        state: 'target-copied-source-remains',
        cause: 'conflict',
      },
    };
    const move = vi.fn<TaskRepository['move']>().mockResolvedValue(partial);

    await expect(service(move).execute({ type: 'move', ref, destination })).resolves.toBe(partial);
    expect(move).toHaveBeenCalledOnce();
  });

  it('maps an unexpected repository rejection without attempting another move', async () => {
    const move = vi.fn<TaskRepository['move']>().mockRejectedValue(new Error('unexpected'));

    await expect(service(move).execute({ type: 'move', ref, destination })).resolves.toEqual({
      type: 'io-error',
      cause: 'repository-error',
      path: destination.filePath,
      contentState: 'unknown',
    });
    expect(move).toHaveBeenCalledOnce();
  });
});
