import { type App, type TFile } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1, NotePlanV1, PrepareNoteV1 } from '../api';
import { deferred, flushMicrotasks, metadataChangedEmitter, useRealMoment } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

useRealMoment();
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.dispose();
  });
});
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
async function setup(files: Record<string, string> = {}) {
  const h = await publicApiHarness({ 'context/source.md': 'Context\n', ...files });
  owners.push(h);
  const notes = h.client().notes;
  if (notes === undefined) throw new Error('Missing notes');
  const commit = (plan: NotePlanV1) => ({
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    requestId: 'native-create',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  return { ...h, notes, commit };
}
function installTemplater(
  app: App,
  render: (target: TFile) => Promise<string> = async () => '---\nstatus: draft\n---\nTemplate\n',
) {
  const settings = {
    trigger_on_file_creation: true,
    templates_folder: 'templates',
    ignore_folders_on_creation: [{ folder: '' }],
    enable_folder_templates: true,
    folder_templates: [{ folder: '/', template: 'templates/default.md' }],
    enable_file_templates: false,
    file_templates: [] as Array<{ regex: string; template: string }>,
  };
  const parse = vi.fn(async (config: { target: TFile }) => render(config.target));
  const start = vi.fn();
  const finish = vi.fn(async () => {});
  const plugin = {
    settings,
    templater: {
      files_with_pending_templates: new Set<string>(),
      start_templater_task: start,
      end_templater_task: finish,
      create_running_config: (_template: TFile, target: TFile) => ({ target }),
      read_and_parse_template: parse,
    },
  };
  Object.defineProperty(app, 'plugins', { configurable: true, value: { getPlugin: () => plugin } });
  return { settings, parse, start, finish };
}
const request = (
  extra: Partial<Extract<PrepareNoteV1, { kind: 'create' }> & { path?: never }> = {},
) => ({
  kind: 'create' as const,
  destination: { type: 'obsidian-default' as const, fileName: 'New.md' },
  title: 'New',
  text: 'Agent prose',
  templateExecution: { type: 'configured-templater' as const },
  ...extra,
});

it('resolves the public native default with explicit context, freezes the suffix, and prepares without writes', async () => {
  const h = await setup({
    'context/New.md': 'Existing\n',
    'templates/default.md': '<% dynamic %>',
  });
  const folder = h.app.vault.getFolderByPath('context');
  const resolve = vi.fn(() => folder);
  Object.defineProperty(h.app.fileManager, 'getNewFileParent', { value: resolve });
  const templater = installTemplater(h.app);
  templater.settings.folder_templates = [{ folder: 'context', template: 'templates/default.md' }];
  const create = vi.spyOn(h.app.vault, 'create');
  const folders = vi.spyOn(h.app.vault, 'createFolder');
  const process = vi.spyOn(h.app.vault, 'process');
  const plan = ok(
    await h.notes.prepare(
      request({
        destination: {
          type: 'obsidian-default',
          fileName: 'New.md',
          fromPath: 'context/source.md',
        },
        collision: 'suffix',
      }),
    ),
  );
  expect(resolve).toHaveBeenCalledWith('context/source.md', 'New.md');
  expect(plan.path).toBe('context/New 2.md');
  expect(plan.creationPreview).toMatchObject({
    type: 'template-first',
    template: { path: 'templates/default.md' },
    requestedBody: { text: 'Agent prose', complete: true },
    placement: 'append-after-template',
  });
  expect(plan.after.text).toBe('Agent prose');
  expect(create).not.toHaveBeenCalled();
  expect(folders).not.toHaveBeenCalled();
  expect(process).not.toHaveBeenCalled();
  expect(templater.start).not.toHaveBeenCalled();
  expect(templater.parse).not.toHaveBeenCalled();
  expect(templater.finish).not.toHaveBeenCalled();
});

it('waits for template execution and cleanup before appending prose while preserving exact frontmatter', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  Object.defineProperty(h.app.fileManager, 'getNewFileParent', {
    value: () => h.app.vault.getRoot(),
  });
  const gate = deferred<string>();
  const entered = deferred<void>();
  const templater = installTemplater(h.app, async () => {
    entered.resolve();
    return gate.promise;
  });
  const plan = ok(await h.notes.prepare(request()));
  const writing = h.notes.create(h.commit(plan));
  await Promise.race([
    entered.promise,
    writing.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  expect(await h.read('New.md')).toBe('');
  gate.resolve('\uFEFF---\r\nstatus: draft\r\n---\r\nTemplate\r\n');
  const saved = await writing;
  expect(saved).toMatchObject({
    ok: true,
    receipt: {
      completion: 'complete',
      templateEffects: 'committed',
      contentEffects: 'committed',
    },
  });
  expect(templater.finish).toHaveBeenCalledOnce();
  expect(await h.read('New.md')).toBe(
    '\uFEFF---\r\nstatus: draft\r\n---\r\nTemplate\r\nAgent prose',
  );
  expect(await h.notes.create(h.commit(plan))).toEqual(saved);
  expect(templater.parse).toHaveBeenCalledOnce();
});

it('retains an incomplete created note and never replays a failing template', async () => {
  const h = await setup({ 'templates/default.md': '<% failing %>' });
  const templater = installTemplater(h.app, async () => {
    throw new Error('Parser failed');
  });
  const base = {
    kind: 'create' as const,
    title: 'New',
    text: 'Agent prose',
    templateExecution: { type: 'configured-templater' as const },
  };
  const plan = ok(await h.notes.prepare({ ...base, path: 'New.md' }));
  const saved = await h.notes.create(h.commit(plan));
  expect(saved).toMatchObject({
    ok: false,
    effects: 'unknown',
    receipt: {
      completion: 'incomplete',
      phase: 'template',
      noteEffects: 'committed',
      effects: 'unknown',
      templateEffects: 'unknown',
      contentEffects: 'unchanged',
    },
  });
  expect(await h.read('New.md')).toBe('');
  expect(await h.notes.create(h.commit(plan))).toEqual(saved);
  expect(templater.parse).toHaveBeenCalledOnce();
});

it.each([
  {
    path: 'context/New.md',
    folder: true,
    rules: [{ folder: '/', template: 'templates/default.md' }],
    expected: 'templates/default.md',
  },
  {
    path: 'context/New.md',
    folder: true,
    rules: [
      { folder: 'context', template: '' },
      { folder: 'context', template: 'templates/other.md' },
    ],
    expected: undefined,
  },
  {
    path: 'context/New.md',
    folder: true,
    rules: [{ folder: 'unmatched', template: 'templates/default.md' }],
    expected: undefined,
  },
  { path: 'context/New.md', folder: false, rules: [], expected: 'templates/other.md' },
  { path: 'templates/New.md', folder: false, rules: [], expected: undefined },
])(
  'captures configured template precedence without executing it: $path $folder $expected',
  async ({ path, folder, rules, expected }) => {
    const h = await setup({
      'templates/default.md': '<% default %>',
      'templates/other.md': '<% other %>',
    });
    const templater = installTemplater(h.app);
    templater.settings.enable_folder_templates = folder;
    templater.settings.folder_templates = rules;
    templater.settings.enable_file_templates = true;
    templater.settings.file_templates = [{ regex: 'New\\.md$', template: 'templates/other.md' }];
    const base = { ...request(), path };
    const { destination, ...input } = base;
    expect(destination.fileName).toBe('New.md');
    const plan = ok(await h.notes.prepare(input));
    expect(plan.creationPreview?.template?.path).toBe(expected);
    expect(templater.start).not.toHaveBeenCalled();
  },
);

it('rejects a changed native destination policy before creating any note', async () => {
  const h = await setup();
  let root = true;
  Object.defineProperty(h.app.fileManager, 'getNewFileParent', {
    value: () => (root ? h.app.vault.getRoot() : h.app.vault.getFolderByPath('context')),
  });
  const plan = ok(await h.notes.prepare(request()));
  root = false;
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(h.app.vault.getFileByPath('New.md')).toBeNull();
  expect(h.app.vault.getFileByPath('context/New.md')).toBeNull();
});

it.each(['settings', 'template', 'template-identity'] as const)(
  'rejects changed %s before provisioning',
  async (changed) => {
    const h = await setup({ 'templates/default.md': '<% dynamic %>' });
    const templater = installTemplater(h.app);
    const plan = ok(
      await h.notes.prepare({
        kind: 'create',
        path: 'New.md',
        title: 'New',
        text: 'Prose',
        templateExecution: { type: 'configured-templater' },
      }),
    );
    if (changed === 'settings') templater.settings.trigger_on_file_creation = false;
    else if (changed === 'template') await h.external('templates/default.md', '<% changed %>');
    else {
      const file = h.app.vault.getFileByPath('templates/default.md');
      if (file === null) throw new Error('Missing template');
      await h.app.vault.rename(file, 'templates/old.md');
      await h.app.vault.create('templates/default.md', '<% dynamic %>');
    }
    expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
    expect(h.app.vault.getFileByPath('New.md')).toBeNull();
  },
);

it('refuses a terminal template task without inventing an editable append range', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  installTemplater(h.app, async () => '---\nstatus: draft\n---\n- [ ] Template task');
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const result = await h.notes.create(h.commit(plan));
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'SECTION_NOT_EDITABLE' },
    receipt: {
      completion: 'incomplete',
      templateEffects: 'committed',
      contentEffects: 'unchanged',
    },
  });
  expect(await h.read('New.md')).toBe('---\nstatus: draft\n---\n- [ ] Template task');
});

