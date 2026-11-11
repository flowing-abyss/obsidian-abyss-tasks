import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1, ProjectMutationResultV1, TasksApiV1 } from '../api';
import { CommandAgent } from '../src/ai/CommandAgent';
import { canonicalCommandPlan } from '../src/ai/commandReads';
import { projectCommandSnapshot } from '../src/ai/commandRecovery';
import { CommandSession } from '../src/ai/CommandSession';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';
import TaskCalendarPlugin from '../src/main';
import * as projectIntegration from '../src/projects/projectIntegration';
import { PANEL_VIEW_TYPE } from '../src/views/PanelView';
import {
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  metadataChangedEmitter,
  useRealMoment,
} from './helpers';
import { publicApiHarness } from './support/publicApiHarness';
import { scriptedWriteReview } from './support/scriptedWriteReview';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

function value<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function receipt(result: ProjectMutationResultV1) {
  if (!result.ok) throw new Error(result.error.code);
  return result.receipt;
}
const root = 'source.md';
const empty = 'projects/Empty.md';
const tree = '- [ ] Root\n  - [ ] Child';
async function setup(files: Record<string, string> = {}) {
  const app = await createAppWithFiles({ [root]: tree, [empty]: '', ...files });
  await app.vault.adapter.mkdir(`${app.vault.configDir}/plugins/abyss-tasks`);
  const plugin = new TaskCalendarPlugin(app, {
    id: 'abyss-tasks',
    name: 'Abyss Tasks',
    version: 'test',
  } as ConstructorParameters<typeof TaskCalendarPlugin>[1]);
  await plugin.onload();
  Object.assign(plugin.settings.projects, {
    membershipQuery: 'projects/',
    createFolder: 'projects',
    taskInsertionMode: 'prepend',
    propertyDefinitionsVersion: 1,
    propertyDefinitions: { 'property:budget': { type: 'number' } },
  });
  plugin.settings.taskPrefix = '';
  plugin.settings.taskLifecycle.addCreatedDate = false;
  await plugin.saveSettings();
  const client = () => value(plugin.getApi(1, { consumerId: 'consumer' }));
  const first = client();
  (app.workspace as unknown as { setLayoutReady__(): void }).setLayoutReady__();
  value(await first.ready());
  return { app, plugin, first, client };
}
function request(requestId: string) {
  return { requestId, expiresAt: Date.now() + 120_000 };
}
function basis(ref: { target: string; revision: string }) {
  return { target: ref.target, expectedRevision: ref.revision };
}

it('manages a project and its physical occurrences through main with the panel closed', async () => {
  const { app, plugin, first, client } = await setup();
  try {
    const other = client();
    const projects = expectDefined(first.projects);
    const peers = expectDefined(other.projects);
    const changes: number[] = [];
    value(first.subscribe((event) => changes.push(event.generation)));
    expect(first.info.capabilities).toEqual(
      expect.arrayContaining([
        'projects.read',
        'projects.schema',
        'projects.create',
        'projects.update',
        'projects.createTask',
        'projects.moveTask',
      ]),
    );
    expect(first.info.projectLimits?.maxProjectInputBytes).toBe(65_536);
    const schema = value(await projects.schema());
    const status = expectDefined(schema.statuses[1]);
    expect(schema.fields).toContainEqual(
      expect.objectContaining({ id: 'property:budget', writable: true }),
    );
    expect(value(await projects.resolve({ path: root })).type).toBe('not-found');
    const pre = value(await projects.list());
    expect(pre.items.map((item) => [item.path, item.stats.total])).toEqual([[empty, 0]]);
    const created = receipt(await projects.create({ ...request('project'), name: 'Launch' }));
    const target = expectDefined(created.project);
    const project = value(await peers.get(target.target));
    expect(value(await projects.resolve({ path: project.path }))).toMatchObject({
      type: 'found',
      project,
    });
    const edit = {
      ...request('edit'),
      ...basis(project),
      statusId: status.id,
      fields: [{ fieldId: 'property:budget', value: 0 }],
    };
    const edited = receipt(await peers.update(edit));
    const detail = value(await projects.get(target.target));
    expect(detail.status).toEqual({ state: 'configured', id: status.id });
    expect(detail.fields).toContainEqual({ fieldId: 'property:budget', state: 'value', value: 0 });
    const one = receipt(
      await projects.createTask({
        ...request('one'),
        ...basis(expectDefined(edited.project)),
        title: 'Duplicate',
      }),
    );
    const duplicate = {
      ...request('two'),
      ...basis(expectDefined(one.project)),
      title: 'Duplicate',
    };
    const [a, b] = await Promise.all([projects.createTask(duplicate), peers.createTask(duplicate)]);
    expect(a).toEqual(b);
    const two = receipt(a);
    const original = expectDefined(one.task),
      inserted = expectDefined(two.task);
    expect(original.target).not.toBe(inserted.target);
    const chosen = value(await other.tasks.get(inserted.target));
    expect(chosen.title).toBe('Duplicate');
    expect(chosen.source.line).toBeLessThan(
      value(await first.tasks.get(original.target)).source.line,
    );
    expect(await first.tasks.complete({ ...basis(chosen), ...request('two') })).toMatchObject({
      error: { code: 'REQUEST_ID_REUSED' },
    });
    expect(await first.tasks.complete({ ...basis(chosen), ...request('complete') })).toMatchObject({
      ok: true,
    });
    expect(
      value(await other.tasks.list({ path: project.path })).items.map((item) => item.status),
    ).toEqual(['done', 'open']);
    const [source, child] = value(await first.tasks.list({ path: root })).items;
    expect(child?.parentTarget).toBe(source?.target);
    const move = {
      ...request('move'),
      ...basis(value(await projects.get(target.target))),
      taskTarget: expectDefined(source).target,
      expectedTaskRevision: expectDefined(source).revision,
    };
    const moved = receipt(await peers.moveTask(move));
    expect(moved).toMatchObject({
      effects: 'committed',
      destinationCopy: 'committed',
      sourceRemoval: 'committed',
    });
    expect(await projects.moveTask(move)).toEqual({ ok: true, receipt: moved });
    expect(value(await first.tasks.list({ path: root })).items).toHaveLength(0);
    const tasks = value(await first.tasks.list({ path: project.path })).items;
    expect(
      value(await first.tasks.list({ path: project.path, statuses: ['done'] })).items.map(
        (item) => item.title,
      ),
    ).toEqual(['Duplicate']);
    expect(tasks.find((t) => t.title === 'Child')?.parentTarget).toBe(
      expectDefined(moved.task).target,
    );
    expect(value(await projects.get(target.target)).stats).toMatchObject({ total: 3, done: 1 });
    const page = value(await projects.list({ limit: 1 }));
    const last = value(await peers.list({ limit: 1, cursor: expectDefined(page.nextCursor) }));
    expect([page.items[0]?.path, last.items[0]?.path]).toEqual([empty, project.path]);
    expect(last.generation).toBe(changes[changes.length - 1]);
    expect(app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)).toHaveLength(0);
  } finally {
    plugin.onunload();
  }
});

