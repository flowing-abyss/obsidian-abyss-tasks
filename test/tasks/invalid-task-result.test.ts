import { describe, expect, it } from 'vitest';
import {
  invalidTaskResult,
  invalidTaskSyntax,
  invalidTaskTarget,
} from '../../src/tasks/domain/validation';

describe('invalid task result factories', () => {
  it('wraps existing issues in order without copying or changing their shape', () => {
    const issues = [
      { code: 'duplicate-field' as const, field: 'due' },
      { code: 'invalid-date' as const, field: 'due' },
      { code: 'invalid-task-syntax' as const },
    ];
    const result = invalidTaskResult(issues);
    expect(result).toStrictEqual({ type: 'invalid', issues });
    expect(result.issues).toBe(issues);
    expect(invalidTaskResult(issues)).not.toBe(result);
  });
  it.each(['dependency', 'subtask', '', 'custom-field'])(
    'preserves the exact target field %j',
    (field) => {
      expect(invalidTaskTarget(field)).toStrictEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field }],
      });
    },
  );

  it('omits the field property for invalid syntax', () => {
    expect(invalidTaskSyntax()).toStrictEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-task-syntax' }],
    });
    expect(invalidTaskSyntax().issues[0]).not.toHaveProperty('field');
  });

  it.each([invalidTaskSyntax, () => invalidTaskTarget('dependency')])(
    'allocates fresh result, issues and issue objects',
    (create) => {
      const first = create();
      const second = create();
      expect(first).not.toBe(second);
      expect(first.issues).not.toBe(second.issues);
      expect(first.issues[0]).not.toBe(second.issues[0]);
    },
  );
});
