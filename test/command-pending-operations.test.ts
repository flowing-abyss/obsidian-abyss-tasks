import { expect, it } from 'vitest';
import { CommandPendingOperations } from '../src/ai/CommandPendingOperations';
import { CommandReferenceBook } from '../src/ai/CommandReferenceBook';

it('retains each operation-less edit preparation without accepting a nested edit discriminator', () => {
  const work = new CommandPendingOperations((value) => value);
  work.reject('task', { input: { kind: 'edit', target: 'a', expectedRevision: 'old' } });
  work.resolve('task', { input: { kind: 'edit', target: 'b', expectedRevision: 'new' } });
  expect(work.unresolved).toBe(true);
  work.resolve('task', { input: { kind: 'edit', target: 'a', expectedRevision: 'new' } });
  expect(work.unresolved).toBe(false);
  work.reject('task', { input: { kind: 'append', operation: { type: 'edit', target: 'a' } } });
  expect(work.unresolved).toBe(false);
});

it('leaves unknown project envelopes to schema errors without inventing a subject', () => {
  const work = new CommandPendingOperations((value) => value);
  work.reject('project', { input: JSON.stringify({ kind: 'update', target: 'p' }) });
  expect(work.unresolved).toBe(false);
  work.reject('project', {
    kind: 'update',
    target: 'p',
    fields: [{ fieldId: 'start', value: null }],
  });
  expect(work.unresolved).toBe(true);
});
it('retains identifiable encoded project fields when another argument prevents format recovery', () => {
  const work = new CommandPendingOperations((value) => value);
  const start = { fieldId: 'start', value: '2026-08-02' },
    end = { fieldId: 'end', value: '2026-08-03' };
  work.reject('project', { target: 'p', fields: JSON.stringify([start, end]), extra: true });
  work.resolve('project', { target: 'p', fields: [start] });
  expect(work.unresolved).toBe(true);
  work.resolve('project', { target: 'p', fields: [end] });
  expect(work.unresolved).toBe(false);
});

it.each(['task', 'note'])(
  'keeps same-title %s creations in distinct destinations separate',
  (name) => {
    const work = new CommandPendingOperations((value) => value);
    const request = (destination: string) =>
      name === 'task'
        ? {
            input: {
              kind: 'create',
              destination: { type: 'project', target: destination },
              tree: { markdownTitle: 'Review' },
            },
          }
        : { input: { kind: 'create', title: 'Review', path: `${destination}.md` } };
    work.reject(name, request('A'));
    work.resolve(name, request('B'));
    expect(work.unresolved).toBe(true);
    work.resolve(name, request('A'));
    expect(work.unresolved).toBe(false);
  },
);
it('keeps distinct appended note paragraphs unresolved and normalizes project names', () => {
  const work = new CommandPendingOperations((value) => value);
  const request = (text: string) => ({
    input: {
      kind: 'edit',
      target: 'note',
      operation: { type: 'append', section: 'section', text },
    },
  });
  work.reject('note', request('First'));
  work.resolve('note', request('Second'));
  expect(work.unresolved).toBe(true);
  work.resolve('note', request('First'));
  expect(work.unresolved).toBe(false);
  work.reject('project', { kind: 'create', name: ' Review ' });
  work.resolve('project', { kind: 'create', name: 'Review' });
  expect(work.unresolved).toBe(false);
});
it('retains explicit duplicate batch additions without counting repeated failures twice', () => {
  const work = new CommandPendingOperations((value) => value);
  const operation = { type: 'add-child', target: 'parent', markdownTitle: 'Repeat' };
  const batch = { input: { kind: 'batch', operations: [operation, operation] } };
  work.reject('task', batch);
  work.reject('task', batch);
  work.resolve('task', { input: { kind: 'append', operation } });
  expect(work.unresolved).toBe(true);
  work.resolve('task', { input: { kind: 'append', operation } });
  expect(work.unresolved).toBe(false);
});

it('repairs duplicate idempotent batch assignments once', () => {
  const work = new CommandPendingOperations((value) => value);
  const operation = {
    type: 'patch',
    target: 'parent',
    patch: { due: { type: 'set', value: '2026-08-03' } },
  };
  work.reject('task', { input: { kind: 'batch', operations: [operation, operation] } });
  work.resolve('task', { input: { kind: 'append', operation } });
  expect(work.unresolved).toBe(false);
});

