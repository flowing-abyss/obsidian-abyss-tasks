import { describe, expect, it, vi } from 'vitest';
import type {
  TaskDependencyQueryApi,
  TaskQueryApi,
} from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type {
  TaskEditRequest,
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import { prepareRetry, type PreparedMutation } from '../../src/tasks/application/taskRetryPolicy';
import { clockFrom } from '../../src/tasks/domain/clock';
import type { TaskCommand } from '../../src/tasks/domain/commands';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type {
  DurationMinutes,
  LocalTime,
  SubtaskRef,
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskMutationTarget,
  TaskPlanning,
  TaskSnapshot,
} from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';

function snapshot(markdownTitle = 'Task', revision = 'old'): TaskSnapshot {
  return {
    ref: { filePath: 'tasks.md', line: 0, revision },
    title: markdownTitle,
    markdownTitle,
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep',
    onCompletionExplicit: false,
    planning: { due: localDate('2026-08-11') },
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: 'tasks.md',
      line: 0,
      originalMarkdown: `- [ ] ${markdownTitle} 📅 2026-08-11`,
      originalBlock: `- [ ] ${markdownTitle} 📅 2026-08-11`,
    },
    presentation: { linkCount: 0 },
  };
}

function prepared(
  command: TaskEditRequest['command'],
  retry: PreparedMutation['retry'],
): PreparedMutation {
  const base = snapshot();
  return {
    publicCommand: { type: 'delete', ref: base.ref },
    repositoryRequest: {
      command,
      baseRoot: base,
      baseTarget: { type: 'task', ref: base.ref },
      reconciliation: { observed: base },
    },
    base,
    targetBase: { type: 'task', ref: base.ref },
    clock: clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0).read(),
    settings: {
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before', removeScheduledDate: false },
    },
    retry,
  };
}

function subtask(root: TaskSnapshot, overrides: Partial<SubtaskSnapshot> = {}): SubtaskSnapshot {
  const ref: SubtaskRef = {
    parent: { type: 'task', ref: root.ref },
    relativeLine: 1,
    originalBlock: '  - [ ] child',
  };
  return {
    ref,
    title: 'child',
    markdownTitle: 'child',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    planning: {},
    tags: [],
    dependsOn: [],
    onCompletion: 'keep',
    onCompletionExplicit: false,
    subtasks: [],
    comments: [],
    ...overrides,
  };
}

function comment(parent: SubtaskSnapshot | TaskSnapshot, text = 'note'): TaskCommentSnapshot {
  return {
    ref: {
      parent:
        'source' in parent
          ? { type: 'task', ref: parent.ref }
          : { type: 'subtask', ref: parent.ref },
      relativeLine: 1,
      originalMarkdown: `  - ${text}`,
    },
    text,
  };
}

function preparedFor(
  base: TaskSnapshot,
  command: TaskEditRequest['command'],
  retry: PreparedMutation['retry'],
  targetBase: TaskMutationTarget = { type: 'task', ref: base.ref },
): PreparedMutation {
  return {
    ...prepared(command, retry),
    base,
    targetBase,
    repositoryRequest: {
      command,
      baseRoot: base,
      baseTarget: targetBase,
      reconciliation: { observed: base },
    },
  };
}

function retryAgainst(
  mutation: PreparedMutation,
  previous: TaskSnapshot,
  current: TaskSnapshot,
  evidence: 'authority-transition' | 'byte-identical-relocation' = 'authority-transition',
) {
  return prepareRetry(mutation, { type: 'rebased', previous, current, evidence });
}

