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
import {
  createAppWithFiles,
  deferred,
  expectDefined,
  taskQueryApi,
  useRealMoment,
} from '../helpers';
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
  return {
    app,
    service,
    behavior,
    repository,
    repositoryWrites,
    readCanonicalRoot,
    prepare,
    validate,
    plan,
    clock,
  };
}

import { localTime } from '../../src/tasks/domain/validation';
import { ChronoTaskInputRecognizer } from '../../src/tasks/infrastructure/input/ChronoTaskInputRecognizer';
import {
  CaptureTargetResolver,
  type CaptureContext,
  type CaptureTarget,
} from '../../src/ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../../src/ui/taskCommandResult';

const reference = {
  epochMs: Date.parse('2026-10-13T12:00:00+07:00'),
  localDate: localDate('2026-10-13'),
  localTime: localTime('12:00'),
  second: 0,
  offsetMinutes: 420,
};
interface SmartCaptureInput {
  readonly inbox?: boolean;
  readonly initial?: TaskCreateRequest['initial'];
  readonly markdownPrefix?: string;
  readonly resolveContext?: CaptureContext;
  readonly previewFailureCallback?: boolean;
}
async function smartTarget(
  real: Awaited<ReturnType<typeof harness>>,
  input: SmartCaptureInput,
): Promise<CaptureTarget> {
  if (input.resolveContext !== undefined)
    return await new CaptureTargetResolver(
      real.service,
      { ...DEFAULT_SETTINGS, inbox: real.behavior.inbox },
      () => reference.localDate,
    ).resolve(input.resolveContext);
  return {
    label: 'Inbox',
    context: { type: 'list', selection: 'inbox' },
    session: await real.service.planCreate(
      { type: 'configured-default' },
      input.inbox === false ? undefined : { intent: 'inbox' },
    ),
    markdownPrefix: input.markdownPrefix ?? '',
    markdownSuffixes: [],
    initial: input.initial ?? { tags: { add: ['#task/inbox'] } },
  };
}
async function smartHarness(
  options: Parameters<typeof harness>[0] = {},
  input: SmartCaptureInput = {},
) {
  const real = await harness(options);
  const target = await smartTarget(real, input);
  const session = target.session;
  const recognizer = new ChronoTaskInputRecognizer();
  const recognize = vi.spyOn(recognizer, 'recognize');
  const readReference = vi.fn(() => reference);
  const enabled = vi.fn(() => true);
  const onRecognitionFailure = vi.fn();
  const onPreviewFailure = vi.fn();
  const preview = vi.spyOn(session, 'preview');
  const execute = vi.spyOn(session, 'execute');
  const onResult = vi.fn();
  const describeResult = vi.fn(describeTaskCreationResult);
  const controller = new TaskCaptureController({
    target,
    smart: {
      recognizer,
      readReference,
      enabled,
      onRecognitionFailure,
      ...(input.previewFailureCallback === false ? {} : { onPreviewFailure }),
    },
    describe: describeResult,
    onResult,
    onRequestClose: () => {},
  });
  return {
    ...real,
    controller,
    recognize,
    readReference,
    enabled,
    preview,
    execute,
    onRecognitionFailure,
    onPreviewFailure,
    onResult,
    describeResult,
  };
}
describe('smart Q canonical commit', () => {
  it.each([true, false])(
    'previews and writes the user example with remove Inbox %s',
    async (removeInbox) => {
      const h = await smartHarness({ removeInbox });
      const raw = 'Набрать другу в 12:00 послезавтра #new/tag';
      h.controller.setDraft(raw);
      expect(h.controller.snapshot().draft).toBe(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: {
          markdownTitle: 'Набрать другу',
          planning: { due: '2026-10-15', time: '12:00' },
          tags: removeInbox ? ['#new/tag'] : ['#new/tag', '#task/inbox'],
        },
      });
      expect(h.repositoryWrites).toHaveLength(0);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(1);
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
        markdownTitle: 'Набрать другу',
        planning: { due: '2026-10-15', time: '12:00' },
        tags: removeInbox ? ['#new/tag'] : ['#new/tag', '#task/inbox'],
      });
    },
  );
  it('previews and writes the exact native numeric identifier input', async () => {
    const h = await smartHarness();
    const raw = 'SMART-CAPTURE-SMOKE-20261013-01 Набрать другу в 12:00 послезавтра #new/tag';
    h.controller.setDraft(raw);
    expect(h.controller.snapshot().draft).toBe(raw);
    expect(h.controller.snapshot().metadata?.projection?.markdownBody).toBe(
      'SMART-CAPTURE-SMOKE-20261013-01 Набрать другу #new/tag',
    );
    const metadata = {
      markdownTitle: 'SMART-CAPTURE-SMOKE-20261013-01 Набрать другу',
      planning: { due: '2026-10-15', time: '12:00' },
      tags: ['#new/tag'],
    };
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({ type: 'valid', metadata });
    expect(h.repositoryWrites).toHaveLength(0);
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(1);
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject(metadata);
  });
  it.each<[string, string, { due?: string; time?: string }]>([
    ['Call at 12:00 tomorrow -123456', 'Call -123456', { due: '2026-10-14', time: '12:00' }],
    ['Call at 12:00 tomorrow -1234', 'Call at 12:00 tomorrow -1234', {}],
  ])(
    'preserves numeric source through preview and canonical writing: %s',
    async (raw, title, planning) => {
      const h = await smartHarness({}, { inbox: false, initial: {} });
      h.controller.setDraft(raw);
      expect(h.controller.snapshot().draft).toBe(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { markdownTitle: title, planning },
      });
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(1);
      const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(root.markdownTitle).toBe(title);
      expect(root.planning.due).toBe(planning.due);
      expect(root.planning.time).toBe(planning.time);
    },
  );
  it.each<[string, string, { due?: string; time?: string }]>([
    ['Call build+07:00 tomorrow', 'Call build+07:00', { due: '2026-10-14' }],
    [
      'Call build+07:00 tomorrow at 12:00',
      'Call build+07:00',
      { due: '2026-10-14', time: '12:00' },
    ],
    ['Позвонить завтра ЗАДАЧА-07:00', 'Позвонить ЗАДАЧА-07:00', { due: '2026-10-14' }],
    [
      'Позвонить в 12:00 ЗАДАЧА-25:00 завтра',
      'Позвонить ЗАДАЧА-25:00',
      { due: '2026-10-14', time: '12:00' },
    ],
    ['Call tomorrow at 12:00+07:00', 'Call tomorrow at 12:00+07:00', {}],
  ])(
    'previews and writes colon-form identifiers without consuming them: %s',
    async (raw, title, planning) => {
      const h = await smartHarness({}, { inbox: false, initial: {} });
      h.controller.setDraft(raw);
      const snapshot = h.controller.snapshot();
      expect(snapshot.draft).toBe(raw);
      expect(snapshot.metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { markdownTitle: title, planning },
      });
      expect(snapshot.metadata?.projection?.initial.due).toEqual(
        planning.due === undefined ? undefined : { type: 'set', value: planning.due },
      );
      expect(snapshot.metadata?.projection?.initial.time).toEqual(
        planning.time === undefined ? undefined : { type: 'set', value: planning.time },
      );
      expect(h.repositoryWrites).toHaveLength(0);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(1);
      const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(root.markdownTitle).toBe(title);
      expect(root.planning.due).toBe(planning.due);
      expect(root.planning.time).toBe(planning.time);
    },
  );
  it('keeps dismissed words across outside edits', async () => {
    const h = await smartHarness();
    h.controller.setDraft('Позвонить послезавтра в 12:00');
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    h.controller.setDraft('Срочно 👩‍💻 Позвонить послезавтра в 12:00 маме');
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe('Срочно 👩‍💻 Позвонить послезавтра в 12:00 маме');
    expect(root.planning.due).toBeUndefined();
    expect(root.planning.time).toBeUndefined();
  });
  it.each(['#tag 📅 2026-10-15', '!!!', 'tomorrow', 'Call 📅 nope'])(
    'blocks unproved authored title before prefix: %s',
    async (raw) => {
      const h = await smartHarness({ prefix: 'Prefix title' });
      h.controller.setDraft(raw);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(0);
      expect(h.controller.snapshot().phase).toBe('error');
    },
  );
  it.each(['`code` tomorrow', '[link](target) tomorrow', '👩‍💻 tomorrow'])(
    'allows substantive Markdown: %s',
    async (raw) => {
      const h = await smartHarness();
      h.controller.setDraft(raw);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(1);
    },
  );
  it('supports manual choice before title without freezing on empty open', async () => {
    const h = await smartHarness();
    expect(h.readReference).not.toHaveBeenCalled();
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-20'),
    });
    expect(h.controller.snapshot().metadata?.projection?.initial.due).toEqual({
      type: 'set',
      value: '2026-10-20',
    });
    expect(h.controller.snapshot().metadata?.preview.type).not.toBe('valid');
    h.controller.setDraft('Call');
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).planning.due).toBe(
      '2026-10-20',
    );
    expect(h.readReference).toHaveBeenCalledOnce();
  });
  it('restores automatic Inbox by deleting another tag and preserves explicit removal', async () => {
    const h = await smartHarness();
    h.controller.setDraft('Call tomorrow #new/tag');
    h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#new/tag' });
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { tags: ['#task/inbox'] },
    });
    h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#task/inbox' });
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { tags: [] },
    });
  });
  it('freezes setting and reference until success', async () => {
    const h = await smartHarness();
    h.controller.setDraft('Call tomorrow');
    h.enabled.mockReturnValue(false);
    h.controller.setDraft('Call again tomorrow');
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).planning.due).toBe(
      '2026-10-14',
    );
    h.controller.setDraft('Literal tomorrow');
    await h.controller.submit('enter');
    expect(
      h.readCanonicalRoot(
        expectDefined(h.repositoryWrites[1])
          .split('\n')
          .filter((line) => line.startsWith('- [ ] '))[1] ?? '',
      ).markdownTitle,
    ).toBe('Literal tomorrow');
    expect(h.readReference).toHaveBeenCalledTimes(2);
    expect(h.enabled).toHaveBeenCalledTimes(2);
  });
});

