import { describe, expect, it } from 'vitest';
import type { TaskCommand, TaskNodeRef } from '../src/tasks';
import * as tasks from '../src/tasks';
import {
  rebaseTaskCommand,
  taskCommandMutationTarget,
  taskCommandRootRef,
  type RootedTaskCommand,
} from '../src/tasks/domain/taskCommandTargets';
import type { TaskMutationTarget } from '../src/tasks/domain/types';

const root = { filePath: 'tasks.md', line: 2, revision: 'before' };
const parent: TaskNodeRef = { type: 'task', ref: root };
const subtask = { parent, relativeLine: 1, originalBlock: '  - [ ] Child' };
const child: TaskNodeRef = { type: 'subtask', ref: subtask };
const comment = { parent: child, relativeLine: 1, originalMarkdown: '    - 💬 Comment' };
const date = tasks.localDate('2026-09-06');
const destination = { filePath: 'other.md', insertion: { type: 'append' as const } };
const cases = {
  create: {
    command: {
      type: 'create',
      markdownBody: 'Created',
      destination: { type: 'configured-default' },
    },
    target: undefined,
  },
  patch: {
    command: { type: 'patch', target: child, patch: { priority: { type: 'set', value: 'A' } } },
    target: child,
  },
  'append-title': {
    command: { type: 'append-title', target: child, markdown: 'more' },
    target: child,
  },
  'set-status': { command: { type: 'set-status', target: child, symbol: '/' }, target: child },
  'toggle-completion': { command: { type: 'toggle-completion', target: child }, target: child },
  'add-dependency': {
    command: { type: 'add-dependency', blocker: parent, dependent: child },
    target: undefined,
  },
  'remove-dependency': {
    command: { type: 'remove-dependency', dependent: child, dependencyId: 'id' },
    target: undefined,
  },
  'reverse-dependency': {
    command: { type: 'reverse-dependency', blocker: parent, dependent: child, dependencyId: 'id' },
    target: undefined,
  },
  'restore-dependency': {
    command: {
      type: 'restore-dependency',
      dependent: child,
      recovery: { dependencyId: 'id', beforeIds: ['id'], afterIds: [] },
    },
    target: undefined,
  },
  'create-dependency-subtask': {
    command: {
      type: 'create-dependency-subtask',
      current: child,
      direction: 'blocks',
      text: 'New',
    },
    target: child,
  },
  reschedule: { command: { type: 'reschedule', ref: root, date }, target: parent },
  'shift-schedule': { command: { type: 'shift-schedule', ref: root, days: 1 }, target: parent },
  'move-time-slot': {
    command: { type: 'move-time-slot', ref: root, days: 1, time: tasks.localTime('12:00') },
    target: parent,
  },
  'move-to-all-day': { command: { type: 'move-to-all-day', ref: root, days: 1 }, target: parent },
  'set-time-slot': {
    command: { type: 'set-time-slot', ref: root, date, time: tasks.localTime('12:00') },
    target: parent,
  },
  'convert-to-all-day': {
    command: { type: 'convert-to-all-day', ref: root, date },
    target: parent,
  },
  'set-span-boundary': {
    command: { type: 'set-span-boundary', ref: root, boundary: 'due', date },
    target: parent,
  },
  'extend-span': { command: { type: 'extend-span', ref: root, due: date }, target: parent },
  'set-description': {
    command: { type: 'set-description', target: child, text: 'Description' },
    target: child,
  },
  'add-subtask': { command: { type: 'add-subtask', parent: child, text: 'New' }, target: child },
  'restore-subtask': {
    command: {
      type: 'restore-subtask',
      parent: child,
      markdown: '    - [ ] Restored',
      placement: { relativeLine: 2 },
    },
    target: child,
  },
  'delete-subtask': { command: { type: 'delete-subtask', subtask }, target: child },
  'reorder-subtask': {
    command: {
      type: 'reorder-subtask',
      subtask,
      target: { ...subtask, relativeLine: 3 },
      placement: 'after',
    },
    target: child,
  },
  'add-comment': {
    command: { type: 'add-comment', parent: child, text: 'Comment' },
    target: child,
  },
  'update-comment': {
    command: { type: 'update-comment', comment, text: 'Edited' },
    target: { type: 'comment', ref: comment },
  },
  'delete-comment': {
    command: { type: 'delete-comment', comment },
    target: { type: 'comment', ref: comment },
  },
  'edit-link': {
    command: {
      type: 'edit-link',
      target: { type: 'comment', ref: comment },
      occurrence: 0,
      replacement: 'link',
    },
    target: { type: 'comment', ref: comment },
  },
  delete: { command: { type: 'delete', ref: root }, target: parent },
  move: { command: { type: 'move', ref: root, destination }, target: parent },
} satisfies Record<
  TaskCommand['type'],
  { command: TaskCommand; target: TaskMutationTarget | undefined }
>;

describe('task command mutation targets', () => {
  it.each(Object.entries(cases).filter(([, value]) => value.target !== undefined))(
    'rebases %s while retaining every non-reference command field',
    (_type, { command }) => {
      const next = { ...root, line: 10, revision: 'after' };
      const result = rebaseTaskCommand(command as RootedTaskCommand, next);
      const expected = JSON.parse(
        JSON.stringify(command).replaceAll(
          '"line":2,"revision":"before"',
          '"line":10,"revision":"after"',
        ),
      ) as TaskCommand;
      expect(result).toEqual(expected);
    },
  );
  it.each(Object.entries(cases))(
    'keeps the complete %s mutation target distinct from its root owner',
    (_type, { command, target }) => {
      expect(taskCommandMutationTarget(command)).toEqual(target);
      expect(taskCommandRootRef(command)).toEqual(target === undefined ? undefined : root);
    },
  );
});
