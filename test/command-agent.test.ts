import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandAgent } from '../src/ai/CommandAgent';
import { preserveAuthoredAnnotations } from '../src/ai/commandSchemas';
import { CommandSession } from '../src/ai/CommandSession';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';
import { ProviderFailure } from '../src/ai/providers/providerFailure';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, expectDefined } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
  vi.restoreAllMocks();
});
let callId = 0;
function call(
  toolName: string,
  input: unknown,
): Awaited<ReturnType<MockLanguageModelV4['doGenerate']>> {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: `call-${++callId}`,
        toolName,
        input: JSON.stringify(['read', 'note'].includes(toolName) ? { input } : input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}
async function setup(
  files: Record<string, string> = { 'a.md': '- [ ] Existing [unknown:: keep]\n' },
  options: Parameters<typeof publicApiHarness>[1] = {},
) {
  const h = await publicApiHarness(files, { ...options, provision: true });
  owners.push(h);
  const api = h.client();
  const scripts: Array<() => Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>> = [];
  const model = new MockLanguageModelV4({
    doGenerate: async () => expectDefined(scripts.shift())(),
  });
  const saved: CommandSessionSnapshot[] = [];
  const session: CommandSession = new CommandSession({
    api,
    journal: {
      save: async (snapshot) => {
        saved.push(snapshot);
      },
    },
    agent: { run: async (input) => agent.run(input) },
    now: () => Date.UTC(2026, 7, 1, 12),
    id: (() => {
      let i = 0;
      return () => `s-${++i}`;
    })(),
    context: 'Current view: unrelated project',
  });
  const agent: CommandAgent = new CommandAgent({
    api,
    session,
    connections: { model: () => model },
    settings: () => ({}),
    now: () => Date.UTC(2026, 7, 1, 12),
    research: {
      search: async (query) => ({
        query,
        summary: 'Finding',
        sources: [
          {
            url: 'https://example.org/evidence',
            title: 'Evidence',
            content: null,
            snippet: null,
            evidence: 'citation',
          },
        ],
        truncated: false,
      }),
    },
  });
  return {
    ...h,
    api,
    session,
    saved,
    model,
    script: (...steps: Array<() => Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>>) =>
      scripts.push(...steps),
  };
}
const interpret =
  (intent = 'plan', research = false) =>
  () =>
    call('interpret', { intent, research });
const finish =
  (message = 'Ready.', question = false) =>
  () =>
    call(
      'finish',
      question
        ? {
            state: 'question',
            message,
            blockingIssue: { kind: 'conflict', detail: 'The requested date is not yet resolved.' },
          }
        : { state: 'ready', message },
    );
const create = () =>
  call('task', {
    input: {
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: {
        markdownTitle: 'New',
        children: [{ markdownTitle: 'Child A' }, { markdownTitle: 'Child B' }],
      },
    },
  });
it('runs the real SDK over the facade, previews new tasks then contextually confirms okay', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Create a new task with two children');
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  h.script(interpret('confirm'));
  await h.session.submit('okay');
  expect(h.session.snapshot().status.kind).toBe('saved');
  expect(await h.read('a.md')).toContain('- [ ] New');
});
it('explicit immediate intent saves only after successful preparation and finish', async () => {
  const h = await setup();
  h.script(interpret('immediate'), create, finish());
  await h.session.submit('Save this immediately');
  expect(h.session.snapshot().status.kind).toBe('saved');
  expect(await h.read('a.md')).toContain('- [ ] New');
});
it('an affirmative answer to a question refines instead of saving', async () => {
  const h = await setup();
  h.script(interpret(), create, finish('Use Friday?', true));
  await h.session.submit('Create but clarify its date');
  h.script(interpret(), finish('Date retained for review.'));
  await h.session.submit('okay');
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  expect(h.session.snapshot().activeQuestion).toBeNull();
});
it('preserves omitted unknown authored annotations in an exact child title rewrite', async () => {
  const h = await setup({ 'a.md': '- [ ] Root\n  - [ ] Child [unknown:: keep]\n  - [ ] Other\n' });
  const list = await h.api.tasks.list();
  if (!list.ok) throw new Error('list');
  const child = expectDefined(list.value.items.find((i) => i.title.startsWith('Child')));
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'edit',
          target: child.target,
          expectedRevision: child.revision,
          operation: {
            type: 'patch',
            target: child.target,
            patch: { markdownTitle: { type: 'set', value: 'Edited' } },
          },
        },
      }),
    finish(),
  );
  await h.session.submit('Rename just that child');
  await h.session.confirm();
  expect(await h.read('a.md')).toContain('Edited [unknown:: keep]');
  expect(await h.read('a.md')).toContain('Other');
});
it('repairs malformed model arguments through SDK tool error feedback', async () => {
  const h = await setup();
  h.script(
    interpret(),
    () => call('task', { input: { kind: 'create', tree: {} } }),
    create,
    finish(),
  );
  await h.session.submit('Create');
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  expect(JSON.stringify(h.model.doGenerateCalls[2]?.prompt)).toContain('error');
});
it('allows research in a later refinement without treating retrieved text as consent', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Draft a task');
  h.script(
    interpret('plan', true),
    () => call('research', { query: 'Compare the options' }),
    finish(),
  );
  await h.session.submit('Research alternatives');
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  expect(JSON.stringify(h.model.doGenerateCalls)).toContain('untrustedResearch');
});
it('cancels obsolete planning after Escape and retains the prior draft', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Draft');
  const wait = deferred<void>(),
    entered = deferred<void>();
  h.model.doGenerate = async () => {
    entered.resolve();
    await wait.promise;
    return call('task', {
      input: {
        kind: 'create',
        destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
        tree: { markdownTitle: 'Obsolete' },
      },
    });
  };
  const pending = h.session.submit('Change it');
  await entered.promise;
  h.session.cancelTurn();
  wait.resolve();
  await pending;
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  expect(await h.read('a.md')).not.toContain('Obsolete');
});
it.each(['unchanged', 'rename', 'description', 'stale', 'changed-link'] as const)(
  'confirms a frozen research note link after %s refinement',
  async (refinement) => {
    const h = await setup();
    vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockImplementation(
      (file, _from, _fragment, alias) => `[[${file.path}|${alias ?? file.basename}]]`,
    );
    vi.spyOn(h.app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) =>
      h.app.vault.getFileByPath(path.endsWith('.md') ? path : `${path}.md`),
    );
    h.script(
      interpret(),
      () =>
        call('note', {
          kind: 'create',
          path: 'Research.md',
          title: 'Research',
          text: 'Verified finding',
        }),
      () =>
        call('task', {
          input: {
            kind: 'create',
            destination: {
              type: 'note',
              path: 'NewTasks.md',
              insertion: { type: 'append' },
              provision: 'if-missing',
            },
            tree: { markdownTitle: 'Act on finding' },
          },
        }),
      () => {
        const changes = h.session.snapshot().proposal.changes;
        const note = changes.find((c) => c.kind === 'note');
        const task = changes.find((c) => c.kind === 'task');
        if (note?.kind !== 'note' || task?.kind !== 'task' || task.plan.after === null)
          throw new Error('Missing dependency plans');
        return call('link', {
          notePlan: note.plan.target,
          taskPlan: task.plan.target,
          taskRevision: task.plan.revision,
          target: task.plan.after.target,
          field: 'description',
          template: 'Read {{link}} before acting.',
          alias: 'Finding',
        });
      },
      finish(),
    );
    await h.session.submit('Draft a research note and link it from a new task');
    expect(h.session.snapshot().status).toEqual({ kind: 'ready', message: 'Ready.' });
    expect(h.app.vault.getAbstractFileByPath('Research.md')).toBeNull();
    expect(h.app.vault.getAbstractFileByPath('NewTasks.md')).toBeNull();
    if (refinement === 'changed-link') {
      const before = h.session.snapshot().proposal;
      const task = expectDefined(before.changes.find((change) => change.kind === 'task'));
      if (task.plan.after === null) throw new Error('task');
      const prepared = await expectDefined(h.api.tasks.prepare)({
        kind: 'append',
        plan: task.plan.target,
        expectedPlanRevision: task.plan.revision,
        operation: {
          type: 'description',
          target: task.plan.after.target,
          text: 'Replacement without the reviewed link',
        },
      });
      if (!prepared.ok) throw new Error(prepared.error.code);
      expect(() => {
        h.session.stage({ kind: 'task', plan: prepared.value });
      }).toThrow('Review its note link');
      expect(h.session.snapshot().proposal).toEqual(before);
      expect(h.app.vault.getAbstractFileByPath('Research.md')).toBeNull();
      expect(h.app.vault.getAbstractFileByPath('NewTasks.md')).toBeNull();
      return;
    }
    if (refinement !== 'unchanged') {
      const previous = expectDefined(
        h.session.snapshot().proposal.changes.find((c) => c.kind === 'link'),
      );
      h.script(
        interpret(),
        () => {
          const change = expectDefined(
            h.session.snapshot().proposal.changes.find((c) => c.kind === 'task'),
          );
          if (change.plan.after === null) throw new Error('task');
          return call('task', {
            input: {
              kind: 'append',
              plan: change.plan.target,
              expectedPlanRevision: change.plan.revision,
              operation:
                refinement === 'description'
                  ? {
                      type: 'description',
                      target: change.plan.after.target,
                      text: `Updated ${change.plan.after.description ?? ''} Add a careful check.`,
                    }
                  : {
                      type: 'patch',
                      target: change.plan.after.target,
                      patch: { markdownTitle: { type: 'set', value: 'Renamed after link' } },
                    },
            },
          });
        },
        finish(),
      );
      await h.session.submit('Refine this linked task');
      expect(h.session.snapshot().status.kind).toBe('ready');
      if (refinement === 'stale') {
        h.session.stage(previous);
        expect(await h.session.confirm()).toBe(false);
        expect(h.session.snapshot().journal).toEqual([]);
        expect(h.app.vault.getAbstractFileByPath('Research.md')).toBeNull();
        expect(h.app.vault.getAbstractFileByPath('NewTasks.md')).toBeNull();
        return;
      }
    }
    await h.session.confirm();
    expect(h.session.snapshot().status.kind).toBe('saved');
    if (refinement === 'rename')
      expect(await h.read('NewTasks.md')).toContain('Renamed after link');
    if (refinement === 'description')
      expect(await h.read('NewTasks.md')).toContain(
        'Updated Read [[Research.md|Finding]] before acting. Add a careful check.',
      );
    expect(await h.read('Research.md')).toContain('Verified finding');
    expect(await h.read('NewTasks.md')).toContain('Read [[Research.md|Finding]] before acting.');
  },
);
it('create then edit then delete of an unsaved root cancels the draft without effects', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Create');
  h.script(
    interpret(),
    () => {
      const c = h.session.snapshot().proposal.changes[0];
      if (c?.kind !== 'task' || c.plan.after === null) throw new Error('draft');
      return call('task', {
        input: {
          kind: 'append',
          plan: c.plan.target,
          expectedPlanRevision: c.plan.revision,
          operation: {
            type: 'patch',
            target: c.plan.after.target,
            patch: { markdownTitle: { type: 'set', value: 'Refined' } },
          },
        },
      });
    },
    finish(),
  );
  await h.session.submit('Change it');
  h.script(
    interpret(),
    () => {
      const c = h.session.snapshot().proposal.changes[0];
      if (c?.kind !== 'task' || c.plan.after === null) throw new Error('draft');
      return call('task', {
        input: {
          kind: 'append',
          plan: c.plan.target,
          expectedPlanRevision: c.plan.revision,
          operation: { type: 'remove', target: c.plan.after.target },
        },
      });
    },
    finish(),
  );
  await h.session.submit('Remove that unsaved task');
  expect(h.session.snapshot().proposal.changes).toHaveLength(0);
  expect(await h.read('a.md')).not.toContain('Refined');
});
it('saved deletion remains a reviewed preview', async () => {
  const h = await setup();
  const result = await h.api.tasks.list();
  if (!result.ok) throw new Error('list');
  const task = expectDefined(result.value.items[0]);
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'edit',
          target: task.target,
          expectedRevision: task.revision,
          operation: { type: 'remove', target: task.target },
        },
      }),
    finish(),
  );
  await h.session.submit('Delete the existing task');
  expect(await h.read('a.md')).toContain('Existing');
  await h.session.confirm();
  expect(await h.read('a.md')).not.toContain('Existing');
});
it('reads all requested tree pages independently of the changed-node budget and searches outside the current view', async () => {
  const h = await setup({
    'a.md': ['- [ ] Root', ...Array.from({ length: 60 }, (_, i) => `  - [ ] Child ${i}`), ''].join(
      '\n',
    ),
    'elsewhere.md': '- [ ] Find outside\n',
  });
  const result = await h.api.tasks.list();
  if (!result.ok) throw new Error('list');
  const root = expectDefined(result.value.items.find((i) => i.title === 'Root'));
  h.script(
    interpret(),
    () => call('read', { kind: 'tasks', query: 'outside' }),
    () => call('read', { kind: 'tree', target: root.target, limit: 100 }),
    finish(),
  );
  await h.session.submit('Find the other task and show the whole root');
  const prompts = JSON.stringify(h.model.doGenerateCalls);
  expect(prompts).toContain('Child 59');
  expect(prompts).toContain('Find outside');
  expect(h.session.snapshot().status.kind).toBe('ready');
});
it('a contradiction becomes a question and a later resolution keeps the same proposal', async () => {
  const h = await setup();
  h.script(interpret(), create, finish('Should it be Friday or Saturday?', true));
  await h.session.submit('Friday, no Saturday');
  const revision = h.session.snapshot().proposal.revision;
  await h.session.submit('');
  expect(h.session.snapshot().proposal.revision).toBe(revision);
  h.script(interpret(), finish('Friday is the agreed date.'));
  await h.session.submit('Friday');
  expect(h.session.snapshot().activeQuestion).toBeNull();
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
});
it('separates two provider retries from model/schema repair and refuses a fourth network attempt', async () => {
  const h = await setup();
  let requests = 0;
  h.model.doGenerate = async () => {
    requests++;
    throw new ProviderFailure('unavailable');
  };
  await h.session.submit('Create');
  expect(requests).toBe(3);
  expect(h.session.snapshot().status.kind).toBe('error');
  expect(h.session.snapshot().proposal.changes).toHaveLength(0);
});
it.each([
  { name: 'retained root', suffix: '', child: false },
  { name: 'deleted root', suffix: ' 🏁 delete', child: false, selectChild: true },
  { name: 'recurring root keep', suffix: ' 🔁 every day 📅 2026-08-01 🏁 keep', child: false },
  { name: 'recurring root delete', suffix: ' 🔁 every day 📅 2026-08-01 🏁 delete', child: false },
  { name: 'retained child', suffix: '', child: true },
  { name: 'deleted child', suffix: ' 🏁 delete', child: true },
  { name: 'recurring child', suffix: ' 🔁 every day 📅 2026-08-01 🏁 keep', child: true },
])('publishes current actual trees after content and $name status', async (config) => {
  const { suffix, child } = config;
  const selectChild = config.selectChild === true;
  const descendant = selectChild ? '  - [ ] Selected descendant\n' : '';
  const h = await setup(
    {
      'a.md': child
        ? `- [ ] Existing\n  - [ ] Child${suffix}\n`
        : `- [ ] Existing${suffix}\n${descendant}`,
    },
    { behaviorSettings: () => DEFAULT_SETTINGS },
  );
  const result = await h.api.tasks.list();
  if (!result.ok) throw new Error('list');
  const original = expectDefined(
    result.value.items.find((item) => item.parentTarget === undefined),
  );
  if (selectChild) {
    const selected = expectDefined(
      result.value.items.find((item) => item.parentTarget === original.target),
    );
    expect(
      await h.session.focus({
        kind: 'task',
        target: selected.target,
        revision: selected.revision,
      }),
    ).toBe(true);
  }
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'edit',
          target: original.target,
          expectedRevision: original.revision,
          operation: {
            type: 'patch',
            target: original.target,
            patch: { markdownTitle: { type: 'set', value: 'Refined' } },
          },
        },
      }),
    () => {
      const c = h.session.snapshot().proposal.changes[0];
      if (c?.kind !== 'task' || c.plan.after === null) throw new Error('plan');
      const target = child ? expectDefined(c.plan.after.children[0]) : c.plan.after;
      return call('status', {
        target: target.target,
        revision: target.revision,
        symbol: 'x',
        plan: c.plan.target,
      });
    },
    finish(),
  );
  await h.session.submit('Rename and complete');
  expect(await h.read('a.md')).toContain('- [ ] Existing');
  expect(await h.session.confirm()).toBe(true);
  expect(h.session.snapshot().status.kind).toBe('saved');
  const accepted = await h.api.tasks.list();
  if (!accepted.ok) throw new Error('list');
  const roots = accepted.value.items.filter((item) => item.parentTarget === undefined);
  const actual = h.session.snapshot().actual;
  expect(actual.map((item) => item.target).sort((a, b) => a.localeCompare(b))).toEqual(
    roots.map((item) => item.target).sort((a, b) => a.localeCompare(b)),
  );
  for (const root of roots) {
    const tree = await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 });
    if (!tree.ok) throw new Error('tree');
    expect(actual.find((item) => item.target === root.target)).toEqual(tree.value.tree);
  }
  expect(h.session.snapshot().journal).toHaveLength(2);
  if (selectChild) expect(h.session.snapshot().focus).toEqual([]);
});
it('merges using a current preservation assessment and removes the source only after destination readback', async () => {
  const h = await setup({ 'a.md': '- [ ] Source\n- [ ] Destination\n' });
  const result = await h.api.tasks.list();
  if (!result.ok) throw new Error('list');
  const source = expectDefined(result.value.items.find((i) => i.title === 'Source')),
    destination = expectDefined(result.value.items.find((i) => i.title === 'Destination'));
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'edit',
          target: destination.target,
          expectedRevision: destination.revision,
          operation: { type: 'description', target: destination.target, text: 'Source' },
        },
      }),
    () => {
      const c = h.session.snapshot().proposal.changes[0];
      if (c?.kind !== 'task' || c.plan.after === null) throw new Error('plan');
      return call('task', {
        input: {
          kind: 'append',
          plan: c.plan.target,
          expectedPlanRevision: c.plan.revision,
          operation: {
            type: 'assess-merge',
            source: source.target,
            expectedSourceRevision: source.revision,
            target: c.plan.after.target,
          },
        },
      });
    },
    () => {
      const c = h.session.snapshot().proposal.changes[0];
      if (c?.kind !== 'task') throw new Error('plan');
      return call('cleanup', {
        destinationPlan: c.plan.target,
        destinationRevision: c.plan.revision,
      });
    },
    finish(),
  );
  await h.session.submit('Merge these tasks');
  expect(h.session.snapshot().status.kind).toBe('ready');
  await h.session.confirm();
  expect(h.session.snapshot().status.message, JSON.stringify(h.session.snapshot().journal)).toBe(
    'Saved.',
  );
  expect(await h.read('a.md')).not.toContain('- [ ] Source');
  expect(await h.read('a.md')).toContain('- > Source');
});
it('binds delayed contextual confirmation to the proposal the utterance actually saw', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Draft');
  const before = h.session.snapshot();
  const basis = { sessionId: before.id, proposalRevision: before.proposal.revision };
  h.script(
    interpret(),
    () => {
      const c = h.session.snapshot().proposal.changes[0];
      if (c?.kind !== 'task' || c.plan.after === null) throw new Error('plan');
      return call('task', {
        input: {
          kind: 'append',
          plan: c.plan.target,
          expectedPlanRevision: c.plan.revision,
          operation: {
            type: 'patch',
            target: c.plan.after.target,
            patch: { markdownTitle: { type: 'set', value: 'Unseen revision' } },
          },
        },
      });
    },
    finish(),
  );
  await h.session.submit('Change');
  h.script(interpret('confirm'));
  await h.session.submit('okay', basis);
  expect(await h.read('a.md')).not.toContain('Unseen revision');
  expect(h.session.snapshot().status.kind).toBe('question');
});
it('uses discovered tags and typed status/date filters without an implicit view restriction', async () => {
  const h = await setup({
    'a.md':
      '- [ ] Match #work 📅 2026-08-02\n- [x] Completed #work 📅 2026-08-02\n- [ ] Other #home 📅 2026-08-02\n',
  });
  h.script(
    interpret(),
    () => call('read', { kind: 'tags' }),
    () =>
      call('read', {
        kind: 'tasks',
        query: '',
        tagsAll: ['#work'],
        statuses: ['open'],
        dates: [{ field: 'due', from: '2026-08-02', to: '2026-08-02' }],
      }),
    finish(),
  );
  await h.session.submit('Find open work tasks due August second');
  const last = JSON.stringify(h.model.doGenerateCalls[h.model.doGenerateCalls.length - 1]?.prompt);
  expect(last).toContain('Match');
  expect(last).not.toContain('Completed');
  expect(last).not.toContain('"title":"Other"');
  expect(h.session.snapshot().status.kind).toBe('ready');
});
it('reads a revision-bound relative contact link through native resolution with duplicate basenames', async () => {
  const h = await setup({
    'A/Task.md': '[[Contact]]',
    'A/Contact.md': 'Right contact',
    'B/Contact.md': 'Wrong contact',
  });
  vi.spyOn(h.app.metadataCache, 'getFirstLinkpathDest').mockImplementation((_link, from) =>
    h.app.vault.getFileByPath(from === 'A/Task.md' ? 'A/Contact.md' : 'B/Contact.md'),
  );
  h.script(
    interpret(),
    () => call('read', { kind: 'note', selector: { path: 'A/Task.md' } }),
    () => {
      const note = expectDefined(h.session.snapshot().entities.notes[0]).note;
      return call('read', {
        kind: 'note',
        selector: {
          link: { from: note.target, expectedFromRevision: note.revision, wikiLink: '[[Contact]]' },
        },
      });
    },
    finish(),
  );
  await h.session.submit('Read the linked contact');
  expect(h.session.snapshot().entities.notes[1]?.note.path).toBe('A/Contact.md');
  expect(h.session.snapshot().entities.notes[1]?.segments[0]?.text).toBe('Right contact');
});