it('rejects project task creation when the saved prefix turns a valid title into multiple lines', async () => {
  const h = await setup({ [empty]: tree });
  try {
    h.plugin.settings.taskPrefix = '#work\n- [ ] Extra';
    await h.plugin.saveSettings();
    const projects = expectDefined(h.first.projects);
    const project = expectDefined(value(await projects.list()).items[0]);
    const input = { ...basis(project), ...request('bad-prefix'), title: 'Ship' };
    const result = await projects.createTask(input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
      effects: 'unchanged',
      receipt: { requestId: input.requestId, outcome: 'failed', effects: 'unchanged' },
    });
    expect(result.receipt?.task).toBeUndefined();

    h.plugin.settings.taskPrefix = '';
    await h.plugin.saveSettings();
    expect(await expectDefined(h.client().projects).createTask(input)).toEqual(result);
    expect(await h.app.vault.adapter.read(empty)).toBe(tree);
  } finally {
    h.plugin.onunload();
  }
});

it.each(['folder', 'note'] as const)(
  'retains creation effects when the %s was written before failure',
  async (race) => {
    const h = await setup();
    try {
      const projects = expectDefined(h.first.projects);
      const { vault } = h.app;
      const folder = 'projects/new';
      h.plugin.settings.projects.createFolder = folder;
      const path = `${folder}/Report.md`;
      if (race === 'folder') {
        const createFolder = vault.createFolder.bind(vault);
        vi.spyOn(vault, 'createFolder').mockImplementationOnce(async (dir) => {
          const result = await createFolder(dir);
          h.plugin.settings.projects.membershipQuery = '#other';
          return result;
        });
      } else {
        await vault.createFolder(folder);
        const create = vault.create.bind(vault);
        vi.spyOn(vault, 'create').mockImplementationOnce(async (...args) => {
          await create(...args);
          throw new Error('lost note acknowledgement');
        });
      }
      const input = { ...request('create-failure'), name: 'Report' };
      const result = await projects.create(input);
      expect(result).toMatchObject({
        ok: false,
        effects: race === 'folder' ? 'partial' : 'unknown',
        recovery: 'reconcile',
        receipt: { outcome: 'failed' },
      });
      expect(result.receipt?.project).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(path);
      expect(await expectDefined(h.client().projects).create(input)).toEqual(result);
      expect(await vault.adapter.exists(folder)).toBe(true);
      expect(await vault.adapter.exists(path)).toBe(race === 'note');
    } finally {
      h.plugin.onunload();
    }
  },
);

it('shares pending request capacity across namespaces and admits a matching join while full', async () => {
  const h = await setup();
  const resume = deferred<void>();
  try {
    const projects = expectDefined(h.first.projects),
      other = h.client();
    const source = expectDefined(value(await other.tasks.list({ path: root })).items[0]);
    const project = expectDefined(value(await projects.list()).items[0]);
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, edit) => {
      await resume.promise;
      return process(file, edit);
    });
    const inputs = Array.from(
      { length: h.first.info.limits.maxPendingRequestsPerConsumer },
      (_, i) => ({
        ...basis(project),
        ...request(`pending-${i}`),
        title: 'once',
      }),
    );
    const pending = inputs.map((input) => projects.createTask(input));
    const join = expectDefined(other.projects).createTask(expectDefined(inputs[0]));
    const complete = { ...basis(source), ...request('task-after-full') };
    const rejected = await other.tasks.complete(complete);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_LIMIT' },
      effects: 'unchanged',
    });
    expect(rejected.receipt).toBeUndefined();
    resume.resolve();
    const settled = await Promise.all(pending);
    expect(await join).toEqual(settled[0]);
    expect(settled.filter((result) => result.ok)).toHaveLength(1);
    expect(await other.tasks.complete(complete)).toMatchObject({ ok: true });
  } finally {
    resume.resolve();
    h.plugin.onunload();
  }
});

it('opens the plugin and reads tasks without materializing project notes', async () => {
  const observed = vi.fn();
  const port = projectIntegration.createProjectIntegrationReads;
  vi.spyOn(projectIntegration, 'createProjectIntegrationReads').mockImplementation(
    (source, settings) => {
      return port(
        {
          ...source,
          get: (path) => {
            observed(path);
            return source.get(path);
          },
        },
        settings,
      );
    },
  );
  const h = await setup();
  try {
    expect(value(await h.first.tasks.list()).items).toHaveLength(2);
    expect(observed).not.toHaveBeenCalled();
    expect(value(await expectDefined(h.first.projects).list()).items).toHaveLength(1);
    expect(observed).toHaveBeenCalledWith(empty);
  } finally {
    h.plugin.onunload();
  }
  const legacy = await publicApiHarness({ [root]: tree });
  try {
    const client = legacy.client();
    expect(client.projects).toBeUndefined();
    expect(client.info.projectLimits).toBeUndefined();
    expect(client.info.capabilities.some((cap) => cap.startsWith('projects.'))).toBe(false);
    expect(value(await client.tasks.list()).items).toHaveLength(2);
  } finally {
    legacy.dispose();
  }
});

it('uses a summary proof for writes and receipt delivery even when detail exceeds the wire limit', async () => {
  const detail = vi.fn();
  const read = projectIntegration.createProjectIntegrationReads;
  vi.spyOn(projectIntegration, 'createProjectIntegrationReads').mockImplementation(
    (source, settings) => {
      const port = read(source, settings);
      const get = port.get.bind(port);
      vi.spyOn(port, 'get').mockImplementation((path) => {
        detail(path);
        return get(path);
      });
      return port;
    },
  );
  const h = await setup({ [empty]: `---\ndescription: ${'x'.repeat(270_000)}\n---\n` });
  try {
    const projects = expectDefined(h.first.projects);
    const project = expectDefined(value(await projects.list()).items[0]);
    expect(await projects.get(project.target)).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    expect(detail).toHaveBeenCalledTimes(1);
    const result = receipt(
      await projects.createTask({ ...basis(project), ...request('oversize'), title: 'Ship' }),
    );
    expect(result.project?.target).toBe(project.target);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(value(await h.first.tasks.get(expectDefined(result.task).target)).title).toBe('Ship');
  } finally {
    h.plugin.onunload();
  }
});

it('checks permission independently for each recipient and both references on replay', async () => {
  const h = await setup();
  const resume = deferred<void>();
  try {
    const projects = expectDefined(h.first.projects),
      peers = expectDefined(h.client().projects);
    const project = expectDefined(value(await projects.list()).items[0]);
    const input = { ...basis(project), ...request('once'), title: 'Private title' };
    const process = h.app.vault.process.bind(h.app.vault);
    const started = deferred<void>();
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
      started.resolve();
      await resume.promise;
      return process(file, transform);
    });
    const first = projects.createTask(input);
    await started.promise;
    const joined = peers.createTask(input);
    h.first.dispose();
    resume.resolve();
    const hidden = receipt(await first),
      live = receipt(await joined);
    expect(hidden.effects).toBe('committed');
    expect(hidden.project).toBeUndefined();
    expect(hidden.task).toBeUndefined();
    expect(live.project?.target).toBe(project.target);
    expect(live.task).toBeDefined();
    h.plugin.settings.projects.membershipQuery = '#other';
    await h.plugin.saveSettings();
    const taskOnly = receipt(await peers.createTask(input));
    expect(taskOnly.project).toBeUndefined();
    expect(taskOnly.task).toEqual(live.task);
    await h.plugin.saveTaskStorageSettings({
      taskArchivePath: h.plugin.settings.taskArchivePath,
      taskIgnoreQuery: 'projects/',
    });
    const revoked = receipt(await peers.createTask(input));
    expect(revoked).toEqual(hidden);
    expect(JSON.stringify(revoked)).not.toContain('Private title');
    expect(await h.app.vault.adapter.read(empty)).toBe('- [ ] Private title');
  } finally {
    resume.resolve();
    h.plugin.onunload();
  }
});