it('never writes prose into a renamed target or an unrelated replacement at the frozen path', async () => {
  const h = await setup({ 'templates/default.md': '<% rename %>' });
  installTemplater(h.app, async (target) => {
    await h.app.vault.rename(target, 'Moved.md');
    await h.app.vault.create('New.md', 'Unrelated\n');
    return 'Template\n';
  });
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const result = await h.notes.create(h.commit(plan));
  expect(result).toMatchObject({
    ok: false,
    receipt: { completion: 'incomplete', noteEffects: 'committed', contentEffects: 'unchanged' },
  });
  expect(await h.read('Moved.md')).toBe('');
  expect(await h.read('New.md')).toBe('Unrelated\n');
  expect(await h.notes.create(h.commit(plan))).toEqual(result);
});

it('rejects prose after a concurrent frontmatter hook changes the initialized source inside process', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  const templater = installTemplater(h.app);
  const gate = deferred<void>();
  let detached: Promise<void> | undefined;
  templater.finish.mockImplementation(async () => {
    detached = gate.promise.then(async () => {
      const file = h.app.vault.getFileByPath('New.md');
      if (file === null) throw new Error('Missing new note');
      await h.app.vault.modify(file, '---\nstatus: changed-by-hook\n---\nTemplate\n');
    });
  });
  const process = h.app.vault.process.bind(h.app.vault);
  let count = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, callback) => {
    if (++count === 2) {
      gate.resolve();
      await detached;
    }
    return process(file, callback);
  });
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const result = await h.notes.create(h.commit(plan));
  expect(result).toMatchObject({
    ok: false,
    receipt: { completion: 'incomplete', noteEffects: 'committed', contentEffects: 'unchanged' },
  });
  expect(await h.read('New.md')).toBe('---\nstatus: changed-by-hook\n---\nTemplate\n');
});