describe('Q context before authored input', () => {
  it.each([
    {
      prefix: '#prefix 📅 2026-10-15 ⏰ 23:30',
      context: { type: 'list', selection: 'today' },
      planning: { due: '2026-10-15', time: '23:30' },
    },
    {
      prefix: '#prefix ⏰ 23:30',
      context: { type: 'default', source: 'projects' },
      planning: { time: '23:30' },
    },
  ] satisfies ReadonlyArray<{
    prefix: string;
    context: CaptureContext;
    planning: { due?: string; time: string };
  }>)(
    'preserves canonical context meaning on the first real edit: $prefix',
    async ({ prefix, context, planning }) => {
      const h = await smartHarness({ prefix }, { resolveContext: context });
      const initial = h.controller.snapshot().metadata?.context;
      expect(initial).toMatchObject({ type: 'ready', metadata: { tags: ['#prefix'], planning } });
      expect(h.readReference).not.toHaveBeenCalled();
      expect(h.recognize).not.toHaveBeenCalled();
      h.controller.setDraft('Call');
      const preview = h.controller.snapshot().metadata?.preview;
      expect(preview).toMatchObject({ type: 'valid', metadata: { tags: ['#prefix'], planning } });
      if (initial?.type !== 'ready' || preview?.type !== 'valid')
        throw new Error('Expected canonical metadata');
      expect({
        tags: preview.metadata.tags,
        planning: preview.metadata.planning,
        priority: preview.metadata.priority,
      }).toEqual(initial.metadata);
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
        markdownTitle: 'Call',
        ...initial.metadata,
      });
    },
  );
  it.each([
    {
      context: { type: 'list', selection: 'today' },
      tags: ['#task/one-off'],
      planning: { due: '2026-10-13' },
    },
    {
      context: { type: 'list', selection: 'upcoming' },
      tags: ['#task/one-off'],
      planning: { due: '2026-10-14' },
    },
    {
      context: { type: 'list', selection: { type: 'tag', tag: '#selected' } },
      tags: ['#task/one-off', '#selected'],
      planning: {},
    },
    {
      context: { type: 'project-dashboard', path: 'Project.md' },
      tags: ['#task/one-off'],
      planning: {},
    },
  ] satisfies ReadonlyArray<{
    context: CaptureContext;
    tags: string[];
    planning: { due?: string };
  }>)(
    'shows frozen canonical metadata for $context immediately',
    async ({ context, tags, planning }) => {
      const h = await smartHarness({ prefix: '#task/one-off' }, { resolveContext: context });
      expect(h.controller.snapshot().metadata?.context).toMatchObject({
        type: 'ready',
        referenceDate: '2026-10-13',
        metadata: { tags, planning },
      });
      expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
      h.controller.snapshot();
      const subscription = h.controller.subscribe(() => h.controller.snapshot());
      subscription.release();
      expect(h.readReference).not.toHaveBeenCalled();
      expect(h.recognize).not.toHaveBeenCalled();
      expect(h.enabled).not.toHaveBeenCalled();
      expect(h.repositoryWrites).toHaveLength(0);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(0);
      h.controller.setDraft('Call');
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { tags, planning },
      });
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
        tags,
        planning,
        markdownTitle: 'Call',
      });
    },
  );

  it.each(['prefix', 'selected'] as const)(
    'removes and restores the empty %s tag without editing raw bytes',
    async (tag) => {
      const h = await smartHarness(
        { prefix: '#prefix' },
        { resolveContext: { type: 'list', selection: { type: 'tag', tag: '#selected' } } },
      );
      expect(h.controller.snapshot().metadata?.context).toMatchObject({
        type: 'ready',
        metadata: { tags: ['#prefix', '#selected'] },
      });
      h.controller.applyMetadataAction({ type: 'remove-tag', tag: `#${tag}` });
      expect(h.controller.snapshot().draft).toBe('');
      expect(h.controller.snapshot().metadata?.context).toMatchObject({
        type: 'ready',
        metadata: { tags: [tag === 'prefix' ? '#selected' : '#prefix'] },
      });
      h.controller.applyMetadataAction({ type: 'restore' });
      expect(h.controller.snapshot().metadata?.context).toMatchObject({
        type: 'ready',
        metadata: { tags: ['#prefix', '#selected'] },
      });
      h.controller.setDraft('Call');
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual([
        '#prefix',
        '#selected',
      ]);
    },
  );

  it('dismisses and restores an empty prefix date above a selected Today fallback', async () => {
    const h = await smartHarness(
      { prefix: '📅 2026-10-15 #prefix' },
      { resolveContext: { type: 'list', selection: 'today' } },
    );
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      sourcePlanning: { due: '2026-10-15' },
      metadata: { planning: { due: '2026-10-15' } },
    });
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      metadata: { planning: {} },
    });
    h.controller.applyMetadataAction({ type: 'restore' });
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      metadata: { planning: { due: '2026-10-15' } },
    });
    expect(h.controller.snapshot().draft).toBe('');
    expect(h.repositoryWrites).toHaveLength(0);
  });

  it('retains real resolver seed provenance across early date/tag actions and actual save', async () => {
    const h = await smartHarness(
      { prefix: '#prefix' },
      {
        resolveContext: {
          type: 'list',
          selection: { type: 'tag', tag: '#selected' },
          date: localDate('2026-10-20'),
        },
      },
    );
    const raw = ' 📅 2026-10-20';
    expect(h.controller.snapshot().draft).toBe(raw);
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      sourcePlanning: { due: '2026-10-20' },
      metadata: { tags: ['#prefix', '#selected'], planning: { due: '2026-10-20' } },
    });
    expect(h.readReference).not.toHaveBeenCalled();
    expect(h.recognize).not.toHaveBeenCalled();
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(0);
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      metadata: { planning: {} },
    });
    expect(h.controller.snapshot().draft).toBe(raw);
    h.controller.applyMetadataAction({ type: 'restore' });
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      metadata: { planning: { due: '2026-10-20' } },
    });
    h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#prefix' });
    expect(h.controller.snapshot().metadata?.context).toMatchObject({
      type: 'ready',
      metadata: { tags: ['#selected'] },
    });
    h.controller.applyMetadataAction({ type: 'restore' });
    h.controller.setDraft(`Call${raw}`);
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { tags: ['#prefix', '#selected'], planning: { due: '2026-10-20' } },
    });
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
      markdownTitle: 'Call',
      tags: ['#prefix', '#selected'],
      planning: { due: '2026-10-20' },
    });
  });

  it('rejects a duplicate seed and prefix date instead of masking the source date', async () => {
    const h = await smartHarness(
      { prefix: '📅 2026-10-15 #prefix' },
      { resolveContext: { type: 'list', selection: 'today', date: localDate('2026-10-20') } },
    );
    expect(h.controller.snapshot().metadata?.context).toEqual({
      type: 'invalid',
      issues: [{ code: 'duplicate-field', field: 'due' }],
    });
    expect(h.controller.snapshot().error?.message).toBeTruthy();
    expect(h.readReference).not.toHaveBeenCalled();
    expect(h.onPreviewFailure).not.toHaveBeenCalled();
    expect(h.repositoryWrites).toHaveLength(0);
  });

  it('does not revive the resolver context exception after real authored input and equal-byte history', async () => {
    const h = await smartHarness(
      { prefix: '#prefix' },
      { resolveContext: { type: 'list', selection: 'today', date: localDate('2026-10-20') } },
    );
    expect(h.controller.snapshot().metadata?.context?.type).toBe('ready');
    h.controller.setDraft('Call 📅 2026-10-20');
    h.controller.setDraft(' 📅 2026-10-20', { editKind: 'history' });
    expect(h.controller.snapshot().metadata?.context).toBeUndefined();
    expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
    expect(h.controller.isEmpty()).toBe(false);
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(0);
  });

  it.each(['Call #health', 'Call #health #work'])(
    'reclassifies Inbox through remove and Restore while raw stays intact: %s',
    async (raw) => {
      const h = await smartHarness();
      h.controller.setDraft(raw);
      expect(h.controller.snapshot().metadata?.destination).toEqual({
        filePath: 'tasks.md',
        inbox: false,
      });
      h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#health' });
      if (!raw.includes('#work'))
        expect(h.controller.snapshot().metadata?.destination).toEqual({
          filePath: 'tasks.md',
          inbox: true,
          representedInboxTag: '#task/inbox',
        });
      else expect(h.controller.snapshot().metadata?.destination?.inbox).toBe(false);
      expect(h.controller.snapshot().draft).toBe(raw);
      h.controller.applyMetadataAction({ type: 'restore' });
      expect(h.controller.snapshot().metadata?.destination?.inbox).toBe(false);
      expect(h.controller.snapshot().draft).toBe(raw);
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual(
        raw.includes('#work') ? ['#health', '#work'] : ['#health'],
      );
    },
  );
});