it.each(['task', 'note'])(
  'normalizes declared %s creation location fields during schema repair',
  (name) => {
    const work = new CommandPendingOperations((value) => value);
    const request = (extra: boolean) => ({
      input:
        name === 'task'
          ? {
              kind: 'create',
              tree: { markdownTitle: 'Review' },
              destination: {
                type: 'note',
                path: 'Notes.md',
                insertion: extra
                  ? { position: 'bottom', type: 'section', heading: 'Tasks', invalid: true }
                  : { type: 'section', heading: 'Tasks', position: 'bottom' },
              },
            }
          : {
              kind: 'create',
              title: 'Review',
              destination: extra
                ? { fileName: 'Review.md', type: 'obsidian-default', invalid: true }
                : { type: 'obsidian-default', fileName: 'Review.md' },
            },
    });
    work.reject(name, request(true));
    work.resolve(name, request(false));
    expect(work.unresolved).toBe(false);
  },
);

it.each(['create', 'refresh'])('does not clear an unrelated task %s failure', (kind) => {
  const work = new CommandPendingOperations((value) => value);
  const request = (name: string) => ({
    input: kind === 'create' ? { kind, tree: { markdownTitle: name } } : { kind, plan: name },
  });
  work.reject('task', request('A'));
  work.resolve('task', request('B'));
  expect(work.unresolved).toBe(true);
  work.resolve('task', request('A'));
  expect(work.unresolved).toBe(false);
});
it.each(['add-child', 'add-comment'])('retains each same-parent %s obligation', (type) => {
  const work = new CommandPendingOperations((value) => value);
  const operation = (value: string) => ({
    type,
    target: 'parent',
    ...(type === 'add-child' ? { markdownTitle: value } : { text: value }),
  });
  work.reject('task', {
    input: { kind: 'batch', operations: [operation('First'), operation('Second')] },
  });
  work.resolve('task', { input: { kind: 'append', operation: operation('First') } });
  expect(work.unresolved).toBe(true);
  work.resolve('task', { input: { kind: 'append', operation: operation('Second') } });
  expect(work.unresolved).toBe(false);
});
it('resolves project field obligations separately with an omitted update kind', () => {
  const work = new CommandPendingOperations((value) => value);
  const start = { fieldId: 'start', value: '2026-08-01' },
    end = { fieldId: 'end', value: '2026-08-03' };
  work.reject('project', { kind: 'update', target: 'project', fields: [start, end] });
  work.resolve('project', { target: 'project', fields: [start] });
  expect(work.unresolved).toBe(true);
  work.resolve('project', { target: 'project', fields: [end] });
  expect(work.unresolved).toBe(false);
});
it('resolves a malformed target from its explicit saved root and tracks patch fields separately', () => {
  const work = new CommandPendingOperations((value) => value);
  const start = { type: 'set', value: '2026-08-01' },
    due = { type: 'set', value: '2026-08-03' };
  work.reject('task', {
    input: { kind: 'edit', target: 'root', operation: { type: 'patch', patch: { start, due } } },
  });
  work.resolve('task', {
    input: {
      kind: 'edit',
      target: 'root',
      operation: { type: 'patch', target: 'root', patch: { start } },
    },
  });
  expect(work.unresolved).toBe(true);
  work.resolve('task', {
    input: {
      kind: 'edit',
      target: 'root',
      operation: { type: 'patch', target: 'root', patch: { due } },
    },
  });
  expect(work.unresolved).toBe(false);
});

