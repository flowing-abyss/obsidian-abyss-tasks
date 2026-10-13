import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import { admitsTaskNode } from '../../src/task-lists/taskNodeMembership';
import type { TaskCreateRequest } from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettings } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskCreatePreviewPort } from '../../src/tasks/application/TaskCreatePreviewPort';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { MarkdownTaskCreatePreview } from '../../src/tasks/infrastructure/markdown/MarkdownTaskCreatePreview';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { CaptureTargetResolver } from '../../src/ui/taskCapture/CaptureTargetResolver';
import { createAppWithFiles, expectDefined, taskQueryApi, useRealMoment } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';

useRealMoment();

async function harness(
  options: {
    prefix?: string;
    removeInbox?: boolean;
    unavailable?: boolean;
    noPort?: boolean;
    previewPort?: TaskCreatePreviewPort;
    inboxMode?: TaskBehaviorSettings['inbox']['mode'];
    inboxTag?: string;
  } = {},
) {
  const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(catalog);
  const app = await createAppWithFiles({ 'tasks.md': '' });
  const index = new TaskIndex(app, { statusCatalog: catalog });
  const repository = new InMemoryTaskRepository({
    files: { 'tasks.md': '' },
    codec,
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
  });
  const repositoryWrites: string[] = [];
  const create = repository.create.bind(repository);
  vi.spyOn(repository, 'create').mockImplementation(async (destination, draft) => {
    const result = await create(destination, draft);
    if (result.type === 'committed') repositoryWrites.push(repository.content('tasks.md') ?? '');
    return result;
  });
  const behavior: TaskBehaviorSettings = {
    taskPrefix: options.prefix ?? '',
    applyTaskPrefixToSubtasks: false,
    inbox: {
      mode: options.inboxMode ?? 'tag',
      tag: options.inboxTag ?? '#task/inbox',
      removeTagOnAssign: options.removeInbox ?? true,
    },
    taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
    recurrence: { newOccurrencePlacement: 'after', removeScheduledDate: false },
  };
  const destination = { filePath: 'tasks.md', insertion: { type: 'append' as const } };
  const prepare = vi.fn(async () => ({ type: 'resolved' as const, destination }));
  const validate = vi.fn(async () => true);
  const plan = vi.fn(async () =>
    options.unavailable === true ? undefined : { destination, prepare, validate },
  );
  const clock = vi.fn(() => localDate('2026-10-13'));
  const service = new TaskApplicationService(
    taskQueryApi(),
    repository,
    catalog,
    { today: clock },
    {
      planConfiguredDefault: plan,
      planExplicit: async () => ({ destination, prepare, validate }),
      resolveConfiguredDefault: prepare,
      prepare,
    },
    () => behavior,
    undefined,
    undefined,
    options.noPort === true
      ? undefined
      : (options.previewPort ?? new MarkdownTaskCreatePreview(codec)),
  );
  const readCanonicalRoot = (content: string) =>
    expectDefined(codec.parseLine(content.split('\n')[0] ?? '', { filePath: 'tasks.md', line: 0 }));
  return { service, behavior, repositoryWrites, readCanonicalRoot, prepare, validate, plan, clock };
}

