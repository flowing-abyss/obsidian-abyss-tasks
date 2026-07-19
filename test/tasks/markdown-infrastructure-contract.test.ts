import { describe, expect, it } from 'vitest';
import type { TaskEditCommand } from '../../src/tasks/application/TaskRepository';
import type { TaskRef } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { applyTaskCommand } from '../../src/tasks/infrastructure/markdown/applyTaskCommand';
import { createTaskLine } from '../../src/tasks/infrastructure/markdown/createTaskLine';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog } from '../helpers';

const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
const ref: TaskRef = { filePath: 'tasks.md', line: 0, revision: 'test-revision' };
const target = { type: 'task' as const, ref };

describe('markdown infrastructure contracts', () => {
  it.each([
    'set-description',
    'add-subtask',
    'delete-subtask',
    'reorder-subtask',
    'add-comment',
    'update-comment',
    'delete-comment',
    'delete',
  ] as const)('keeps structural command %s out of the line-only editor', (type) => {
    expect(applyTaskCommand(codec, '- [ ] task', { type } as unknown as TaskEditCommand)).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'block' }],
    });
  });

  it('rejects malformed source and command targets before producing a line candidate', () => {
    expect(applyTaskCommand(codec, 'plain text', { type: 'patch', target, patch: {} })).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-task-syntax' }],
    });
    expect(
      applyTaskCommand(codec, '- [ ] task', {
        type: 'patch',
        target,
        patch: {
          start: { type: 'set', value: localDate('2026-07-21') },
          due: { type: 'set', value: localDate('2026-07-20') },
        },
      }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'inverted-span', field: 'start,due' }],
    });
    expect(
      applyTaskCommand(codec, '- [ ] task', {
        type: 'edit-link',
        target: { type: 'description', target },
        occurrence: 0,
        replacement: '[[Changed]]',
      }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'link' }],
    });
  });

  it('executes explicit clear variants through the ordered patch editor', () => {
    expect(
      applyTaskCommand(codec, '- [ ] task', {
        type: 'patch',
        target,
        patch: { markdownTitle: { type: 'clear' } },
      }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-title', field: 'title' }],
    });
    expect(
      applyTaskCommand(codec, '- [ ] task 🔺', {
        type: 'patch',
        target,
        patch: { priority: { type: 'clear' } },
      }),
    ).toEqual({ type: 'changed', content: '- [ ] task' });
  });

  it.each([
    {
      source: '- [ ] due 📅 2026-07-20',
      days: 1 as const,
      expected: '- [ ] due 📅 2026-07-21',
    },
    {
      source: '- [ ] planned ⏳ 2026-07-10 📅 2026-07-20',
      days: 1 as const,
      expected: '- [ ] planned ⏳ 2026-07-11 📅 2026-07-20',
    },
    {
      source: '- [ ] span ⏰ 09:00 ⏱️ 1h30m 🛫 2026-07-18 ⏳ 2026-07-01 📅 2026-07-20',
      days: 1 as const,
      expected: '- [ ] span ⏰ 09:00 ⏱️ 1h30m 🛫 2026-07-19 ⏳ 2026-07-01 📅 2026-07-21',
    },
  ])('shifts the $source schedule atomically', ({ source, days, expected }) => {
    expect(applyTaskCommand(codec, source, { type: 'shift-schedule', ref, days })).toEqual({
      type: 'changed',
      content: expected,
    });
  });

  it('rejects a missing anchor and shifts beyond the local-date bounds without producing a line', () => {
    expect(
      applyTaskCommand(codec, '- [ ] unscheduled', { type: 'shift-schedule', ref, days: 1 }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'schedule' }],
    });
    expect(
      applyTaskCommand(codec, '- [ ] earliest 📅 0000-01-01', {
        type: 'shift-schedule',
        ref,
        days: -1,
      }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-date', field: 'schedule' }],
    });
    expect(
      applyTaskCommand(codec, '- [ ] latest 📅 9999-12-31', {
        type: 'shift-schedule',
        ref,
        days: 1,
      }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-date', field: 'schedule' }],
    });
  });

  it.each([
    {
      name: 'multiline body',
      markdownBody: 'first\nsecond',
      issues: [{ code: 'invalid-title', field: 'title' }],
    },
    {
      name: 'empty title',
      markdownBody: '   ',
      issues: [{ code: 'invalid-title', field: 'title' }],
    },
    {
      name: 'malformed metadata',
      markdownBody: 'task ⏰ 25:00',
      issues: [{ code: 'invalid-time', field: 'time' }],
    },
  ] as const)('rejects a $name while constructing a root line', ({ markdownBody, issues }) => {
    expect(createTaskLine(codec, { markdownBody })).toEqual({ type: 'invalid', issues });
  });
});