it('returns the original exact root for a same-project no-op, and rejects selecting its child', async () => {
  const h = await setup({ [empty]: tree });
  try {
    const projects = expectDefined(h.first.projects);
    const project = expectDefined(value(await projects.list()).items[0]);
    const [parent, child] = value(await h.first.tasks.list({ path: empty })).items;
    for (const [id, task] of [
      ['child', expectDefined(child)],
      ['root', expectDefined(parent)],
    ] as const) {
      const result = await projects.moveTask({
        ...basis(project),
        ...request(id),
        taskTarget: task.target,
        expectedTaskRevision: task.revision,
      });
      expect(result.receipt).toMatchObject({
        effects: 'unchanged',
        destinationCopy: 'unchanged',
        sourceRemoval: 'unchanged',
      });
      if (id === 'child')
        expect(result).toMatchObject({ ok: false, error: { category: 'unsupported' } });
      else
        expect(receipt(result)).toMatchObject({
          outcome: 'noop',
          task: { target: task.target, revision: task.revision },
        });
    }
    expect(await h.app.vault.adapter.read(empty)).toBe(tree);
  } finally {
    h.plugin.onunload();
  }
});

it('withholds a retained project-write task reference after metadata permission becomes unprovable', async () => {
  const body = '- [ ] Root';
  const h = await setup({ [empty]: ['---', 'secret: no', 'extra: one', '---', body].join('\n') });
  try {
    await h.plugin.saveTaskStorageSettings({
      taskArchivePath: h.plugin.settings.taskArchivePath,
      taskIgnoreQuery: 'secret=yes',
    });
    const projects = expectDefined(h.first.projects);
    const project = expectDefined(value(await projects.list()).items[0]);
    const task = expectDefined(value(await h.first.tasks.list({ path: empty })).items[0]);
    const input = {
      ...basis(project),
      ...request('move'),
      taskTarget: task.target,
      expectedTaskRevision: task.revision,
    };
    expect(receipt(await projects.moveTask(input)).task?.target).toBe(task.target);
    const file = expectDefined(h.app.vault.getFileByPath(empty));
    const next = ['---', 'secret: yes', 'extra: [', '---', body].join('\n');
    await h.app.vault.adapter.write(empty, next);
    file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
    const start = { line: 4, col: 0, offset: next.indexOf(body) };
    metadataChangedEmitter(h.app)(file, next, {
      listItems: [
        {
          task: ' ',
          parent: -1,
          position: {
            start,
            end: { ...start, col: body.length, offset: next.length },
          },
        },
      ],
    });
    await flushMicrotasks();
    expect(await projects.resolve({ path: empty })).toMatchObject({
      error: { code: 'INCOMPLETE_READ' },
    });
    const replay = receipt(await projects.moveTask(input));
    expect(replay).toMatchObject({ outcome: 'noop', effects: 'unchanged' });
    expect(replay.project).toBeUndefined();
    expect(replay.task).toBeUndefined();
  } finally {
    h.plugin.onunload();
  }
});

it.each(['changed source', 'lost removal ack', 'lost copy ack'] as const)(
  'reconciles two-file effects after %s without repeating either phase',
  async (race) => {
    const h = await setup();
    try {
      const projects = expectDefined(h.first.projects),
        peers = expectDefined(h.client().projects);
      const project = expectDefined(value(await projects.list()).items[0]);
      const source = expectDefined(value(await h.first.tasks.list({ path: root })).items[0]);
      const input = {
        ...basis(project),
        ...request('partial-move'),
        taskTarget: source.target,
        expectedTaskRevision: source.revision,
      };
      const process = h.app.vault.process.bind(h.app.vault);
      const spy = vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, edit) => {
        if (file.path === root && race === 'changed source')
          await h.app.vault.modify(file, `${tree}\n#external`);
        const result = await process(file, edit);
        if (
          (file.path === root && race === 'lost removal ack') ||
          (file.path === empty && race === 'lost copy ack')
        )
          throw new Error('private diagnostic');
        return result;
      });
      const result = await projects.moveTask(input);
      expect(result).toMatchObject({
        ok: false,
        effects: race === 'lost copy ack' ? 'unknown' : 'partial',
        recovery: 'reconcile',
        receipt: {
          destinationCopy: race === 'lost copy ack' ? 'unknown' : 'committed',
          sourceRemoval: race === 'lost removal ack' ? 'unknown' : 'unchanged',
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/private diagnostic|source\.md|Empty\.md|Child/u);
      const writes = spy.mock.calls.length;
      expect(await peers.moveTask(input)).toEqual(result);
      expect(spy).toHaveBeenCalledTimes(writes);
      expect(await h.app.vault.adapter.read(empty)).toBe(tree);
      expect((await h.app.vault.adapter.read(root)).includes('Child')).toBe(
        race !== 'lost removal ack',
      );
    } finally {
      h.plugin.onunload();
    }
  },
);

it.each(['status', 'field', 'membership'] as const)(
  'rejects changed %s inside the storage callback',
  async (change) => {
    const h = await setup();
    try {
      const projects = expectDefined(h.first.projects);
      const project = expectDefined(value(await projects.list()).items[0]);
      const schema = value(await projects.schema()),
        status = expectDefined(schema.statuses[0]);
      const process = h.app.vault.process.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce((file, edit) =>
        process(file, (live) => {
          if (change === 'status')
            expectDefined(h.plugin.settings.projects.statuses[0]).name = 'New meaning';
          if (change === 'field') h.plugin.settings.projects.propertyDefinitions = {};
          if (change === 'membership') h.plugin.settings.projects.membershipQuery = '#other';
          return edit(live);
        }),
      );
      const input = {
        ...basis(project),
        ...request('race'),
        statusId: status.id,
        fields: [{ fieldId: 'property:budget', value: 17 }],
      };
      expect(await projects.update(input)).toMatchObject({
        ok: false,
        receipt: { outcome: 'failed', effects: 'unchanged' },
      });
      expect(await h.app.vault.adapter.read(empty)).toBe('');
    } finally {
      h.plugin.onunload();
    }
  },
);

