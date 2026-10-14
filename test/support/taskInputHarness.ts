import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import { projectTaskInput } from '../../src/tasks/domain/taskInputProjection';
import type { TaskInputState } from '../../src/tasks/domain/taskInputState';
import type { TaskInputInitial, TaskInputReference } from '../../src/tasks/domain/taskInputTypes';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { ChronoTaskInputRecognizer } from '../../src/tasks/infrastructure/input/ChronoTaskInputRecognizer';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from '../helpers';
export const reference: TaskInputReference = {
  epochMs: 1791867600000,
  localDate: localDate('2026-10-13'),
  localTime: localTime('12:00'),
  second: 0,
  offsetMinutes: 420,
};
export const recognizer = new ChronoTaskInputRecognizer();
export const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
export function project(state: TaskInputState, contextInitial?: TaskInputInitial) {
  const inspection = inspectTaskInput(state.raw);
  return projectTaskInput({
    state,
    reference,
    inspection,
    sourcePlanning: {},
    candidates: recognizer.recognize({
      text: state.raw,
      reference,
      protectedRanges: inspection.protectedRanges,
    }),
    ...(contextInitial === undefined ? {} : { contextInitial }),
  });
}

import { vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { TaskCreateRequest } from '../../src/tasks/application/TaskApplicationApi';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskBehaviorSettings } from '../../src/tasks/application/TaskBehaviorSettings';
import type { TaskCreatePreviewPort } from '../../src/tasks/application/TaskCreatePreviewPort';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { MarkdownTaskCreatePreview } from '../../src/tasks/infrastructure/markdown/MarkdownTaskCreatePreview';
import { createAppWithFiles, taskQueryApi } from '../helpers';
import { InMemoryTaskRepository } from './InMemoryTaskRepository';

import type { RecurrenceInputParser } from '../../src/tasks/application/RecurrenceInputParser';
export async function captureHarness(
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

import {
  CaptureTargetResolver,
  type CaptureContext,
  type CaptureTarget,
} from '../../src/ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../../src/ui/taskCommandResult';

const captureReference = {
  epochMs: Date.parse('2026-10-13T12:00:00+07:00'),
  localDate: localDate('2026-10-13'),
  localTime: localTime('12:00'),
  second: 0,
  offsetMinutes: 420,
};
interface SmartCaptureInput {
  readonly inbox?: boolean;
  readonly recurrence?: RecurrenceInputParser;
  readonly reference?: TaskInputReference;
  readonly initial?: TaskCreateRequest['initial'];
  readonly markdownPrefix?: string;
  readonly resolveContext?: CaptureContext;
  readonly previewFailureCallback?: boolean;
}
async function smartTarget(
  real: Awaited<ReturnType<typeof captureHarness>>,
  input: SmartCaptureInput,
): Promise<CaptureTarget> {
  if (input.resolveContext !== undefined)
    return await new CaptureTargetResolver(
      real.service,
      { ...DEFAULT_SETTINGS, inbox: real.behavior.inbox },
      () => captureReference.localDate,
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
export async function smartHarness(
  options: Parameters<typeof captureHarness>[0] = {},
  input: SmartCaptureInput = {},
) {
  const real = await captureHarness(options);
  const target = await smartTarget(real, input);
  const session = target.session;
  const recognizer = new ChronoTaskInputRecognizer();
  const recognize = vi.spyOn(recognizer, 'recognize');
  const readReference = vi.fn(() => input.reference ?? captureReference);
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
      ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
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
