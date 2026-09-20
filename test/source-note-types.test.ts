import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';

describe('sourceNoteDisplay defaults', () => {
  it('DEFAULT_SETTINGS.sourceNoteDisplay is non-default', () => {
    expect(DEFAULT_SETTINGS.sourceNoteDisplay).toBe('non-default');
  });
});