it('publishes explicit object schemas to providers while retaining strict union validation', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare a task');
  const tools = expectDefined(h.model.doGenerateCalls[1]).tools;
  for (const name of ['read', 'note', 'finish']) {
    const definition = expectDefined(tools?.find((candidate) => candidate.name === name));
    expect(definition).toHaveProperty('inputSchema.type', 'object');
    expect(definition).toHaveProperty('inputSchema.properties');
    for (const keyword of ['oneOf', 'anyOf', 'allOf'])
      expect(definition).not.toHaveProperty(`inputSchema.${keyword}`);
  }
  expect(tools?.find((candidate) => candidate.name === 'task')).toHaveProperty(
    'inputSchema.properties.input.type',
    'object',
  );
  expect(tools?.find((candidate) => candidate.name === 'read')).toHaveProperty(
    'inputSchema.properties.input.oneOf',
  );
  expect(tools?.find((candidate) => candidate.name === 'task')).toHaveProperty(
    'inputSchema.properties.input.oneOf',
  );
  h.script(interpret(), () => call('finish', { state: 'question', message: 'Save?' }), finish());
  await h.session.submit('Show the preview');
  expect(
    JSON.stringify(h.model.doGenerateCalls[h.model.doGenerateCalls.length - 1]?.prompt),
  ).toContain('blockingIssue');
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(h.session.snapshot().activeQuestion).toBeNull();
  expect(await h.read('a.md')).toBe('- [ ] Existing [unknown:: keep]\n');
});

