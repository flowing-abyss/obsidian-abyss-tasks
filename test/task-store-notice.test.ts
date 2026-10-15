// @vitest-environment node
import type * as ObsidianModule from 'obsidian';
import { Notice } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presentTaskCommandResult } from '../src/ui/taskCommandResult';

// File-level mock: override Notice with a vi.fn so presentation messages are captured.
// Everything else from obsidian stays real (spread actual). Verified empirically.
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

// Helper to read the mocked Notice's call history
function noticeCalls(): unknown[][] {
  return (Notice as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

describe('task command presentation error paths', () => {
  beforeEach(() => {
    (Notice as unknown as { mock: { calls: unknown[][] } }).mock.calls = [];
  });

  it('not-found shows the missing-task Notice', () => {
    presentTaskCommandResult({
      type: 'not-found',
      target: { type: 'task', ref: { filePath: 'nonexistent.md', line: 0, revision: 'missing' } },
    });
    expect(noticeCalls().length).toBeGreaterThan(0);
    expect(noticeCalls()[0]?.[0]).toContain('no longer exists');
  });

  it('unknown process failure shows a retry-safe failure Notice', () => {
    presentTaskCommandResult({
      type: 'io-error',
      cause: 'process-error',
      path: 't.md',
      contentState: 'unknown',
    });
    expect(noticeCalls().length).toBeGreaterThan(0);
    expect(String(noticeCalls()[0]?.[0])).toContain('Failed to update');
  });
});

it.each([
  ['read-failed', 'Task deleted, but the empty note could not be removed: tasks.md.'],
  ['removal-unconfirmed', 'Task deleted, but note cleanup could not be confirmed. Check tasks.md.'],
] as const)('presents one cleanup warning for %s', (cause, message) => {
  vi.mocked(Notice).mockClear();
  presentTaskCommandResult({
    type: 'ok',
    changed: true,
    outcome: {
      type: 'deleted',
      ref: { filePath: 'tasks.md', line: 0, revision: 'deleted' },
      noteCleanupWarning: { cause, path: 'tasks.md' },
    },
  });
  expect(Notice).toHaveBeenCalledExactlyOnceWith(message);
});

it('keeps successful deletion silent without a cleanup warning', () => {
  vi.mocked(Notice).mockClear();
  presentTaskCommandResult({
    type: 'ok',
    changed: true,
    outcome: { type: 'deleted', ref: { filePath: 'tasks.md', line: 0, revision: 'deleted' } },
  });
  expect(Notice).not.toHaveBeenCalled();
});
