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
import { TaskCaptureController } from '../../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../../src/ui/taskCommandResult';

const reference = {
  epochMs: Date.parse('2026-10-13T12:00:00+07:00'),
  localDate: localDate('2026-10-13'),
  localTime: localTime('12:00'),
  second: 0,
  offsetMinutes: 420,
};
async function smartHarness(
  options: Parameters<typeof harness>[0] = {},
  input: {
    readonly inbox?: boolean;
    readonly initial?: TaskCreateRequest['initial'];
    readonly markdownPrefix?: string;
  } = {},
) {
  const real = await harness(options);
  const session = await real.service.planCreate(
    { type: 'configured-default' },
    input.inbox === false ? undefined : { intent: 'inbox' },
  );
  const recognizer = new ChronoTaskInputRecognizer();
  const recognize = vi.spyOn(recognizer, 'recognize');
  const readReference = vi.fn(() => reference);
  const enabled = vi.fn(() => true);
  const onRecognitionFailure = vi.fn();
  const preview = vi.spyOn(session, 'preview');
  const execute = vi.spyOn(session, 'execute');
  const onResult = vi.fn();
  const describeResult = vi.fn(describeTaskCreationResult);
  const controller = new TaskCaptureController({
    target: {
      label: 'Inbox',
      context: { type: 'list', selection: 'inbox' },
      session,
      markdownPrefix: input.markdownPrefix ?? '',
      markdownSuffixes: [],
      initial: input.initial ?? { tags: { add: ['#task/inbox'] } },
    },
    smart: { recognizer, readReference, enabled, onRecognitionFailure },
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