it('keeps strict runtime validation for discriminants and cross-branch fields', async () => {
  const h = await setup();
  h.script(
    interpret(),
    () => call('read', { kind: 'statuses', query: 'not a status argument' }),
    () => call('read', { kind: 'unknown-operation' }),
    () => call('read', { kind: 'statuses' }),
    finish(),
  );
  await h.session.submit('Show the status catalog');
  expect(JSON.stringify(h.model.doGenerateCalls[2]?.prompt)).toContain('Match one advertised kind');
  expect(JSON.stringify(h.model.doGenerateCalls[3]?.prompt)).toContain('Match one advertised kind');
  expect(h.session.snapshot().status.kind).toBe('ready');
});

it('prepares rename and three children as one bounded same-plan batch', async () => {
  const h = await setup();
  const root = await h.api.tasks.list({});
  if (!root.ok) throw new Error(root.error.code);
  const task = expectDefined(root.value.items[0]);
  const prepared = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: task.target,
    expectedRevision: task.revision,
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  const plan = prepared.value;
  h.session.stage({ kind: 'task', plan });
  const target = expectDefined(plan.after).target;
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'batch',
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          operations: [
            { type: 'patch', target, patch: { markdownTitle: { type: 'set', value: 'Renamed' } } },
            ...['A', 'B', 'C'].map((markdownTitle) => ({
              type: 'add-child',
              target,
              markdownTitle,
            })),
          ],
        },
      }),
    finish(),
  );
  await h.session.submit('Rename and add three children');
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(h.session.snapshot().proposal.operations).toBe(5);
  expect(h.session.snapshot().trees[0]?.after?.childCount).toBe(3);
  expect(h.session.snapshot().trees[0]?.after?.markdownTitle).toBe('Renamed [unknown:: keep]');
  await h.session.confirm();
  expect(await h.read('a.md')).toContain('- [ ] Renamed [unknown:: keep]');
  expect(await h.read('a.md')).toContain('\t- [ ] C');
});

