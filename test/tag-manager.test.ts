// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';

describe('TagManager task boundary', () => {
  it('owns settings and vault-wide operations, not per-task mutation methods', () => {
    const manager = new TagManager(null as never, DEFAULT_SETTINGS, vi.fn());

    for (const method of [
      'addTagToTask',
      'removeTagFromTask',
      'toggleTagOnTask',
      'replaceTagOnTask',
      'assignTagFromInbox',
    ]) {
      expect(manager).not.toHaveProperty(method);
    }
  });
});