it.each(['resolve', 'list'] as const)(
  'withholds a delayed callback on the first project %s and verifies the installed note',
  async (method) => {
    const late = 'projects/Z.md';
    const h = await setup({ 'projects/B.md': '', [late]: '' });
    try {
      await h.plugin.saveTaskStorageSettings({
        taskArchivePath: h.plugin.settings.taskArchivePath,
        taskIgnoreQuery: 'secret=yes',
      });
      const projects = expectDefined(h.first.projects);
      const file = expectDefined(h.app.vault.getFileByPath(late));
      const emit = metadataChangedEmitter(h.app);
      const older = '---\nsecret: no\ndescription: public\n---\n';
      const privateNote = '---\nsecret: yes\n---\n'.padEnd(older.length);
      const events: number[] = [];
      value(h.first.subscribe((event) => events.push(event.generation)));
      const native = vi.spyOn(h.app.vault, 'read');
      const cached = vi.spyOn(h.app.vault, 'cachedRead');
      await h.app.vault.adapter.write(late, privateNote);
      file.stat = { ...file.stat, size: older.length, mtime: file.stat.mtime + 1 };
      emit(file, older, {});
      await flushMicrotasks();
      expect(native).not.toHaveBeenCalled();
      expect(cached).not.toHaveBeenCalled();
      const pending = deferred<string>();
      native.mockReturnValueOnce(pending.promise);
      // Z sorts after both the requested page and its lookahead.
      const result =
        method === 'resolve'
          ? await projects.resolve({ path: late })
          : await projects.list({ limit: 1 });
      expect(result).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_READ' } });
      expect(await projects.resolve({ path: empty })).toMatchObject({
        ok: true,
        value: { type: 'found' },
      });
      expect(await projects.resolve({ path: late })).toMatchObject({ ok: false });
      expect(native.mock.calls.map(([f]) => f.path)).toEqual([late]);
      const before = events.length;
      pending.resolve(privateNote);
      await flushMicrotasks();
      expect(events.length).toBeGreaterThan(before);
      expect(await projects.resolve({ path: late })).toMatchObject({
        ok: true,
        value: { type: 'not-found' },
      });
      expect(value(await projects.list()).items.map((p) => p.path)).toEqual([
        'projects/B.md',
        empty,
      ]);
      native.mockClear();
      await h.app.vault.adapter.write(late, older);
      file.stat = { ...file.stat, mtime: file.stat.mtime + 1 };
      emit(file, older, {});
      await flushMicrotasks();
      expect(await projects.resolve({ path: late })).toMatchObject({
        ok: true,
        value: { type: 'found' },
      });
      expect(native).toHaveBeenCalledTimes(1);
      emit(file, older, {});
      await flushMicrotasks();
      expect(native).toHaveBeenCalledTimes(1);
    } finally {
      h.plugin.onunload();
    }
  },
);

it('reports the same effective default as headless project creation', async () => {
  const h = await setup();
  try {
    const projects = expectDefined(h.first.projects);
    h.plugin.settings.projects.defaultStatusId = '';
    const schema = value(await projects.schema());
    const created = receipt(await projects.create({ ...request('default'), name: 'Default' }));
    const actual = value(await projects.get(expectDefined(created.project).target)).status;
    expect(actual).toEqual({ state: 'configured', id: expectDefined(schema.statuses[0]).id });
    expect(schema.defaultStatusId).toEqual(expectDefined(schema.statuses[0]).id);
    h.plugin.settings.projects.defaultStatusId = 'removed-id';
    expect(value(await projects.schema()).defaultStatusId).toBeUndefined();
    expect(await projects.create({ ...request('removed'), name: 'Removed' })).toMatchObject({
      ok: false,
      receipt: { effects: 'unchanged' },
    });
  } finally {
    h.plugin.onunload();
  }
});