describe('guarded Q context and draft diagnostics', () => {
  it('reports thrown context once per revision, keeps snapshots observational and recovers to a real write', async () => {
    const canonical = new MarkdownTaskCreatePreview(
      new TaskMarkdownCodec(new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses))),
    );
    let fails = true;
    const readContext = vi.fn(
      (draft: Parameters<NonNullable<TaskCreatePreviewPort['previewContext']>>[0]) => {
        if (fails) throw new Error('private raw /private/path');
        return canonical.previewContext(draft);
      },
    );
    const h = await smartHarness({
      previewPort: { preview: (draft) => canonical.preview(draft), previewContext: readContext },
    });
    expect(h.controller.snapshot().phase).not.toBe('closed');
    expect(h.controller.snapshot().metadata?.context).toEqual({
      type: 'unavailable',
      cause: 'preview-capability',
    });
    expect(h.controller.snapshot().error?.message).toBeTruthy();
    h.controller.snapshot();
    h.controller.subscribe(() => h.controller.snapshot()).release();
    expect(h.onPreviewFailure.mock.calls).toEqual([['context']]);
    expect(readContext).toHaveBeenCalledOnce();
    expect(h.readReference).not.toHaveBeenCalled();
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-14'),
    });
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-14'),
    });
    expect(h.onPreviewFailure.mock.calls).toEqual([['context']]);
    fails = false;
    h.controller.setDraft('Call');
    expect(h.controller.snapshot().error).toBeUndefined();
    h.controller.setDraft('');
    expect(h.controller.snapshot().metadata?.context?.type).toBe('ready');
    expect(h.controller.snapshot().error).toBeUndefined();
    h.controller.setDraft('Call');
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(1);
  });

  it('uses a constant fallback diagnostic without exposing raw input, paths or thrown causes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const canonical = new MarkdownTaskCreatePreview(
        new TaskMarkdownCodec(new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses))),
      );
      const h = await smartHarness(
        {
          previewPort: {
            preview: (draft) => canonical.preview(draft),
            previewContext: () => {
              throw new Error('private raw /private/path');
            },
          },
        },
        { previewFailureCallback: false },
      );
      expect(log.mock.calls).toEqual([['[abyss-tasks] Quick-capture context preview failed']]);
      h.controller.snapshot();
      h.controller.applyMetadataAction({
        type: 'select-date',
        role: 'due',
        value: localDate('2026-10-14'),
      });
      expect(log).toHaveBeenCalledOnce();
      h.controller.setDraft('Call');
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('handles draft exceptions at a distinct once-per-revision boundary', async () => {
    const canonical = new MarkdownTaskCreatePreview(
      new TaskMarkdownCodec(new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses))),
    );
    let fails = true;
    const h = await smartHarness({
      previewPort: {
        previewContext: (draft) => canonical.previewContext(draft),
        preview: (draft) => {
          if (fails) throw new Error('private input');
          return canonical.preview(draft);
        },
      },
    });
    h.controller.setDraft('Call tomorrow');
    h.controller.flushRecognition();
    await h.controller.submit('enter');
    expect(h.onPreviewFailure.mock.calls).toEqual([['draft']]);
    expect(h.repositoryWrites).toHaveLength(0);
    fails = false;
    h.controller.setDraft('Call tomorrow!');
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(1);
  });

  it('treats missing context support quietly while ordinary title-bearing capture stays usable', async () => {
    const canonical = new MarkdownTaskCreatePreview(
      new TaskMarkdownCodec(new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses))),
    );
    const h = await smartHarness({ previewPort: { preview: (draft) => canonical.preview(draft) } });
    expect(h.controller.snapshot().error).toBeUndefined();
    expect(h.onPreviewFailure).not.toHaveBeenCalled();
    h.controller.setDraft('Call');
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(1);
  });

  it.each([false, true])(
    'uses structured feedback without unexpected logging; unavailable=%s',
    async (unavailable) => {
      const h = await smartHarness(
        { unavailable, prefix: unavailable ? '' : '⏰ 25:00' },
        { inbox: false, initial: {} },
      );
      expect(h.controller.snapshot().metadata?.context?.type).toBe(
        unavailable ? 'unavailable' : 'invalid',
      );
      expect(h.controller.snapshot().error?.message).toBeTruthy();
      expect(h.onPreviewFailure).not.toHaveBeenCalled();
      expect(h.repositoryWrites).toHaveLength(0);
    },
  );
});

