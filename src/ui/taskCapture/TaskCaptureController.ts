import {
  applyTaskInputAction,
  createTaskInputState,
  editTaskInput,
  inspectTaskInput,
  projectTaskInput,
  projectTaskInputContext,
  taskInputPreflightBody,
  taskInputPreflightInitial,
  type TaskCommandResult,
  type TaskCreateContextPreview,
  type TaskCreatePreview,
  type TaskCreateRequest,
  type TaskInputAction,
  type TaskInputProjection,
  type TaskInputReference,
  type TaskInputServices,
  type TaskInputState,
} from '../../tasks';
import { describeTaskCreationResult, type CreationResultDescription } from '../taskCommandResult';
import { commandBodyForCapture, type CaptureTarget } from './CaptureTargetResolver';

export interface CaptureSmartOptions extends TaskInputServices {
  readonly enabled: () => boolean;
  readonly onRecognitionFailure: () => void;
  readonly onPreviewFailure?: (phase: 'context' | 'draft') => void;
}
export interface CaptureMetadataSnapshot {
  readonly referenceDate?: TaskInputReference['localDate'];
  readonly destination?: {
    readonly filePath: string;
    readonly inbox: boolean;
    readonly representedInboxTag?: string;
  };
  readonly preview: TaskCreatePreview;
  readonly context?: TaskCreateContextPreview;
  readonly projection?: TaskInputProjection;
  readonly canRestore: boolean;
  readonly recognitionError?: string;
  readonly needsCheckedRetry: boolean;
}
interface FrozenCaptureSubmission {
  readonly request: TaskCreateRequest;
  readonly state: TaskInputState;
  readonly reference: TaskInputReference;
}
interface ContextRead {
  readonly context: TaskCreateContextPreview;
  readonly preview: TaskCreatePreview;
  readonly projection?: TaskInputProjection;
}
function missingTitlePreview(): TaskCreatePreview {
  return { type: 'invalid', issues: [{ code: 'invalid-title', field: 'title' }] };
}
function readyMetadata(
  preview: TaskCreatePreview,
  context: TaskCreateContextPreview | undefined,
):
  | Extract<TaskCreatePreview, { type: 'valid' }>
  | Extract<TaskCreateContextPreview, { type: 'ready' }>
  | undefined {
  if (preview.type === 'valid') return preview;
  return context?.type === 'ready' ? context : undefined;
}
function unsupportedContext(context: TaskCreateContextPreview | undefined): boolean {
  return (
    context === undefined ||
    (context.type === 'unavailable' && context.cause === 'preview-capability')
  );
}
function detachFrozen<T>(value: T): T {
  const detached = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(detached);
  return detached;
}

function missingTitleOnly(preview: TaskCreatePreview): boolean {
  return (
    preview.type === 'invalid' && preview.issues.every((issue) => issue.code === 'invalid-title')
  );
}

function canProjectEmptyInput(state: TaskInputState, preview: TaskCreatePreview): boolean {
  return state.raw.trim().length === 0 && missingTitleOnly(preview);
}

type CaptureEditKind = 'input' | 'paste' | 'composition' | 'history';

export type CapturePhase = 'idle' | 'submitting' | 'error' | 'closed';
export type CaptureSubmitCause = 'enter' | 'blur';

export interface CaptureSnapshot {
  readonly phase: CapturePhase;
  readonly draft: string;
  readonly readonly: boolean;
  readonly ariaBusy: boolean;
  readonly focusEpoch: number;
  readonly error?: CreationResultDescription;
  readonly metadata?: CaptureMetadataSnapshot;
}

export interface CaptureObserver {
  (snapshot: CaptureSnapshot): void;
}

export interface TaskCaptureControllerOptions {
  readonly smart?: CaptureSmartOptions;
  readonly target: CaptureTarget;
  readonly onSubmit?: () => void;
  readonly describe: typeof describeTaskCreationResult;
  readonly onResult: (result: TaskCommandResult, description: CreationResultDescription) => void;
  readonly onRequestClose: () => void;
}

interface CaptureSubmission {
  readonly cause: CaptureSubmitCause;
  readonly draft: string;
  readonly token: number;
}

export class TaskCaptureController {
  readonly target: CaptureTarget;