it('keeps durable journals out of bounded model context while confirming the current proposal', async () => {
  const title = `Long ${'x'.repeat(5000)}`;
  const h = await setup({ 'a.md': `- [ ] ${title}\n` });
  const prepare = expectDefined(h.api.tasks.prepare);
  for (let index = 0; index < 12; index++) {
    const list = await h.api.tasks.list({});
    if (!list.ok) throw new Error(list.error.code);
    const root = expectDefined(list.value.items[0]);
    const result = await prepare({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { markdownTitle: { type: 'set', value: `${title} ${index}` } },
      },
    });
    if (!result.ok) throw new Error(result.error.code);
    h.session.stage({ kind: 'task', plan: result.value });
    if (index < 11) expect(await h.session.confirm()).toBe(true);
  }
  expect(JSON.stringify(h.session.snapshot()).length).toBeGreaterThan(96000);
  const journalLength = h.session.snapshot().journal.length;
  h.script(interpret('confirm'));
  await h.session.submit('Save the current version');
  expect(h.session.snapshot().status.kind).toBe('saved');
  expect(h.session.snapshot().journal).toHaveLength(journalLength + 1);
  const context = JSON.stringify(h.model.doGenerateCalls[0]?.prompt);
  expect(context.length).toBeLessThan(96000);
  expect(context).not.toContain('journal');
  expect(await h.read('a.md')).toContain(`${title} 11`);
});

