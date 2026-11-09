import { expect, it } from 'vitest';
import { CommandReferenceBook } from '../src/ai/CommandReferenceBook';

const canonical = {
  task: {
    target: 'canonical-task',
    revision: 'task-revision',
    markdownTitle: 'Same',
    statusSymbol: ' ',
  },
  peer: {
    target: 'canonical-peer',
    revision: 'peer-revision',
    markdownTitle: 'Same',
    statusSymbol: ' ',
  },
  project: {
    target: 'canonical-project',
    revision: 'project-revision',
    name: 'Project',
    path: 'project.md',
    stats: {},
  },
  note: {
    target: 'canonical-note',
    revision: 'note-revision',
    path: 'note.md',
    name: 'Note',
    aliases: [],
  },
  comment: {
    target: 'canonical-comment',
    parentTarget: 'canonical-task',
    text: '@turn:t1 stays authored',
  },
  section: { target: 'canonical-section', canReplace: true, canAppend: true, kind: 'prose' },
  taskPlan: {
    target: 'canonical-task-plan',
    revision: 'task-plan-revision',
    kind: 'edit',
    expiresAt: 1,
    before: null,
    after: null,
  },
  notePlan: {
    target: 'canonical-note-plan',
    revision: 'note-plan-revision',
    kind: 'create',
    expiresAt: 1,
    path: 'note.md',
    before: null,
    after: { text: 'body' },
  },
  projectProposal: {
    kind: 'project-create',
    id: 'canonical-project-proposal',
    proposal: 'canonical-project-proposal',
  },
  nextCursor: 'canonical-cursor',
};
function fixture(turn = 'turn') {
  const book = new CommandReferenceBook(turn);
  const refs = book.project(canonical) as typeof canonical;
  return { book, refs };
}

it('projects short typed references without changing authored text or same-title identity', () => {
  const { refs } = fixture();
  expect(refs.task.target).not.toBe(refs.peer.target);
  expect(refs.task.target).toMatch(/^@turn:t\d+$/u);
  expect(refs.task.revision).toMatch(/^@turn:r\d+$/u);
  expect(refs.task.target.length).toBeLessThan(16);
  expect(refs.task.revision.length).toBeLessThan(16);
  expect(refs.task.markdownTitle).toBe('Same');
  expect(refs.comment.text).toBe('@turn:t1 stays authored');
  expect(refs.note.path).toBe('note.md');
  expect(canonical.task.target).toBe('canonical-task');
});