describe('prepareRetry', () => {
  it('rebases anchored subtree restoration with the complete current parent and anchor references', () => {
    const previousBase = snapshot();
    const previous = {
      ...previousBase,
      subtasks: [subtask(previousBase)],
      source: {
        ...previousBase.source,
        originalBlock: `${previousBase.source.originalMarkdown}\n  - [ ] child`,
      },
    };
    const currentBase = snapshot('Task', 'current');
    const current = { ...currentBase, subtasks: [subtask(currentBase)], source: previous.source };
    const command: TaskEditRequest['command'] = {
      type: 'restore-subtask',
      parent: { type: 'task', ref: previous.ref },
      markdown: '  - [ ] restored\n',
      placement: { relativeLine: 1, before: subtask(previous).ref },
    };
    const retry = retryAgainst(preparedFor(previous, command, 'exact-target'), previous, current);
    expect(retry.type).toBe('edit');
    if (retry.type !== 'edit') return;
    expect(retry.request.command).toEqual({
      ...command,
      parent: { type: 'task', ref: current.ref },
      placement: { relativeLine: 1, before: subtask(current).ref },
    });
    expect(retry.request.baseTarget).toEqual({ type: 'task', ref: current.ref });
  });

  it('does not reuse a relative-only restoration position after the base revision changes', () => {
    const previous = snapshot();
    const current = snapshot('Task', 'current');
    const command: TaskEditRequest['command'] = {
      type: 'restore-subtask',
      parent: { type: 'task', ref: previous.ref },
      markdown: '  - [ ] restored',
      placement: { relativeLine: 1, lineEnding: '\n' },
    };
    expect(retryAgainst(preparedFor(previous, command, 'exact-target'), previous, current)).toEqual(
      { type: 'unsafe' },
    );
  });

  it.each(['revision', 'relocation'] as const)(
    'does not rebase an anchored restoration gap after %s',
    (change) => {
      const previousBase = snapshot();
      const previous = {
        ...previousBase,
        subtasks: [subtask(previousBase)],
        source: {
          ...previousBase.source,
          originalBlock: `${previousBase.source.originalMarkdown}\n  - [ ] child`,
        },
      };
      const currentBase =
        change === 'revision'
          ? snapshot('Task', 'current')
          : { ...previousBase, ref: { ...previousBase.ref, line: 2 } };
      const current = { ...currentBase, subtasks: [subtask(currentBase)], source: previous.source };
      const command: TaskEditRequest['command'] = {
        type: 'restore-subtask',
        parent: { type: 'task', ref: previous.ref },
        markdown: '  - [ ] restored\n',
        placement: { relativeLine: 3, after: subtask(previous).ref },
      };
      expect(
        retryAgainst(preparedFor(previous, command, 'exact-target'), previous, current),
      ).toEqual({ type: 'unsafe' });
    },
  );

  it('does not restore into a changed parent even if its neighboring child still matches', () => {
    const previousBase = snapshot();
    const previous = {
      ...previousBase,
      subtasks: [subtask(previousBase)],
      source: {
        ...previousBase.source,
        originalBlock: `${previousBase.source.originalMarkdown}\n  - [ ] child`,
      },
    };
    const currentBase = snapshot('Renamed', 'current');
    const current = {
      ...currentBase,
      subtasks: [subtask(currentBase)],
      source: {
        ...currentBase.source,
        originalBlock: `${currentBase.source.originalMarkdown}\n  - [ ] child`,
      },
    };
    const command: TaskEditRequest['command'] = {
      type: 'restore-subtask',
      parent: { type: 'task', ref: previous.ref },
      markdown: '  - [ ] restored\n',
      placement: { relativeLine: 1, before: subtask(previous).ref },
    };
    expect(retryAgainst(preparedFor(previous, command, 'exact-target'), previous, current)).toEqual(
      { type: 'unsafe' },
    );
  });

  it.each([
    {
      name: 'dependency id',
      command: (base: TaskSnapshot): TaskEditRequest['command'] => ({
        type: 'set-dependency-id',
        target: { type: 'task', ref: base.ref },
        id: 'next-id',
      }),
      unchanged: (root: TaskSnapshot): TaskSnapshot => ({ ...root, dependencyId: 'old-id' }),
      changed: (root: TaskSnapshot): TaskSnapshot => ({ ...root, dependencyId: 'external-id' }),
    },
    {
      name: 'depends-on ids',
      command: (base: TaskSnapshot): TaskEditRequest['command'] => ({
        type: 'set-depends-on',
        target: { type: 'task', ref: base.ref },
        ids: ['next'],
      }),
      unchanged: (root: TaskSnapshot): TaskSnapshot => ({ ...root, dependsOn: ['old', 'old'] }),
      changed: (root: TaskSnapshot): TaskSnapshot => ({ ...root, dependsOn: ['external'] }),
    },
  ])(
    'rebases $name edits only while the authored metadata is unchanged',
    ({ command, unchanged, changed }) => {
      const previous = unchanged(snapshot());
      const currentBase = { ...snapshot('Renamed elsewhere', 'new'), source: previous.source };
      const current = unchanged(currentBase);
      const edit = command(previous);

      expect(
        retryAgainst(preparedFor(previous, edit, 'exact-target'), previous, current),
      ).toMatchObject({
        type: 'edit',
        request: {
          command: { type: edit.type, target: { type: 'task', ref: current.ref } },
          baseRoot: current,
        },
      });
      expect(
        retryAgainst(preparedFor(previous, edit, 'exact-target'), previous, changed(currentBase)),
      ).toEqual({ type: 'unsafe' });
    },
  );

  it.each([
    {
      name: 'dependency id',
      command: (target: { readonly type: 'subtask'; readonly ref: SubtaskRef }) => ({
        type: 'set-dependency-id' as const,
        target,
        id: 'next-id',
      }),
      previousChild: { dependencyId: 'old-id' },
      changedChild: { dependencyId: 'external-id' },
    },
    {
      name: 'depends-on ids',
      command: (target: { readonly type: 'subtask'; readonly ref: SubtaskRef }) => ({
        type: 'set-depends-on' as const,
        target,
        ids: ['next'],
      }),
      previousChild: { dependsOn: ['old', 'old'] },
      changedChild: { dependsOn: ['external'] },
    },
  ])(
    'rebases nested $name edits against the exact subtask',
    ({ command, previousChild, changedChild }) => {
      const previousRoot = snapshot();
      const previousSubtask = subtask(previousRoot, previousChild);
      const previous = { ...previousRoot, subtasks: [previousSubtask] };
      const currentRoot = snapshot('Renamed elsewhere', 'new');
      const currentSubtask = subtask(currentRoot, {
        ...previousChild,
        ref: { ...previousSubtask.ref, parent: { type: 'task', ref: currentRoot.ref } },
      });
      const current = { ...currentRoot, subtasks: [currentSubtask] };
      const target = { type: 'subtask' as const, ref: previousSubtask.ref };
      const edit = command(target);
      const mutation = preparedFor(previous, edit, 'exact-target', target);

      expect(retryAgainst(mutation, previous, current)).toMatchObject({
        type: 'edit',
        request: {
          command: { type: edit.type, target: { type: 'subtask', ref: currentSubtask.ref } },
          baseTarget: { type: 'subtask', ref: currentSubtask.ref },
        },
      });
      expect(
        retryAgainst(mutation, previous, {
          ...current,
          subtasks: [{ ...currentSubtask, ...changedChild }],
        }),
      ).toEqual({ type: 'unsafe' });
    },
  );

  it('accepts a field race that already applied the requested value', () => {
    const base = snapshot();
    const command = {
      type: 'patch' as const,
      target: { type: 'task' as const, ref: base.ref },
      patch: { priority: { type: 'set' as const, value: 'A' as const } },
    };
    const current = { ...snapshot('Task', 'new'), priority: 'A' as const };

    expect(
      prepareRetry(prepared(command, 'field-compare'), {
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      }),
    ).toMatchObject({ type: 'edit', request: { baseRoot: current } });
  });

  it.each([
    {
      command: { type: 'reschedule' as const, ref: snapshot().ref, date: localDate('2026-08-12') },
      planning: { due: localDate('2026-08-12') },
    },
    {
      command: {
        type: 'set-time-slot' as const,
        ref: snapshot().ref,
        date: localDate('2026-08-12'),
        time: '10:00' as LocalTime,
      },
      planning: {
        due: localDate('2026-08-12'),
        time: '10:00' as LocalTime,
      },
    },
    {
      command: {
        type: 'convert-to-all-day' as const,
        ref: snapshot().ref,
        date: localDate('2026-08-12'),
      },
      planning: { due: localDate('2026-08-12') },
    },
    {
      command: {
        type: 'set-span-boundary' as const,
        ref: snapshot().ref,
        boundary: 'due' as const,
        date: localDate('2026-08-14'),
      },
      planning: { due: localDate('2026-08-14') },
    },
    {
      command: {
        type: 'extend-span' as const,
        ref: snapshot().ref,
        due: localDate('2026-08-14'),
      },
      planning: { start: localDate('2026-08-11'), due: localDate('2026-08-14') },
    },
  ])('accepts already-requested scheduling intent: $command.type', ({ command, planning }) => {
    const base = snapshot();
    const current = { ...snapshot('Task', 'new'), planning };
    expect(
      prepareRetry(prepared(command, 'field-compare'), {
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      }),
    ).toMatchObject({ type: 'edit', request: { baseRoot: current } });
  });

  it('compares a nested field on the exact child rather than the root', () => {
    const base = snapshot();
    const childRef = {
      parent: { type: 'task' as const, ref: base.ref },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const child = {
      ref: childRef,
      title: 'child',
      markdownTitle: 'child',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      planning: {},
      tags: [],
      dependsOn: [],
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      subtasks: [],
      comments: [],
    };
    const previous = { ...base, subtasks: [child] };
    const current = {
      ...snapshot('Root changed', 'new'),
      subtasks: [
        {
          ...child,
          ref: { ...childRef, parent: { type: 'task' as const, ref: snapshot('x', 'new').ref } },
          priority: 'A' as const,
        },
      ],
    };
    const command = {
      type: 'patch' as const,
      target: { type: 'subtask' as const, ref: childRef },
      patch: { priority: { type: 'set' as const, value: 'B' as const } },
    };
    const mutation = {
      ...prepared(command, 'field-compare'),
      base: previous,
      targetBase: command.target,
      repositoryRequest: {
        command,
        baseRoot: previous,
        baseTarget: command.target,
        reconciliation: { observed: previous },
      },
    } satisfies PreparedMutation;

    expect(
      prepareRetry(mutation, {
        type: 'rebased',
        previous,
        current,
        evidence: 'authority-transition',
      }),
    ).toEqual({ type: 'unsafe' });
  });

  it('recomputes an add-tag intent against an authority-proven current root', () => {
    const base = snapshot();
    const command = {
      type: 'patch' as const,
      target: { type: 'task' as const, ref: base.ref },
      patch: { tags: { add: ['#work'] } },
    };
    const current = { ...snapshot('Task', 'new'), tags: ['#external'] };

    expect(
      prepareRetry(prepared(command, 'commutative'), {
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      }),
    ).toMatchObject({
      type: 'edit',
      request: {
        command: {
          type: 'patch',
          target: { type: 'task', ref: current.ref },
          patch: { tags: { add: ['#work'] } },
        },
        baseRoot: current,
      },
    });
  });

  it('does not retry a field replacement when that field changed', () => {
    const base = snapshot();
    const command = {
      type: 'patch' as const,
      target: { type: 'task' as const, ref: base.ref },
      patch: { markdownTitle: { type: 'set' as const, value: 'Requested' } },
    };

    expect(
      prepareRetry(prepared(command, 'field-compare'), {
        type: 'rebased',
        previous: base,
        current: snapshot('External', 'new'),
        evidence: 'authority-transition',
      }),
    ).toEqual({ type: 'unsafe' });
  });

  it('retries whole-task delete only after byte-identical relocation', () => {
    const base = snapshot();
    const command = { type: 'delete' as const, ref: base.ref };
    const current = {
      ...base,
      ref: { ...base.ref, line: 4, revision: 'moved' },
      source: { ...base.source, line: 4 },
    };

    expect(
      prepareRetry(prepared(command, 'relocation-only'), {
        type: 'rebased',
        previous: base,
        current,
        evidence: 'byte-identical-relocation',
      }),
    ).toMatchObject({
      type: 'edit',
      request: { command: { type: 'delete', ref: current.ref } },
    });
    expect(
      prepareRetry(prepared(command, 'relocation-only'), {
        type: 'rebased',
        previous: base,
        current: snapshot('Task', 'changed'),
        evidence: 'authority-transition',
      }),
    ).toEqual({ type: 'unsafe' });
  });

  it.each([
    {
      name: 'append title',
      command: (base: TaskSnapshot): TaskEditRequest['command'] => ({
        type: 'append-title',
        target: { type: 'task', ref: base.ref },
        markdown: ' #next',
      }),
    },
    {
      name: 'set description',
      command: (base: TaskSnapshot): TaskEditRequest['command'] => ({
        type: 'set-description',
        target: { type: 'task', ref: base.ref },
        text: 'details',
      }),
    },
    {
      name: 'add subtask',
      command: (base: TaskSnapshot): TaskEditRequest['command'] => ({
        type: 'add-subtask',
        parent: { type: 'task', ref: base.ref },
        text: 'child',
        today: localDate('2026-08-11'),
        addCreatedDate: true,
      }),
    },
    {
      name: 'add comment',
      command: (base: TaskSnapshot): TaskEditRequest['command'] => ({
        type: 'add-comment',
        parent: { type: 'task', ref: base.ref },
        text: 'note',
        stamp: atomDateTime('2026-08-11T09:32:10+00:00'),
      }),
    },
  ])('rebases an exact-target $name command onto the authoritative root', ({ command }) => {
    const base = snapshot();
    const current = snapshot('Task', 'new');
    const result = retryAgainst(preparedFor(base, command(base), 'exact-target'), base, current);

    expect(result).toMatchObject({
      type: 'edit',
      request: { baseRoot: current, baseTarget: { type: 'task', ref: current.ref } },
    });
  });

  it('rebases subtask and comment mutation targets recursively', () => {
    const base = snapshot();
    const child = subtask(base);
    const childComment = comment(child);
    const previous = { ...base, subtasks: [{ ...child, comments: [childComment] }] };
    const currentRoot = snapshot('Task', 'new');
    const currentChild = subtask(currentRoot, {
      ref: { ...child.ref, parent: { type: 'task', ref: currentRoot.ref } },
      comments: [
        {
          ...childComment,
          ref: {
            ...childComment.ref,
            parent: {
              type: 'subtask',
              ref: { ...child.ref, parent: { type: 'task', ref: currentRoot.ref } },
            },
          },
        },
      ],
    });
    const current = { ...currentRoot, subtasks: [currentChild] };
    const command: TaskEditRequest['command'] = {
      type: 'update-comment',
      comment: childComment.ref,
      text: 'updated',
    };
    const targetBase: TaskMutationTarget = { type: 'comment', ref: childComment.ref };

    expect(
      retryAgainst(preparedFor(previous, command, 'exact-target', targetBase), previous, current),
    ).toMatchObject({
      type: 'edit',
      request: {
        command: {
          type: 'update-comment',
          comment: {
            parent: { type: 'subtask', ref: { parent: { type: 'task', ref: current.ref } } },
          },
        },
        baseTarget: {
          type: 'comment',
          ref: { parent: { type: 'subtask', ref: { parent: { type: 'task', ref: current.ref } } } },
        },
      },
    });
  });

  it.each(['update-comment', 'delete-comment'] as const)(
    'retries %s only while the referenced comment still exists',
    (type) => {
      const base = snapshot();
      const baseComment = comment(base);
      const previous = { ...base, comments: [baseComment] };
      const currentRoot = snapshot('Task', 'new');
      const currentComment = {
        ...baseComment,
        ref: { ...baseComment.ref, parent: { type: 'task' as const, ref: currentRoot.ref } },
      };
      const current = { ...currentRoot, comments: [currentComment] };
      const command: TaskEditRequest['command'] =
        type === 'update-comment'
          ? { type, comment: baseComment.ref, text: 'updated' }
          : { type, comment: baseComment.ref };

      expect(
        retryAgainst(preparedFor(previous, command, 'exact-target'), previous, current),
      ).toMatchObject({
        type: 'edit',
        request: { command: { type, comment: currentComment.ref } },
      });
      expect(
        retryAgainst(preparedFor(previous, command, 'exact-target'), previous, {
          ...current,
          comments: [],
        }),
      ).toEqual({ type: 'unsafe' });
    },
  );

  it.each([
    {
      name: 'title',
      target: (base: TaskSnapshot) => ({
        type: 'title' as const,
        target: { type: 'task' as const, ref: base.ref },
      }),
      changed: (current: TaskSnapshot): TaskSnapshot => ({
        ...current,
        markdownTitle: 'Externally changed',
      }),
    },
    {
      name: 'description',
      target: (base: TaskSnapshot) => ({
        type: 'description' as const,
        target: { type: 'task' as const, ref: base.ref },
      }),
      changed: (current: TaskSnapshot): TaskSnapshot => ({
        ...current,
        description: 'Externally changed',
      }),
    },
  ])('retries an edit-link $name only while its text field is unchanged', ({ target, changed }) => {
    const base = { ...snapshot(), description: 'details' };
    const current = { ...base, ref: snapshot('Task', 'new').ref };
    const command: TaskEditRequest['command'] = {
      type: 'edit-link',
      target: target(base),
      occurrence: 0,
      replacement: '[[New]]',
    };

    expect(retryAgainst(preparedFor(base, command, 'exact-target'), base, current)).toMatchObject({
      type: 'edit',
      request: { command: { type: 'edit-link', target: target(current) } },
    });
    expect(
      retryAgainst(preparedFor(base, command, 'exact-target'), base, changed(current)),
    ).toEqual({ type: 'unsafe' });
  });

  it('retries a comment edit-link only while that exact comment exists', () => {
    const base = snapshot();
    const baseComment = comment(base);
    const previous = { ...base, comments: [baseComment] };
    const currentRoot = snapshot('Task', 'new');
    const currentComment = {
      ...baseComment,
      ref: { ...baseComment.ref, parent: { type: 'task' as const, ref: currentRoot.ref } },
    };
    const current = { ...currentRoot, comments: [currentComment] };
    const command: TaskEditRequest['command'] = {
      type: 'edit-link',
      target: { type: 'comment', ref: baseComment.ref },
      occurrence: 0,
      replacement: '[[New]]',
    };

    expect(
      retryAgainst(preparedFor(previous, command, 'exact-target'), previous, current),
    ).toMatchObject({
      type: 'edit',
      request: { command: { target: { type: 'comment', ref: currentComment.ref } } },
    });
    expect(
      retryAgainst(preparedFor(previous, command, 'exact-target'), previous, {
        ...current,
        comments: [],
      }),
    ).toEqual({ type: 'unsafe' });
  });

  it('retries deleting an unchanged subtask but never retries reordering one', () => {
    const base = snapshot();
    const child = subtask(base);
    const previous = { ...base, subtasks: [child] };
    const currentRoot = snapshot('Task', 'new');
    const currentChild = subtask(currentRoot, {
      ref: { ...child.ref, parent: { type: 'task', ref: currentRoot.ref } },
    });
    const current = { ...currentRoot, subtasks: [currentChild] };
    const deleteCommand: TaskEditRequest['command'] = {
      type: 'delete-subtask',
      subtask: child.ref,
    };
    const reorderCommand: TaskEditRequest['command'] = {
      type: 'reorder-subtask',
      subtask: child.ref,
      target: child.ref,
      placement: 'after',
    };

    expect(
      retryAgainst(
        preparedFor(previous, deleteCommand, 'exact-target', { type: 'subtask', ref: child.ref }),
        previous,
        current,
      ),
    ).toMatchObject({
      type: 'edit',
      request: {
        command: { type: 'delete-subtask', subtask: currentChild.ref },
        baseTarget: { type: 'subtask', ref: currentChild.ref },
      },
    });
    expect(
      retryAgainst(preparedFor(previous, reorderCommand, 'exact-target'), previous, current),
    ).toEqual({ type: 'unsafe' });
  });

  it.each([
    ['markdownTitle', { type: 'set' as const, value: 'Requested' }, { markdownTitle: 'Requested' }],
    ['priority', { type: 'set' as const, value: 'A' }, { priority: 'A' as const }],
    ['recurrence', { type: 'set' as const, value: 'every day' }, { recurrence: 'every day' }],
    [
      'onCompletion',
      { type: 'set' as const, value: 'delete' },
      { onCompletion: 'delete' as const },
    ],
    ['due', { type: 'clear' as const }, { planning: {} }],
  ] as const)(
    'accepts an already-applied %s patch and preserves it during rebase',
    (field, update, currentOverride) => {
      const base = snapshot();
      const command = {
        type: 'patch' as const,
        target: { type: 'task' as const, ref: base.ref },
        patch: { [field]: update },
      } as TaskEditRequest['command'];
      const current = { ...snapshot('Task', 'new'), ...currentOverride };

      expect(
        retryAgainst(preparedFor(base, command, 'field-compare'), base, current),
      ).toMatchObject({
        type: 'edit',
        request: { command: { type: 'patch', patch: { [field]: update } } },
      });
    },
  );

  it.each([
    {
      name: 'reschedule on a scheduled anchor',
      planning: { scheduled: localDate('2026-08-11') },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'reschedule',
        ref,
        date: localDate('2026-08-15'),
      }),
      currentPlanning: { scheduled: localDate('2026-08-15') },
    },
    {
      name: 'shift a due-only task',
      planning: { due: localDate('2026-08-11') },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'shift-schedule',
        ref,
        days: 2,
      }),
      currentPlanning: { due: localDate('2026-08-13') },
    },
    {
      name: 'shift a task span',
      planning: { start: localDate('2026-08-10'), due: localDate('2026-08-11') },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'shift-schedule',
        ref,
        days: 2,
      }),
      currentPlanning: { start: localDate('2026-08-12'), due: localDate('2026-08-13') },
    },
    {
      name: 'move a timed task',
      planning: { due: localDate('2026-08-11'), time: '09:00' as LocalTime },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'move-time-slot',
        ref,
        days: 1,
        time: '10:00' as LocalTime,
      }),
      currentPlanning: { due: localDate('2026-08-12'), time: '10:00' as LocalTime },
    },
    {
      name: 'move a timed task to all day',
      planning: {
        due: localDate('2026-08-11'),
        time: '09:00' as LocalTime,
        duration: 30 as DurationMinutes,
      },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'move-to-all-day',
        ref,
        days: 1,
      }),
      currentPlanning: { due: localDate('2026-08-12') },
    },
    {
      name: 'set a slot with duration',
      planning: { due: localDate('2026-08-11') },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'set-time-slot',
        ref,
        date: localDate('2026-08-15'),
        time: '10:00' as LocalTime,
        duration: 45 as DurationMinutes,
      }),
      currentPlanning: {
        due: localDate('2026-08-15'),
        time: '10:00' as LocalTime,
        duration: 45 as DurationMinutes,
      },
    },
    {
      name: 'convert a timed task to all day',
      planning: {
        due: localDate('2026-08-11'),
        time: '09:00' as LocalTime,
        duration: 30 as DurationMinutes,
      },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'convert-to-all-day',
        ref,
        date: localDate('2026-08-15'),
      }),
      currentPlanning: { due: localDate('2026-08-15') },
    },
    {
      name: 'change a span start',
      planning: { start: localDate('2026-08-10'), due: localDate('2026-08-11') },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'set-span-boundary',
        ref,
        boundary: 'start',
        date: localDate('2026-08-09'),
      }),
      currentPlanning: { start: localDate('2026-08-09'), due: localDate('2026-08-11') },
    },
    {
      name: 'extend a scheduled task into a span',
      planning: { scheduled: localDate('2026-08-11') },
      command: (ref: TaskSnapshot['ref']): TaskEditRequest['command'] => ({
        type: 'extend-span',
        ref,
        due: localDate('2026-08-15'),
      }),
      currentPlanning: {
        scheduled: localDate('2026-08-11'),
        start: localDate('2026-08-11'),
        due: localDate('2026-08-15'),
      },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    planning: TaskPlanning;
    command: (ref: TaskSnapshot['ref']) => TaskEditRequest['command'];
    currentPlanning: TaskPlanning;
  }>)(
    'accepts already-applied scheduling intent: $name',
    ({ planning, command, currentPlanning }) => {
      const base = { ...snapshot(), planning };
      const current = { ...snapshot('Task', 'new'), planning: currentPlanning };
      const editCommand = command(base.ref);

      expect(
        retryAgainst(preparedFor(base, editCommand, 'field-compare'), base, current),
      ).toMatchObject({
        type: 'edit',
        request: { baseRoot: current, command: { type: editCommand.type, ref: current.ref } },
      });
    },
  );

  it('rejects field and exact-target retries when the target is missing or ambiguous', () => {
    const base = snapshot();
    const child = subtask(base);
    const previous = { ...base, subtasks: [child] };
    const command: TaskEditRequest['command'] = {
      type: 'set-status',
      target: { type: 'subtask', ref: child.ref },
      symbol: 'x',
    };
    const exactCommand: TaskEditRequest['command'] = {
      type: 'append-title',
      target: { type: 'subtask', ref: child.ref },
      markdown: ' changed',
    };
    const missing = snapshot('Task', 'new');
    const duplicateChild = subtask(missing, {
      ref: { ...child.ref, parent: { type: 'task', ref: missing.ref } },
    });
    const ambiguous = { ...missing, subtasks: [duplicateChild, { ...duplicateChild }] };

    expect(
      retryAgainst(preparedFor(previous, command, 'field-compare'), previous, missing),
    ).toEqual({
      type: 'unsafe',
    });
    expect(
      retryAgainst(preparedFor(previous, exactCommand, 'exact-target'), previous, ambiguous),
    ).toEqual({ type: 'unsafe' });
  });

  it('honors status idempotence, never, and move retry policies', () => {
    const base = snapshot();
    const statusCommand: TaskEditRequest['command'] = {
      type: 'set-status',
      target: { type: 'task', ref: base.ref },
      symbol: 'x',
    };
    const completed = { ...snapshot('Task', 'new'), statusSymbol: 'x', status: 'done' as const };

    expect(
      retryAgainst(preparedFor(base, statusCommand, 'field-compare'), base, completed),
    ).toMatchObject({
      type: 'edit',
    });
    expect(retryAgainst(preparedFor(base, statusCommand, 'never'), base, completed)).toEqual({
      type: 'unsafe',
    });

    const moveMutation: PreparedMutation = {
      ...preparedFor(base, { type: 'delete', ref: base.ref }, 'never'),
      publicCommand: {
        type: 'move',
        ref: base.ref,
        destination: { filePath: 'archive.md', insertion: { type: 'append' } },
      },
      repositoryRequest: {
        destination: { filePath: 'archive.md', insertion: { type: 'append' } },
        baseRoot: base,
        baseTarget: { type: 'task', ref: base.ref },
        reconciliation: { observed: base },
      },
    };
    expect(retryAgainst(moveMutation, base, completed)).toEqual({ type: 'unsafe' });
  });

  it('retries recurrence completion for an unchanged nested owner and rebases its target', () => {
    const base = snapshot();
    const child = subtask(base, {
      recurrence: 'every day',
      ref: {
        parent: { type: 'task', ref: base.ref },
        relativeLine: 1,
        originalBlock: '  - [ ] child 🔁 every day\n    - note',
      },
    });
    const previous = { ...base, subtasks: [child] };
    const currentRoot = snapshot('Task', 'new');
    const currentChild = subtask(currentRoot, {
      ...child,
      ref: { ...child.ref, parent: { type: 'task', ref: currentRoot.ref } },
    });
    const current = { ...currentRoot, subtasks: [currentChild] };
    const request = {
      command: {
        target: { type: 'subtask' as const, ref: child.ref },
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-11'),
        addCreatedDate: true,
        addCompletionDate: true,
        placement: 'before' as const,
        policy: {
          type: 'rrule' as const,
          rule: 'FREQ=DAILY',
          removeScheduledDate: false,
        },
      },
      baseRoot: previous,
      baseTarget: { type: 'subtask' as const, ref: child.ref },
      reconciliation: { observed: previous },
      baseOwnedDescendants: '\n    - note',
    };
    const mutation: PreparedMutation = {
      ...preparedFor(previous, { type: 'delete', ref: previous.ref }, 'never'),
      publicCommand: { type: 'set-status', target: request.command.target, symbol: 'x' },
      repositoryRequest: request,
      targetBase: request.baseTarget,
    };

    expect(retryAgainst(mutation, previous, current)).toMatchObject({
      type: 'recurrence',
      request: {
        command: { target: { type: 'subtask', ref: currentChild.ref } },
        baseRoot: current,
        baseTarget: { type: 'subtask', ref: currentChild.ref },
        baseOwnedDescendants: '\n    - note',
      },
    });
  });
});