describe('smart Q settlement and failure contracts', () => {
  it('retains explicit/manual/context values on recognition failure with one sanitized report per revision', async () => {
    const h = await smartHarness();
    h.recognize.mockImplementation(() => {
      throw new Error('private raw path');
    });
    h.controller.setDraft('Call tomorrow ⏰ 14:00');
    h.controller.flushRecognition();
    expect(h.onRecognitionFailure).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().metadata?.recognitionError).not.toContain('private');
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call tomorrow', planning: { time: '14:00' } },
    });
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-20'),
    });
    expect(h.onRecognitionFailure).toHaveBeenCalledOnce();
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).planning).toMatchObject({
      due: '2026-10-20',
      time: '14:00',
    });
  });
  it.each(['throw', 'unavailable'] as const)('blocks canonical preview %s', async (kind) => {
    const h = await smartHarness();
    h.preview.mockImplementation(() => {
      if (kind === 'throw') {
        throw new Error('private');
      }
      return { type: 'unavailable', cause: 'preview-capability' };
    });
    h.controller.setDraft('Call tomorrow');
    await h.controller.submit('enter');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.controller.snapshot().phase).toBe('error');
  });
  it('requires explicit Enter after editing a known unchanged failure', async () => {
    const h = await smartHarness();
    vi.spyOn(h.repository, 'create').mockResolvedValueOnce({
      type: 'io-error',
      cause: 'process-error',
      contentState: 'unchanged',
    });
    h.controller.setDraft('Call tomorrow');
    await h.controller.submit('enter');
    h.controller.setDraft('Call again tomorrow');
    await h.controller.submit('blur');
    expect(h.execute).toHaveBeenCalledTimes(1);
    await h.controller.submit('enter');
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.readReference).toHaveBeenCalledOnce();
  });
  it('latches a rejected execute promise across all edits until checked retry', async () => {
    const h = await smartHarness();
    h.execute.mockRejectedValueOnce(new Error('private'));
    h.controller.setDraft('Call tomorrow');
    await h.controller.submit('enter');
    h.controller.setDraft('Call again tomorrow');
    await h.controller.submit('enter');
    await h.controller.submit('blur');
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().metadata?.needsCheckedRetry).toBe(true);
    await h.controller.confirmCheckedRetry();
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.repositoryWrites).toHaveLength(1);
  });
  it('flushes deferred input and holds the reference through midnight and clock equality', async () => {
    const h = await smartHarness();
    h.controller.setDraft('Call at 12:00', { deferRecognition: true, editKind: 'composition' });
    expect(h.recognize).not.toHaveBeenCalled();
    h.readReference.mockReturnValue({
      ...reference,
      localDate: localDate('2026-10-14'),
      epochMs: reference.epochMs + 86400000,
    });
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).planning).toMatchObject({
      due: '2026-10-14',
      time: '12:00',
    });
    expect(h.readReference).toHaveBeenCalledOnce();
  });
  it('settles 250 generated real-writer sessions with immutable exact retries and unknown blocking', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'Call tomorrow at 14:00',
            'Позвонить послезавтра в 12:00',
            'Call tomorrow',
            'Call at 14:00',
          ),
          fc.array(fc.constantFrom('noop', 'render', 'enter', 'blur'), {
            minLength: 1,
            maxLength: 12,
          }),
          fc.boolean(),
          async (raw, events, unknown) => {
            const h = await smartHarness();
            const ownerWindow = expectDefined(
              h.app.workspace.containerEl.ownerDocument.defaultView,
            );
            const gate = deferred<void>(),
              entered = deferred<void>();
            vi.spyOn(h.repository, 'create').mockImplementationOnce(async () => {
              entered.resolve(undefined);
              await gate.promise;
              return {
                type: 'io-error',
                cause: 'process-error',
                contentState: unknown ? 'unknown' : 'unchanged',
              };
            });
            h.controller.setDraft(raw);
            const first = h.controller.submit('enter');
            await entered.promise;
            const request = expectDefined(h.execute.mock.calls[0]?.[0]);
            const detached = structuredClone(request);
            expect(Object.isFrozen(request)).toBe(true);
            expect(Object.isFrozen(request.initial)).toBe(true);
            for (const event of events)
              ownerWindow.setTimeout(() => {
                if (event === 'noop') h.controller.setDraft(raw);
                else if (event === 'render') {
                  const lease = h.controller.subscribe(() => {});
                  lease.release();
                } else
                  h.controller.submit(event).catch(() => {
                    throw new Error('Unexpected settlement rejection');
                  });
              }, 1);
            await vi.advanceTimersByTimeAsync(10);
            expect(h.execute).toHaveBeenCalledOnce();
            expect(h.readReference).toHaveBeenCalledOnce();
            expect(h.enabled).toHaveBeenCalledOnce();
            expect(request).toEqual(detached);
            gate.resolve(undefined);
            await first;
            const counts = [
              h.recognize.mock.calls.length,
              h.preview.mock.calls.length,
              h.readReference.mock.calls.length,
              h.enabled.mock.calls.length,
            ];
            h.controller.setDraft(raw);
            await h.controller.submit('blur');
            expect(h.execute).toHaveBeenCalledOnce();
            if (unknown) {
              await h.controller.submit('enter');
              h.controller.setDraft(`${raw} details`);
              await h.controller.submit('enter');
              await h.controller.submit('blur');
              expect(h.execute).toHaveBeenCalledOnce();
              expect(h.controller.snapshot().metadata?.needsCheckedRetry).toBe(true);
              await h.controller.confirmCheckedRetry();
            } else {
              await h.controller.submit('enter');
              expect(h.execute.mock.calls[1]?.[0]).toBe(request);
              expect([
                h.recognize.mock.calls.length,
                h.preview.mock.calls.length,
                h.readReference.mock.calls.length,
                h.enabled.mock.calls.length,
              ]).toEqual(counts);
            }
            expect(h.execute).toHaveBeenCalledTimes(2);
            expect(h.repositoryWrites).toHaveLength(1);
            expect(h.repository.content('tasks.md')).toContain('📅 2026-10-');
            expect(request).toEqual(detached);
            h.controller.destroy();
          },
        ),
        { numRuns: 250, seed: 2026101307 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const agreementCases: ReadonlyArray<{
  readonly body: string;
  readonly initial?: TaskCreateRequest['initial'];
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly due?: string;
  readonly invalid?: string;
}> = [
  { body: 'Call', title: 'Call', tags: [] },
  {
    body: 'Call',
    initial: { due: { type: 'set', value: localDate('2026-10-16') } },
    title: 'Call',
    tags: [],
    due: '2026-10-16',
  },
  {
    body: 'Call 📅 2026-10-15',
    initial: { due: { type: 'set', value: localDate('2026-10-17') } },
    title: 'Call',
    tags: [],
    due: '2026-10-17',
  },
  { body: 'Call 📅 2026-10-15', initial: { due: { type: 'clear' } }, title: 'Call', tags: [] },
  {
    body: 'Call #Work #work #other',
    initial: { tags: { add: ['#WORK'] } },
    title: 'Call',
    tags: ['#Work', '#other'],
  },
  {
    body: 'Call #new/tag',
    initial: { tags: { add: ['#task/inbox'] } },
    title: 'Call',
    tags: ['#new/tag'],
  },
  { body: 'Call 📅 nope', invalid: 'invalid-date' },
  { body: 'Call', initial: { tags: { add: ['#broken/'] } }, invalid: 'invalid-target' },
];
function agreementTags(
  tags: readonly string[],
  prefixed: boolean,
  inbox: boolean,
  removeInbox: boolean,
): readonly string[] {
  return [
    ...(prefixed && !inbox ? ['#prefix'] : []),
    ...tags,
    ...(inbox && !removeInbox ? ['#task/inbox'] : []),
  ];
}
async function expectInvalidAgreement(
  h: Awaited<ReturnType<typeof harness>>,
  session: Awaited<ReturnType<TaskApplicationService['planCreate']>>,
  request: TaskCreateRequest,
  invalid: { readonly issueCode: string; readonly before: string | undefined },
): Promise<void> {
  const preview = session.preview(request);
  expect(preview.type).toBe('invalid');
  if (preview.type === 'invalid')
    expect(preview.issues.map((issue) => issue.code)).toContain(invalid.issueCode);
  expect((await session.execute(request)).type).toBe('invalid');
  expect(h.repository.content('tasks.md')).toBe(invalid.before);
  expect(h.repositoryWrites).toHaveLength(0);
}

describe('canonical agreement independent oracles', () => {
  it('retains malformed raw due literal from seed 2026101305 path 2:1:1:1', async () => {
    const h = await harness({ removeInbox: false });
    const session = await h.service.planCreate({ type: 'configured-default' });
    const request = { markdownBody: 'alpha 📅 nope' };
    expect(session.preview(request)).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-date', field: 'due' }],
    });
    expect((await session.execute(request)).type).toBe('invalid');
    expect(h.repository.content('tasks.md')).toBe('');
    expect(h.repositoryWrites).toHaveLength(0);
  });
  it('compares 250 previews with independent literal fixtures and actual saved codec bytes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...agreementCases),
        fc
          .array(fc.constantFrom('alpha', 'Бета', '👩‍💻', 'code', 'link'), {
            minLength: 1,
            maxLength: 5,
          })
          .map((words) => words.join(' ')),
        fc.boolean(),
        fc.boolean(),
        async (row, title, prefixed, removeInbox) => {
          const h = await harness({ prefix: prefixed ? '#prefix' : '', removeInbox });
          const session = await h.service.planCreate(
            { type: 'configured-default' },
            row.body.includes('#new/tag') ? { intent: 'inbox' } : undefined,
          );
          const request: TaskCreateRequest = {
            markdownBody: row.body.replace('Call', title),
            ...(row.initial !== undefined && { initial: row.initial }),
          };
          const before = h.repository.content('tasks.md');
          const preview = session.preview(request);
          expect(vi.spyOn(h.repository, 'create')).not.toHaveBeenCalled();
          expect(h.repositoryWrites).toHaveLength(0);
          if (row.invalid !== undefined) {
            await expectInvalidAgreement(h, session, request, { issueCode: row.invalid, before });
          } else {
            const inbox = row.body.includes('#new/tag');
            const tags = agreementTags(row.tags ?? [], prefixed, inbox, removeInbox);
            const planning = row.due === undefined ? {} : { due: row.due };
            expect(preview).toMatchObject({
              type: 'valid',
              metadata: { markdownTitle: title, tags, planning, priority: 'D' },
            });
            expect((await session.execute(request)).type).toBe('ok');
            expect(vi.spyOn(h.repository, 'create')).toHaveBeenCalledOnce();
            const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
            expect(root.markdownTitle).toBe(title);
            expect(root.tags).toEqual(tags);
            expect(root.planning).toEqual({ ...planning, created: '2026-10-13' });
            if (preview.type === 'valid') {
              expect(root.tags).toEqual(preview.metadata.tags);
              expect(root.markdownTitle).toBe(preview.metadata.markdownTitle);
              expect(root.planning).toMatchObject(preview.metadata.planning);
            }
          }
        },
      ),
      { numRuns: 250, seed: 2026101305 },
    );
  });
});