it('preserves frontmatter from a hook completed before supported cleanup resolves', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  const templater = installTemplater(h.app);
  templater.finish.mockImplementation(async () => {
    const file = h.app.vault.getFileByPath('New.md');
    if (file === null) throw new Error('Missing new note');
    await h.app.vault.modify(file, '---\nstatus: completed-hook\n---\nTemplate\n');
  });
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: true });
  expect(await h.read('New.md')).toBe('---\nstatus: completed-hook\n---\nTemplate\nProse');
});

it.each(['/', 'context'])(
  'joins a native %s folder and supplies an empty no-source context',
  async (parent) => {
    const h = await setup();
    const resolve = vi.fn(() =>
      parent === '/' ? h.app.vault.getRoot() : h.app.vault.getFolderByPath(parent),
    );
    Object.defineProperty(h.app.fileManager, 'getNewFileParent', { value: resolve });
    const plan = ok(await h.notes.prepare(request()));
    expect(plan.path).toBe(parent === '/' ? 'New.md' : 'context/New.md');
    expect(resolve).toHaveBeenCalledWith('', 'New.md');
  },
);

it.each(['../New.md', '/New.md', 'nested/New.md', '.md', 'New', ' New.md', 'C:.md'])(
  'rejects an invalid default basename before host resolution: %s',
  async (fileName) => {
    const h = await setup();
    const resolve = vi.fn(() => h.app.vault.getRoot());
    Object.defineProperty(h.app.fileManager, 'getNewFileParent', { value: resolve });
    expect(
      await h.notes.prepare(request({ destination: { type: 'obsidian-default', fileName } })),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(resolve).not.toHaveBeenCalled();
  },
);

it('never chooses a new suffix when the frozen path collides after preparation', async () => {
  const h = await setup({ 'New.md': 'Original\n', 'templates/default.md': '<% dynamic %>' });
  const templater = installTemplater(h.app);
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      collision: 'suffix',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  expect(plan.path).toBe('New 2.md');
  await h.app.vault.create('New 2.md', 'Concurrent\n');
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(await h.read('New 2.md')).toBe('Concurrent\n');
  expect(h.app.vault.getFileByPath('New 3.md')).toBeNull();
  expect(templater.parse).not.toHaveBeenCalled();
});

it('supports explicit core templates without Templater while rejecting executable fallback before writes', async () => {
  const h = await setup({
    'templates/default.md': '---\nstatus: draft\n---\n{{title}}\n',
    'templates/exec.md': '<% dynamic %>',
  });
  const template = ok(await h.notes.read({ selector: { path: 'templates/default.md' } })).note;
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      template: template.target,
      expectedTemplateRevision: template.revision,
      templateExecution: { type: 'explicit-templater' },
    }),
  );
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: true });
  expect(await h.read('New.md')).toBe('---\nstatus: draft\n---\nNew\nProse');
  const executable = ok(await h.notes.read({ selector: { path: 'templates/exec.md' } })).note;
  expect(
    await h.notes.prepare({
      kind: 'create',
      path: 'Blocked.md',
      title: 'Blocked',
      text: 'Prose',
      template: executable.target,
      expectedTemplateRevision: executable.revision,
      templateExecution: { type: 'explicit-templater' },
    }),
  ).toMatchObject({ ok: false });
  expect(h.app.vault.getFileByPath('Blocked.md')).toBeNull();
});