it('prepares structured project task trees through the existing guarded destination and rejects stale proofs', async () => {
  const { app, plugin, first } = await setup();
  try {
    const projects = expectDefined(first.projects),
      project = expectDefined(value(await projects.list()).items[0]);
    const prepare = expectDefined(first.tasks.prepare),
      create = expectDefined(first.tasks.create);
    const plan = value(
      await prepare({
        kind: 'create',
        destination: {
          type: 'project',
          target: project.target,
          expectedRevision: project.revision,
        },
        tree: {
          markdownTitle: 'Prepared',
          children: [{ markdownTitle: 'Nested', description: 'Details' }],
        },
      }),
    );
    expect(plan.destination).toMatchObject({
      type: 'project',
      path: empty,
      insertion: { type: 'prepend' },
    });
    expect(value(await first.tasks.list({ path: empty })).items).toEqual([]);
    const saved = await create({
      ...request('prepared-project'),
      plan: plan.target,
      expectedPlanRevision: plan.revision,
    });
    expect(saved).toMatchObject({
      ok: true,
      receipt: { effects: 'committed', snapshots: 'complete' },
    });
    expect(value(await first.tasks.list({ path: empty })).items.map((task) => task.title)).toEqual([
      'Prepared',
      'Nested',
    ]);
    expect(
      await prepare({
        kind: 'create',
        destination: {
          type: 'project',
          target: project.target,
          expectedRevision: project.revision,
        },
        tree: { markdownTitle: 'Stale' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const fresh = value(await projects.get(project.target));
    const pending = value(
      await prepare({
        kind: 'create',
        destination: { type: 'project', target: fresh.target, expectedRevision: fresh.revision },
        tree: { markdownTitle: 'Pending' },
      }),
    );
    plugin.settings.projects.taskInsertionMode = 'append';
    expect(
      await prepare({
        kind: 'refresh',
        plan: pending.target,
        expectedPlanRevision: pending.revision,
      }),
    ).toMatchObject({ ok: false });
    expect(app.vault.getAbstractFileByPath(empty)).toBeDefined();
  } finally {
    plugin.onunload();
  }
});

it.each([false, true])(
  'sequences a reviewed duplicate-root task edit after project metadata; external race=%s',
  async (race) => {
    const path = 'projects/Duplicates.md',
      body = '- [ ] Same\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n';
    const { app, plugin, first } = await setup({ [path]: body });
    try {
      const projects = expectDefined(first.projects),
        project = expectDefined(value(await projects.list()).items.find((p) => p.path === path));
      const before = value(await projects.get(project.target));
      const roots = value(await first.tasks.list({ path })).items.filter(
        (t) => t.parentTarget === undefined,
      );
      const second = expectDefined(roots[1]);
      const tree = value(await expectDefined(first.tasks.tree)({ target: second.target }));
      const child = expectDefined(tree.tree.children[0]);
      const plan = value(
        await expectDefined(first.tasks.prepare)({
          kind: 'edit',
          target: second.target,
          expectedRevision: second.revision,
          operation: {
            type: 'patch',
            target: child.target,
            patch: { markdownTitle: { type: 'set', value: 'Only second' } },
          },
        }),
      );
      const api = {
        ...first,
        projects: {
          ...projects,
          update: async (input: Parameters<typeof projects.update>[0]) => {
            const result = await projects.update(input);
            if (race) {
              const file = expectDefined(app.vault.getFileByPath(path));
              const text = (await app.vault.read(file)).replace(
                '  - [ ] Child',
                '  - [ ] External',
              );
              await app.vault.modify(file, text);
              metadataChangedEmitter(app)(file, text, {});
              await flushMicrotasks();
            }
            return result;
          },
        },
      };
      const session = new CommandSession({
        api,
        agent: { run: async () => {} },
        journal: { save: async () => {} },
        now: () => Date.now(),
        id: () => crypto.randomUUID(),
      });
      expect(
        await session.focus([
          { kind: 'project', target: before.target, revision: before.revision },
          { kind: 'task', target: child.target, revision: child.revision },
        ]),
      ).toBe(true);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(path)))).toBe(body);
      session.stage({ kind: 'task', plan });
      session.stage({
        kind: 'project',
        before,
        fields: [{ fieldId: 'property:budget', value: 7 }],
      });
      await session.confirm();
      const content = await app.vault.read(expectDefined(app.vault.getFileByPath(path)));
      expect(content).toContain('budget: 7');
      if (race) {
        expect(content).toContain('External');
        expect(content).not.toContain('Only second');
        expect(session.snapshot().status.kind).toBe('error');
      } else {
        expect(content).toContain('- [ ] Same\n  - [ ] Child\n- [ ] Same\n  - [ ] Only second');
        expect(session.snapshot().status.kind).toBe('saved');
        expect(session.snapshot().focus).toEqual([
          {
            kind: 'project',
            target: before.target,
            revision: value(await projects.get(before.target)).revision,
          },
          {
            kind: 'task',
            target: child.target,
            revision: value(await first.tasks.get(child.target)).revision,
          },
        ]);
        expect(
          session.snapshot().entities.projects.find((p) => p.target === before.target),
        ).toEqual(value(await projects.get(before.target)));
      }
    } finally {
      plugin.onunload();
    }
  },
);

it('holds a reviewed deep edit when a descendant changes after the project receipt', async () => {
  const path = 'projects/Deep.md';
  const { app, plugin, first } = await setup({
    [path]: '- [ ] Root\n  - [ ] Child\n    - [ ] Deep\n',
  });
  try {
    const projects = expectDefined(first.projects),
      project = expectDefined(value(await projects.list()).items.find((p) => p.path === path)),
      before = value(await projects.get(project.target)),
      root = expectDefined(
        value(await first.tasks.list({ path })).items.find((t) => t.title === 'Root'),
      ),
      prepare = expectDefined(first.tasks.prepare);
    const plan = value(
      await prepare({
        kind: 'edit',
        target: root.target,
        expectedRevision: root.revision,
        operation: {
          type: 'patch',
          target: root.target,
          patch: { markdownTitle: { type: 'set', value: 'Reviewed root' } },
        },
      }),
    );
    const canonical = await canonicalCommandPlan(first, plan, new AbortController().signal, {
      now: () => Date.now(),
      deadline: Date.now() + 5000,
    });
    let injected = false;
    const api = {
      ...first,
      tasks: {
        ...first.tasks,
        prepare: async (...args: Parameters<typeof prepare>) => {
          if (args[0].kind === 'refresh' && !injected) {
            injected = true;
            const file = expectDefined(app.vault.getFileByPath(path));
            const text = (await app.vault.read(file)).replace(
              '    - [ ] Deep',
              '    - [ ] External deep',
            );
            await app.vault.modify(file, text);
            metadataChangedEmitter(app)(file, text, {});
            await flushMicrotasks();
          }
          return prepare(...args);
        },
      },
    };
    const session = new CommandSession({
      api,
      agent: { run: async () => {} },
      journal: { save: async () => {} },
      now: () => Date.now(),
      id: () => crypto.randomUUID(),
    });
    session.stage({ kind: 'task', plan: canonical });
    session.stage({ kind: 'project', before, fields: [{ fieldId: 'property:budget', value: 7 }] });
    expect(await session.confirm()).toBe(false);
    expect(injected).toBe(true);
    expect(session.snapshot().status.kind).toBe('error');
    expect(session.snapshot().proposal.changes.find((change) => change.kind === 'task')).toEqual({
      kind: 'task',
      plan: canonical,
    });
    const text = await app.vault.read(expectDefined(app.vault.getFileByPath(path)));
    expect(text).toContain('budget: 7');
    expect(text).toContain('External deep');
    expect(text).not.toContain('Reviewed root');
  } finally {
    plugin.onunload();
  }
});

function projectCommandSession(api: TasksApiV1) {
  const saved: CommandSessionSnapshot[] = [];
  const steps: Array<{ toolName: string; input: unknown }> = [];
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = expectDefined(steps.shift());
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: crypto.randomUUID(),
            toolName: step.toolName,
            input: JSON.stringify(step.input),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const session: CommandSession = new CommandSession({
    api,
    journal: {
      save: async (snapshot) => {
        saved.push(snapshot);
      },
    },
    agent: { run: async (input) => agent.run(input) },
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
  });
  const agent: CommandAgent = new CommandAgent({
    reviewWrite: scriptedWriteReview,
    api,
    session,
    connections: { model: () => model },
    settings: () => ({}),
    now: () => Date.now(),
  });
  return {
    session,
    saved,
    confirmLimited: async () => {
      steps.push({
        toolName: 'interpret',
        input: {
          intent: 'confirm',
          approval: 'Save only this move',
          research: false,
          scope: {
            proposalRevision: session.snapshot().proposal.revision,
            changes: [{ kind: 'change', index: 0 }],
          },
        },
      });
      await session.submit('Save only this move');
    },
    select: (selection: unknown, transitionDisposition?: 'keep') =>
      steps.push(
        {
          toolName: 'interpret',
          input: { intent: 'plan', research: false, transitionDisposition },
        },
        { toolName: 'finish', input: { state: 'ready', message: 'Ready.', selection } },
      ),
    turn: (input: unknown) =>
      steps.push(
        { toolName: 'interpret', input: { intent: 'plan', research: false } },
        { toolName: 'expand', input: { capabilities: ['project'] } },
        { toolName: 'project', input },
        { toolName: 'finish', input: { state: 'ready', message: 'Ready.' } },
      ),
  };
}

it('composes project fields and status over two real SDK turns before one guarded commit', async () => {
  const path = 'projects/Compose.md';
  const { app, plugin, first } = await setup({ [path]: '- [ ] Existing\n' });
  try {
    const projects = expectDefined(first.projects);
    const project = expectDefined(
      value(await projects.list()).items.find((item) => item.path === path),
    );
    const before = value(await projects.get(project.target));
    const status = expectDefined(value(await projects.schema()).statuses[1]);
    const { session, turn } = projectCommandSession(first);
    turn({ ...basis(before), fields: [{ fieldId: 'start', value: '2026-11-09' }] });
    await session.submit('Set its start date');
    expect(session.snapshot().status.kind).toBe('ready');
    turn({
      ...basis(before),
      fields: [{ fieldId: 'property:budget', value: 7 }],
      statusId: status.id,
    });
    await session.submit('Also change its status');
    expect(session.snapshot().status.kind).toBe('ready');
    expect(session.snapshot().proposal.changes).toEqual([
      {
        kind: 'project',
        before,
        fields: [
          { fieldId: 'start', value: '2026-11-09' },
          { fieldId: 'property:budget', value: 7 },
        ],
        statusId: status.id,
      },
    ]);
    expect(await app.vault.read(expectDefined(app.vault.getFileByPath(path)))).toBe(
      '- [ ] Existing\n',
    );
    expect(await session.confirm()).toBe(true);
    const current = value(await projects.get(before.target));
    expect(current.fields).toContainEqual({ fieldId: 'property:budget', state: 'value', value: 7 });
    expect(current.fields).toContainEqual({
      fieldId: 'start',
      state: 'value',
      value: '2026-11-09',
    });
    expect(current.status).toEqual({ state: 'configured', id: status.id });
  } finally {
    plugin.onunload();
  }
});

it('composes explicit project clears and refuses a changed accepted basis without dropping pending edits', async () => {
  const { plugin, first } = await setup();
  try {
    const projects = expectDefined(first.projects);
    const before = value(
      await projects.get(expectDefined(value(await projects.list()).items[0]).target),
    );
    const status = expectDefined(value(await projects.schema()).statuses[1]);
    const { session } = projectCommandSession(first);
    session.stage({
      kind: 'project',
      before,
      fields: [{ fieldId: 'property:budget', value: 7 }],
      statusId: status.id,
    });
    session.stage({
      kind: 'project',
      before,
      fields: [{ fieldId: 'property:budget', value: null }],
    });
    expect(session.snapshot().proposal.changes).toEqual([
      {
        kind: 'project',
        before,
        fields: [{ fieldId: 'property:budget', value: null }],
        statusId: status.id,
      },
    ]);
    session.stage({ kind: 'project', before, statusId: null });
    const pending = session.snapshot().proposal;
    expect(pending.changes).toEqual([
      {
        kind: 'project',
        before,
        fields: [{ fieldId: 'property:budget', value: null }],
        statusId: null,
      },
    ]);
    receipt(
      await projects.update({
        ...basis(before),
        ...request('external'),
        fields: [{ fieldId: 'property:budget', value: 12 }],
      }),
    );
    const newer = value(await projects.get(before.target));
    expect(() => {
      session.stage({ kind: 'project', before: newer, statusId: status.id });
    }).toThrow('changed');
    expect(session.snapshot().proposal).toEqual(pending);
  } finally {
    plugin.onunload();
  }
});

it('previews and refines project creation through the SDK before one native create and exact focus', async () => {
  const { app, plugin, first } = await setup();
  try {
    const projects = expectDefined(first.projects);
    const create = vi.fn(projects.create);
    const { session, turn } = projectCommandSession({
      ...first,
      projects: { ...projects, create },
    });
    turn({ kind: 'create', name: 'Launch', fields: [{ fieldId: 'start', value: '2026-11-09' }] });
    await session.submit('Create a project');
    expect(session.snapshot().status.kind).toBe('ready');
    expect(create).not.toHaveBeenCalled();
    expect(app.vault.getFileByPath('projects/Launch.md')).toBeNull();
    const pending = expectDefined(session.snapshot().proposal.changes[0]);
    expect(pending.kind).toBe('project-create');
    if (pending.kind !== 'project-create') throw new Error('Missing project proposal');
    expect(pending).not.toHaveProperty('before');
    expect(projectCommandSnapshot(session.snapshot())).toEqual(session.snapshot());
    turn({
      kind: 'refine-create',
      proposal: pending.id,
      fields: [{ fieldId: 'end', value: '2026-11-12' }],
    });
    await session.submit('Also set the end date');
    expect(session.snapshot().status.kind).toBe('ready');
    expect(await session.confirm()).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const current = value(await projects.get(expectDefined(session.snapshot().focus[0]).target));
    expect(current.name).toBe('Launch');
    expect(current.fields).toEqual(
      expect.arrayContaining([
        { fieldId: 'start', state: 'value', value: '2026-11-09' },
        { fieldId: 'end', state: 'value', value: '2026-11-12' },
      ]),
    );
    expect(session.snapshot().entities.projects).toContainEqual(current);
  } finally {
    plugin.onunload();
  }
});

it.each([
  { fields: [{ fieldId: 'property:budget', value: 'seven' }] },
  {
    fields: [
      { fieldId: 'start', value: '2026-11-12' },
      { fieldId: 'end', value: '2026-11-09' },
    ],
  },
  { statusId: 'unconfigured' },
])('rejects invalid project creation before admission: %j', async (invalid) => {
  const { plugin, first } = await setup();
  try {
    const projects = expectDefined(first.projects);
    const create = vi.fn(projects.create);
    const { session, turn } = projectCommandSession({
      ...first,
      projects: { ...projects, create },
    });
    turn({ kind: 'create', name: 'Invalid', ...invalid });
    await session.submit('Create this project');
    expect(session.snapshot().status.kind).toBe('error');
    expect(session.snapshot().proposal.changes).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  } finally {
    plugin.onunload();
  }
});

it('previews an explicit project membership move and preserves its complete native subtree', async () => {
  const authored =
    '- [ ] Same 📅 2026-11-12\n  - > Description [[Guide]]\n  - [ ] Same\n    - [ ] Deep #kept\n';
  const { app, plugin, first } = await setup({ [root]: authored });
  try {
    const projects = expectDefined(first.projects);
    const destination = value(
      await projects.get(
        expectDefined(value(await projects.list()).items.find((p) => p.path === empty)).target,
      ),
    );
    const source = expectDefined(
      value(await first.tasks.list({ path: root })).items.find((t) => t.parentTarget === undefined),
    );
    const move = vi.fn(projects.moveTask);
    const { session, turn } = projectCommandSession({
      ...first,
      projects: { ...projects, moveTask: move },
    });
    await session.focus([{ kind: 'task', target: source.target, revision: source.revision }]);
    turn({
      kind: 'move-task',
      ...basis(destination),
      taskTarget: source.target,
      expectedTaskRevision: source.revision,
    });
    await session.submit('Move this task into the project');
    expect(session.snapshot().status.kind).toBe('ready');
    expect(move).not.toHaveBeenCalled();
    expect(session.snapshot().proposal.changes[0]?.kind).toBe('project-move');
    expect(projectCommandSnapshot(session.snapshot())).toEqual(session.snapshot());
    expect(await app.vault.read(expectDefined(app.vault.getFileByPath(root)))).toBe(authored);
    expect(await session.confirm()).toBe(true);
    expect(move).toHaveBeenCalledTimes(1);
    expect(await app.vault.read(expectDefined(app.vault.getFileByPath(empty)))).toContain(
      authored.trimEnd(),
    );
    const focused = value(await first.tasks.get(expectDefined(session.snapshot().focus[0]).target));
    expect(focused.source.path).toBe(empty);
  } finally {
    plugin.onunload();
  }
});

it('retains requested project values on a changed schema with truthful unchanged effects', async () => {
  const { plugin, first } = await setup();
  try {
    const projects = expectDefined(first.projects),
      create = vi.fn(projects.create);
    const { session, turn } = projectCommandSession({
      ...first,
      projects: { ...projects, create },
    });
    turn({ kind: 'create', name: 'Retained', fields: [{ fieldId: 'property:budget', value: 7 }] });
    await session.submit('Prepare a project');
    const proposal = session.snapshot().proposal;
    plugin.settings.projects.defaultStatusId = expectDefined(
      value(await projects.schema()).statuses[1],
    ).id;
    await plugin.saveSettings();
    expect(await session.confirm()).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(session.snapshot().proposal).toEqual(proposal);
    expect(session.snapshot().journal[0]?.effects).toBe('unchanged');
    expect(session.snapshot().status.message).toContain('not saved');
    expect(session.snapshot().status.message).not.toContain('partly');
  } finally {
    plugin.onunload();
  }
});

it('never duplicates project creation after an admitted result is lost', async () => {
  const { app, plugin, first } = await setup();
  try {
    let accepted: ProjectMutationResultV1 | undefined;
    const projects = expectDefined(first.projects),
      create = vi.fn(async (...args: Parameters<typeof projects.create>) => {
        accepted = await projects.create(...args);
        throw new Error('Lost response after admission');
      });
    const { session, turn } = projectCommandSession({
      ...first,
      projects: { ...projects, create },
    });
    turn({ kind: 'create', name: 'Exactly once' });
    await session.submit('Prepare a project');
    expect(await session.confirm()).toBe(false);
    expect(await session.confirm()).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(session.snapshot().blocked).toBe(true);
    expect(session.snapshot().journal[0]?.effects).toBe('unknown');
    expect(session.snapshot().status.kind).toBe('error');
    expect(accepted).toMatchObject({ ok: true });
    expect(
      app.vault.getMarkdownFiles().filter((f) => f.path.includes('Exactly once')),
    ).toHaveLength(1);
  } finally {
    plugin.onunload();
  }
});

it('retains selected descendant context and overlapping drafts rather than guessing project-move correspondence', async () => {
  const { plugin, first } = await setup();
  try {
    const projects = expectDefined(first.projects),
      items = value(await first.tasks.list({ path: root })).items;
    const source = expectDefined(items.find((t) => t.parentTarget === undefined)),
      child = expectDefined(items.find((t) => t.parentTarget !== undefined));
    const destination = value(
      await projects.get(expectDefined(value(await projects.list()).items[0]).target),
    );
    const { session, turn } = projectCommandSession(first);
    await session.focus({ kind: 'task', target: child.target, revision: child.revision });
    turn({
      kind: 'move-task',
      ...basis(destination),
      taskTarget: source.target,
      expectedTaskRevision: source.revision,
    });
    await session.submit('Move the root');
    expect(session.snapshot().status.kind).toBe('error');
    expect(session.snapshot().focus[0]?.target).toBe(child.target);
    expect(session.snapshot().proposal.changes).toEqual([]);
    const pending = value(
      await expectDefined(first.tasks.prepare)({
        kind: 'edit',
        ...basis(source),
        operation: { type: 'description', target: source.target, text: 'Retained' },
      }),
    );
    session.stage({
      kind: 'task',
      plan: await canonicalCommandPlan(first, pending, new AbortController().signal, {
        now: () => Date.now(),
        deadline: Date.now() + 5000,
      }),
    });
    const previous = session.snapshot().proposal;
    const page = value(await expectDefined(first.tasks.tree)({ target: source.target }));
    expect(() => {
      session.stage({ kind: 'project-move', before: page.tree, destination });
    }).toThrow('retained');
    expect(session.snapshot().proposal).toEqual(previous);
  } finally {
    plugin.onunload();
  }
});

it.each(['single', 'mixed', 'sdk'] as const)(
  'retains a late project-move descendant focus conflict (%s)',
  async (mode) => {
    const authored = '- [ ] Same\n  - [ ] Same\n    - Kept [[Guide]]\n  - [ ] Same\n';
    const { app, plugin, first } = await setup({ [root]: authored });
    try {
      const projects = expectDefined(first.projects);
      const destination = value(
        await projects.get(
          expectDefined(value(await projects.list()).items.find((p) => p.path === empty)).target,
        ),
      );
      const source = expectDefined(
        value(await first.tasks.list({ path: root })).items.find(
          (t) => t.parentTarget === undefined,
        ),
      );
      const tree = value(await expectDefined(first.tasks.tree)({ target: source.target })).tree;
      const child = expectDefined(tree.children[0]);
      const rootFocus = { kind: 'task' as const, target: source.target, revision: source.revision };
      const childFocus = { kind: 'task' as const, target: child.target, revision: child.revision };
      const move = vi.fn(projects.moveTask);
      const { session, turn, select, saved, confirmLimited } = projectCommandSession({
        ...first,
        projects: { ...projects, moveTask: move },
      });
      expect(await session.focus(rootFocus)).toBe(true);
      turn({
        kind: 'move-task',
        ...basis(destination),
        taskTarget: source.target,
        expectedTaskRevision: source.revision,
      });
      await session.submit('Move this root');
      expect(session.snapshot().status.kind, session.snapshot().status.message).toBe('ready');
      expect(session.snapshot().proposal.changes).toMatchObject([
        {
          kind: 'project-move',
          before: { target: source.target },
          destination: { target: destination.target },
        },
      ]);
      const changes = session.snapshot().proposal.changes;
      const originalId = session.snapshot().id;
      const historyCount = saved.length;
      const destinationBefore = await app.vault.read(expectDefined(app.vault.getFileByPath(empty)));
      if (mode === 'sdk') {
        select([rootFocus, childFocus]);
        await session.submit('Select the child too');
      } else
        expect(await session.focus(mode === 'mixed' ? [rootFocus, childFocus] : childFocus)).toBe(
          false,
        );
      expect(session.snapshot().focus).toEqual([rootFocus]);
      expect(session.snapshot().proposal.changes).toEqual(changes);
      expect(session.snapshot().status.message).toMatch(/root/i);
      expect(session.snapshot().pendingTransition).toMatchObject({ kind: 'focus' });
      await session.submit('');
      expect(await session.resolveTransition('save')).toBe(false);
      session.answer();
      session.status('ready', 'Attempted generic answer');
      expect(await session.confirm()).toBe(false);
      session.answer();
      session.status('ready', 'Attempted limited answer');
      await confirmLimited();
      expect(session.snapshot().status.kind).toBe('question');
      expect(move).not.toHaveBeenCalled();
      expect(session.snapshot().journal).toEqual([]);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(root)))).toBe(authored);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(empty)))).toBe(
        destinationBefore,
      );
      if (mode === 'sdk') {
        select(undefined);
        await session.submit('Inspect the retained proposal');
        expect(session.snapshot().status.kind).toBe('question');
        expect(session.snapshot().status.message).toMatch(/root/i);
        expect(await session.confirm()).toBe(false);
        select([rootFocus]);
        await session.submit('Return to the saved root');
      } else expect(await session.focus(rootFocus)).toBe(true);
      expect(session.snapshot().pendingTransition).toBeNull();
      expect(session.snapshot().id).toBe(originalId);
      expect(session.snapshot().proposal.changes).toEqual(changes);
      expect(saved).toHaveLength(historyCount);
      expect(await session.confirm()).toBe(true);
      expect(move).toHaveBeenCalledTimes(1);
      expect(session.snapshot().status.kind).toBe('saved');
      const moved = value(await first.tasks.get(expectDefined(session.snapshot().focus[0]).target));
      expect(moved.source.path).toBe(empty);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(empty)))).toContain(
        authored.trimEnd(),
      );
    } finally {
      plugin.onunload();
    }
  },
);