it.each(['invalid-middle', 'stale-revision', 'unknown-node'] as const)(
  'keeps the earlier draft committable after a batch failure: %s',
  async (failure) => {
    const h = await setup();
    h.script(interpret(), create, finish());
    await h.session.submit('Prepare a tree');
    const change = expectDefined(h.session.snapshot().proposal.changes[0]);
    if (change.kind !== 'task') throw new Error('Expected task');
    const plan = change.plan;
    const target = expectDefined(plan.after).target;
    h.script(
      interpret(),
      () =>
        call('task', {
          input: {
            kind: 'batch',
            plan: plan.target,
            expectedPlanRevision:
              failure === 'stale-revision' ? `${plan.revision}-stale` : plan.revision,
            operations: [
              {
                type: 'patch',
                target,
                patch: { markdownTitle: { type: 'set', value: 'Not staged' } },
              },
              failure === 'invalid-middle'
                ? { type: 'patch', target, patch: { due: { type: 'set', value: 'invalid-date' } } }
                : {
                    type: 'add-child',
                    target: failure === 'unknown-node' ? 'unissued-child' : target,
                    markdownTitle: 'Later',
                  },
            ],
          },
        }),
      () => ({
        ...call('unused', {}),
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
      }),
    );
    await h.session.submit('Refine the draft');
    expect(h.session.snapshot().proposal.changes[0]).toEqual(change);
    expect(h.session.snapshot().status.kind).toBe('error');
    h.script(interpret(), finish());
    await h.session.submit('Keep the earlier draft');
    expect(await h.session.confirm()).toBe(true);
    expect(await h.read('a.md')).toContain('- [ ] New');
    expect(await h.read('a.md')).not.toContain('Not staged');
  },
);

it('counts every batch operation against the existing session budget', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare');
  for (let index = 0; index < 4; index++) {
    const change = expectDefined(h.session.snapshot().proposal.changes[0]);
    if (change.kind !== 'task') throw new Error('Expected task');
    const plan = change.plan,
      target = expectDefined(plan.after).target;
    h.script(
      interpret(),
      () =>
        call('task', {
          input: {
            kind: 'batch',
            plan: plan.target,
            expectedPlanRevision: plan.revision,
            operations: Array.from({ length: 20 }, (_, item) => ({
              type: 'description',
              target,
              text: `Revision ${index}-${item}`,
            })),
          },
        }),
      finish(),
    );
    await h.session.submit('Refine descriptions');
    expect(h.session.snapshot().status.kind).toBe('ready');
  }
  const previous = h.session.snapshot().proposal;
  expect(previous.operations).toBe(81);
  const change = expectDefined(previous.changes[0]);
  if (change.kind !== 'task') throw new Error('Expected task');
  const plan = change.plan,
    target = expectDefined(plan.after).target;
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'batch',
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          operations: Array.from({ length: 20 }, () => ({
            type: 'description',
            target,
            text: 'Too many',
          })),
        },
      }),
    () => ({ ...call('unused', {}), content: [], finishReason: { unified: 'stop', raw: 'stop' } }),
  );
  await h.session.submit('Another batch');
  expect(h.session.snapshot().proposal).toEqual(previous);
  expect(h.session.snapshot().status.kind).toBe('error');
});