const statuses = new StatusCatalog([
  { id: 'todo', symbol: ' ', type: 'todo', defaultForType: true },
  { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
]);

function query(
  resolution: ReturnType<TaskQueryApi['resolve']>,
): TaskQueryApi & TaskDependencyQueryApi {
  return {
    listNodes: () => [],
    dependencies: () => ({
      blockedBy: [],
      blocks: [],
      activeBlockedByCount: 0,
      activeBlocksCount: 0,
    }),
    dependencyEligibility: () => ({ type: 'allowed' }),
    list: () => [],
    forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
    resolve: () => resolution,
    subscribe: () => () => undefined,
  };
}

function repositoryWith(
  edit: TaskRepository['edit'],
  overrides: Partial<TaskRepository> = {},
): TaskRepository {
  return {
    supportsRevisionPreconditions: true,
    edit,
    editBatch: vi.fn(),
    completeRecurrence: vi.fn(),
    create: vi.fn(),
    move: vi.fn(),
    ...overrides,
  };
}

function committed(task = snapshot()): TaskRepositoryResult {
  return { type: 'committed', outcome: { type: 'task', task }, changed: true };
}

describe('TaskApplicationService one-shot retry', () => {
  it('retries add-comment once against the repository-proven parent', async () => {
    const base = snapshot();
    const current = {
      ...snapshot('Task #external', 'new'),
      tags: ['#external'],
    };
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      })
      .mockResolvedValueOnce(committed(current));
    const clock = { read: vi.fn(() => clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0).read()) };
    const settings = vi.fn(() => ({
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'before' as const, removeScheduledDate: false },
    }));
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit),
      statuses,
      clock,
      undefined,
      settings,
    );

    await expect(
      service.execute({
        type: 'add-comment',
        parent: { type: 'task', ref: base.ref },
        text: 'Keep this text',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0]?.[0]).toMatchObject({
      command: { type: 'add-comment', stamp: '2026-08-11T09:32:10+00:00' },
      baseRoot: base,
    });
    expect(edit.mock.calls[1]?.[0]).toMatchObject({
      command: { type: 'add-comment', stamp: '2026-08-11T09:32:10+00:00' },
      baseRoot: current,
    });
    expect(clock.read).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
  });

  it('never performs a third write after a second repository race', async () => {
    const base = snapshot();
    const current = snapshot('Task #one', 'one');
    const latest = snapshot('Task #one #two', 'two');
    const edit = vi
      .fn<TaskRepository['edit']>()
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      })
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: current,
        current: latest,
        evidence: 'authority-transition',
      });
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'add-comment',
        parent: { type: 'task', ref: base.ref },
        text: 'Only once',
      }),
    ).resolves.toEqual({ type: 'conflict', current: latest });
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('does not retry a description replacement after that description changed', async () => {
    const base = { ...snapshot(), description: 'Old' };
    const current = { ...snapshot('Task', 'new'), description: 'External' };
    const edit = vi.fn<TaskRepository['edit']>().mockResolvedValueOnce({
      type: 'rebased',
      previous: base,
      current,
      evidence: 'authority-transition',
    });
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'set-description',
        target: { type: 'task', ref: base.ref },
        text: 'Requested',
      }),
    ).resolves.toEqual({ type: 'conflict', current });
    expect(edit).toHaveBeenCalledOnce();
  });

  it('routes an eligible recurrence retry only through completeRecurrence', async () => {
    const base = { ...snapshot(), recurrence: 'every day' };
    const current = { ...base, ref: { ...base.ref, revision: 'new' }, tags: ['#external'] };
    const completeRecurrence = vi
      .fn<TaskRepository['completeRecurrence']>()
      .mockResolvedValueOnce({
        type: 'rebased',
        previous: base,
        current,
        evidence: 'authority-transition',
      })
      .mockResolvedValueOnce(committed(current));
    const edit = vi.fn<TaskRepository['edit']>();
    const move = vi.fn<TaskRepository['move']>();
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(edit, { completeRecurrence, move }),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: base.ref },
        symbol: 'x',
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(completeRecurrence).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('does not retry recurrence after its owned descendants changed', async () => {
    const base = {
      ...snapshot(),
      recurrence: 'every day',
      source: {
        ...snapshot().source,
        originalBlock: '- [ ] Task 🔁 every day\n  - comment',
      },
    };
    const current = {
      ...base,
      ref: { ...base.ref, revision: 'new' },
      source: {
        ...base.source,
        originalBlock: '- [ ] Task 🔁 every day\n  - edited comment',
      },
    };
    const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>().mockResolvedValueOnce({
      type: 'rebased',
      previous: base,
      current,
      evidence: 'authority-transition',
    });
    const service = new TaskApplicationService(
      query({ type: 'exact', task: base, basis: { observed: base } }),
      repositoryWith(vi.fn(), { completeRecurrence }),
      statuses,
      clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
    );

    await expect(
      service.execute({
        type: 'set-status',
        target: { type: 'task', ref: base.ref },
        symbol: 'x',
      }),
    ).resolves.toEqual({ type: 'conflict', current });
    expect(completeRecurrence).toHaveBeenCalledOnce();
  });

  it.each(['edit', 'move', 'recurrence'] as const)(
    'performs zero repository writes for a visual-only %s preflight',
    async (kind) => {
      const base = { ...snapshot(), recurrence: 'every day' };
      const visual = snapshot('Replacement', 'replacement');
      const edit = vi.fn<TaskRepository['edit']>();
      const move = vi.fn<TaskRepository['move']>();
      const completeRecurrence = vi.fn<TaskRepository['completeRecurrence']>();
      const service = new TaskApplicationService(
        query({ type: 'visual', stale: base.ref, current: visual, evidence: 'same-line' }),
        repositoryWith(edit, { move, completeRecurrence }),
        statuses,
        clockFrom(Date.parse('2026-08-11T09:32:10Z'), 0),
      );
      let command: TaskCommand;
      if (kind === 'move') {
        command = {
          type: 'move',
          ref: base.ref,
          destination: { filePath: 'archive.md', insertion: { type: 'append' } },
        };
      } else if (kind === 'recurrence') {
        command = {
          type: 'set-status',
          target: { type: 'task', ref: base.ref },
          symbol: 'x',
        };
      } else {
        command = {
          type: 'patch',
          target: { type: 'task', ref: base.ref },
          patch: { tags: { add: ['#work'] } },
        };
      }

      await service.execute(command);
      expect(edit).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(completeRecurrence).not.toHaveBeenCalled();
    },
  );
});