describe('retained canonical create preview', () => {
  it('uses selected tags instead of fallback tags in context, preview and saved Markdown', async () => {
    const h = await harness({ prefix: '#task/one-off' });
    const session = await h.service.planCreate({ type: 'configured-default' });
    const initial = { tags: { add: ['#task/multistep'] } };
    expect(session.previewContext?.({ markdownBody: '', initial })).toMatchObject({
      type: 'ready',
      metadata: { tags: ['#task/multistep'] },
    });
    const request = { markdownBody: 'Новая задача', initial };
    expect(session.preview(request)).toMatchObject({
      type: 'valid',
      metadata: { tags: ['#task/multistep'] },
    });
    expect((await session.execute(request)).type).toBe('ok');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual([
      '#task/multistep',
    ]);
  });

  it.each([
    { body: 'Call', tags: ['#base', '#second'] },
    { body: 'Call #specific', tags: ['#specific'] },
    { body: 'Call #BASE', tags: ['#BASE'] },
    {
      body: 'Call #specific',
      initial: { tags: { remove: ['#specific'] } },
      tags: ['#base', '#second'],
    },
    { body: 'Call', initial: { tags: { remove: ['#base', '#second'] } }, tags: [] },
    {
      body: 'Call',
      initial: { tags: { add: ['#specific'], remove: ['#specific'] } },
      tags: ['#base', '#second'],
    },
    { body: 'Call #specific', initial: { tags: { remove: ['#base'] } }, tags: ['#specific'] },
  ])('keeps literal fallback expectations for $body $initial', async ({ body, tags, ...row }) => {
    const h = await harness({ prefix: '#base #second' });
    const session = await h.service.planCreate({ type: 'configured-default' });
    const request = { markdownBody: body, ...row };
    expect(session.preview(request)).toMatchObject({ type: 'valid', metadata: { tags } });
    expect((await session.execute(request)).type).toBe('ok');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual(tags);
  });

  it.each([
    { mode: 'tag', remove: true, body: 'Call', tags: ['#task/inbox'], member: true },
    { mode: 'tag', remove: false, body: 'Call #specific', tags: ['#specific'], member: false },
    { mode: 'tag', remove: true, body: 'Call #specific', tags: ['#specific'], member: false },
    { mode: 'untagged', remove: true, body: 'Call', tags: ['#task/inbox'], member: false },
    { mode: 'untagged', remove: false, body: 'Call #specific', tags: ['#specific'], member: false },
    { mode: 'untagged', remove: true, body: 'Call #specific', tags: ['#specific'], member: false },
    { mode: 'both', remove: true, body: 'Call', tags: ['#task/inbox'], member: true },
    { mode: 'both', remove: false, body: 'Call #specific', tags: ['#specific'], member: false },
    { mode: 'both', remove: true, body: 'Call #specific', tags: ['#specific'], member: false },
  ] as const)('keeps fallback classification under $mode/remove=$remove: $body', async (row) => {
    const h = await harness({
      prefix: '#task/inbox',
      inboxMode: row.mode,
      removeInbox: row.remove,
    });
    const session = await h.service.planCreate({ type: 'configured-default' });
    const request = { markdownBody: row.body };
    expect(session.preview(request)).toMatchObject({
      type: 'valid',
      metadata: { tags: row.tags },
      inbox: { member: row.member },
    });
    expect((await session.execute(request)).type).toBe('ok');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual(row.tags);
  });

  it('freezes Inbox policy and removes its automatic tag without writing', async () => {
    const { service, behavior, repositoryWrites, readCanonicalRoot } = await harness({
      prefix: '#prefix',
    });
    const input = { markdownBody: 'Call #new/tag', initial: { tags: { add: ['#task/inbox'] } } };
    const session = await service.planCreate({ type: 'configured-default' }, { intent: 'inbox' });
    const before = session.preview(input);
    expect(before).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call', tags: ['#new/tag'] },
    });
    expect(repositoryWrites).toHaveLength(0);
    Object.assign(behavior.inbox, { removeTagOnAssign: false });
    expect(session.preview(input)).toEqual(before);
    expect((await session.execute(input)).type).toBe('ok');
    expect(readCanonicalRoot(expectDefined(repositoryWrites[0])).tags).toEqual(['#new/tag']);
  });

  it.each([
    {
      removeInbox: false,
      prefix: '#prefix',
      inbox: true,
      input: { markdownBody: 'Call #new/tag', initial: { tags: { add: ['#task/inbox'] } } },
      tags: ['#new/tag', '#task/inbox'],
    },
    {
      prefix: '#WORK',
      input: { markdownBody: 'Call #work #other', initial: { tags: { add: ['#Work', '#next'] } } },
      tags: ['#work', '#other', '#next'],
    },
    {
      prefix: '#prefix',
      input: { markdownBody: 'Call #other', initial: { tags: { remove: ['#prefix'] } } },
      tags: ['#other'],
    },
  ])('uses canonical tag policy for $input', async ({ input, tags, ...options }) => {
    const { service, repositoryWrites, readCanonicalRoot } = await harness(options);
    const session = await service.planCreate(
      { type: 'configured-default' },
      options.inbox === true ? { intent: 'inbox' } : undefined,
    );
    expect(session.preview(input)).toMatchObject({ type: 'valid', metadata: { tags } });
    expect((await session.execute(input)).type).toBe('ok');
    expect(readCanonicalRoot(expectDefined(repositoryWrites[0])).tags).toEqual(tags);
  });

  it('retains source planning before manual override and normalizes final timing', async () => {
    const { service, repositoryWrites, readCanonicalRoot } = await harness({
      prefix: '📅 2026-10-15',
    });
    const session = await service.planCreate({ type: 'configured-default' });
    const input = {
      markdownBody: 'Call ⏰ 23:30 ⏱️ 2h',
      initial: { due: { type: 'set' as const, value: localDate('2026-10-16') } },
    };
    expect(session.preview(input)).toMatchObject({
      type: 'valid',
      sourcePlanning: { due: '2026-10-15', time: '23:30' },
      metadata: { planning: { due: '2026-10-16', time: '23:30', duration: 30 } },
    });
    await session.execute(input);
    expect(readCanonicalRoot(expectDefined(repositoryWrites[0])).planning).toMatchObject({
      due: '2026-10-16',
      time: '23:30',
      duration: 30,
    });
  });

  it('reads every source planning role separately from the final initial fields', async () => {
    const { service, repositoryWrites, readCanonicalRoot } = await harness();
    const session = await service.planCreate({ type: 'configured-default' });
    const input = {
      markdownBody: 'Call 🛫 2026-10-13 ⏳ 2026-10-14 📅 2026-10-15 ⏰ 14:00 ⏱️ 1h',
      initial: { scheduled: { type: 'clear' as const }, start: { type: 'clear' as const } },
    };
    expect(session.preview(input)).toEqual({
      type: 'valid',
      inbox: { member: false },
      sourcePlanning: {
        start: '2026-10-13',
        scheduled: '2026-10-14',
        due: '2026-10-15',
        time: '14:00',
      },
      metadata: {
        markdownTitle: 'Call',
        tags: [],
        priority: 'D',
        planning: { due: '2026-10-15', time: '14:00', duration: 60 },
      },
    });
    expect(repositoryWrites).toHaveLength(0);
    expect((await session.execute(input)).type).toBe('ok');
    expect(readCanonicalRoot(expectDefined(repositoryWrites[0])).planning).toEqual({
      created: '2026-10-13',
      due: '2026-10-15',
      time: '14:00',
      duration: 60,
    });
  });

  it.each(['Call 📅 nope', 'Call 📅 2026-10-15 📅 2026-10-16', 'Call 📅 2026-02-30', ''])(
    'rejects invalid raw input before initial patch or prefix: %s',
    async (markdownBody) => {
      const { service, repositoryWrites } = await harness({ prefix: 'Named prefix' });
      const session = await service.planCreate({ type: 'configured-default' });
      const input = { markdownBody, initial: { due: { type: 'clear' as const } } };
      const preview = session.preview(input);
      expect(preview.type).toBe('invalid');
      expect(await session.execute(input)).toEqual(preview);
      expect(repositoryWrites).toHaveLength(0);
    },
  );

  it('preview never rereads time or prepares/validates a destination', async () => {
    const { service, clock, plan, prepare, validate, repositoryWrites } = await harness();
    const session = await service.planCreate({ type: 'configured-default' });
    expect(session.preview({ markdownBody: 'Call' })).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call', priority: 'D', planning: {} },
    });
    session.preview({ markdownBody: 'Call again' });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(repositoryWrites).toHaveLength(0);
    await session.execute({ markdownBody: 'Call' });
    expect(expectDefined(repositoryWrites[0])).toContain('➕ 2026-10-13');
  });

  it.each([
    { unavailable: true, cause: 'destination' },
    { noPort: true, cause: 'preview-capability' },
  ])('returns explicit unavailable capability: $cause', async ({ cause, ...options }) => {
    const { service, prepare, repositoryWrites } = await harness(options);
    const session = await service.planCreate({ type: 'configured-default' });
    expect(session.preview({ markdownBody: 'Call' })).toEqual({ type: 'unavailable', cause });
    expect(prepare).not.toHaveBeenCalled();
    expect(repositoryWrites).toHaveLength(0);
  });

  it('propagates preview port exceptions to the initiating boundary', async () => {
    const failure = new Error('preview failed');
    const { service, repositoryWrites } = await harness({
      previewPort: {
        preview: () => {
          throw failure;
        },
      },
    });
    const session = await service.planCreate({ type: 'configured-default' });
    expect(() => session.preview({ markdownBody: 'Call' })).toThrow(failure);
    expect(repositoryWrites).toHaveLength(0);
  });

  it('retains authored source due when an initial clear removes the final due', async () => {
    const { service, repositoryWrites, readCanonicalRoot } = await harness();
    const session = await service.planCreate({ type: 'configured-default' });
    const input = {
      markdownBody: 'Call 📅 2026-10-15',
      initial: { due: { type: 'clear' as const } },
    };
    expect(session.preview(input)).toEqual({
      type: 'valid',
      inbox: { member: false },
      sourcePlanning: { due: '2026-10-15' },
      metadata: { markdownTitle: 'Call', tags: [], priority: 'D', planning: {} },
    });
    await session.execute(input);
    expect(readCanonicalRoot(expectDefined(repositoryWrites[0])).planning.due).toBeUndefined();
  });

  it('rejects an invalid initial tag through the same preparation as execute', async () => {
    const { service, repositoryWrites } = await harness();
    const session = await service.planCreate({ type: 'configured-default' });
    const input = { markdownBody: 'Call', initial: { tags: { add: ['#broken/'] } } };
    const preview = session.preview(input);
    expect(preview).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'tags' }],
    });
    expect(await session.execute(input)).toEqual(preview);
    expect(repositoryWrites).toHaveLength(0);
  });

  it('resolver unavailable target exposes destination preview outcome', async () => {
    const { service } = await harness();
    const resolver = new CaptureTargetResolver(service, {
      ...DEFAULT_SETTINGS,
      inbox: { ...DEFAULT_SETTINGS.inbox, tag: '', mode: 'tag' },
    });
    const target = await resolver.resolve({ type: 'list', selection: 'inbox' });
    expect(target.session.preview({ markdownBody: 'Call' })).toEqual({
      type: 'unavailable',
      cause: 'destination',
    });
  });

  it('agrees with real writes over bounded tag, prefix, context and clear combinations', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', '#prefix', '📅 2026-10-15'),
        fc.constantFrom('Call #new/tag', 'Call 📅 2026-10-14', 'Call 📅 nope'),
        fc.constantFrom<TaskCreateRequest['initial']>(
          undefined,
          { tags: { add: ['#task/inbox'] } },
          { tags: { remove: ['#new/tag'] } },
          { due: { type: 'clear' } },
          { due: { type: 'set', value: localDate('2026-10-16') } },
        ),
        fc.boolean(),
        async (prefix, markdownBody, initial, removeInbox) => {
          const { service, repositoryWrites, readCanonicalRoot } = await harness({
            prefix,
            removeInbox,
          });
          const session = await service.planCreate({ type: 'configured-default' });
          const input = { markdownBody, ...(initial === undefined ? {} : { initial }) };
          const preview = session.preview(input);
          expect(repositoryWrites).toHaveLength(0);
          const result = await session.execute(input);
          if (preview.type === 'invalid') {
            expect(result).toEqual(preview);
            expect(repositoryWrites).toHaveLength(0);
          } else {
            expect(preview.type).toBe('valid');
            expect(result.type).toBe('ok');
            if (preview.type !== 'valid') throw new Error('expected canonical preview');
            const root = readCanonicalRoot(expectDefined(repositoryWrites[0]));
            const { due, scheduled, start, time, duration } = root.planning;
            expect(preview.metadata).toEqual({
              markdownTitle: root.markdownTitle,
              tags: root.tags,
              priority: root.priority,
              planning: {
                ...(due === undefined ? {} : { due }),
                ...(scheduled === undefined ? {} : { scheduled }),
                ...(start === undefined ? {} : { start }),
                ...(time === undefined ? {} : { time }),
                ...(duration === undefined ? {} : { duration }),
              },
            });
          }
        },
      ),
      { seed: 20261013, numRuns: 60 },
    );
  });
});

