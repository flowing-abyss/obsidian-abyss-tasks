// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchesSubmittedChild } from '../../src/tasks/domain/dependencySubtaskProof';
import { subtask } from '../helpers';

describe('creation proof of normalized duration', () => {
  it.each([
    ['Child ⏱️ 25h', 'Child ⏱️ 24h'],
    ['Child ⏰ 20:30 ⏱️ 22h', 'Child ⏰ 20:30 ⏱️ 3h30m'],
    ['Child ⏱️ 22h', 'Child ⏱️ 22h'],
    ['Child ⏱️ 90m', 'Child ⏱️ 90m'],
  ])('accepts exactly the new child %s → %s', (submitted, actual) => {
    expect(
      matchesSubmittedChild(subtask({ ref: { originalBlock: `  - [ ] ${actual}` } }), submitted),
    ).toBe(true);
  });

  it.each([
    ['Child ⏱️ 25h', 'Child ⏱️ 23h'],
    ['Child ⏱️ 25h', 'Child ⏱️ 25h'],
    ['Child ⏱️ 25h', 'Other ⏱️ 24h'],
    ['Child #keep ⏱️ 25h', 'Child #different ⏱️ 24h'],
    ['Child ⏱️ 25h', 'Child ⏰ 00:00 ⏱️ 24h'],
    ['Child ⏱️ 25h', 'Child ⏱️ 1440m'],
    ['Child ⏱️ 90m', 'Child ⏱️ 1h30m'],
    ['Child ⏰ 99:99 ⏱️ 25h', 'Child ⏰ 99:99 ⏱️ 24h'],
    ['Child ⏱️ 25h ⏱️ 26h', 'Child ⏱️ 24h ⏱️ 24h'],
  ])('rejects unowned child timing or source %s → %s', (submitted, actual) => {
    expect(
      matchesSubmittedChild(subtask({ ref: { originalBlock: `  - [ ] ${actual}` } }), submitted),
    ).toBe(false);
  });
});
