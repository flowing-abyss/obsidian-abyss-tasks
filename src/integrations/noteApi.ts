import type {
  ApiAbortSignalV1,
  ApiResultV1,
  CommitNoteV1,
  ErrorCategoryV1,
  MutationOptionsV1,
  NoteMutationReceiptV1,
  NoteMutationResultV1,
  NotePlanV1,
  NoteReadPageV1,
  NoteSearchPageV1,
  NotesApiV1,
  PrepareNoteV1,
  ReadOptionsV1,
} from '../../api';
import {
  NOTE_LIMITS,
  NoteFailure,
  type NoteCommitOutcome,
  type PreparedNote,
} from '../notes/noteApi';
import type { NoteReadRegistry } from './NoteReadRegistry';
import type { TaskApiContext } from './TaskApiProvider';
import type { TaskRequestRegistry } from './TaskRequestRegistry';
import { NoteApiReads } from './noteApiReads';
import { noteReceipt } from './noteReceipt';
import { validateNotePrepare, validateNoteRead, validateNoteSearch } from './noteValidation';
import { lifecycleError, readError } from './taskApiReads';
import { validateContentApply } from './taskContentValidation';
import { validateReadOptions } from './validation';
import { freezeValue } from './values';

type NoteReadValue = NotePlanV1 | NoteReadPageV1 | NoteSearchPageV1;
interface Plan {
  readonly target: string;
  readonly revision: string;
  readonly expiresAt: number;
  readonly prepared: PreparedNote;
  readonly section?: string;
  attempted: boolean;
  accepted: boolean;
}
interface Options {
  readonly api: TaskApiContext;
  readonly registry: NoteReadRegistry;
  readonly requests: TaskRequestRegistry;
  readonly consumerId: string;
  readonly epoch: string;
  readonly now: () => number;
  readonly isDisposed: () => boolean;
}
function error(cause: unknown): Extract<ApiResultV1<never>, { ok: false }> {
  const code = cause instanceof NoteFailure ? cause.code : 'INTERNAL_ERROR';
  let category: ErrorCategoryV1 = 'unavailable';
  if (code === 'RESOURCE_LIMIT') category = 'resource';
  else if (code === 'INVALID_ARGUMENT') category = 'validation';
  else if (code.includes('CONFLICT') || code.includes('STALE') || code === 'DESTINATION_EXISTS')
    category = 'conflict';
  return readError(category, code, 'Note operation could not use its current source or proposal.');
}
/** Consumer lifecycle and detached DTOs; all native access stays behind the note port. */
export class NoteApi {
  readonly api: NotesApiV1;
  private readonly reads: NoteApiReads;
  private readonly plans = new Map<string, Plan>();
  private retainedBytes = 0;
  constructor(private readonly options: Options) {
    this.reads = new NoteApiReads(options.api, options.registry, options.now);
    this.api = Object.freeze<NotesApiV1>({
      search: (query, readOptions) =>
        this.run(validateNoteSearch(query), readOptions, (input, signal) =>
          this.reads.search(input, signal),
        ),
      read: (query, readOptions) =>
        this.run(
          validateNoteRead(query),
          readOptions,
          (input) => this.reads.read(input),
          (input) => {
            this.reads.validateOrigins(input);
          },
        ),
      prepare: (input, readOptions) => this.prepare(input, readOptions),
      create: (input, mutationOptions) => this.mutate('notes.create', input, mutationOptions),
      apply: (input, mutationOptions) => this.mutate('notes.apply', input, mutationOptions),
    });
  }
  private async run<I, O extends NoteReadValue>(
    input: ApiResultV1<I>,
    opts: ReadOptionsV1 | undefined,
    operation: (input: I, signal?: ApiAbortSignalV1) => Promise<O>,
    validate?: (input: I) => void,
  ): Promise<ApiResultV1<O>> {
    try {
      if (!input.ok) return input;
      const parsed = validateReadOptions(opts);
      if (!parsed.ok) return parsed;
      const initial =
        this.options.api.check(parsed.value.signal) ??
        lifecycleError(this.options.api.reads.capture());
      if (initial !== undefined) return initial;
      const value = await operation(input.value, parsed.value.signal);
      validate?.(input.value);
      const failure = this.deliveryFailure(value, parsed.value.signal);
      if (failure !== undefined) return failure;
      return freezeValue({ ok: true, value });
    } catch (cause) {
      return cause instanceof NoteFailure ? error(cause) : this.options.api.internal('notes.read');
    }
  }
  private deliveryFailure(
    value: NoteReadValue,
    signal?: ApiAbortSignalV1,
  ): ApiResultV1<never> | undefined {
    const failure =
      this.options.api.check(signal) ?? lifecycleError(this.options.api.reads.capture());
    if (failure !== undefined) return failure;
    this.validateDelivery(value);
    const current = this.options.api.reads.capture();
    if (
      value.generation !== current.generation ||
      value.scopeRevision !== current.scopeRevision ||
      value.semanticsRevision !== current.semanticsRevision
    )
      throw new NoteFailure('INCOMPLETE_READ');
    return undefined;
  }
  private validateDelivery(value: NoteReadValue): void {
    if ('kind' in value) {
      const plan = this.plans.get(value.target);
      if (plan === undefined) throw new NoteFailure('PLAN_UNAVAILABLE');
      plan.prepared.validate();
    }
    const notes = 'items' in value ? value.items.map((item) => item.note) : [value.note];
    for (const note of notes)
      if (note !== undefined && !this.options.registry.available(note.target, note.revision))
        throw new NoteFailure('TARGET_UNAVAILABLE');
  }
  private clean(): void {
    for (const plan of this.plans.values())
      if (!plan.accepted && plan.expiresAt <= this.options.now()) this.remove(plan);
  }
  private remove(plan: Plan): void {
    if (this.plans.delete(plan.target)) this.retainedBytes -= plan.prepared.retainedBytes;
  }
  private async prepare(
    input: PrepareNoteV1,
    options?: ReadOptionsV1,
  ): Promise<ApiResultV1<NotePlanV1>> {
    let unpublished: Plan | undefined;
    const result = await this.run(validateNotePrepare(input), options, async (value) => {
      this.checkPrepareSize(value);
      this.clean();
      const prepared = await this.nativePreparation(value);
      if (
        this.plans.size >= NOTE_LIMITS.maxPlans ||
        this.retainedBytes + prepared.retainedBytes > NOTE_LIMITS.maxRetainedPlanBytes
      )
        throw new NoteFailure('RESOURCE_LIMIT');
      const plan: Plan = {
        target: this.options.registry.token('note-plan'),
        revision: this.options.registry.token('note-plan-revision'),
        expiresAt: this.options.now() + NOTE_LIMITS.planTtlMs,
        prepared,
        attempted: false,
        accepted: false,
        ...(value.kind === 'edit' ? { section: value.operation.section } : {}),
      };
      unpublished = plan;
      this.plans.set(plan.target, plan);
      this.retainedBytes += prepared.retainedBytes;
      return this.projectPlan(plan);
    });
    if (!result.ok && unpublished !== undefined) this.remove(unpublished);
    return result;
  }
  private checkPrepareSize(value: PrepareNoteV1): void {
    const prose = value.kind === 'edit' ? value.operation.text : value.text;
    if (
      prose.length > NOTE_LIMITS.maxInputBytes ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > NOTE_LIMITS.maxInputBytes
    )
      throw new NoteFailure('RESOURCE_LIMIT');
  }