describe('Q canonical source priority and final boundaries', () => {
  it('keeps raw explicit and manual roles above context and previews configured policy before final request', async () => {
    const h = await smartHarness(
      { prefix: '📅 2026-10-17' },
      {
        inbox: false,
        initial: { due: { type: 'set', value: localDate('2026-10-13') } },
        markdownPrefix: '#context',
      },
    );
    h.controller.setDraft('Call tomorrow');
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: {
        markdownTitle: 'Call tomorrow',
        tags: ['#context'],
        planning: { due: '2026-10-17' },
      },
    });
    h.controller.setDraft('Call tomorrow 📅 2026-10-18');
    expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toHaveLength(0);
    const plain = await smartHarness(
      {},
      {
        inbox: false,
        initial: { due: { type: 'set', value: localDate('2026-10-13') } },
        markdownPrefix: '#context',
      },
    );
    plain.controller.setDraft('Call tomorrow 📅 2026-10-18');
    expect(plain.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { planning: { due: '2026-10-18' } },
    });
    plain.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-20'),
    });
    await plain.controller.submit('enter');
    expect(plain.execute.mock.calls[0]?.[0].markdownBody).toBe(
      '#context Call tomorrow 📅 2026-10-18',
    );
    const root = plain.readCanonicalRoot(expectDefined(plain.repositoryWrites[0]));
    expect(root.planning.due).toBe('2026-10-20');
    expect(root.tags).toEqual(['#context']);
  });
  it('uses literal priority and source invalid description without attempting a write', async () => {
    const h = await smartHarness();
    h.controller.setDraft('Call tomorrow 🔺');
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { priority: 'A' },
    });
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).priority).toBe('A');
    h.controller.setDraft('Call 📅 nope');
    expect(h.controller.snapshot().error?.message).toBe(
      'The new task is invalid and was not created.',
    );
    await h.controller.submit('enter');
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().error?.message).toBe(
      'The new task is invalid and was not created.',
    );
  });
  it.each(['result', 'description'] as const)(
    'success stays committed when %s presentation throws',
    async (kind) => {
      const h = await smartHarness();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      if (kind === 'result')
        h.onResult.mockImplementation(() => {
          throw new Error('private');
        });
      else
        h.describeResult.mockImplementation(() => {
          throw new Error('private');
        });
      h.controller.setDraft('Call tomorrow');
      await h.controller.submit('enter');
      expect(h.controller.snapshot().draft).toBe('');
      expect(h.controller.snapshot().phase).toBe('idle');
      await h.controller.submit('enter');
      await h.controller.submit('blur');
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.repositoryWrites).toHaveLength(1);
      expect(log.mock.calls.flat().join(' ')).not.toContain('private');
      log.mockRestore();
    },
  );
  it('freezes a draft through midnight and reads the new civil day after success', async () => {
    const h = await smartHarness();
    h.readReference.mockReturnValue({ ...reference, localTime: localTime('23:59') });
    h.controller.setDraft('Call tomorrow');
    h.readReference.mockReturnValue({
      ...reference,
      localDate: localDate('2026-10-14'),
      localTime: localTime('00:01'),
      epochMs: reference.epochMs + 86400000,
    });
    h.controller.setDraft('Call again tomorrow');
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).planning.due).toBe(
      '2026-10-14',
    );
    h.controller.setDraft('Next tomorrow');
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { planning: { due: '2026-10-15' } },
    });
    expect(h.readReference).toHaveBeenCalledTimes(2);
  });
  it('blocks real missing preview capability and never falls back to plain writing', async () => {
    const h = await smartHarness({ noPort: true });
    h.controller.setDraft('Call tomorrow');
    await h.controller.submit('enter');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.repositoryWrites).toHaveLength(0);
    expect(h.controller.snapshot().metadata?.preview).toEqual({
      type: 'unavailable',
      cause: 'preview-capability',
    });
  });
});