it.each(['task', 'read', 'status', 'note', 'project', 'link', 'cleanup', 'finish'])(
  'decodes exact %s reference fields while preserving authored values',
  (name) => {
    const { book, refs: r } = fixture();
    const cases: Record<string, { input: unknown; expected: unknown }> = {
      task: {
        input: {
          input: {
            kind: 'batch',
            plan: r.taskPlan.target,
            expectedPlanRevision: r.taskPlan.revision,
            operations: [
              {
                type: 'patch',
                target: r.peer.target,
                patch: { markdownTitle: { type: 'set', value: r.task.target } },
              },
              { type: 'copy-comment', source: r.comment.target, target: r.task.target },
            ],
          },
        },
        expected: {
          input: {
            kind: 'batch',
            plan: 'canonical-task-plan',
            expectedPlanRevision: 'task-plan-revision',
            operations: [
              {
                type: 'patch',
                target: 'canonical-peer',
                patch: { markdownTitle: { type: 'set', value: r.task.target } },
              },
              { type: 'copy-comment', source: 'canonical-comment', target: 'canonical-task' },
            ],
          },
        },
      },
      read: {
        input: {
          input: {
            kind: 'note',
            selector: {
              link: {
                from: r.note.target,
                expectedFromRevision: r.note.revision,
                wikiLink: '[[Note]]',
              },
            },
            cursor: r.nextCursor,
            linkFor: {
              from: r.note.target,
              expectedFromRevision: r.note.revision,
              alias: r.task.target,
            },
          },
        },
        expected: {
          input: {
            kind: 'note',
            selector: {
              link: {
                from: 'canonical-note',
                expectedFromRevision: 'note-revision',
                wikiLink: '[[Note]]',
              },
            },
            cursor: 'canonical-cursor',
            linkFor: {
              from: 'canonical-note',
              expectedFromRevision: 'note-revision',
              alias: r.task.target,
            },
          },
        },
      },
      status: {
        input: {
          target: r.task.target,
          revision: r.task.revision,
          plan: r.taskPlan.target,
          symbol: 'x',
        },
        expected: {
          target: 'canonical-task',
          revision: 'task-revision',
          plan: 'canonical-task-plan',
          symbol: 'x',
        },
      },
      note: {
        input: {
          input: {
            kind: 'refine',
            plan: r.notePlan.target,
            expectedPlanRevision: r.notePlan.revision,
            operation: { type: 'replace-section', section: r.section.target, text: r.task.target },
          },
        },
        expected: {
          input: {
            kind: 'refine',
            plan: 'canonical-note-plan',
            expectedPlanRevision: 'note-plan-revision',
            operation: {
              type: 'replace-section',
              section: 'canonical-section',
              text: r.task.target,
            },
          },
        },
      },
      project: {
        input: {
          kind: 'move-task',
          target: r.project.target,
          expectedRevision: r.project.revision,
          taskTarget: r.task.target,
          expectedTaskRevision: r.task.revision,
        },
        expected: {
          kind: 'move-task',
          target: 'canonical-project',
          expectedRevision: 'project-revision',
          taskTarget: 'canonical-task',
          expectedTaskRevision: 'task-revision',
        },
      },
      link: {
        input: {
          notePlan: r.notePlan.target,
          taskPlan: r.taskPlan.target,
          taskRevision: r.taskPlan.revision,
          target: r.task.target,
          field: 'comment',
          comment: r.comment.target,
          template: r.task.target,
          alias: r.note.target,
        },
        expected: {
          notePlan: 'canonical-note-plan',
          taskPlan: 'canonical-task-plan',
          taskRevision: 'task-plan-revision',
          target: 'canonical-task',
          field: 'comment',
          comment: 'canonical-comment',
          template: r.task.target,
          alias: r.note.target,
        },
      },
      cleanup: {
        input: { destinationPlan: r.taskPlan.target, destinationRevision: r.taskPlan.revision },
        expected: {
          destinationPlan: 'canonical-task-plan',
          destinationRevision: 'task-plan-revision',
        },
      },
      finish: {
        input: {
          state: 'ready',
          message: r.task.target,
          selection: [
            {
              kind: 'task',
              target: r.task.target,
              plan: r.taskPlan.target,
              expectedPlanRevision: r.taskPlan.revision,
            },
            { kind: 'project', target: r.project.target, revision: r.project.revision },
            { kind: 'note', target: r.note.target, revision: r.note.revision },
          ],
          reveal: { target: r.peer.target, revision: r.peer.revision },
        },
        expected: {
          state: 'ready',
          message: r.task.target,
          selection: [
            {
              kind: 'task',
              target: 'canonical-task',
              plan: 'canonical-task-plan',
              expectedPlanRevision: 'task-plan-revision',
            },
            { kind: 'project', target: 'canonical-project', revision: 'project-revision' },
            { kind: 'note', target: 'canonical-note', revision: 'note-revision' },
          ],
          reveal: { target: 'canonical-peer', revision: 'peer-revision' },
        },
      },
    };
    const item = cases[name];
    if (item === undefined) throw new Error('Missing reference shape');
    expect(book.input(name, item.input)).toEqual(item.expected);
  },
);

it('rejects unknown, wrong-kind, and prior-turn aliases instead of guessing an entity', () => {
  const { book, refs } = fixture();
  for (const target of [refs.project.target, '@turn:t999', '@old:t1'])
    expect(() => book.input('read', { input: { kind: 'tree', target } })).toThrow();
  const later = fixture('later');
  expect(() =>
    later.book.input('read', { input: { kind: 'tree', target: refs.task.target } }),
  ).toThrow();
  expect(book.input('read', { input: { kind: 'tree', target: 'canonical-task' } })).toEqual({
    input: { kind: 'tree', target: 'canonical-task' },
  });
});

