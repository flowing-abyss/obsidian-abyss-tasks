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
  attempted: boolean;
  accepted: boolean;
}
interface DeliveryGuards<I, O> {
  readonly validateInput?: (input: I) => void;
  readonly validateDelivery?: (value: O) => void;
  readonly publish?: () => void;
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
        this.run(validateNoteRead(query), readOptions, (input) => this.reads.read(input), {
          validateInput: (input) => {
            this.reads.validateOrigins(input);
          },
        }),
      prepare: (input, readOptions) => this.prepare(input, readOptions),
      create: (input, mutationOptions) => this.mutate('notes.create', input, mutationOptions),
      apply: (input, mutationOptions) => this.mutate('notes.apply', input, mutationOptions),
    });
  }
  private async run<I, O extends NoteReadValue>(
    input: ApiResultV1<I>,
    opts: ReadOptionsV1 | undefined,
    operation: (input: I, signal?: ApiAbortSignalV1) => Promise<O>,
    guards?: DeliveryGuards<I, O>,
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
      guards?.validateInput?.(input.value);
      return this.deliver(value, parsed.value.signal, guards);
    } catch (cause) {
      return cause instanceof NoteFailure ? error(cause) : this.options.api.internal('notes.read');
    }
  }
  private deliver<I, O extends NoteReadValue>(
    value: O,
    signal: ApiAbortSignalV1 | undefined,
    guards?: DeliveryGuards<I, O>,
  ): ApiResultV1<O> {
    const validate = guards?.validateDelivery;
    const failure = this.deliveryFailure(
      value,
      signal,
      validate === undefined
        ? undefined
        : () => {
            validate(value);
          },
    );
    if (failure !== undefined) return failure;
    guards?.publish?.();
    return freezeValue({ ok: true, value });
  }
  private deliveryFailure(
    value: NoteReadValue,
    signal?: ApiAbortSignalV1,
    validate?: () => void,
  ): ApiResultV1<never> | undefined {
    const failure =
      this.options.api.check(signal) ?? lifecycleError(this.options.api.reads.capture());
    if (failure !== undefined) return failure;
    if (validate === undefined) this.validateDelivery(value);
    else validate();
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
    let next: Plan | undefined;
    let previous: Plan | undefined;
    return this.run(
      validateNotePrepare(input),
      options,
      async (value) => {
        this.checkPrepareSize(value);
        this.clean();
        if (value.kind === 'refine') previous = this.refinementPlan(value);
        const prepared = await this.nativePreparation(value, previous);
        const plan: Plan = {
          target: previous?.target ?? this.options.registry.token('note-plan'),
          revision: this.options.registry.token('note-plan-revision'),
          expiresAt: previous?.expiresAt ?? this.options.now() + NOTE_LIMITS.planTtlMs,
          prepared,
          attempted: false,
          accepted: false,
        };
        next = plan;
        return this.projectPlan(plan);
      },
      {
        validateDelivery: () => {
          this.validatePrepared(next, previous);
        },
        publish: () => {
          if (next === undefined) throw new NoteFailure('PLAN_UNAVAILABLE');
          this.plans.set(next.target, next);
          this.retainedBytes +=
            next.prepared.retainedBytes - (previous?.prepared.retainedBytes ?? 0);
        },
      },
    );
  }
  private validatePrepared(next: Plan | undefined, previous: Plan | undefined): void {
    if (next === undefined) throw new NoteFailure('PLAN_UNAVAILABLE');
    next.prepared.validate();
    this.validateRefinementCurrent(previous);
    const retained =
      this.retainedBytes - (previous?.prepared.retainedBytes ?? 0) + next.prepared.retainedBytes;
    if (
      (previous === undefined && this.plans.size >= NOTE_LIMITS.maxPlans) ||
      retained > NOTE_LIMITS.maxRetainedPlanBytes
    )
      throw new NoteFailure('RESOURCE_LIMIT');
  }
  private validateRefinementCurrent(previous: Plan | undefined): void {
    if (
      previous !== undefined &&
      (this.plans.get(previous.target) !== previous ||
        previous.attempted ||
        previous.expiresAt <= this.options.now())
    )
      throw new NoteFailure('REVISION_CONFLICT');
  }
  private refinementPlan(input: Extract<PrepareNoteV1, { kind: 'refine' }>): Plan {
    const plan = this.plans.get(input.plan);
    if (plan === undefined) throw new NoteFailure('PLAN_UNAVAILABLE');
    if (plan.revision !== input.expectedPlanRevision || plan.attempted)
      throw new NoteFailure('REVISION_CONFLICT');
    plan.prepared.validate();
    return plan;
  }
  private checkPrepareSize(value: PrepareNoteV1): void {
    const prose = value.kind === 'create' ? value.text : value.operation.text;
    if (
      prose.length > NOTE_LIMITS.maxInputBytes ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > NOTE_LIMITS.maxInputBytes
    )
      throw new NoteFailure('RESOURCE_LIMIT');
  }

  private async nativePreparation(value: PrepareNoteV1, previous?: Plan): Promise<PreparedNote> {
    const port = this.options.registry.port;
    if (value.kind === 'refine') return this.refineNative(value, previous);
    if (value.kind === 'create') return this.prepareCreation(value);
    const source = await this.options.registry.acquire(value.target, value.expectedRevision);
    const selected = await this.options.registry.selected(value.operation.section);
    if (selected.source.identity !== source.identity || selected.source.version !== source.version)
      throw new NoteFailure('REVISION_CONFLICT');
    return port.prepareEdit(
      source,
      selected.range,
      value.operation.text,
      value.operation.type === 'append',
    );
  }
  private async prepareCreation(
    value: Extract<PrepareNoteV1, { kind: 'create' }>,
  ): Promise<PreparedNote> {
    const template =
      value.template === undefined
        ? undefined
        : await this.options.registry.acquire(value.template, value.expectedTemplateRevision);
    return this.options.registry.port.prepareCreate(value.path, value.title, value.text, {
      ...(template === undefined ? {} : { template }),
      ...(value.collision === undefined ? {} : { collision: value.collision }),
    });
  }
  private async refineNative(
    value: Extract<PrepareNoteV1, { kind: 'refine' }>,
    previous: Plan | undefined,
  ): Promise<PreparedNote> {
    if (previous === undefined) throw new NoteFailure('PLAN_UNAVAILABLE');
    if (value.operation.type === 'replace-body') {
      if (previous.prepared.refineBody === undefined) throw new NoteFailure('INVALID_ARGUMENT');
      return previous.prepared.refineBody(value.operation.text);
    }
    const selected = await this.options.registry.selected(value.operation.section);
    if (
      previous.prepared.source?.identity !== selected.source.identity ||
      previous.prepared.source.version !== selected.source.version
    )
      throw new NoteFailure('REVISION_CONFLICT');
    if (previous.prepared.refineSection === undefined) throw new NoteFailure('INVALID_ARGUMENT');
    return previous.prepared.refineSection(
      selected.range,
      value.operation.text,
      value.operation.type === 'append',
    );
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
      ...this.projectSections(prepared),
    };
  }
  private projectSections(prepared: PreparedNote): Pick<NotePlanV1, 'section' | 'sections'> {
    const source = prepared.source;
    if (source === undefined || prepared.sections === undefined) return {};
    const sections = prepared.sections.map((entry) => ({
      section: this.options.registry.section(source, entry.range).target,
      before: { text: entry.before, complete: true as const },
      after: { text: entry.after, complete: true as const },
    }));
    const only = sections.length === 1 ? sections[0] : undefined;
    return only === undefined ? { sections } : { section: only.section };
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
      delete redacted.section;
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
    let section: NoteMutationReceiptV1['section'];
    if (outcome.source !== undefined && !this.options.isDisposed()) {
      try {
        const summary = project(outcome.source);
        note = { target: summary.target, revision: summary.revision };
        if (outcome.section !== undefined)
          section = this.options.registry.section(outcome.source, outcome.section).target;
      } catch {
        /* Current identity projection cannot change acknowledged storage effects. */
      }
    }
    return noteReceipt(
      {
        epoch: this.options.epoch,
        acceptedAt,
        input,
        ...(note === undefined ? {} : { note }),
        ...(section === undefined ? {} : { section }),
      },
      outcome,
    );
  }
  dispose(): void {
    this.reads.dispose();
    for (const plan of this.plans.values()) if (!plan.accepted) this.remove(plan);
  }
}