it('normalizes words-as-tags literal from seed 2026101305 path 3:1', async () => {
  const h = await harness({ removeInbox: false });
  const session = await h.service.planCreate({ type: 'configured-default' });
  const request = { markdownBody: 'alpha', initial: { tags: { add: ['invalid tag'] } } };
  expect(session.preview(request)).toMatchObject({
    type: 'valid',
    metadata: { markdownTitle: 'alpha', tags: ['#invalid', '#tag'] },
  });
  expect((await session.execute(request)).type).toBe('ok');
  expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual([
    '#invalid',
    '#tag',
  ]);
});

it('clears unknown recovery when the capture closes', async () => {
  const h = await smartHarness();
  h.execute.mockRejectedValueOnce(new Error('private'));
  h.controller.setDraft('Call tomorrow');
  await h.controller.submit('enter');
  expect(h.controller.snapshot().metadata?.needsCheckedRetry).toBe(true);
  h.controller.escape();
  expect(h.controller.snapshot().phase).toBe('closed');
  expect(h.controller.snapshot().metadata?.needsCheckedRetry).toBe(false);
});

describe('metadata-only canonical source removals', () => {
  it.each([true, false])(
    'removes typed duplicates before Inbox policy, Inbox dismissed %s',
    async (dismissInbox) => {
      const h = await smartHarness();
      h.controller.setDraft('Call');
      if (dismissInbox)
        h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#task/inbox' });
      const raw = 'Call #work #WORK';
      h.controller.setDraft(raw);
      h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#work' });
      expect(h.controller.snapshot().draft).toBe(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { tags: dismissInbox ? [] : ['#task/inbox'] },
      });
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).tags).toEqual(
        dismissInbox ? [] : ['#task/inbox'],
      );
      expect(h.repositoryWrites[0]).not.toMatch(/#work/iu);
    },
  );
  it.each(['📅 2026-10-21 Call 📅 2026-10-20', 'Call 📅 2026-10-20 📅 2026-10-21'])(
    'preflights new active carriers through actual source validation: %s',
    async (raw) => {
      const h = await smartHarness({ prefix: 'Prefix' }, { inbox: false, initial: {} });
      h.controller.setDraft('Call 📅 2026-10-20');
      h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
      h.controller.setDraft(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { planning: { due: '2026-10-21' } },
      });
      await h.controller.submit('enter');
      const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(root.planning.due).toBe('2026-10-21');
      expect(root.markdownTitle).toBe('Prefix Call');
    },
  );
  it.each(['Call 📅 nope', 'Call 📅 2026-10-21 📅 2026-10-22'])(
    'never hides changed invalid or active duplicate metadata: %s',
    async (raw) => {
      const h = await smartHarness();
      h.controller.setDraft('Call 📅 2026-10-20');
      h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
      h.controller.setDraft(raw);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toEqual([]);
      expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
    },
  );
  it('stages IME changes against one precomposition suppression baseline', async () => {
    const h = await smartHarness();
    const raw = 'Call tomorrow';
    h.controller.setDraft(raw);
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    h.recognize.mockClear();
    h.controller.setDraft('Call tom', { deferRecognition: true, editKind: 'composition' });
    h.controller.setDraft(raw, { deferRecognition: true, editKind: 'composition' });
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-22'),
    });
    expect(h.recognize).not.toHaveBeenCalled();
    h.controller.flushRecognition();
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: raw, planning: {} },
    });
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).planning.due).toBeUndefined();
  });
});