it.each(['reject', 'acknowledgement-lost'] as const)(
  'retains create I/O evidence without replay: %s',
  async (failure) => {
    const h = await setup();
    const create = h.app.vault.create.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'create').mockImplementationOnce(async (path, content) => {
      if (failure === 'acknowledgement-lost') await create(path, content);
      throw new Error('Create failed');
    });
    const plan = ok(
      await h.notes.prepare({
        kind: 'create',
        path: 'New.md',
        title: 'New',
        text: 'Prose',
        templateExecution: { type: 'configured-templater' },
      }),
    );
    const saved = await h.notes.create(h.commit(plan));
    expect(saved).toMatchObject({
      ok: false,
      effects: 'unknown',
      receipt: {
        completion: 'incomplete',
        phase: 'provision',
        noteEffects: 'unknown',
        contentEffects: 'unchanged',
      },
    });
    expect(await h.notes.create(h.commit(plan))).toEqual(saved);
    expect(h.app.vault.getFileByPath('New.md') !== null).toBe(failure === 'acknowledgement-lost');
  },
);

it('retains folder-only effects when subsequent folder provisioning fails', async () => {
  const h = await setup();
  const createFolder = h.app.vault.createFolder.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'createFolder').mockImplementation(async (path) => {
    if (path === 'new/nested') throw new Error('Folder failed');
    return createFolder(path);
  });
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'new/nested/New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  expect(await h.notes.create(h.commit(plan))).toMatchObject({
    ok: false,
    effects: 'partial',
    receipt: {
      completion: 'incomplete',
      destinationEffects: 'committed',
      noteEffects: 'unchanged',
    },
  });
  expect(h.app.vault.getFolderByPath('new')).not.toBeNull();
  expect(h.app.vault.getFileByPath('new/nested/New.md')).toBeNull();
});