  private async nativePreparation(value: PrepareNoteV1): Promise<PreparedNote> {
    const port = this.options.registry.port;
    let prepared: PreparedNote;
    if (value.kind === 'edit') {
      const source = await this.options.registry.acquire(value.target, value.expectedRevision);
      const selected = await this.options.registry.selected(value.operation.section);
      if (
        selected.source.identity !== source.identity ||
        selected.source.version !== source.version
      )
        throw new NoteFailure('REVISION_CONFLICT');
      prepared = port.prepareEdit(
        source,
        selected.range,
        value.operation.text,
        value.operation.type === 'append',
      );
    } else {
      const template =
        value.template === undefined
          ? undefined
          : await this.options.registry.acquire(value.template, value.expectedTemplateRevision);
      prepared = await port.prepareCreate(value.path, value.title, value.text, template);
    }
    return prepared;
  }
  private projectPlan(plan: Plan): NotePlanV1 {
    const prepared = plan.prepared;
    return {
      ...this.options.api.observation(this.options.registry.port.capture()),
      target: plan.target,
      revision: plan.revision,
      kind: prepared.kind,
      expiresAt: plan.expiresAt,
      path: prepared.path,
      before: prepared.before === null ? null : { text: prepared.before, complete: true },
      after: { text: prepared.after, complete: true },
      ...(prepared.source === undefined
        ? {}
        : {
            note: {
              target: this.options.registry.summary(prepared.source).target,
              revision: this.options.registry.revision(prepared.source),
            },
          }),
      ...(plan.section === undefined ? {} : { section: plan.section }),
    };
  }
  private plan(input: CommitNoteV1, kind: 'create' | 'edit'): Plan {
    this.clean();
    const plan = this.plans.get(input.plan);
    if (plan === undefined) throw new NoteFailure('PLAN_UNAVAILABLE');
    if (plan.revision !== input.expectedPlanRevision || plan.prepared.kind !== kind)
      throw new NoteFailure('REVISION_CONFLICT');
    if (plan.attempted) throw new NoteFailure('PLAN_CONSUMED');
    return plan;
  }
  private async mutate(
    method: 'notes.apply' | 'notes.create',
    input: CommitNoteV1,
    options?: MutationOptionsV1,
  ): Promise<NoteMutationResultV1> {
    const validated = validateContentApply(input),
      opts = validateReadOptions(options);
    if (!validated.ok || !opts.ok)
      return {
        ...(validated.ok ? opts : validated),
        effects: 'unchanged',
        recovery: 'none',
      } as NoteMutationResultV1;
    const normalized = validated.value;
    const result = await this.options.requests.executeNote(
      this.options.consumerId,
      method,
      normalized,
      {
        ...opts.value,
        isDisposed: this.options.isDisposed,
        admit: () => {
          try {
            const failure = this.options.api.check();
            if (failure !== undefined) return failure;
            const plan = this.plan(normalized, method === 'notes.create' ? 'create' : 'edit');
            const reservation = this.options.registry.reserve();
            return {
              ok: true,
              value: {
                retainedBytes: plan.prepared.retainedBytes + 4096,
                release: () => {
                  reservation.release();
                  if (plan.accepted) this.remove(plan);
                },
                execute: async (acceptedAt) => {
                  plan.attempted = true;
                  plan.accepted = true;
                  const outcome = await plan.prepared.commit();
                  return this.receipt(normalized, acceptedAt, outcome, (source) =>
                    reservation.project(source),
                  );
                },
                unknown: (acceptedAt, cause) => ({
                  ok: false,
                  error: cause,
                  effects: 'unknown',
                  recovery: 'reconcile',
                  receipt: this.receipt(normalized, acceptedAt, {
                    code: 'WRITE_UNCONFIRMED',
                    noteEffects: 'unknown',
                    destinationEffects: 'unknown',
                  }).receipt,
                }),
              },
            };
          } catch (cause) {
            return error(cause);
          }
        },
      },
    );
    const receipt = result.receipt;
    if (
      receipt?.note !== undefined &&
      (this.options.isDisposed() ||
        !this.options.registry.available(receipt.note.target, receipt.note.revision))
    ) {
      const redacted = { ...receipt };
      delete redacted.note;
      return freezeValue({ ...result, receipt: redacted });
    }
    return freezeValue(result);
  }
  private receipt(
    input: CommitNoteV1,
    acceptedAt: number,
    outcome: NoteCommitOutcome,
    project = this.options.registry.summary.bind(this.options.registry),
  ): NoteMutationResultV1 & { readonly receipt: NoteMutationReceiptV1 } {
    let note: NoteMutationReceiptV1['note'];
    if (outcome.source !== undefined && !this.options.isDisposed()) {
      try {
        const summary = project(outcome.source);
        note = { target: summary.target, revision: summary.revision };
      } catch {
        /* Current identity projection cannot change acknowledged storage effects. */
      }
    }
    return noteReceipt(
      { epoch: this.options.epoch, acceptedAt, input, ...(note === undefined ? {} : { note }) },
      outcome,
    );
  }
  dispose(): void {
    this.reads.dispose();
    for (const plan of this.plans.values()) if (!plan.accepted) this.remove(plan);
  }
}