for (const editKind of ['paste', 'composition', 'history'] as const) {
  it.each([
    ['Call 📅 2026-10-20 📅 2026-10-20', 'Call 📅 2026-10-20'],
    ['📅 2026-10-20 Call 📅 2026-10-20', '📅 2026-10-20 Call'],
  ])(`saves only the new identical canonical carrier after ${editKind}: %s`, async (raw, body) => {
    const h = await smartHarness({ prefix: 'Prefix' }, { inbox: false, initial: {} });
    h.controller.setDraft('Call 📅 2026-10-20');
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    h.preview.mockClear();
    h.controller.setDraft(raw, { editKind, deferRecognition: true });
    h.controller.flushRecognition();
    const snapshot = h.controller.snapshot();
    expect(snapshot.draft).toBe(raw);
    expect(h.preview.mock.calls[0]?.[0].markdownBody).toBe(body);
    expect(snapshot.metadata?.projection?.markdownBody).toBe(body);
    expect(snapshot.metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Prefix Call', planning: { due: '2026-10-20' } },
    });
    await h.controller.submit('enter');
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.repositoryWrites).toHaveLength(1);
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
      markdownTitle: 'Prefix Call',
      planning: { due: '2026-10-20' },
    });
    expect(h.repositoryWrites[0]?.match(/📅 2026-10-20/gu)).toHaveLength(1);
  });
}

it.each([
  'Call tomorrow at 14:00 PST',
  'Call tomorrow at 14:00 pst',
  'Call tomorrow at 14:00 PsT',
  'Позвонить завтра в 14:00 MSK',
  'Позвонить завтра в 14:00 msk',
  'Позвонить завтра в 14:00 MsK',
])('writes timezone-qualified wording unchanged: %s', async (raw) => {
  const h = await smartHarness();
  h.controller.setDraft(raw);
  await h.controller.submit('enter');
  const saved = h.readCanonicalRoot(h.repositoryWrites[0] ?? '');
  expect(saved.markdownTitle).toBe(raw);
  expect(saved.planning.due).toBeUndefined();
  expect(saved.planning.time).toBeUndefined();
  expect(h.execute.mock.calls[0]?.[0].markdownBody).toBe(raw);
});

it.each([
  ['2026-10-17', 'Call last Friday', '2026-10-16', 'Call'],
  ['2026-10-17', 'Позвонить в прошлую пятницу', '2026-10-16', 'Позвонить'],
  ['2026-10-19', 'Call last Sunday', '2026-10-18', 'Call'],
  ['2026-10-19', 'Позвонить в воскресенье на прошлой неделе', '2026-10-18', 'Позвонить'],
])('writes the nearest past weekday at %s: %s', async (day, raw, due, title) => {
  const h = await smartHarness();
  h.readReference.mockReturnValue({
    ...reference,
    epochMs: Date.parse(`${day}T12:00:00+07:00`),
    localDate: localDate(day),
  });
  h.controller.setDraft(raw);
  await h.controller.submit('enter');
  const saved = h.readCanonicalRoot(h.repositoryWrites[0] ?? '');
  expect(saved.markdownTitle).toBe(title);
  expect(saved.planning.due).toBe(due);
});