it('retains old exact revisions for native stale checks and never decodes JSON strings', () => {
  const { book, refs } = fixture();
  const next = book.project({
    ...canonical.task,
    revision: 'new-revision',
  }) as typeof canonical.task;
  expect(next.revision).not.toBe(refs.task.revision);
  expect(
    book.input('task', {
      input: { kind: 'edit', target: refs.task.target, expectedRevision: refs.task.revision },
    }),
  ).toEqual({
    input: { kind: 'edit', target: 'canonical-task', expectedRevision: 'task-revision' },
  });
  const encoded = JSON.stringify({
    kind: 'edit',
    target: refs.task.target,
    expectedRevision: refs.task.revision,
  });
  expect(book.input('task', { input: encoded })).toEqual({ input: encoded });
});

it.each([
  'project-destination',
  'hierarchy',
  'reorder',
  'copy-subtree',
  'comment',
  'task-page',
  'project-read',
  'section-read',
  'note-create',
  'note-edit',
  'project-refine',
  'saved-link',
])('decodes the %s branch without touching authored values', (branch) => {
  const { book, refs: r } = fixture();
  const cases: Record<string, [string, unknown, unknown]> = {
    'project-destination': [
      'task',
      {
        input: {
          kind: 'create',
          destination: {
            type: 'project',
            target: r.project.target,
            expectedRevision: r.project.revision,
          },
          tree: { markdownTitle: r.task.target },
        },
      },
      {
        input: {
          kind: 'create',
          destination: {
            type: 'project',
            target: 'canonical-project',
            expectedRevision: 'project-revision',
          },
          tree: { markdownTitle: r.task.target },
        },
      },
    ],
    hierarchy: [
      'task',
      {
        input: {
          kind: 'hierarchy',
          operation: {
            type: 'reparent',
            source: r.task.target,
            expectedSourceRevision: r.task.revision,
            parent: r.peer.target,
            expectedParentRevision: r.peer.revision,
          },
        },
      },
      {
        input: {
          kind: 'hierarchy',
          operation: {
            type: 'reparent',
            source: 'canonical-task',
            expectedSourceRevision: 'task-revision',
            parent: 'canonical-peer',
            expectedParentRevision: 'peer-revision',
          },
        },
      },
    ],
    reorder: [
      'task',
      {
        input: {
          kind: 'append',
          plan: r.taskPlan.target,
          expectedPlanRevision: r.taskPlan.revision,
          operation: {
            type: 'reorder',
            target: r.task.target,
            relativeTo: r.peer.target,
            placement: 'after',
          },
        },
      },
      {
        input: {
          kind: 'append',
          plan: 'canonical-task-plan',
          expectedPlanRevision: 'task-plan-revision',
          operation: {
            type: 'reorder',
            target: 'canonical-task',
            relativeTo: 'canonical-peer',
            placement: 'after',
          },
        },
      },
    ],
    'copy-subtree': [
      'task',
      {
        input: {
          kind: 'edit',
          target: r.task.target,
          expectedRevision: r.task.revision,
          operation: {
            type: 'copy-subtree',
            source: r.peer.target,
            expectedSourceRevision: r.peer.revision,
            target: r.task.target,
          },
        },
      },
      {
        input: {
          kind: 'edit',
          target: 'canonical-task',
          expectedRevision: 'task-revision',
          operation: {
            type: 'copy-subtree',
            source: 'canonical-peer',
            expectedSourceRevision: 'peer-revision',
            target: 'canonical-task',
          },
        },
      },
    ],
    comment: [
      'task',
      {
        input: {
          kind: 'edit',
          target: r.task.target,
          expectedRevision: r.task.revision,
          operation: { type: 'update-comment', target: r.comment.target, text: r.task.target },
        },
      },
      {
        input: {
          kind: 'edit',
          target: 'canonical-task',
          expectedRevision: 'task-revision',
          operation: { type: 'update-comment', target: 'canonical-comment', text: r.task.target },
        },
      },
    ],
    'task-page': [
      'read',
      {
        input: {
          kind: 'tree',
          target: r.task.target,
          plan: r.taskPlan.target,
          expectedPlanRevision: r.taskPlan.revision,
          side: 'before',
          cursor: r.nextCursor,
        },
      },
      {
        input: {
          kind: 'tree',
          target: 'canonical-task',
          plan: 'canonical-task-plan',
          expectedPlanRevision: 'task-plan-revision',
          side: 'before',
          cursor: 'canonical-cursor',
        },
      },
    ],
    'project-read': [
      'read',
      { input: { kind: 'project', target: r.project.target } },
      { input: { kind: 'project', target: 'canonical-project' } },
    ],
    'section-read': [
      'read',
      { input: { kind: 'note', selector: { section: r.section.target } } },
      { input: { kind: 'note', selector: { section: 'canonical-section' } } },
    ],
    'note-create': [
      'note',
      {
        input: {
          kind: 'create',
          template: r.note.target,
          expectedTemplateRevision: r.note.revision,
          title: r.task.target,
          path: r.project.target,
          text: r.task.target,
        },
      },
      {
        input: {
          kind: 'create',
          template: 'canonical-note',
          expectedTemplateRevision: 'note-revision',
          title: r.task.target,
          path: r.project.target,
          text: r.task.target,
        },
      },
    ],
    'note-edit': [
      'note',
      {
        input: {
          kind: 'edit',
          target: r.note.target,
          expectedRevision: r.note.revision,
          operation: { type: 'append', section: r.section.target, text: r.task.target },
        },
      },
      {
        input: {
          kind: 'edit',
          target: 'canonical-note',
          expectedRevision: 'note-revision',
          operation: { type: 'append', section: 'canonical-section', text: r.task.target },
        },
      },
    ],
    'project-refine': [
      'project',
      {
        kind: 'refine-create',
        proposal: r.projectProposal.proposal,
        name: r.task.target,
        fields: [{ fieldId: 'start', value: r.task.target }],
      },
      {
        kind: 'refine-create',
        proposal: 'canonical-project-proposal',
        name: r.task.target,
        fields: [{ fieldId: 'start', value: r.task.target }],
      },
    ],
    'saved-link': [
      'link',
      {
        target: r.task.target,
        expectedRevision: r.task.revision,
        notePlan: r.notePlan.target,
        template: r.note.target,
      },
      {
        target: 'canonical-task',
        expectedRevision: 'task-revision',
        notePlan: 'canonical-note-plan',
        template: r.note.target,
      },
    ],
  };
  const entry = cases[branch];
  if (entry === undefined) throw new Error('Missing branch');
  expect(book.input(entry[0], entry[1])).toEqual(entry[2]);
});