it('never appends after template cleanup fails and retains the completed template effect', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  const templater = installTemplater(h.app);
  templater.finish.mockRejectedValue(new Error('Cleanup failed'));
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const saved = await h.notes.create(h.commit(plan));
  expect(saved).toMatchObject({
    ok: false,
    receipt: {
      completion: 'incomplete',
      phase: 'template',
      templateEffects: 'committed',
      contentEffects: 'unchanged',
    },
  });
  expect(await h.read('New.md')).toBe('---\nstatus: draft\n---\nTemplate\n');
  expect(await h.notes.create(h.commit(plan))).toEqual(saved);
});

it('rechecks native destination policy inside the template write transaction', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  let root = true;
  Object.defineProperty(h.app.fileManager, 'getNewFileParent', {
    value: () => (root ? h.app.vault.getRoot() : h.app.vault.getFolderByPath('context')),
  });
  installTemplater(h.app);
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, callback) => {
    root = false;
    return process(file, callback);
  });
  const plan = ok(await h.notes.prepare(request()));
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: false });
  expect(await h.read('New.md')).toBe('');
});

it('rejects an unsupported active Templater adapter with a specific preparation failure', async () => {
  const h = await setup();
  Object.defineProperty(h.app, 'plugins', { value: { getPlugin: () => ({ templater: {} }) } });
  expect(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_TEMPLATE' } });
  expect(h.app.vault.getFileByPath('New.md')).toBeNull();
});

it('stops template output and prose when the confirming consumer is disposed during parsing', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  const gate = deferred<string>();
  const entered = deferred<void>();
  installTemplater(h.app, async () => {
    entered.resolve();
    return gate.promise;
  });
  const client = h.client('disposable');
  const notes = client.notes;
  if (notes === undefined) throw new Error('Missing notes');
  const plan = ok(
    await notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const writing = notes.create(h.commit(plan));
  await entered.promise;
  client.dispose();
  gate.resolve('Template\n');
  expect(await writing).toMatchObject({
    ok: false,
    receipt: { completion: 'incomplete', noteEffects: 'committed', contentEffects: 'unchanged' },
  });
  expect(await h.read('New.md')).toBe('');
});

it('refuses to refine a preview whose configured template policy changed', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  const templater = installTemplater(h.app);
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  templater.settings.trigger_on_file_creation = false;
  expect(
    await h.notes.prepare({
      kind: 'refine',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: { type: 'replace-body', text: 'Revised' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  expect(templater.parse).not.toHaveBeenCalled();
});

it('retains unknown aggregate effects when prose commits but its acknowledgement is lost', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  installTemplater(h.app);
  const process = h.app.vault.process.bind(h.app.vault);
  let writes = 0;
  vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, callback) => {
    const content = await process(file, callback);
    if (++writes === 2) throw new Error('Lost prose acknowledgement');
    return content;
  });
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const saved = await h.notes.create(h.commit(plan));
  expect(saved).toMatchObject({
    ok: false,
    effects: 'unknown',
    recovery: 'reconcile',
    receipt: {
      completion: 'incomplete',
      phase: 'content',
      effects: 'unknown',
      recovery: 'reconcile',
      noteEffects: 'committed',
      templateEffects: 'committed',
      contentEffects: 'unknown',
    },
  });
  expect(await h.read('New.md')).toBe('---\nstatus: draft\n---\nTemplate\nProse');
  expect(await h.notes.create(h.commit(plan))).toEqual(saved);
  expect(writes).toBe(2);
});

it('finishes a no-template create when a blank metadata acquisition supersedes its first reconciliation', async () => {
  const h = await setup();
  const createdLoad = deferred<string>();
  const metadataRead = deferred<string>();
  const cachedRead = h.app.vault.cachedRead.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'cachedRead').mockImplementation((file) =>
    file.path === 'New.md' ? createdLoad.promise : cachedRead(file),
  );
  const read = h.app.vault.read.bind(h.app.vault);
  let injected = false,
    blockedMetadata = false,
    rejectedUnchangedRead = false;
  vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
    if (file.path !== 'New.md') return await read(file);
    if (!injected) {
      injected = true;
      metadataChangedEmitter(h.app)(file, '', {});
      return await read(file);
    }
    if (!blockedMetadata) {
      blockedMetadata = true;
      return await metadataRead.promise;
    }
    return await read(file);
  });
  const reconcile = h.noteService.sources.reconcile.bind(h.noteService.sources);
  vi.spyOn(h.noteService.sources, 'reconcile').mockImplementation(async (...args) => {
    const accepted = await reconcile(...args);
    if (!accepted && !rejectedUnchangedRead) {
      rejectedUnchangedRead = true;
      createdLoad.resolve('');
      metadataRead.resolve('');
    }
    return accepted;
  });
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Requested prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  try {
    const saved = await h.notes.create(h.commit(plan));
    expect(rejectedUnchangedRead).toBe(true);
    expect(saved).toMatchObject({
      ok: true,
      receipt: { completion: 'complete', contentEffects: 'committed' },
    });
    expect(await h.read('New.md')).toBe('Requested prose');
    expect(await h.notes.create(h.commit(plan))).toEqual(saved);
  } finally {
    createdLoad.resolve('');
    metadataRead.resolve('');
    await flushMicrotasks();
  }
});