it.each(['whole', 'limited'] as const)(
  'rechecks current project-move descendant focus before %s write admission',
  async (mode) => {
    const authored = '- [ ] Root\n  - [ ] Child\n';
    const { app, plugin, first } = await setup({ [root]: authored });
    try {
      const projects = expectDefined(first.projects);
      const destination = value(
        await projects.get(
          expectDefined(value(await projects.list()).items.find((p) => p.path === empty)).target,
        ),
      );
      const source = expectDefined(
        value(await first.tasks.list({ path: root })).items.find(
          (t) => t.parentTarget === undefined,
        ),
      );
      const tree = value(await expectDefined(first.tasks.tree)({ target: source.target })).tree;
      const child = expectDefined(tree.children[0]);
      const move = vi.fn(projects.moveTask);
      const { session, confirmLimited } = projectCommandSession({
        ...first,
        projects: { ...projects, moveTask: move },
      });
      expect(
        await session.focus({ kind: 'task', target: child.target, revision: child.revision }),
      ).toBe(true);
      session.stage({ kind: 'project-move', before: tree, destination });
      const changes = session.snapshot().proposal.changes;
      if (mode === 'whole') expect(await session.confirm()).toBe(false);
      else await confirmLimited();
      expect(move).not.toHaveBeenCalled();
      expect(session.snapshot().journal).toEqual([]);
      expect(session.snapshot().blocked).toBe(false);
      expect(session.snapshot().proposal.changes).toEqual(changes);
      expect(session.snapshot().focus[0]?.target).toBe(child.target);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(root)))).toBe(authored);
      expect(
        await session.focus({ kind: 'task', target: source.target, revision: source.revision }),
      ).toBe(true);
      if (mode === 'whole') expect(await session.confirm()).toBe(true);
      else await confirmLimited();
      expect(move).toHaveBeenCalledTimes(1);
      expect(session.snapshot().status.kind).toBe('saved');
    } finally {
      plugin.onunload();
    }
  },
);