it('gives actionable draft-basis feedback without accepting guessed or mixed references', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare a draft');
  const change = expectDefined(h.session.snapshot().proposal.changes[0]);
  if (change.kind !== 'task') throw new Error('Expected task');
  const plan = change.plan,
    node = expectDefined(plan.after);
  const operation = {
    type: 'patch',
    target: node.target,
    patch: { markdownTitle: { type: 'set', value: 'Refined' } },
  };
  h.script(
    interpret(),
    () =>
      call('task', {
        input: { kind: 'edit', target: node.target, expectedRevision: node.revision, operation },
      }),
    () =>
      call('task', {
        input: {
          kind: 'append',
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          operation,
        },
      }),
    finish(),
  );
  await h.session.submit('Refine that draft');
  expect(JSON.stringify(h.model.doGenerateCalls[5]?.prompt)).toContain('Use append/batch');
  expect(h.session.snapshot().status.kind).toBe('ready');
  expect(h.session.snapshot().trees[0]?.after?.title).toBe('Refined');
  expect(await h.read('a.md')).not.toContain('Refined');
});

it('refuses a nested creation over fifty changed nodes before surfacing a proposal', async () => {
  const h = await setup();
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'create',
          destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
          tree: {
            markdownTitle: 'Root',
            children: [
              {
                markdownTitle: 'Branch',
                children: Array.from({ length: 50 }, (_, index) => ({
                  markdownTitle: `Leaf ${index}`,
                })),
              },
            ],
          },
        },
      }),
    () => ({ ...call('unused', {}), content: [], finishReason: { unified: 'stop', raw: 'stop' } }),
  );
  await h.session.submit('Prepare a deeply nested tree');
  expect(h.session.snapshot().proposal.changes).toHaveLength(0);
  expect(await h.read('a.md')).not.toContain('Leaf');
});

it('requires a protocol tool and never accepts plaintext termination after preparation', async () => {
  const h = await setup();
  h.script(interpret(), create, () => ({
    ...call('unused', {}),
    content: [{ type: 'text', text: 'Ready' }],
    finishReason: { unified: 'stop', raw: 'stop' },
  }));
  await h.session.submit('Prepare a tree');
  for (const call of h.model.doGenerateCalls) expect(call.toolChoice).toEqual({ type: 'required' });
  expect(h.session.snapshot().status.kind).toBe('error');
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
  expect(await h.read('a.md')).not.toContain('- [ ] New');
});

it('counts deep changes while retaining an unchanged large canonical tree', async () => {
  const body = [
    '- [ ] Root',
    '  - [ ] Branch',
    ...Array.from({ length: 51 }, (_, i) => `    - [ ] Leaf ${i}`),
    '',
  ].join('\n');
  const h = await setup({ 'a.md': body });
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  h.script(
    interpret(),
    () =>
      call('task', {
        input: { kind: 'edit', target: root.target, expectedRevision: root.revision },
      }),
    finish(),
  );
  await h.session.submit('Work with this tree');
  expect(h.session.snapshot().status.kind).toBe('ready');
  const initial = expectDefined(h.session.snapshot().proposal.changes[0]);
  if (initial.kind !== 'task') throw new Error('Expected task');
  const originalPlan = initial.plan,
    branch = expectDefined(originalPlan.after?.children[0]);
  const operations = branch.children.slice(0, 20).map((node) => ({
    type: 'patch',
    target: node.target,
    patch: { markdownTitle: { type: 'set', value: `Changed ${node.title}` } },
  }));
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'batch',
          plan: originalPlan.target,
          expectedPlanRevision: originalPlan.revision,
          operations,
        },
      }),
    finish(),
  );
  await h.session.submit('Refine twenty deep nodes');
  expect(h.session.snapshot().status.kind).toBe('ready');
  const current = expectDefined(h.session.snapshot().proposal.changes[0]);
  if (current.kind !== 'task') throw new Error('Expected task');
  const remaining = expectDefined(current.plan.after?.children[0]).children.slice(20);
  for (const node of remaining.slice(0, 30))
    h.session.stage({
      kind: 'status',
      target: node.target,
      revision: node.revision,
      symbol: 'x',
      plan: current.plan.target,
      nuance: 'Ordinary completion',
    });
  const last = expectDefined(remaining[30]);
  expect(() => {
    h.session.stage({
      kind: 'status',
      target: last.target,
      revision: last.revision,
      symbol: 'x',
      plan: current.plan.target,
      nuance: 'Ordinary completion',
    });
  }).toThrow('too large');
  expect(await h.read('a.md')).toBe(body);
});

it('retains an authored annotation when the replacement contains its literal only inside code', () => {
  expect(preserveAuthoredAnnotations('Old [unknown:: keep]', 'New `[unknown:: keep]`')).toBe(
    'New `[unknown:: keep]` [unknown:: keep]',
  );
});

it('reports an application generation deadline as timeout rather than user cancellation', async () => {
  const h = await setup();
  const entered = deferred<void>();
  let calls = 0;
  h.model.doGenerate = async ({ abortSignal }) => {
    calls++;
    entered.resolve();
    return new Promise((_resolve, reject) => {
      abortSignal?.addEventListener(
        'abort',
        () => {
          reject(new ProviderFailure('cancelled'));
        },
        {
          once: true,
        },
      );
    });
  };
  vi.useFakeTimers();
  try {
    const pending = h.session.submit('Prepare a task');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25001);
    await pending;
    expect(calls).toBe(1);
    expect(h.session.snapshot().status.kind).toBe('error');
    expect(h.session.snapshot().status.message).toContain('too long');
    expect(h.session.snapshot().status.message).not.toContain('cancelled');
  } finally {
    vi.useRealTimers();
  }
});

it('stops on repair exhaustion and sends concise format feedback instead of SDK input echoes', async () => {
  const h = await setup();
  const malformed = () => call('task', { input: 'invalid encoded input' });
  h.script(interpret(), malformed, malformed, malformed, finish());
  await h.session.submit('Prepare a task');
  expect(h.model.doGenerateCalls).toHaveLength(4);
  expect(h.session.snapshot().status.kind).toBe('error');
  expect(h.session.snapshot().proposal.changes).toHaveLength(0);
  const retry = JSON.stringify(h.model.doGenerateCalls[2]?.prompt);
  expect(retry).not.toContain('AI_InvalidToolInputError');
  expect(retry).toContain('input must be an object');
});

