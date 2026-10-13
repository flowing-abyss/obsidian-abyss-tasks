import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
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
    inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: options.removeInbox ?? true },
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
      tags: ['#WORK', '#other', '#next'],
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
