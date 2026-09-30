// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tagSettingsFailureNotice } from '../src/tags/tagSettingsFailure';

describe('tagSettingsFailureNotice', () => {
  it.each([
    [
      'archive tag',
      'Could not archive tag. Your changes were rolled back.',
      'An earlier request to archive tag was not saved. Newer changes were kept.',
    ],
    [
      'add tag group',
      'Could not add tag group. Your changes were rolled back.',
      'An earlier request to add tag group was not saved. Newer changes were kept.',
    ],
    [
      'update tag group',
      'Could not update tag group. Your changes were rolled back.',
      'An earlier request to update tag group was not saved. Newer changes were kept.',
    ],
  ])('words both outcomes of a failed %s save', (description, rolledBack, kept) => {
    expect(tagSettingsFailureNotice(description, true)).toBe(rolledBack);
    expect(tagSettingsFailureNotice(description, false)).toBe(kept);
  });
});
