import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { resolvedConfig } from './helpers';

describe('sourceNoteDisplay defaults', () => {
  it('DEFAULT_SETTINGS.sourceNoteDisplay is non-default', () => {
    expect(DEFAULT_SETTINGS.sourceNoteDisplay).toBe('non-default');
  });

  it('resolvedConfig() helper includes sourceNoteDisplay non-default', () => {
    expect(resolvedConfig().sourceNoteDisplay).toBe('non-default');
  });

  it('resolvedConfig() helper includes the default task file path', () => {
    expect(resolvedConfig().taskFilePath).toBe('tasks/active.md');
  });

  it('resolvedConfig() override wins', () => {
    expect(resolvedConfig({ sourceNoteDisplay: 'always' }).sourceNoteDisplay).toBe('always');
    expect(resolvedConfig({ taskFilePath: 'inbox.md' }).taskFilePath).toBe('inbox.md');
  });
});
