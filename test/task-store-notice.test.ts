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