it('projects note continuation selectors and link contexts through the same exact note aliases', () => {
  const { book, refs } = fixture();
  const page = book.project({
    note: canonical.note,
    request: {
      selector: { target: canonical.note.target, expectedRevision: canonical.note.revision },
      linkFor: {
        from: canonical.note.target,
        expectedFromRevision: canonical.note.revision,
        alias: 'canonical-task',
      },
    },
  });
  expect(page).toEqual({
    note: refs.note,
    request: {
      selector: { target: refs.note.target, expectedRevision: refs.note.revision },
      linkFor: {
        from: refs.note.target,
        expectedFromRevision: refs.note.revision,
        alias: 'canonical-task',
      },
    },
  });
});
it('decodes nested first-answer task operands while preserving authored literals', () => {
  const book = new CommandReferenceBook('work'),
    r = book.project(canonical) as typeof canonical;
  const input = {
    intent: 'plan',
    research: false,
    work: {
      task: {
        input: {
          kind: 'append',
          plan: r.taskPlan.target,
          expectedPlanRevision: r.taskPlan.revision,
          operation: { type: 'add-comment', target: r.task.target, text: r.peer.target },
        },
      },
      message: r.project.target,
      focus: r.task.target,
    },
  };
  expect(book.input('interpret', input)).toEqual({
    intent: 'plan',
    research: false,
    work: {
      task: {
        input: {
          kind: 'append',
          plan: 'canonical-task-plan',
          expectedPlanRevision: 'task-plan-revision',
          operation: { type: 'add-comment', target: 'canonical-task', text: r.peer.target },
        },
      },
      message: r.project.target,
      focus: 'canonical-task',
    },
  });
  expect(() =>
    book.input('interpret', { ...input, work: { ...input.work, focus: r.project.target } }),
  ).toThrow();
});