it.each(['stamp', 'replacement', 'meaning'] as const)(
  'does not recover blank reconciliation after a genuine %s change',
  async (changed) => {
    const h = await setup();
    const createdLoad = deferred<string>();
    const cachedRead = h.app.vault.cachedRead.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'cachedRead').mockImplementation((file) =>
      file.path === 'New.md' ? createdLoad.promise : cachedRead(file),
    );
    const read = h.app.vault.read.bind(h.app.vault);
    let injected = false;
    vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
      const content = await read(file);
      if (file.path === 'New.md' && !injected) {
        injected = true;
        if (changed === 'stamp') file.stat.mtime += 1;
        if (changed === 'meaning') h.index.updateIntegrationSemantics('during-blank-read');
        if (changed === 'replacement') {
          await h.app.vault.rename(file, 'Moved.md');
          await h.app.vault.create('New.md', '');
        }
      }
      return content;
    });
    const plan = ok(
      await h.notes.prepare({
        kind: 'create',
        path: 'New.md',
        title: 'New',
        text: 'Requested prose',
        templateExecution: { type: 'configured-templater' },
      }),
    );
    try {
      const saved = await h.notes.create(h.commit(plan));
      expect(injected).toBe(true);
      expect(saved).toMatchObject({
        ok: false,
        receipt: {
          completion: 'incomplete',
          noteEffects: 'committed',
          contentEffects: 'unchanged',
        },
      });
      expect(await h.read('New.md')).toBe('');
      expect(h.app.vault.getFileByPath('New 2.md')).toBeNull();
      expect(await h.notes.create(h.commit(plan))).toEqual(saved);
    } finally {
      createdLoad.resolve('');
      await flushMicrotasks();
    }
  },
);