it('resolves failed batch members independently and does not hide a different field failure', () => {
  const work = new CommandPendingOperations((value) => value);
  const title = {
    type: 'patch',
    target: 'a',
    patch: { markdownTitle: { type: 'set', value: 'New' } },
  };
  const date = {
    type: 'patch',
    target: 'a',
    patch: { scheduled: { type: 'set', value: '2026-08-03' } },
  };
  const second = { ...title, target: 'b' };
  work.reject('task', { input: { kind: 'batch', operations: [title, second] } });
  work.resolve('task', { input: { kind: 'edit', operation: date } });
  expect(work.unresolved).toBe(true);
  work.resolve('task', { input: { kind: 'edit', operation: title } });
  expect(work.unresolved).toBe(true);
  work.resolve('task', { input: { kind: 'append', operation: second } });
  expect(work.unresolved).toBe(false);
});
it.each(['note', 'project'])(
  'keeps failures tied to the exact %s and requested operation',
  (name) => {
    const work = new CommandPendingOperations((value) => value);
    const a = { kind: 'edit', target: 'a', operation: { type: 'append', section: 'section-a' } };
    work.reject(name, { input: a });
    work.resolve(name, { input: { ...a, target: 'b' } });
    expect(work.unresolved).toBe(true);
    work.resolve(name, { input: { ...a, expectedRevision: 'fresh' } });
    expect(work.unresolved).toBe(false);
  },
);
it('retains issued discovery entity kinds without granting executable reference authority', () => {
  const book = new CommandReferenceBook('test');
  const projected = book.project({ kind: 'project', target: 'project', revision: 'revision' });
  expect(projected).toHaveProperty('target', expect.stringMatching(/^@test:p/u));
  const issued = book.issuedEntities();
  expect(issued[0]?.kind).toBe('project');
  expect(() =>
    book.input('read', { input: { kind: 'tree', target: issued[0]?.reference } }),
  ).toThrow();
  expect(book.identity(issued[0]?.reference ?? '')).toBe('project');
});

it('binds one rejected create retry to its exact turn, intent and normalized destination', () => {
  const work = new CommandPendingOperations((value) => value, 'turn1');
  const input = {
    input: {
      kind: 'create',
      intent: 'inbox',
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'Invalid' },
    },
  };
  const token = work.rejectCreate(input);
  expect(work.unresolved).toBe(true);
  work.resolve('create_task', { tree: { markdownTitle: 'Other' } });
  expect(work.unresolved).toBe(true);
  expect(() => {
    work.checkRetry(token, { input: { ...input.input, tree: { markdownTitle: 'Corrected' } } });
  }).not.toThrow();
  for (const changed of [
    { ...input.input, intent: undefined },
    {
      ...input.input,
      destination: { type: 'note', path: 'Other.md', insertion: { type: 'append' } },
    },
  ])
    expect(() => {
      work.checkRetry(token, { input: changed });
    }).toThrow(/exact destination/);
  expect(() => {
    new CommandPendingOperations((value) => value, 'turn2').checkRetry(token, input);
  }).toThrow();
  expect(() => {
    work.checkRetry('unknown', input);
  }).toThrow();
  expect(work.rejectCreate(input, token)).toBe(token);
  work.resolveCreate(token);
  expect(work.unresolved).toBe(false);
  expect(() => {
    work.checkRetry(token, input);
  }).toThrow();
});
it('retains unrelated rejected creates while retiring only the named retry', () => {
  const work = new CommandPendingOperations((value) => value, 'turn');
  const input = { input: { kind: 'create', destination: { type: 'configured-default' } } };
  const a = work.rejectCreate(input),
    b = work.rejectCreate(input);
  expect(a).not.toBe(b);
  work.resolveCreate(b);
  expect(work.unresolved).toBe(true);
  work.resolveCreate(a);
  expect(work.unresolved).toBe(false);
});

it('keeps schema-owner markers separate from canonical debts and same-generation successes', () => {
  const pending = new CommandPendingOperations((value) => value);
  pending.rejectSchema('owner:basis1', 1);
  pending.rejectSchema('owner:basis1', 1);
  expect(pending.taskRefinement).toBe(true);
  for (const [basis, generation] of [
    ['owner:basis1', 1],
    ['peer:basis1', 2],
    ['owner:basis2', 2],
  ] as const) {
    pending.resolveSchema(basis, generation);
    expect(pending.unresolved).toBe(true);
  }
  pending.resolveSchema('owner:basis1', 2);
  expect(pending.unresolved).toBe(false);
  const input = {
    kind: 'edit',
    target: 'owner',
    operation: { type: 'patch', target: 'owner', patch: { due: { type: 'set', value: 'bad' } } },
  };
  pending.reject('task', input);
  pending.rejectSchema('owner:basis1', 3);
  pending.resolveSchema('owner:basis1', 4);
  expect(pending.taskRefinement).toBe(true);
  pending.resolve('task', input);
  expect(pending.unresolved).toBe(false);
});