it.each(['cancel', 'keep', 'discard'] as const)(
  'keeps project-move conflict disposition %s usable without saving',
  async (disposition) => {
    const authored = '- [ ] Root\n  - [ ] Child\n';
    const { app, plugin, first } = await setup({ [root]: authored });
    try {
      const projects = expectDefined(first.projects);
      const destination = value(
        await projects.get(
          expectDefined(value(await projects.list()).items.find((p) => p.path === empty)).target,
        ),
      );
      const source = expectDefined(
        value(await first.tasks.list({ path: root })).items.find(
          (t) => t.parentTarget === undefined,
        ),
      );
      const child = expectDefined(
        value(await expectDefined(first.tasks.tree)({ target: source.target })).tree.children[0],
      );
      const move = vi.fn(projects.moveTask);
      const { session, turn, select, saved } = projectCommandSession({
        ...first,
        projects: { ...projects, moveTask: move },
      });
      expect(
        await session.focus({ kind: 'task', target: source.target, revision: source.revision }),
      ).toBe(true);
      turn({
        kind: 'move-task',
        ...basis(destination),
        taskTarget: source.target,
        expectedTaskRevision: source.revision,
      });
      await session.submit('Move this root');
      expect(session.snapshot().status.kind, session.snapshot().status.message).toBe('ready');
      expect(session.snapshot().proposal.changes).toMatchObject([
        {
          kind: 'project-move',
          before: { target: source.target },
          destination: { target: destination.target },
        },
      ]);
      const previous = session.snapshot();
      const destinationBefore = await app.vault.read(expectDefined(app.vault.getFileByPath(empty)));
      expect(
        await session.focus({ kind: 'task', target: child.target, revision: child.revision }),
      ).toBe(false);
      if (disposition === 'keep') {
        select([{ kind: 'task', target: source.target, revision: source.revision }], 'keep');
        await session.submit('Keep the draft in history and leave this session');
      } else expect(await session.resolveTransition(disposition)).toBe(true);
      expect(session.snapshot().pendingTransition == null).toBe(true);
      expect(move).not.toHaveBeenCalled();
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(root)))).toBe(authored);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(empty)))).toBe(
        destinationBefore,
      );
      if (disposition === 'cancel') {
        expect(session.snapshot().id).toBe(previous.id);
        expect(session.snapshot().proposal.changes).toEqual(previous.proposal.changes);
        expect(session.snapshot().focus[0]?.target).toBe(source.target);
        expect(await session.confirm()).toBe(true);
        expect(move).toHaveBeenCalledTimes(1);
      } else {
        expect(session.snapshot().id).not.toBe(previous.id);
        expect(session.snapshot().focus[0]?.target).toBe(
          disposition === 'keep' ? source.target : child.target,
        );
        expect(session.snapshot().proposal.changes).toEqual([]);
        const archived = expectDefined(saved.find((snapshot) => snapshot.id === previous.id));
        expect(archived.proposal.changes).toEqual(
          disposition === 'keep' ? previous.proposal.changes : [],
        );
      }
    } finally {
      plugin.onunload();
    }
  },
);