  private phase_abyssPrivate: CapturePhase = 'idle';
  private draft_abyssPrivate = '';
  private focusEpoch_abyssPrivate = 0;
  private error_abyssPrivate: CreationResultDescription | undefined;
  private readonly observers_abyssPrivate = new Set<CaptureObserver>();
  private readonly onSubmit_abyssPrivate: TaskCaptureControllerOptions['onSubmit'];
  private readonly describe_abyssPrivate: typeof describeTaskCreationResult;
  private readonly onResult_abyssPrivate: TaskCaptureControllerOptions['onResult'];
  private readonly onRequestClose_abyssPrivate: TaskCaptureControllerOptions['onRequestClose'];
  private submissionToken_abyssPrivate = 0;
  private closeAfterSuccess_abyssPrivate = false;
  private destroyed_abyssPrivate = false;

  private readonly smart_abyssPrivate: CaptureSmartOptions | undefined;
  private state_abyssPrivate = createTaskInputState();
  private compositionBaseline_abyssPrivate: TaskInputState | undefined;
  private reference_abyssPrivate: TaskInputReference | undefined;
  private enabled_abyssPrivate = false;
  private metadata_abyssPrivate: CaptureMetadataSnapshot | undefined;
  private frozen_abyssPrivate: FrozenCaptureSubmission | undefined;
  private recognitionPending_abyssPrivate = false;
  private recognitionFailureRevision_abyssPrivate: number | undefined;
  private readonly previewFailureRevisions_abyssPrivate = new Map<'context' | 'draft', number>();
  private ownedSeed_abyssPrivate = false;
  private needsCheckedRetry_abyssPrivate = false;
  private requiresEnter_abyssPrivate = false;

  constructor(options: TaskCaptureControllerOptions) {
    this.target = options.target;
    this.smart_abyssPrivate = options.smart;
    this.state_abyssPrivate = createTaskInputState(this.target.draftSeed ?? '');
    this.draft_abyssPrivate = this.target.draftSeed ?? '';
    this.onSubmit_abyssPrivate = options.onSubmit;
    this.describe_abyssPrivate = options.describe;
    this.onResult_abyssPrivate = options.onResult;
    this.onRequestClose_abyssPrivate = options.onRequestClose;
    this.ownedSeed_abyssPrivate = this.target.draftSeed !== undefined;
    if (this.smart_abyssPrivate !== undefined) this.refreshContext_abyssPrivate();
  }

  snapshot(): CaptureSnapshot {
    return {
      phase: this.phase_abyssPrivate,
      draft: this.raw_abyssPrivate(),
      readonly: this.phase_abyssPrivate === 'submitting',
      ariaBusy: this.phase_abyssPrivate === 'submitting',
      focusEpoch: this.focusEpoch_abyssPrivate,
      ...(this.error_abyssPrivate !== undefined && { error: this.error_abyssPrivate }),
      ...(this.smart_abyssPrivate !== undefined && { metadata: this.smartMetadata_abyssPrivate() }),
    };
  }