it('keeps background reads separate from explicit finish selection of a draft child', async () => {
  const h = await setup();
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.code);
  const task = expectDefined(listed.value.items[0]);
  h.script(interpret(), () => call('read', { kind: 'tree', target: task.target }), finish());
  await h.session.submit('Read this task as reference');
  expect(h.session.snapshot().focus).toHaveLength(0);
  h.script(interpret(), create, () => {
    const change = expectDefined(h.session.snapshot().proposal.changes[0]);
    if (change.kind !== 'task') throw new Error('Expected task');
    const child = expectDefined(change.plan.after?.children[1]);
    return call('finish', {
      state: 'ready',
      message: 'Ready.',
      selection: [
        {
          kind: 'task',
          target: child.target,
          plan: change.plan.target,
          expectedPlanRevision: change.plan.revision,
        },
      ],
    });
  });
  await h.session.submit('Create a draft and work on its second child');
  expect(h.session.snapshot().focus).toHaveLength(1);
  expect(
    h.session.snapshot().entities.tasks[h.session.snapshot().entities.tasks.length - 1]?.tree.title,
  ).toBe('Child B');
  expect(await h.read('a.md')).not.toContain('- [ ] New');
});

it('retires stale child read pages before the next model turn and refreshes selected peers from that source', async () => {
  const h = await setup(
    {
      'a.md': '- [ ] Root\n  - [ ] Child 🏁 delete\n- [ ] Selected peer\n',
      'b.md': '- [ ] Unrelated source\n',
    },
    { behaviorSettings: () => DEFAULT_SETTINGS },
  );
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error('list');
  const root = expectDefined(listed.value.items.find((task) => task.title === 'Root'));
  const child = expectDefined(listed.value.items.find((task) => task.title === 'Child'));
  const peer = expectDefined(listed.value.items.find((task) => task.title === 'Selected peer'));
  const unrelated = expectDefined(
    listed.value.items.find((task) => task.title === 'Unrelated source'),
  );
  await h.session.readTreePage({ target: child.target });
  await h.session.readTreePage({ target: unrelated.target });
  expect(
    await h.session.focus({ kind: 'task', target: peer.target, revision: peer.revision }),
  ).toBe(true);
  h.script(
    interpret(),
    () =>
      call('task', {
        input: {
          kind: 'edit',
          target: root.target,
          expectedRevision: root.revision,
          operation: {
            type: 'patch',
            target: root.target,
            patch: { markdownTitle: { type: 'set', value: 'Refined root' } },
          },
        },
      }),
    () => {
      const plan = expectDefined(
        h.session.snapshot().proposal.changes.find((change) => change.kind === 'task'),
      ).plan;
      const current = expectDefined(plan.after?.children[0]);
      return call('status', {
        target: current.target,
        revision: current.revision,
        symbol: 'x',
        plan: plan.target,
      });
    },
    finish(),
  );
  await h.session.submit('Rename root and complete its child');
  expect(await h.session.confirm()).toBe(true);
  const next = h.model.doGenerateCalls.length;
  h.script(interpret(), finish());
  await h.session.submit('Show the current work');
  const prompt = JSON.stringify(h.model.doGenerateCalls[next]?.prompt);
  expect(prompt).not.toContain(child.revision);
  expect(prompt).toContain(unrelated.revision);
  const currentPeer = await h.api.tasks.get(peer.target);
  if (!currentPeer.ok) throw new Error('peer');
  expect(h.session.snapshot().focus).toEqual([
    { kind: 'task', target: peer.target, revision: currentPeer.value.revision },
  ]);
  expect(
    h.session
      .snapshot()
      .entities.tasks.some(
        (page) =>
          page.tree.target === peer.target && page.tree.revision === currentPeer.value.revision,
      ),
  ).toBe(true);
});
it('bounds model replies without dropping earlier user constraints from durable history', async () => {
  const h = await setup();
  h.session.exchange('user', 'Keep the original project membership.');
  for (let index = 0; index < 20; index++)
    h.session.exchange('agent', `Historical reply ${index}.`);
  h.script(interpret(), finish());
  await h.session.submit('Show the current task');
  const prompt = JSON.stringify(h.model.doGenerateCalls[0]?.prompt);
  expect(prompt).toContain('Keep the original project membership.');
  expect(prompt).not.toContain('Historical reply 0.');
  expect(prompt).toContain('Historical reply 19.');
  expect(h.session.snapshot().exchanges.some((entry) => entry.text === 'Historical reply 0.')).toBe(
    true,
  );
});

it('semantic new-session does not wait for the turn that requested it', async () => {
  const h = await setup();
  const id = h.session.snapshot().id;
  h.script(interpret('new-session'));
  const turn = h.session.submit('Start a separate conversation');
  await vi.waitFor(
    () => {
      expect(h.session.snapshot().id).not.toBe(id);
    },
    { timeout: 200 },
  );
  await turn;
  expect(h.session.snapshot().status.kind).toBe('ready');
});
it('a normal dirty focus question finishes without schema repair or a ready overwrite', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare a new task');
  const list = await h.api.tasks.list();
  if (!list.ok) throw new Error('list');
  const existing = expectDefined(list.value.items[0]);
  h.script(interpret(), () =>
    call('finish', {
      state: 'ready',
      message: 'Selected.',
      selection: [{ kind: 'task', target: existing.target, revision: existing.revision }],
    }),
  );
  await h.session.submit('Move to the existing task');
  expect(h.session.snapshot().status.kind).toBe('question');
  expect(h.session.snapshot().pendingTransition?.kind).toBe('focus');
  h.script(() =>
    call('interpret', {
      intent: 'resolve-transition',
      research: false,
      transitionDisposition: 'cancel',
    }),
  );
  await h.session.submit('Stay with the draft');
  expect(h.session.snapshot().pendingTransition).toBeNull();
  expect(h.session.snapshot().proposal.changes).toHaveLength(1);
});
it('semantic save-current then prepare-another renews the preview without saving the new tree', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare the first');
  h.script(
    interpret('save-then-plan'),
    () =>
      call('task', {
        input: {
          kind: 'create',
          destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
          tree: { markdownTitle: 'Next draft' },
        },
      }),
    finish(),
  );
  await h.session.submit('Save this, then prepare another task');
  expect(await h.read('a.md')).toContain('- [ ] New');
  expect(await h.read('a.md')).not.toContain('Next draft');
  expect(h.session.snapshot().trees[0]?.after?.title).toBe('Next draft');
  expect(h.session.snapshot().status.kind).toBe('ready');
});