function postProseMetadataRace(
  h: Awaited<ReturnType<typeof setup>>,
  afterRejected: (file: TFile) => void | Promise<void> = () => {},
) {
  const text = 'Requested prose';
  const metadataRead = deferred<string>();
  const read = h.app.vault.read.bind(h.app.vault);
  let forwarded = false,
    reconciling = false,
    injected = false,
    rejectedRead = false;
  const process = h.app.vault.process.bind(h.app.vault);
  const writes = vi.spyOn(h.app.vault, 'process').mockImplementation((file, callback) =>
    process(file, (live) => {
      const candidate = callback(live);
      forwarded = candidate === text;
      return candidate;
    }),
  );
  const reading = vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
    if (file.path !== 'New.md' || !forwarded) return await read(file);
    if (reconciling && !injected) {
      injected = true;
      metadataChangedEmitter(h.app)(file, text, {});
      return await read(file);
    }
    return await metadataRead.promise;
  });
  const reconcile = h.index.reconcileCommittedSource.bind(h.index);
  vi.spyOn(h.index, 'reconcileCommittedSource').mockImplementation(async (...args) => {
    const candidateRead = args[2] === text;
    reconciling = candidateRead;
    const accepted = await reconcile(...args);
    if (candidateRead && !accepted && !rejectedRead) {
      rejectedRead = true;
      const file = h.app.vault.getFileByPath('New.md');
      if (file === null) throw new Error('Missing written note');
      await afterRejected(file);
      metadataRead.resolve(text);
    }
    reconciling = false;
    return accepted;
  });
  return {
    text,
    writes,
    rejected: () => rejectedRead,
    release: async () => {
      metadataRead.resolve(text);
      await flushMicrotasks();
      reading.mockRestore();
    },
  };
}

it('verifies an acknowledged no-template prose write after its reconciliation is superseded by metadata', async () => {
  const h = await setup();
  const race = postProseMetadataRace(h);
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: race.text,
      templateExecution: { type: 'configured-templater' },
    }),
  );
  try {
    const saved = await h.notes.create(h.commit(plan));
    expect(race.rejected()).toBe(true);
    expect(saved).toMatchObject({
      ok: true,
      receipt: { completion: 'complete', contentEffects: 'committed' },
    });
    const reference = saved.receipt?.note;
    if (reference === undefined) throw new Error('Missing accepted readback');
    const readback = ok(
      await h.notes.read({
        selector: { target: reference.target, expectedRevision: reference.revision },
      }),
    );
    expect(readback.segments.map((segment) => segment.text).join('')).toBe(race.text);
    await race.release();
    expect(await h.read('New.md')).toBe(race.text);
    expect(race.writes).toHaveBeenCalledOnce();
    expect(await h.notes.create(h.commit(plan))).toEqual(saved);
    expect(race.writes).toHaveBeenCalledOnce();
  } finally {
    await race.release();
  }
});

it.each(['stamp', 'replacement', 'meaning', 'content'] as const)(
  'withholds acknowledged prose readback after a genuine %s change',
  async (changed) => {
    const h = await setup();
    const race = postProseMetadataRace(h, async (file) => {
      if (changed === 'stamp') file.stat.mtime += 1;
      if (changed === 'meaning') h.index.updateIntegrationSemantics('after-prose-acknowledgement');
      if (changed === 'content') await h.app.vault.modify(file, 'Concurrent content');
      if (changed === 'replacement') {
        await h.app.vault.rename(file, 'Moved.md');
        await h.app.vault.create('New.md', 'Requested prose');
      }
    });
    const plan = ok(
      await h.notes.prepare({
        kind: 'create',
        path: 'New.md',
        title: 'New',
        text: race.text,
        templateExecution: { type: 'configured-templater' },
      }),
    );
    try {
      const saved = await h.notes.create(h.commit(plan));
      expect(race.rejected()).toBe(true);
      expect(saved).toMatchObject({
        ok: false,
        error: { code: 'READBACK_UNAVAILABLE' },
        receipt: { completion: 'incomplete', contentEffects: 'committed' },
      });
      expect(saved.receipt?.note).toBeUndefined();
      expect(saved.receipt?.section).toBeUndefined();
      await race.release();
      expect(await h.read('New.md')).toBe(changed === 'content' ? 'Concurrent content' : race.text);
      expect(race.writes).toHaveBeenCalledOnce();
      expect(await h.notes.create(h.commit(plan))).toEqual(saved);
      expect(race.writes).toHaveBeenCalledOnce();
    } finally {
      await race.release();
    }
  },
);