  subscribe(observer: CaptureObserver): { release(): void } {
    if (!this.destroyed_abyssPrivate) this.observers_abyssPrivate.add(observer);
    observer(this.snapshot());
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.observers_abyssPrivate.delete(observer);
      },
    };
  }

  setDraft(
    value: string,
    options?: {
      readonly deferRecognition?: boolean;
      readonly editKind?: CaptureEditKind;
    },
  ): void {
    if (
      this.destroyed_abyssPrivate ||
      this.phase_abyssPrivate === 'submitting' ||
      this.phase_abyssPrivate === 'closed'
    )
      return;
    if (this.smart_abyssPrivate !== undefined) {
      this.setSmartDraft_abyssPrivate(value, options);
      return;
    }
    if (value === this.draft_abyssPrivate && this.phase_abyssPrivate !== 'error') return;
    this.draft_abyssPrivate = value;
    this.phase_abyssPrivate = 'idle';
    this.error_abyssPrivate = undefined;
    this.emit_abyssPrivate();
  }

  private setSmartDraft_abyssPrivate(
    value: string,
    options?: {
      readonly deferRecognition?: boolean;
      readonly editKind?: CaptureEditKind;
    },
  ): void {
    if (value === this.state_abyssPrivate.raw) return;
    this.ownedSeed_abyssPrivate = false;
    this.editSmartDraft_abyssPrivate(value, options);
    this.frozen_abyssPrivate = undefined;
    this.phase_abyssPrivate = 'idle';
    this.error_abyssPrivate = undefined;
    if (value.trim().length > 0) this.freezeReference_abyssPrivate();
    this.recognitionPending_abyssPrivate = true;
    if (
      (this.hasContextInput_abyssPrivate() || options?.deferRecognition !== true) &&
      this.compositionBaseline_abyssPrivate === undefined
    )
      this.refreshSmart_abyssPrivate();
    this.emit_abyssPrivate();
  }

  private editSmartDraft_abyssPrivate(
    value: string,
    options?: {
      readonly deferRecognition?: boolean;
      readonly editKind?: 'input' | 'paste' | 'composition' | 'history';
    },
  ): void {
    if (options?.editKind === 'composition' && options.deferRecognition === true) {
      this.compositionBaseline_abyssPrivate ??= this.state_abyssPrivate;
      this.state_abyssPrivate = {
        ...this.state_abyssPrivate,
        raw: value,
        revision: this.state_abyssPrivate.revision + 1,
      };
    } else if (this.compositionBaseline_abyssPrivate !== undefined) {
      this.state_abyssPrivate = {
        ...this.state_abyssPrivate,
        raw: value,
        revision: this.state_abyssPrivate.revision + 1,
      };
    } else
      this.state_abyssPrivate = editTaskInput(this.state_abyssPrivate, value, options?.editKind);
  }

  isEmpty(): boolean {
    const draft = this.raw_abyssPrivate().trim();
    return (
      draft.length === 0 ||
      (this.smart_abyssPrivate === undefined
        ? draft === this.target.draftSeed?.trim()
        : this.ownedSeed_abyssPrivate)
    );
  }

  async submit(cause: CaptureSubmitCause): Promise<void> {
    if (this.smart_abyssPrivate !== undefined) {
      await this.submitSmart_abyssPrivate(cause);
      return;
    }
    const submission = this.beginSubmission_abyssPrivate(cause);
    if (submission === undefined || this.isSubmissionObsolete_abyssPrivate(submission.token))
      return;
    const result = await this.target.session.execute({
      markdownBody: commandBodyForCapture(this.target, submission.draft),
      ...(this.target.initial !== undefined && { initial: this.target.initial }),
    });
    if (this.isSubmissionObsolete_abyssPrivate(submission.token)) return;
    this.finishSubmission_abyssPrivate(submission, result);
  }

  private raw_abyssPrivate(): string {
    return this.smart_abyssPrivate === undefined
      ? this.draft_abyssPrivate
      : this.state_abyssPrivate.raw;
  }

  private smartMetadata_abyssPrivate(): CaptureMetadataSnapshot {
    const { context: cachedContext, ...metadata }: Partial<CaptureMetadataSnapshot> =
      this.metadata_abyssPrivate ?? {};
    const preview = metadata.preview ?? missingTitlePreview();
    const context = this.hasContextInput_abyssPrivate() ? cachedContext : undefined;
    const destination = this.metadataDestination_abyssPrivate(preview, context);
    return {
      ...metadata,
      ...(context === undefined ? {} : { context }),
      ...(this.reference_abyssPrivate !== undefined && {
        referenceDate: this.reference_abyssPrivate.localDate,
      }),
      ...(destination === undefined ? {} : { destination }),
      preview,
      canRestore: this.state_abyssPrivate.restore !== undefined,
      needsCheckedRetry: this.needsCheckedRetry_abyssPrivate,
    };
  }

  private metadataDestination_abyssPrivate(
    preview: TaskCreatePreview,
    context: TaskCreateContextPreview | undefined,
  ): CaptureMetadataSnapshot['destination'] {
    if (this.target.session.type !== 'ready') return undefined;
    const filePath = this.target.session.destination.filePath;
    if (this.target.context.type !== 'list' || this.target.context.selection !== 'inbox')
      return { filePath, inbox: false };
    const value = readyMetadata(preview, context);
    const inbox =
      value === undefined
        ? this.legacyEmptyInbox_abyssPrivate(preview, context)
        : value.inbox?.member === true;
    const serviceTag = inbox ? value?.inbox?.serviceTag : undefined;
    return {
      filePath,
      inbox,
      ...(serviceTag === undefined ? {} : { representedInboxTag: serviceTag }),
    };
  }

  private legacyEmptyInbox_abyssPrivate(
    preview: TaskCreatePreview,
    context: TaskCreateContextPreview | undefined,
  ): boolean {
    return (
      this.state_abyssPrivate.raw.trim().length === 0 &&
      unsupportedContext(context) &&
      missingTitleOnly(preview)
    );
  }

  private hasContextInput_abyssPrivate(): boolean {
    return this.state_abyssPrivate.raw.trim().length === 0 || this.ownedSeed_abyssPrivate;
  }

  private previewFailure_abyssPrivate(phase: 'context' | 'draft'): void {
    const revision = this.state_abyssPrivate.revision;
    if (this.previewFailureRevisions_abyssPrivate.get(phase) === revision) return;
    this.previewFailureRevisions_abyssPrivate.set(phase, revision);
    try {
      if (this.smart_abyssPrivate?.onPreviewFailure !== undefined) {
        this.smart_abyssPrivate.onPreviewFailure(phase);
        return;
      }
    } catch {
      /* Preserve the inline failure even if presentation diagnostics fail. */
    }
    console.error(
      phase === 'context'
        ? '[abyss-tasks] Quick-capture context preview failed'
        : '[abyss-tasks] Quick-capture draft preview failed',
    );
  }

  private refreshContext_abyssPrivate(): void {
    if (this.smart_abyssPrivate === undefined || !this.hasContextInput_abyssPrivate()) return;
    const state = this.state_abyssPrivate;
    let reading: ContextRead;
    try {
      reading = this.readContext_abyssPrivate(inspectTaskInput(state.raw));
    } catch {
      reading = {
        context: { type: 'unavailable', cause: 'preview-capability' },
        preview: { type: 'unavailable', cause: 'preview-capability' },
      };
      this.previewFailure_abyssPrivate('context');
    }
    if (!unsupportedContext(reading.context))
      this.showSmartValidation_abyssPrivate(reading.context);
    this.showSmartValidation_abyssPrivate(reading.preview);
    this.recognitionPending_abyssPrivate = false;
    this.metadata_abyssPrivate = {
      ...reading,
      canRestore: state.restore !== undefined,
      needsCheckedRetry: this.needsCheckedRetry_abyssPrivate,
    };
  }

  private preflightRequest_abyssPrivate(
    inspection: ReturnType<typeof inspectTaskInput>,
  ): TaskCreateRequest {
    const state = this.state_abyssPrivate;
    return {
      markdownBody: commandBodyForCapture(this.target, taskInputPreflightBody(state, inspection)),
      initial: taskInputPreflightInitial(state, this.target.initial),
    };
  }

  private contextProjection_abyssPrivate(
    inspection: ReturnType<typeof inspectTaskInput>,
    sourcePlanning: Extract<TaskCreateContextPreview, { type: 'ready' }>['sourcePlanning'],
  ): TaskInputProjection {
    return projectTaskInputContext({
      state: this.state_abyssPrivate,
      inspection,
      sourcePlanning,
      ...(this.target.initial === undefined ? {} : { contextInitial: this.target.initial }),
    });
  }

  private readContext_abyssPrivate(inspection: ReturnType<typeof inspectTaskInput>): ContextRead {
    const session = this.target.session;
    const context: TaskCreateContextPreview = session.previewContext?.(
      this.preflightRequest_abyssPrivate(inspection),
    ) ?? {
      type: 'unavailable',
      cause: session.type === 'ready' ? 'preview-capability' : 'destination',
    };
    if (context.type === 'ready')
      return this.readProjectedContext_abyssPrivate(inspection, context);
    if (
      unsupportedContext(context) &&
      this.state_abyssPrivate.raw.trim().length === 0 &&
      this.reference_abyssPrivate !== undefined
    )
      return this.readLegacyContext_abyssPrivate(inspection, context);
    return { context, preview: missingTitlePreview() };
  }

  private readProjectedContext_abyssPrivate(
    inspection: ReturnType<typeof inspectTaskInput>,
    source: Extract<TaskCreateContextPreview, { type: 'ready' }>,
  ): ContextRead {
    const projection = this.contextProjection_abyssPrivate(inspection, source.sourcePlanning);
    const context: TaskCreateContextPreview = this.target.session.previewContext?.(
      this.request_abyssPrivate(projection),
    ) ?? { type: 'unavailable', cause: 'preview-capability' };
    return {
      context,
      preview: missingTitlePreview(),
      ...(context.type === 'ready' ? { projection } : {}),
    };
  }

  private readLegacyContext_abyssPrivate(
    inspection: ReturnType<typeof inspectTaskInput>,
    context: TaskCreateContextPreview,
  ): ContextRead {
    try {
      const preview = this.target.session.preview(this.preflightRequest_abyssPrivate(inspection));
      return {
        context,
        preview,
        ...(canProjectEmptyInput(this.state_abyssPrivate, preview)
          ? { projection: this.contextProjection_abyssPrivate(inspection, {}) }
          : {}),
      };
    } catch {
      this.previewFailure_abyssPrivate('draft');
      return { context, preview: { type: 'unavailable', cause: 'preview-capability' } };
    }
  }

  private freezeReference_abyssPrivate(): void {
    if (this.reference_abyssPrivate !== undefined || this.smart_abyssPrivate === undefined) return;
    this.reference_abyssPrivate = detachFrozen(this.smart_abyssPrivate.readReference());
    this.enabled_abyssPrivate = this.smart_abyssPrivate.enabled();
  }

  flushRecognition(): void {
    if (
      this.destroyed_abyssPrivate ||
      this.phase_abyssPrivate === 'closed' ||
      this.phase_abyssPrivate === 'submitting'
    )
      return;
    this.settleComposition_abyssPrivate();
    if (this.recognitionPending_abyssPrivate) this.refreshSmart_abyssPrivate();
    this.emit_abyssPrivate();
  }

  private settleComposition_abyssPrivate(): void {
    const baseline = this.compositionBaseline_abyssPrivate;
    if (baseline === undefined) return;
    this.compositionBaseline_abyssPrivate = undefined;
    this.state_abyssPrivate = editTaskInput(
      baseline,
      this.state_abyssPrivate.raw,
      'composition',
      this.state_abyssPrivate.revision + 1,
    );
  }

  private refreshSmart_abyssPrivate(): void {
    if (this.hasContextInput_abyssPrivate()) {
      this.refreshContext_abyssPrivate();
      return;
    }
    const smart = this.smart_abyssPrivate,
      reference = this.reference_abyssPrivate;
    if (smart === undefined || reference === undefined) return;
    this.recognitionPending_abyssPrivate = false;
    const state = this.state_abyssPrivate,
      inspection = inspectTaskInput(state.raw);
    const { candidates, recognitionError } = this.recognize_abyssPrivate(smart, reference);
    let preview: TaskCreatePreview;
    let projection: TaskInputProjection | undefined;
    try {
      const source = this.target.session.preview(this.preflightRequest_abyssPrivate(inspection));
      preview = source;
      if (source.type === 'valid') {
        projection = projectTaskInput({
          state,
          reference,
          candidates,
          inspection,
          sourcePlanning: source.sourcePlanning,
          ...(this.target.initial !== undefined && { contextInitial: this.target.initial }),
        });
        preview = this.target.session.preview(this.request_abyssPrivate(projection));
      }
    } catch {
      preview = { type: 'unavailable', cause: 'preview-capability' };
      projection = undefined;
      this.previewFailure_abyssPrivate('draft');
    }
    this.showSmartValidation_abyssPrivate(preview);
    this.metadata_abyssPrivate = {
      preview,
      ...(projection !== undefined && { projection }),
      canRestore: state.restore !== undefined,
      needsCheckedRetry: this.needsCheckedRetry_abyssPrivate,
      ...(recognitionError !== undefined && { recognitionError }),
    };
  }

  private showSmartValidation_abyssPrivate(
    preview: TaskCreatePreview | TaskCreateContextPreview,
  ): void {
    if (preview.type === 'valid' || preview.type === 'ready') return;
    if (missingTitleOnly(preview)) return;
    this.error_abyssPrivate = {
      kind: 'error',
      message: this.smartValidationMessage_abyssPrivate(preview),
      ariaLive: 'assertive',
      requiresRecovery: preview.type === 'unavailable',
    };
  }

  private recognize_abyssPrivate(
    smart: CaptureSmartOptions,
    reference: TaskInputReference,
  ): {
    readonly candidates: ReturnType<CaptureSmartOptions['recognizer']['recognize']>;
    readonly recognitionError?: string;
  } {
    const state = this.state_abyssPrivate,
      inspection = inspectTaskInput(state.raw);
    let recognitionError: string | undefined;
    let candidates: ReturnType<CaptureSmartOptions['recognizer']['recognize']> = [];
    if (this.enabled_abyssPrivate) {
      try {
        candidates = smart.recognizer.recognize({
          text: state.raw,
          reference,
          protectedRanges: inspection.protectedRanges,
        });
      } catch {
        recognitionError =
          'Could not recognize dates and times. Explicit choices are still available.';
        if (this.recognitionFailureRevision_abyssPrivate !== state.revision) {
          this.recognitionFailureRevision_abyssPrivate = state.revision;
          smart.onRecognitionFailure();
        }
      }
    }
    return { candidates, ...(recognitionError !== undefined && { recognitionError }) };
  }

  private request_abyssPrivate(projection: TaskInputProjection): TaskCreateRequest {
    let body = projection.markdownBody;
    const offset = projection.capitalizationTarget?.bodyOffset;
    if (offset !== undefined) {
      const first = [...body.slice(offset)][0];
      const uppercase = first?.toUpperCase();
      if (first !== undefined && uppercase !== undefined && [...uppercase].length === 1)
        body = body.slice(0, offset) + uppercase + body.slice(offset + first.length);
    }
    return {
      markdownBody: commandBodyForCapture(this.target, body),
      initial: projection.initial,
    };
  }

  private canEdit_abyssPrivate(): boolean {
    return (
      this.smart_abyssPrivate !== undefined &&
      !this.destroyed_abyssPrivate &&
      this.phase_abyssPrivate !== 'submitting' &&
      this.phase_abyssPrivate !== 'closed'
    );
  }

  applyMetadataAction(action: TaskInputAction): void {
    if (!this.canEdit_abyssPrivate() || this.compositionBaseline_abyssPrivate !== undefined) return;
    this.freezeReference_abyssPrivate();
    if (
      this.metadata_abyssPrivate?.projection === undefined ||
      this.recognitionPending_abyssPrivate
    )
      this.refreshSmart_abyssPrivate();
    const projection = this.metadata_abyssPrivate?.projection;
    if (projection === undefined) return;
    const next = applyTaskInputAction(
      this.state_abyssPrivate,
      action,
      projection,
      inspectTaskInput(this.state_abyssPrivate.raw),
    );
    if (next === this.state_abyssPrivate) return;
    this.state_abyssPrivate = next;
    this.frozen_abyssPrivate = undefined;
    this.phase_abyssPrivate = 'idle';
    this.error_abyssPrivate = undefined;
    this.refreshSmart_abyssPrivate();
    this.emit_abyssPrivate();
  }

  async confirmCheckedRetry(): Promise<void> {
    if (!this.needsCheckedRetry_abyssPrivate || this.phase_abyssPrivate === 'submitting') return;
    this.needsCheckedRetry_abyssPrivate = false;
    await this.submit('enter');
  }

  private smartError_abyssPrivate(message: string, requiresRecovery = false): void {
    this.phase_abyssPrivate = 'error';
    this.error_abyssPrivate = { kind: 'error', message, ariaLive: 'assertive', requiresRecovery };
    this.emit_abyssPrivate();
  }

  private canSubmitSmart_abyssPrivate(cause: CaptureSubmitCause): boolean {
    if (!this.canEdit_abyssPrivate()) {
      if (this.phase_abyssPrivate === 'submitting' && cause === 'blur')
        this.closeAfterSuccess_abyssPrivate = true;
      return false;
    }
    if (this.needsCheckedRetry_abyssPrivate) return false;
    return cause !== 'blur' || !this.requiresEnter_abyssPrivate;
  }

  private async submitSmart_abyssPrivate(cause: CaptureSubmitCause): Promise<void> {
    if (!this.canSubmitSmart_abyssPrivate(cause)) return;
    if (this.isEmpty()) {
      if (cause === 'blur') this.close_abyssPrivate();
      return;
    }
    if (!this.prepareSmartSubmission_abyssPrivate()) return;
    const frozen = this.frozen_abyssPrivate;
    if (frozen === undefined) return;
    const submission = this.beginSubmission_abyssPrivate(cause);
    if (submission === undefined || this.isSubmissionObsolete_abyssPrivate(submission.token))
      return;
    let result: TaskCommandResult;
    try {
      result = await this.target.session.execute(frozen.request);
    } catch {
      result = { type: 'io-error', cause: 'capture-write-unconfirmed', contentState: 'unknown' };
    }
    if (this.isSubmissionObsolete_abyssPrivate(submission.token)) return;
    this.classifySmartResult_abyssPrivate(result);
    this.finishSubmission_abyssPrivate(submission, result);
  }

  private ensureSmartProjection_abyssPrivate(): void {
    this.settleComposition_abyssPrivate();
    if (this.recognitionPending_abyssPrivate || this.metadata_abyssPrivate === undefined)
      this.refreshSmart_abyssPrivate();
  }

  private smartValidationMessage_abyssPrivate(
    preview: TaskCreatePreview | TaskCreateContextPreview | undefined,
  ): string {
    if (preview?.type === 'unavailable' && preview.cause === 'destination')
      return describeTaskCreationResult({
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      }).message;
    if (preview?.type === 'unavailable')
      return 'Could not preview this task. Try again before saving.';
    if (
      preview?.type === 'invalid' &&
      preview.issues.some((issue) => issue.code !== 'invalid-title')
    )
      return describeTaskCreationResult(preview).message;
    return 'Add a task title before saving.';
  }

  private prepareSmartSubmission_abyssPrivate(): boolean {
    if (this.frozen_abyssPrivate !== undefined) return true;
    this.freezeReference_abyssPrivate();
    this.ensureSmartProjection_abyssPrivate();
    const metadata = this.metadata_abyssPrivate,
      projection = metadata?.projection;
    if (metadata?.preview.type !== 'valid' || projection?.hasAuthoredTitle !== true) {
      this.smartError_abyssPrivate(this.smartValidationMessage_abyssPrivate(metadata?.preview));
      return false;
    }
    const reference = this.reference_abyssPrivate;
    if (reference === undefined) return false;
    this.frozen_abyssPrivate = detachFrozen({
      request: this.request_abyssPrivate(projection),
      state: this.state_abyssPrivate,
      reference,
    });
    return true;
  }

  private classifySmartResult_abyssPrivate(result: TaskCommandResult): void {
    // Classify the write before any presentation callback can fail.
    if (result.type === 'ok') {
      this.frozen_abyssPrivate = undefined;
      this.state_abyssPrivate = createTaskInputState(this.target.draftSeed ?? '');
      this.ownedSeed_abyssPrivate = this.target.draftSeed !== undefined;
      this.reference_abyssPrivate = undefined;
      this.metadata_abyssPrivate = undefined;
      this.recognitionPending_abyssPrivate = false;
      this.recognitionFailureRevision_abyssPrivate = undefined;
      this.previewFailureRevisions_abyssPrivate.clear();
      this.requiresEnter_abyssPrivate = false;
      this.needsCheckedRetry_abyssPrivate = false;
      this.refreshContext_abyssPrivate();
    } else {
      this.requiresEnter_abyssPrivate = true;
      if (result.type === 'io-error' && result.contentState === 'unknown')
        this.needsCheckedRetry_abyssPrivate = true;
    }
  }

  private beginSubmission_abyssPrivate(cause: CaptureSubmitCause): CaptureSubmission | undefined {
    if (this.destroyed_abyssPrivate || this.phase_abyssPrivate === 'closed') return undefined;
    if (this.phase_abyssPrivate === 'submitting') {
      if (cause === 'blur') this.closeAfterSuccess_abyssPrivate = true;
      return undefined;
    }
    if (this.isEmpty()) {
      if (cause === 'blur') this.close_abyssPrivate();
      return undefined;
    }
    const submission = {
      cause,
      draft: this.raw_abyssPrivate(),
      token: ++this.submissionToken_abyssPrivate,
    };
    this.phase_abyssPrivate = 'submitting';
    this.error_abyssPrivate = undefined;
    this.closeAfterSuccess_abyssPrivate = false;
    this.onSubmit_abyssPrivate?.();
    this.emit_abyssPrivate();
    return submission;
  }

  private describeResult_abyssPrivate(result: TaskCommandResult): CreationResultDescription {
    if (this.smart_abyssPrivate === undefined) return this.describe_abyssPrivate(result);
    try {
      const description = this.describe_abyssPrivate(result);
      return result.type === 'ok' && description.kind !== 'success'
        ? describeTaskCreationResult(result)
        : description;
    } catch {
      console.error('[abyss-tasks] Could not describe the quick-capture result');
      return describeTaskCreationResult(result);
    }
  }

  private finishSubmission_abyssPrivate(
    submission: CaptureSubmission,
    result: TaskCommandResult,
  ): void {
    const description = this.needsCheckedRetry_abyssPrivate
      ? {
          kind: 'error' as const,
          message: `Could not confirm whether the task was saved to ${this.target.session.type === 'ready' ? this.target.session.destination.filePath : 'the destination'}. Inspect it before repeating.`,
          ariaLive: 'assertive' as const,
          requiresRecovery: true,
        }
      : this.describeResult_abyssPrivate(result);
    const shouldRequestClose = this.applySubmissionDescription_abyssPrivate(
      submission,
      description,
    );
    this.closeAfterSuccess_abyssPrivate = false;
    this.emit_abyssPrivate();
    if (this.isSubmissionObsolete_abyssPrivate(submission.token)) return;
    this.presentResult_abyssPrivate(result, description);
    if (shouldRequestClose && !this.isSubmissionObsolete_abyssPrivate(submission.token)) {
      this.onRequestClose_abyssPrivate();
    }
  }

  /**
   * The command has finished by now, so a failure to show its result is logged and does not fail
   * the capture.
   */
  private presentResult_abyssPrivate(
    result: TaskCommandResult,
    description: CreationResultDescription,
  ): void {
    try {
      this.onResult_abyssPrivate(result, description);
    } catch (error) {
      if (this.smart_abyssPrivate === undefined)
        console.error('[abyss-tasks] Could not show the capture result', error);
      else console.error('[abyss-tasks] Could not show the quick-capture result');
    }
  }

  private applySubmissionDescription_abyssPrivate(
    submission: CaptureSubmission,
    description: CreationResultDescription,
  ): boolean {
    if (description.kind === 'success') {
      const shouldClose = submission.cause === 'blur' || this.closeAfterSuccess_abyssPrivate;
      this.draft_abyssPrivate = this.target.draftSeed ?? '';
      if (shouldClose) {
        this.phase_abyssPrivate = 'closed';
      } else {
        this.phase_abyssPrivate = 'idle';
        this.focusEpoch_abyssPrivate++;
      }
      return shouldClose;
    }
    this.draft_abyssPrivate = submission.draft;
    this.phase_abyssPrivate = 'error';
    this.error_abyssPrivate = description;
    if (submission.cause === 'enter') this.focusEpoch_abyssPrivate++;
    return false;
  }

  private isSubmissionObsolete_abyssPrivate(token: number): boolean {
    return this.destroyed_abyssPrivate || token !== this.submissionToken_abyssPrivate;
  }

  escape(): void {
    if (this.destroyed_abyssPrivate || this.phase_abyssPrivate === 'closed') return;
    if (this.phase_abyssPrivate === 'submitting') {
      this.closeAfterSuccess_abyssPrivate = true;
      return;
    }
    this.close_abyssPrivate();
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.needsCheckedRetry_abyssPrivate = false;
    this.phase_abyssPrivate = 'closed';
    this.submissionToken_abyssPrivate++;
    this.observers_abyssPrivate.clear();
  }

  private close_abyssPrivate(): void {
    if (this.phase_abyssPrivate === 'closed') return;
    const token = this.submissionToken_abyssPrivate;
    this.needsCheckedRetry_abyssPrivate = false;
    this.phase_abyssPrivate = 'closed';
    this.emit_abyssPrivate();
    if (this.destroyed_abyssPrivate || token !== this.submissionToken_abyssPrivate) return;
    this.onRequestClose_abyssPrivate();
  }

  private emit_abyssPrivate(): void {
    const snapshot = this.snapshot();
    for (const observer of [...this.observers_abyssPrivate]) {
      if (this.destroyed_abyssPrivate) return;
      if (this.observers_abyssPrivate.has(observer)) observer(snapshot);
    }
  }
}