describe('Q caption capitalization after a consumed natural prefix', () => {
  it.each<[string, string, string, { due?: string; time?: string }]>([
    [
      'Завтра в 10:00 приём у стоматолога',
      'приём у стоматолога',
      'Приём у стоматолога',
      { due: '2026-10-14', time: '10:00' },
    ],
    ['Tomorrow call a friend #work', 'call a friend #work', 'Call a friend', { due: '2026-10-14' }],
    [
      'Tomorrow at 10:00 call a friend',
      'call a friend',
      'Call a friend',
      { due: '2026-10-14', time: '10:00' },
    ],
    ['tomorrow call a friend', 'call a friend', 'call a friend', { due: '2026-10-14' }],
    ['call a friend Tomorrow', 'call a friend', 'call a friend', { due: '2026-10-14' }],
    ['Tomorrow iOS update', 'iOS update', 'iOS update', { due: '2026-10-14' }],
    ['Tomorrow eBay listing', 'eBay listing', 'eBay listing', { due: '2026-10-14' }],
    ['Tomorrow i18nAPI update', 'i18nAPI update', 'i18nAPI update', { due: '2026-10-14' }],
    ['Tomorrow i-Phone update', 'i-Phone update', 'i-Phone update', { due: '2026-10-14' }],
    ['Tomorrow `call` a friend', '`call` a friend', '`call` a friend', { due: '2026-10-14' }],
    [
      'Tomorrow [call](https://example.com) a friend',
      '[call](https://example.com) a friend',
      '[call](https://example.com) a friend',
      { due: '2026-10-14' },
    ],
    ['Tomorrow "call" a friend', '"call" a friend', '"call" a friend', { due: '2026-10-14' }],
    ["Tomorrow 'call' a friend", "'call' a friend", "'call' a friend", { due: '2026-10-14' }],
    ['Tomorrow ßeta task', 'ßeta task', 'ßeta task', { due: '2026-10-14' }],
    ['Tomorrow 𐐨eta task', '𐐨eta task', '𐐀eta task', { due: '2026-10-14' }],
    ['Tomorrow élan task', 'élan task', 'Élan task', { due: '2026-10-14' }],
    ['Tomorrow , call a friend', ', call a friend', ', call a friend', { due: '2026-10-14' }],
    ['Tomorrow – call a friend', '– call a friend', '– call a friend', { due: '2026-10-14' }],
    [
      'Tomorrow at 10:00 PST call a friend',
      'Tomorrow at 10:00 PST call a friend',
      'Tomorrow at 10:00 PST call a friend',
      {},
    ],
    [
      'Tomorrow and Friday call a friend',
      'Tomorrow and Friday call a friend',
      'Tomorrow and Friday call a friend',
      {},
    ],
    [
      'Tomorrow 📅 2026-10-20 call a friend',
      'Tomorrow 📅 2026-10-20 call a friend',
      'Tomorrow call a friend',
      { due: '2026-10-20' },
    ],
  ])(
    'preserves raw and neutral projection while preview and writer agree: %s',
    async (raw, body, title, planning) => {
      const h = await smartHarness();
      h.controller.setDraft(raw);
      const snapshot = h.controller.snapshot();
      expect(snapshot.draft).toBe(raw);
      expect(snapshot.metadata?.projection?.markdownBody).toBe(body);
      expect(snapshot.metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { markdownTitle: title, planning },
      });
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
        markdownTitle: title,
      });
      const saved = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(saved.planning.due).toBe(planning.due);
      expect(saved.planning.time).toBe(planning.time);
      const request = expectDefined(h.execute.mock.calls[0]?.[0]);
      expect(h.preview.mock.calls[h.preview.mock.calls.length - 1]?.[0]).toEqual(request);
      expect(saved.tags).toEqual(raw.includes('#work') ? ['#work'] : ['#task/inbox']);
    },
  );

  it.each(['due', 'time'] as const)(
    'keeps the original compound literal after %s dismissal and capitalizes after Restore',
    async (role) => {
      const h = await smartHarness();
      const raw = 'Завтра в 10:00 приём у стоматолога';
      h.controller.setDraft(raw);
      h.controller.applyMetadataAction({ type: 'dismiss', role });
      expect(h.controller.snapshot().draft).toBe(raw);
      expect(h.controller.snapshot().metadata?.projection?.markdownBody).toBe(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { markdownTitle: raw },
      });
      await h.controller.submit('enter');
      expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).markdownTitle).toBe(raw);
      const restored = await smartHarness();
      restored.controller.setDraft(raw);
      restored.controller.applyMetadataAction({ type: 'dismiss', role });
      restored.controller.applyMetadataAction({ type: 'restore' });
      expect(restored.controller.snapshot().metadata?.projection?.markdownBody).toBe(
        'приём у стоматолога',
      );
      expect(restored.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { markdownTitle: 'Приём у стоматолога' },
      });
      await restored.controller.submit('enter');
      expect(
        restored.readCanonicalRoot(expectDefined(restored.repositoryWrites[0])).markdownTitle,
      ).toBe('Приём у стоматолога');
    },
  );

  it.each([
    '📅 2026-10-20 call a friend',
    '#work Tomorrow call a friend',
    'Tomorrow #work call a friend',
  ])('never treats canonical or tag removal as natural prefix proof: %s', async (raw) => {
    const h = await smartHarness({}, { inbox: false, initial: {} });
    h.controller.setDraft(raw);
    if (raw.includes('#work'))
      h.controller.applyMetadataAction({ type: 'remove-tag', tag: '#work' });
    else h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    expect(h.controller.snapshot().draft).toBe(raw);
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'call a friend' },
    });
    await h.controller.submit('enter');
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).markdownTitle).toBe(
      'call a friend',
    );
  });

  it('keeps the normalized request and planning frozen through an unchanged write failure', async () => {
    const h = await smartHarness();
    vi.spyOn(h.repository, 'create').mockResolvedValueOnce({
      type: 'io-error',
      cause: 'process-error',
      contentState: 'unchanged',
    });
    const raw = 'Завтра в 10:00 приём у стоматолога';
    h.controller.setDraft(raw);
    const previewRequest = structuredClone(
      expectDefined(h.preview.mock.calls[h.preview.mock.calls.length - 1]?.[0]),
    );
    expect(previewRequest.markdownBody).toBe('Приём у стоматолога');
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toEqual([]);
    expect(h.controller.snapshot().draft).toBe(raw);
    h.readReference.mockReturnValue({ ...reference, localDate: localDate('2026-10-20') });
    await h.controller.submit('blur');
    await h.controller.submit('enter');
    expect(h.execute.mock.calls.map(([request]) => request)).toEqual([
      previewRequest,
      previewRequest,
    ]);
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
      markdownTitle: 'Приём у стоматолога',
      planning: { due: '2026-10-14', time: '10:00' },
    });
    expect(h.readReference).toHaveBeenCalledOnce();
  });

  it('keeps the normalized frozen request through an unknown outcome and checked retry', async () => {
    const h = await smartHarness();
    vi.spyOn(h.repository, 'create').mockResolvedValueOnce({
      type: 'io-error',
      cause: 'process-error',
      contentState: 'unknown',
    });
    h.controller.setDraft('Tomorrow call a friend');
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toEqual([]);
    expect(h.controller.snapshot().metadata?.needsCheckedRetry).toBe(true);
    h.readReference.mockReturnValue({ ...reference, localDate: localDate('2026-10-20') });
    await h.controller.submit('enter');
    expect(h.repositoryWrites).toEqual([]);
    await h.controller.confirmCheckedRetry();
    expect(h.execute.mock.calls.map(([request]) => request.markdownBody)).toEqual([
      'Call a friend',
      'Call a friend',
    ]);
    expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]))).toMatchObject({
      markdownTitle: 'Call a friend',
      planning: { due: '2026-10-14' },
    });
  });

  it('preserves smart-off Q and non-Q captions', async () => {
    const raw = 'Tomorrow call a friend';
    const off = await smartHarness();
    off.enabled.mockReturnValue(false);
    off.controller.setDraft(raw);
    expect(off.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: raw, planning: {} },
    });
    await off.controller.submit('enter');
    expect(off.readCanonicalRoot(expectDefined(off.repositoryWrites[0])).markdownTitle).toBe(raw);
    const plain = await harness();
    const session = await plain.service.planCreate({ type: 'configured-default' });
    const controller = new TaskCaptureController({
      target: {
        label: 'Task',
        context: { type: 'default', source: 'calendar' },
        session,
        markdownPrefix: '',
        markdownSuffixes: [],
      },
      describe: describeTaskCreationResult,
      onResult: () => {},
      onRequestClose: () => {},
    });
    controller.setDraft(raw);
    await controller.submit('enter');
    expect(plain.readCanonicalRoot(expectDefined(plain.repositoryWrites[0])).markdownTitle).toBe(
      raw,
    );
  });

  it('conserves title bytes except the first letter across bounded whitespace and word lengths', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom('a', 'b', 'c', 'я'), { minLength: 1, maxLength: 24 })
          .map((letters) => letters.join('')),
        fc.constantFrom('', ' ', '\t', ' \t '),
        fc.constantFrom(' ', '  ', '\t', ' \t  '),
        fc.constantFrom('', ' ', '\t '),
        async (word, before, gap, after) => {
          const h = await smartHarness();
          const title = `${word} remaining text`;
          const raw = `${before}Tomorrow${gap}${title}${after}`;
          h.controller.setDraft(raw);
          const neutral = `${before}${gap.slice(1)}${title}${after}`;
          const normalized = `${word[0]?.toUpperCase()}${word.slice(1)} remaining text`;
          expect(h.controller.snapshot().draft).toBe(raw);
          expect(h.controller.snapshot().metadata?.projection?.markdownBody).toBe(neutral);
          expect(h.controller.snapshot().metadata?.preview).toMatchObject({
            type: 'valid',
            metadata: { markdownTitle: normalized, planning: { due: '2026-10-14' } },
          });
          await h.controller.submit('enter');
          expect(h.readCanonicalRoot(expectDefined(h.repositoryWrites[0])).markdownTitle).toBe(
            normalized,
          );
          expect(h.execute.mock.calls[0]?.[0].markdownBody).toBe(normalized);
        },
      ),
      { seed: 2026101311, numRuns: 32 },
    );
  });
});