it('historical mode permits read-only turns and explicit review prepares fresh canonical evidence in the same session', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Create original tree');
  const original = h.session.snapshot();
  h.session.restore(original);
  h.script(
    interpret(),
    () => call('read', { kind: 'tasks', query: '' }),
    finish('Current tasks inspected.'),
  );
  await h.session.submit('Show what exists now');
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  expect(h.session.snapshot().recovery).toBe('historical');
  h.script(interpret('review'), create, finish());
  await h.session.submit('Prepare a fresh preview of my original request');
  expect(h.session.snapshot().id).toBe(original.id);
  expect(h.session.snapshot().recovery).toBe('live');
  expect(h.session.snapshot().recoveryEvidence?.proposal).toEqual(original.proposal);
  expect(h.session.snapshot().preparations).toHaveLength(1);
  expect(h.session.snapshot().proposal.revision).toBeGreaterThan(original.proposal.revision);
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  await h.session.submit('');
  expect(await h.read('a.md')).toContain('- [ ] New');
});
it('fresh review refuses an old plan append even when its original client still owns it', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Original');
  const original = h.session.snapshot();
  const change = expectDefined(original.proposal.changes[0]);
  if (change.kind !== 'task') throw new Error('task');
  h.session.restore(original);
  h.script(interpret('review'), () =>
    call('task', {
      input: {
        kind: 'append',
        plan: change.plan.target,
        expectedPlanRevision: change.plan.revision,
        operation: {
          type: 'patch',
          target: expectDefined(change.plan.after).target,
          patch: { markdownTitle: { type: 'set', value: 'Stale replay' } },
        },
      },
    }),
  );
  await h.session.submit('Rebuild from current source');
  expect(h.session.snapshot().proposal.changes).toEqual([]);
  expect(h.session.snapshot().recovery).toBe('reviewing');
  expect(await h.read('a.md')).not.toContain('Stale replay');
});

it('delayed save-and-switch is bound to the original pending target as well as the proposal', async () => {
  const h = await setup({ 'a.md': '- [ ] First\n- [ ] Second\n' });
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare pending work');
  const tasks = await h.api.tasks.list();
  if (!tasks.ok) throw new Error('list');
  const first = expectDefined(tasks.value.items[0]),
    second = expectDefined(tasks.value.items[1]);
  await h.session.focus({ kind: 'task', target: first.target, revision: first.revision });
  const recorded = {
    sessionId: h.session.snapshot().id,
    proposalRevision: h.session.snapshot().proposal.revision,
  };
  await h.session.focus({ kind: 'task', target: second.target, revision: second.revision });
  h.script(() =>
    call('interpret', {
      intent: 'resolve-transition',
      research: false,
      transitionDisposition: 'save',
    }),
  );
  await h.session.submit('Save and switch there', recorded);
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  expect(h.session.snapshot().pendingTransition).toMatchObject({
    kind: 'focus',
    target: [{ target: second.target }],
  });
  expect(h.session.snapshot().status.kind).toBe('question');
});
it.each(['keep', 'discard'] as const)(
  'rejects delayed %s new-session disposition after the preview changes',
  async (disposition) => {
    const h = await setup();
    h.script(interpret(), create, finish());
    await h.session.submit('Original preview');
    const original = h.session.snapshot();
    h.script(
      interpret(),
      () =>
        call('task', {
          input: {
            kind: 'create',
            destination: { type: 'configured-default' },
            tree: { markdownTitle: 'More work' },
          },
        }),
      finish(),
    );
    await h.session.submit('Also prepare another task');
    h.script(() => call('interpret', { intent: 'new-session', research: false, disposition }));
    await h.session.submit('Start another conversation', {
      sessionId: original.id,
      proposalRevision: original.proposal.revision,
    });
    expect(h.session.snapshot().id).toBe(original.id);
    expect(h.session.snapshot().proposal.changes).toHaveLength(2);
    expect(h.session.snapshot().status.kind).toBe('question');
  },
);

it('an unresolved semantic disposition retains the pending draft and asks without a tool repair', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare pending work');
  await h.session.newSession();
  const previous = h.session.snapshot();
  const calls = h.model.doGenerateCalls.length;
  h.script(() => call('interpret', { intent: 'resolve-transition', research: false }));
  await h.session.submit('Move on, but I am unsure what to do with this draft');
  expect(h.session.snapshot().id).toBe(previous.id);
  expect(h.session.snapshot().proposal).toEqual(previous.proposal);
  expect(h.session.snapshot().pendingTransition).toEqual(previous.pendingTransition);
  expect(h.session.snapshot().status.kind).toBe('question');
  expect(h.model.doGenerateCalls.length - calls).toBe(1);
  expect(await h.read('a.md')).not.toContain('- [ ] New');
});

it('semantic keep archives a resumable unsaved preview without a source write', async () => {
  const h = await setup();
  h.script(interpret(), create, finish());
  await h.session.submit('Prepare a task and its children');
  await h.session.newSession();
  const previous = h.session.snapshot();
  h.script(() =>
    call('interpret', {
      intent: 'resolve-transition',
      research: false,
      transitionDisposition: 'keep',
    }),
  );
  await h.session.submit('Оставь предыдущую незаписанной, начнём новую.');
  expect(h.session.snapshot().id).not.toBe(previous.id);
  const archived = expectDefined(h.saved.find((snapshot) => snapshot.id === previous.id));
  expect(archived.proposal).toEqual(previous.proposal);
  expect(archived.trees).toEqual(previous.trees);
  expect(archived.input).toBe('Оставь предыдущую незаписанной, начнём новую.');
  expect(await h.read('a.md')).not.toContain('- [ ] New');
  expect(h.session.restore(archived)).toBe(true);
  await h.session.resumeOwned();
  expect(await h.session.confirm()).toBe(true);
  expect((await h.read('a.md')).match(/- \[ \] New/g)).toHaveLength(1);
});