describe('retained title-free canonical context', () => {
  it('shares frozen prefix, selected tag, planning normalization and priority with real creation', async () => {
    const h = await harness({ prefix: '#task/one-off 📅 2026-10-15 ⏰ 23:30 ⏱️ 2h 🔼' });
    const session = await h.service.planCreate({ type: 'configured-default' });
    const initial: TaskCreateRequest['initial'] = {
      tags: { add: ['work'] },
      due: { type: 'set', value: localDate('2026-10-14') },
    };
    const context = expectDefined(session.previewContext?.({ markdownBody: '', initial }));
    expect(context).toEqual({
      type: 'ready',
      referenceDate: '2026-10-13',
      sourcePlanning: { due: '2026-10-15', time: '23:30' },
      metadata: {
        tags: ['#work'],
        planning: { due: '2026-10-14', time: '23:30', duration: 30 },
        priority: 'C',
      },
      inbox: { member: false },
    });
    expect(context).not.toHaveProperty('markdownBody');
    expect(context).not.toHaveProperty('metadata.markdownTitle');
    Object.assign(h.behavior, { taskPrefix: '#changed' });
    Object.assign(h.behavior.inbox, { mode: 'untagged', removeTagOnAssign: false });
    expect(session.previewContext?.({ markdownBody: '', initial })).toEqual(context);
    const request = { markdownBody: 'Call', initial };
    const preview = session.preview(request);
    expect(preview).toMatchObject({ type: 'valid', metadata: { markdownTitle: 'Call' } });
    if (context.type !== 'ready' || preview.type !== 'valid') throw new Error('Expected metadata');
    expect({
      tags: preview.metadata.tags,
      planning: preview.metadata.planning,
      priority: preview.metadata.priority,
    }).toEqual(context.metadata);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.clock).toHaveBeenCalledOnce();
    expect(h.repositoryWrites).toHaveLength(0);
    expect((await session.execute(request)).type).toBe('ok');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
      markdownTitle: 'Call',
      ...context.metadata,
    });
  });

  it('defaults to an empty authored body and never grants empty creation', async () => {
    const h = await harness();
    const session = await h.service.planCreate({ type: 'configured-default' });
    expect(session.previewContext?.()).toEqual({
      type: 'ready',
      referenceDate: '2026-10-13',
      sourcePlanning: {},
      metadata: { tags: [], planning: {}, priority: 'D' },
      inbox: { member: false },
    });
    expect(session.preview({ markdownBody: '' })).toMatchObject({ type: 'invalid' });
    expect((await session.execute({ markdownBody: '' })).type).toBe('invalid');
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.repositoryWrites).toHaveLength(0);
  });

  it.each([
    { prefix: '📅 nope', body: '', code: 'invalid-date', field: 'due' },
    { prefix: '📅 2026-02-30', body: '', code: 'invalid-date', field: 'due' },
    { prefix: '📅 2026-10-15', body: '📅 2026-10-16', code: 'duplicate-field', field: 'due' },
    { prefix: '⏰ 25:00', body: '', code: 'invalid-time', field: 'time' },
    { prefix: '➕ nope', body: '', code: 'invalid-date', field: 'created' },
    { prefix: '➕ 2026-10-15 ➕ 2026-10-16', body: '', code: 'duplicate-field', field: 'created' },
  ])(
    'validates titleless metadata before an initial clear: $prefix $body',
    async ({ prefix, body, code, field }) => {
      const h = await harness({ prefix });
      const session = await h.service.planCreate({ type: 'configured-default' });
      const initial: TaskCreateRequest['initial'] = {
        due: { type: 'clear' },
        time: { type: 'clear' },
      };
      expect(session.previewContext?.({ markdownBody: body, initial })).toEqual({
        type: 'invalid',
        issues: [{ code, field }],
      });
      expect(h.repositoryWrites).toHaveLength(0);
      expect(h.prepare).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed initial tags without a title', async () => {
    const h = await harness();
    const session = await h.service.planCreate({ type: 'configured-default' });
    expect(
      session.previewContext?.({
        markdownBody: '',
        initial: { tags: { add: ['#broken/'] } },
      }),
    ).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'tags' }],
    });
    expect(h.repositoryWrites).toHaveLength(0);
  });

  it('reads exact source date before an initial override and respects protected Markdown', async () => {
    const h = await harness({ prefix: '#prefix `#literal` [note](#link)' });
    const session = await h.service.planCreate({ type: 'configured-default' });
    expect(
      session.previewContext?.({
        markdownBody: ' 📅 2026-10-15',
        initial: { due: { type: 'set', value: localDate('2026-10-14') } },
      }),
    ).toMatchObject({
      type: 'ready',
      sourcePlanning: { due: '2026-10-15' },
      metadata: { tags: ['#prefix'], planning: { due: '2026-10-14' } },
    });
  });

  it.each([
    { unavailable: true, cause: 'destination' },
    { noPort: true, cause: 'preview-capability' },
  ])('preserves the existing unavailable cause: $cause', async ({ cause, ...options }) => {
    const h = await harness(options);
    const session = await h.service.planCreate({ type: 'configured-default' });
    expect(session.previewContext?.()).toEqual({ type: 'unavailable', cause });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.repositoryWrites).toHaveLength(0);
  });

  it('keeps a legacy adapter optional and its real preview/save usable', async () => {
    const actual = await harness();
    const actualSession = await actual.service.planCreate({ type: 'configured-default' });
    const h = await harness({
      previewPort: {
        preview: (draft) =>
          actualSession.preview(draft) as Exclude<
            ReturnType<typeof actualSession.preview>,
            { type: 'unavailable' }
          >,
      },
    });
    const session = await h.service.planCreate({ type: 'configured-default' });
    expect(session.previewContext?.()).toEqual({
      type: 'unavailable',
      cause: 'preview-capability',
    });
    expect(session.preview({ markdownBody: 'Call' }).type).toBe('valid');
    expect((await session.execute({ markdownBody: 'Call' })).type).toBe('ok');
  });
});