it.each(['historical', 'blocked', 'uncertain'] as const)(
  'allows exact child inspection in a %s project-move session without admitting writes',
  async (mode) => {
    const authored = '- [ ] Same\n  - [ ] Same\n  - [ ] Same\n';
    const { app, plugin, first } = await setup({ [root]: authored });
    try {
      const projects = expectDefined(first.projects);
      const destination = value(
        await projects.get(
          expectDefined(value(await projects.list()).items.find((p) => p.path === empty)).target,
        ),
      );
      const source = expectDefined(
        value(await first.tasks.list({ path: root })).items.find(
          (t) => t.parentTarget === undefined,
        ),
      );
      const child = expectDefined(
        value(await expectDefined(first.tasks.tree)({ target: source.target })).tree.children[1],
      );
      const move = vi.fn(projects.moveTask);
      const { session, turn } = projectCommandSession({
        ...first,
        projects: { ...projects, moveTask: move },
      });
      expect(
        await session.focus({ kind: 'task', target: source.target, revision: source.revision }),
      ).toBe(true);
      turn({
        kind: 'move-task',
        ...basis(destination),
        taskTarget: source.target,
        expectedTaskRevision: source.revision,
      });
      await session.submit('Move this root');
      expect(session.snapshot().status.kind, session.snapshot().status.message).toBe('ready');
      expect(session.snapshot().proposal.changes).toMatchObject([
        {
          kind: 'project-move',
          before: { target: source.target },
          destination: { target: destination.target },
        },
      ]);
      const previous = session.snapshot();
      if (mode === 'historical') expect(session.restore(previous)).toBe(true);
      else
        expect(
          session.restore(
            {
              ...previous,
              ...(mode === 'blocked' ? { blocked: true } : { recovery: 'uncertain' as const }),
            },
            false,
          ),
        ).toBe(true);
      expect(session.readOnly()).toBe(true);
      const destinationBefore = await app.vault.read(expectDefined(app.vault.getFileByPath(empty)));
      expect(
        await session.focus({ kind: 'task', target: child.target, revision: child.revision }),
      ).toBe(true);
      expect(session.snapshot().focus[0]?.target).toBe(child.target);
      expect(session.snapshot().pendingTransition == null).toBe(true);
      expect(session.snapshot().proposal.changes).toEqual(previous.proposal.changes);
      expect(await session.confirm()).toBe(false);
      await session.submit('');
      expect(move).not.toHaveBeenCalled();
      expect(session.snapshot().journal).toEqual([]);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(root)))).toBe(authored);
      expect(await app.vault.read(expectDefined(app.vault.getFileByPath(empty)))).toBe(
        destinationBefore,
      );
    } finally {
      plugin.onunload();
    }
  },
);