it('does not bypass failed canonical task continuity to recover a template prose receipt', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  installTemplater(h.app, async () => '- [ ] Template task\n\nTrailing prose\n');
  const reconcile = h.index.reconcileCommittedSource.bind(h.index);
  vi.spyOn(h.index, 'reconcileCommittedSource').mockImplementation(async (...args) => {
    if (args[3] !== undefined && args[2].endsWith('Requested prose')) return false;
    return await reconcile(...args);
  });
  const writes = vi.spyOn(h.app.vault, 'process');
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'New.md',
      title: 'New',
      text: 'Requested prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const saved = await h.notes.create(h.commit(plan));
  expect(saved).toMatchObject({
    ok: false,
    error: { code: 'READBACK_UNAVAILABLE' },
    receipt: { completion: 'incomplete', contentEffects: 'committed' },
  });
  expect(saved.receipt?.note).toBeUndefined();
  expect(saved.receipt?.section).toBeUndefined();
  expect(await h.read('New.md')).toBe('- [ ] Template task\n\nTrailing prose\nRequested prose');
  expect(writes).toHaveBeenCalledTimes(2);
  expect(await h.notes.create(h.commit(plan))).toEqual(saved);
  expect(writes).toHaveBeenCalledTimes(2);
});

it('rechecks native destination after the final template read before provisioning', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  installTemplater(h.app);
  let root = true;
  Object.defineProperty(h.app.fileManager, 'getNewFileParent', {
    value: () => (root ? h.app.vault.getRoot() : h.app.vault.getFolderByPath('context')),
  });
  const plan = ok(await h.notes.prepare(request()));
  const read = h.app.vault.read.bind(h.app.vault);
  let reads = 0;
  const entered = deferred<void>(),
    release = deferred<void>();
  vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
    const result = await read(file);
    if (file.path === 'templates/default.md' && ++reads === 4) {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const create = vi.spyOn(h.app.vault, 'create');
  const writing = h.notes.create(h.commit(plan));
  await entered.promise;
  root = false;
  release.resolve();
  const result = await writing;
  expect(result).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(create).not.toHaveBeenCalled();
});

it('does not create a folder when the confirming consumer is disposed during its final template read', async () => {
  const h = await setup({ 'templates/default.md': '<% dynamic %>' });
  installTemplater(h.app);
  const client = h.client('folder-disposable');
  const notes = client.notes;
  if (notes === undefined) throw new Error('Missing notes');
  const plan = ok(
    await notes.prepare({
      kind: 'create',
      path: 'new/New.md',
      title: 'New',
      text: 'Agent prose',
      templateExecution: { type: 'configured-templater' },
    }),
  );
  const read = h.app.vault.read.bind(h.app.vault);
  const entered = deferred<void>(),
    release = deferred<void>();
  let reads = 0;
  vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
    const result = await read(file);
    if (file.path === 'templates/default.md' && ++reads === 3) {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const create = vi.spyOn(h.app.vault, 'create');
  const folders = vi.spyOn(h.app.vault, 'createFolder');
  const writing = notes.create(h.commit(plan));
  await entered.promise;
  client.dispose();
  release.resolve();
  const result = await writing;
  expect(result).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(create).not.toHaveBeenCalled();
  expect(folders).not.toHaveBeenCalled();
});