describe('frozen preview and actual central Inbox membership', () => {
  const cases = [
    {
      mode: 'tag',
      remove: true,
      body: 'Call',
      tags: ['#task/inbox'],
      member: true,
      serviceTag: '#task/inbox',
    },
    { mode: 'tag', remove: true, body: 'Call #health', tags: ['#health'], member: false },
    {
      mode: 'tag',
      remove: false,
      body: 'Call #health',
      tags: ['#health', '#task/inbox'],
      member: true,
      serviceTag: '#task/inbox',
    },
    {
      mode: 'both',
      remove: true,
      body: 'Call',
      tags: ['#task/inbox'],
      member: true,
      serviceTag: '#task/inbox',
    },
    {
      mode: 'both',
      remove: true,
      body: 'Call #health #work',
      tags: ['#health', '#work'],
      member: false,
    },
    {
      mode: 'both',
      remove: false,
      body: 'Call #health #work',
      tags: ['#health', '#work', '#task/inbox'],
      member: true,
      serviceTag: '#task/inbox',
    },
    { mode: 'untagged', remove: true, body: 'Call', initial: {}, tags: [], member: true },
    {
      mode: 'untagged',
      remove: false,
      body: 'Call #task/inbox',
      initial: {},
      tags: ['#task/inbox'],
      member: false,
    },
    {
      mode: 'tag',
      remove: false,
      body: 'Call #TASK/INBOX',
      tags: ['#TASK/INBOX'],
      member: true,
      serviceTag: '#TASK/INBOX',
    },
    {
      mode: 'tag',
      remove: true,
      body: 'Call #task/inbox/child',
      tags: ['#task/inbox/child'],
      member: false,
    },
    {
      mode: 'tag',
      remove: true,
      body: 'Call `#health` [link](#work)',
      tags: ['#task/inbox'],
      member: true,
      serviceTag: '#task/inbox',
    },
    {
      mode: 'tag',
      remove: true,
      body: 'Call',
      initial: { tags: { add: ['#task/inbox', '#health'] } },
      tags: ['#health'],
      member: false,
    },
    {
      mode: 'tag',
      remove: true,
      body: 'Call #health',
      initial: { tags: { add: ['#task/inbox'], remove: ['#health'] } },
      tags: ['#task/inbox'],
      member: true,
      serviceTag: '#task/inbox',
    },
    {
      mode: 'tag',
      remove: false,
      body: 'Call #health',
      initial: { tags: { add: ['#task/inbox'], remove: ['#task/inbox'] } },
      tags: ['#health'],
      member: false,
    },
    {
      mode: 'tag',
      remove: false,
      body: 'Call #task/inbox',
      tag: '#task/inbox #other',
      initial: {},
      tags: ['#task/inbox'],
      member: false,
    },
    {
      mode: 'both',
      remove: false,
      body: 'Call',
      tag: '#broken/',
      initial: {},
      tags: [],
      member: true,
    },
  ] as const;
  it.each(cases)('agrees across $mode remove=$remove $body', async (row) => {
    const h = await harness({
      inboxMode: row.mode,
      ...('tag' in row ? { inboxTag: row.tag } : {}),
      removeInbox: row.remove,
    });
    const session = await h.service.planCreate({ type: 'configured-default' }, { intent: 'inbox' });
    const request: TaskCreateRequest = {
      markdownBody: row.body,
      initial: 'initial' in row ? row.initial : { tags: { add: ['#task/inbox'] } },
    };
    const inbox = {
      member: row.member,
      ...('serviceTag' in row ? { serviceTag: row.serviceTag } : {}),
    };
    expect(session.preview(request)).toMatchObject({
      type: 'valid',
      metadata: { tags: row.tags },
      inbox,
    });
    Object.assign(h.behavior.inbox, {
      mode: row.mode === 'untagged' ? 'tag' : 'untagged',
      tag: '#changed',
      removeTagOnAssign: !row.remove,
    });
    expect(session.preview(request)).toMatchObject({ inbox });
    expect((await session.execute(request)).type).toBe('ok');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.tags).toEqual(row.tags);
    expect(
      admitsTaskNode(
        {
          depth: 0,
          tags: root.tags,
          planning: {},
          status: 'open',
          statusSymbol: ' ',
          source: { filePath: 'tasks.md', line: 0 },
        },
        {
          selection: 'inbox',
          today: localDate('2026-10-13'),
          observedTags: root.tags,
          settings: {
            ...DEFAULT_SETTINGS,
            inbox: {
              mode: row.mode,
              tag: 'tag' in row ? row.tag : '#task/inbox',
              removeTagOnAssign: row.remove,
            },
          },
        },
      ),
    ).toBe(row.member);
  });
});
