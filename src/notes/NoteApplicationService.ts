import type { App, TFile } from 'obsidian';
import type { DefaultNoteDestinationV1 } from '../../api';
import { frontmatterRange } from '../markdown/frontmatterRange';
import { sameNoteFileStamp, type NoteFileStamp } from '../markdown/noteFileStamp';
import { readVaultText } from '../markdown/readVaultText';
import type { NoteHostAdapter } from './NoteHostAdapter';
import type { AcceptedNoteSource, NoteSourceReadApi, TaskReadObservation } from './NoteSourceApi';
import {
  NoteTemplateService,
  StaticNoteFailure,
  TemplateFirstFailure,
  type PreparedStaticNoteRequest,
  type StaticNotePlan,
  type TemplateFirstPlan,
} from './NoteTemplateService';
import {
  NOTE_LIMITS,
  NoteFailure,
  type NoteApplicationApi,
  type NoteCommitOutcome,
  type NoteRange,
  type NoteReplacement,
  type NoteTaskProtection,
  type NoteTaskStage,
  type PreparedNote,
} from './noteApi';

function utf8(value: string): number {
  return new TextEncoder().encode(value).length;
}
function bounded(text: string): void {
  if (text.length > NOTE_LIMITS.maxPlanTextBytes || utf8(text) > NOTE_LIMITS.maxPlanTextBytes)
    throw new NoteFailure('RESOURCE_LIMIT');
}
function join(original: string, text: string, newline: string): string {
  if (text === '') return original;
  return original + (original === '' || original.endsWith('\n') ? '' : newline) + text;
}
function appendSection(
  content: string,
  range: NoteRange,
  text: string,
  before = content.slice(range.from, range.to),
): string {
  if (text === '') return before;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const appended =
    range.appendOnly === true && before === '' && !content.endsWith('\n')
      ? newline + text
      : join(before, text, newline);
  return range.to < content.length && before.endsWith('\n') && !appended.endsWith('\n')
    ? appended + newline
    : appended;
}
function preservedFrontmatter(before: string, after: string): boolean {
  const original = frontmatterRange(before),
    candidate = frontmatterRange(after);
  if (original === null) return candidate === null;
  if (
    candidate === null ||
    before.slice(0, original.bodyFrom) !== after.slice(0, original.bodyFrom)
  )
    return false;
  if (candidate.bodyFrom === original.bodyFrom) return true;
  const separator = after.slice(original.bodyFrom, candidate.bodyFrom);
  return (
    original.bodyFrom === before.length &&
    !before.endsWith('\n') &&
    (separator === '\n' || separator === '\r\n')
  );
}
function sameMeaning(before: TaskReadObservation, after: TaskReadObservation): boolean {
  return (
    after.lifecycle === 'ready' &&
    before.scopeRevision === after.scopeRevision &&
    before.semanticsRevision === after.semanticsRevision
  );
}
interface CreationBasis {
  template: AcceptedNoteSource | undefined;
  observation: TaskReadObservation;
  destinationCurrent(): void;
}
type CreationOptions = NonNullable<Parameters<NoteApplicationApi['prepareCreate']>[3]>;
type InitializedNote = Awaited<ReturnType<NoteTemplateService['createTemplateFirstNote']>>;
interface EditBasis {
  readonly guard?: () => void;
  readonly source: AcceptedNoteSource;
  readonly range: NoteRange;
  readonly replacement: string;
  readonly edits: readonly NoteReplacement[];
  readonly candidate: string;
  readonly observation: TaskReadObservation;
  readonly file: TFile;
}
interface NoteServiceDependencies {
  readonly yield: (signal: AbortSignal) => Promise<void>;
  readonly capture: () => TaskReadObservation;
  readonly host: NoteHostAdapter;
  readonly protection: NoteTaskProtection;
  readonly serialize: <T>(path: string, work: () => Promise<T>) => Promise<T>;
}
interface EditAttempt {
  stage?: NoteTaskStage;
  forwarded: boolean;
  acknowledged: boolean;
  failure: string;
}
/** Owns one exact, prepared prose mutation; task ownership is supplied by the canonical adapter. */
export class NoteApplicationService implements NoteApplicationApi {
  private readonly templates: NoteTemplateService;
  private readonly editBases = new WeakMap<PreparedNote, EditBasis>();
  constructor(
    private readonly app: App,
    readonly sources: NoteSourceReadApi,
    private readonly dependencies: NoteServiceDependencies,
  ) {
    this.templates = new NoteTemplateService(app);
  }
  capture(): TaskReadObservation {
    return this.dependencies.capture();
  }
  readonly matcher: NoteApplicationApi['matcher'] = (query) =>
    this.dependencies.host.matcher(query);
  readonly yield: NoteApplicationApi['yield'] = (signal) => this.dependencies.yield(signal);
  readonly resolve: NoteApplicationApi['resolve'] = (from, link) =>
    this.dependencies.host.resolve(from, link);
  readonly link: NoteApplicationApi['link'] = (selection, from, alias) =>
    this.dependencies.host.link(selection, from, alias);
  readonly linkFromPath: NoteApplicationApi['linkFromPath'] = (selection, fromPath, alias) =>
    this.dependencies.host.linkFromPath(selection, fromPath, alias);
  sections(source: AcceptedNoteSource): readonly NoteRange[] {
    this.current(source);
    const protectedRanges = [
      ...this.frontmatterRanges(source.content),
      ...this.dependencies.protection.ranges(source.content),
      ...this.dependencies.host.anchors(source),
    ].sort((a, b) => (a.from === b.from ? b.to - a.to : a.from - b.from));
    const result: NoteRange[] = [];
    let position = 0;
    for (const range of protectedRanges) {
      if (range.from < position) continue;
      if (range.from > position)
        result.push({ from: position, to: range.from, kind: 'prose', editable: true });
      result.push(range);
      position = range.to;
    }
    if (position < source.content.length || result[result.length - 1]?.kind !== 'task')
      result.push({
        from: position,
        to: source.content.length,
        kind: 'prose',
        editable: true,
        ...(position === source.content.length && position > 0
          ? { appendOnly: true as const }
          : {}),
      });
    return result;
  }
  private frontmatterRanges(content: string): NoteRange[] {
    const frontmatter = frontmatterRange(content);
    if (frontmatter !== null)
      return [{ from: 0, to: frontmatter.bodyFrom, kind: 'frontmatter', editable: false }];
    return content.startsWith('\uFEFF') ? [{ from: 0, to: 1, kind: 'other', editable: false }] : [];
  }
  private current(source: AcceptedNoteSource): void {
    const read = this.sources.get(source.path);
    if (read.type === 'error') throw new NoteFailure('INCOMPLETE_READ');
    if (
      read.value?.identity !== source.identity ||
      read.value.version !== source.version ||
      read.value.content !== source.content
    )
      throw new NoteFailure('REVISION_CONFLICT');
  }
  private checkEdit(basis: EditBasis, live: string): void {
    basis.guard?.();
    this.current(basis.source);
    if (
      !sameMeaning(basis.observation, this.capture()) ||
      this.app.vault.getAbstractFileByPath(basis.source.path) !== basis.file ||
      !this.sources.matchesFile(basis.source, basis.file) ||
      live !== basis.source.content
    )
      throw new NoteFailure('REVISION_CONFLICT');
    if (!preservedFrontmatter(live, basis.candidate))
      throw new NoteFailure('FRONTMATTER_REQUIRES_PROPERTY_API');
    if (!this.dependencies.protection.preservesAll(live, basis.candidate, basis.edits))
      throw new NoteFailure('TASK_CONTENT_REQUIRES_TASK_API');
    if (this.sources.candidate(basis.source, live, basis.candidate).type !== 'ok')
      throw new NoteFailure('TARGET_UNAVAILABLE');
  }
  prepareEdit(
    source: AcceptedNoteSource,
    range: NoteRange,
    text: string,
    append: boolean,
  ): PreparedNote {
    return this.prepareSections(source, [], { range, text, append });
  }
  private prepareSections(
    source: AcceptedNoteSource,
    previous: readonly NoteReplacement[],
    operation: { range: NoteRange; text: string; append: boolean },
  ): PreparedNote {
    const { range, text, append } = operation;
    this.current(source);
    const owned = this.sections(source).find(
      (part) => part.editable && part.from === range.from && part.to === range.to,
    );
    if (!range.editable || owned === undefined || (!append && owned.appendOnly === true))
      throw new NoteFailure('SECTION_NOT_EDITABLE');
    bounded(text);
    const earlier = previous.find(
      (edit) => edit.range.from === range.from && edit.range.to === range.to,
    );
    const replacement = append
      ? appendSection(source.content, owned, text, earlier?.replacement)
      : text;
    bounded(replacement);
    const edits = [
      ...previous.filter((edit) => edit !== earlier),
      { range: { ...owned }, replacement },
    ].sort((a, b) => a.range.from - b.range.from);
    if (
      edits.length > NOTE_LIMITS.maxEditsPerPlan ||
      edits.some((edit, i) => i > 0 && edit.range.from < (edits[i - 1]?.range.to ?? 0))
    )
      throw new NoteFailure('RESOURCE_LIMIT');
    return this.preparedSections(source, edits);
  }
  private preparedSections(
    source: AcceptedNoteSource,
    edits: readonly NoteReplacement[],
  ): PreparedNote {
    const from = edits[0]?.range.from,
      to = edits[edits.length - 1]?.range.to;
    if (from === undefined || to === undefined) throw new NoteFailure('INVALID_ARGUMENT');
    let candidate = source.content;
    for (const edit of [...edits].reverse())
      candidate =
        candidate.slice(0, edit.range.from) + edit.replacement + candidate.slice(edit.range.to);
    const delta = candidate.length - source.content.length;
    const before = source.content.slice(from, to),
      after = candidate.slice(from, to + delta);
    bounded(before);
    bounded(after);
    const basis: EditBasis = {
      source,
      edits,
      range: { from, to, kind: 'prose', editable: false },
      replacement: after,
      candidate,
      observation: this.capture(),
      file: this.dependencies.host.file(source),
    };
    this.checkEdit(basis, source.content);
    const sections = edits.map((edit) => ({
      range: edit.range,
      before: edits.length === 1 ? before : source.content.slice(edit.range.from, edit.range.to),
      after: edits.length === 1 ? after : edit.replacement,
    }));
    let result: Promise<NoteCommitOutcome> | undefined;
    const prepared: PreparedNote = {
      kind: 'edit',
      path: source.path,
      source,
      before,
      after,
      sections,
      validate: () => {
        this.checkEdit(basis, source.content);
      },
      refineSection: (range, text, append) =>
        this.prepareSections(source, edits, { range, text, append }),
      retainedBytes:
        utf8(source.content) +
        utf8(candidate) +
        utf8(before) +
        utf8(after) +
        (sections.length === 1
          ? 0
          : sections.reduce((sum, section) => sum + utf8(section.before) + utf8(section.after), 0)),
      commit: () =>
        (result ??= this.dependencies.serialize(source.path, () =>
          this.commitPreparedSection(basis),
        )),
    };
    this.editBases.set(prepared, basis);
    return prepared;
  }
  private async commitPreparedSection(
    basis: EditBasis,
    onAcknowledged?: (stamp: NoteFileStamp) => void,
  ): Promise<NoteCommitOutcome> {
    const state: EditAttempt = {
      forwarded: false,
      acknowledged: false,
      failure: 'REVISION_CONFLICT',
    };
    try {
      this.checkEdit(basis, basis.source.content);
      if (basis.candidate === basis.source.content)
        return {
          noteEffects: 'unchanged',
          destinationEffects: 'unchanged',
          source: basis.source,
          section: this.editedRange(basis),
          noop: true,
        };
      const written = await this.app.vault.process(basis.file, (live) =>
        this.forwardSection(basis, live, state),
      );
      if (!state.forwarded)
        return { code: state.failure, noteEffects: 'unchanged', destinationEffects: 'unchanged' };
      state.acknowledged = written === basis.candidate;
      if (state.acknowledged) onAcknowledged?.({ ...basis.file.stat });
      return await this.finishEdit(basis, state);
    } catch (cause) {
      return await this.failedEdit(basis, state, cause);
    } finally {
      state.stage?.release();
    }
  }
  private forwardSection(basis: EditBasis, live: string, state: EditAttempt): string {
    try {
      this.checkEdit(basis, live);
      const stage = this.dependencies.protection.stageAll(
        basis.source,
        basis.candidate,
        basis.edits,
      );
      if (stage === undefined) return live;
      state.stage = stage;
      const candidate = stage.forward(live);
      if (candidate !== basis.candidate) return live;
      state.forwarded = true;
      return candidate;
    } catch (cause) {
      state.failure = cause instanceof NoteFailure ? cause.code : 'INTERNAL_ERROR';
      return live;
    }
  }
  private async finishEdit(basis: EditBasis, state: EditAttempt): Promise<NoteCommitOutcome> {
    if (!state.acknowledged) {
      await state.stage?.reject(basis.file);
      return { code: 'WRITE_UNCONFIRMED', noteEffects: 'unknown', destinationEffects: 'unchanged' };
    }
    const installed = await state.stage?.install(basis.file);
    if (installed !== true) await state.stage?.reject(basis.file);
    const read = installed === true ? this.sources.get(basis.source.path) : undefined;
    const source = read?.type === 'ok' ? read.value : undefined;
    return {
      noteEffects: 'committed',
      destinationEffects: 'unchanged',
      ...(this.acceptedEdit(basis, source)
        ? { source, section: this.editedRange(basis) }
        : { code: 'READBACK_UNAVAILABLE' }),
    };
  }
  private acceptedEdit(
    basis: EditBasis,
    source: AcceptedNoteSource | undefined,
  ): source is AcceptedNoteSource {
    return (
      source?.identity === basis.source.identity &&
      source.content === basis.candidate &&
      sameMeaning(basis.observation, this.capture()) &&
      this.app.vault.getAbstractFileByPath(source.path) === basis.file &&
      this.sources.matchesFile(source, basis.file)
    );
  }
  private editedRange(basis: EditBasis): NoteRange {
    // This receipt grants readback scope, not new edit authority over merged/split sections.
    return {
      from: basis.range.from,
      to: basis.range.from + basis.replacement.length,
      kind: 'prose',
      editable: false,
    };
  }
  private async failedEdit(
    basis: EditBasis,
    state: EditAttempt,
    cause: unknown,
  ): Promise<NoteCommitOutcome> {
    await state.stage?.reject(basis.file);
    if (state.acknowledged)
      return {
        code: 'READBACK_UNAVAILABLE',
        noteEffects: 'committed',
        destinationEffects: 'unchanged',
      };
    if (!state.forwarded)
      return {
        code: cause instanceof NoteFailure ? cause.code : 'WRITE_FAILED',
        noteEffects: 'unchanged',
        destinationEffects: 'unchanged',
      };
    const unchanged = await this.originalStillPresent(basis);
    return {
      code: 'WRITE_FAILED',
      noteEffects: unchanged ? 'unchanged' : 'unknown',
      destinationEffects: 'unchanged',
    };
  }
  private async originalStillPresent(basis: EditBasis): Promise<boolean> {
    try {
      const stamp = { ...basis.file.stat };
      const live = await readVaultText(this.app.vault, basis.file);
      return (
        this.app.vault.getAbstractFileByPath(basis.source.path) === basis.file &&
        sameNoteFileStamp(stamp, basis.file.stat) &&
        live === basis.source.content
      );
    } catch {
      return false;
    }
  }
  private creationPath(requested: string, collision: 'reject' | 'suffix'): string {
    if (this.app.vault.getAbstractFileByPath(requested) === null) return requested;
    if (collision === 'reject') throw new NoteFailure('DESTINATION_EXISTS');
    const stem = requested.slice(0, -3);
    for (let suffix = 2; suffix <= 101; suffix++) {
      const path = `${stem} ${suffix}.md`;
      if (this.app.vault.getAbstractFileByPath(path) === null) return path;
    }
    throw new NoteFailure('RESOURCE_LIMIT');
  }
  async prepareCreate(
    destination: string | DefaultNoteDestinationV1,
    title: string,
    text: string,
    options: CreationOptions = {},
  ): Promise<PreparedNote> {
    const requestedPath = this.resolveDestination(destination);
    const path = this.creationPath(requestedPath, options.collision ?? 'reject');
    bounded(text);
    const basis: CreationBasis = {
      template: options.template,
      observation: this.capture(),
      destinationCurrent: () => {
        if (this.resolveDestination(destination) !== requestedPath)
          throw new NoteFailure('REVISION_CONFLICT');
      },
    };
    if (basis.template !== undefined) this.current(basis.template);
    const mode = options.templateExecution?.type ?? 'static';
    if (mode !== 'static')
      return await this.prepareTemplateCreation({ path, title, text }, basis, mode);
    const staticPlan = await this.templates.planStaticNote(path, basis.template?.path ?? '', title);
    if (staticPlan.type !== 'ready') throw new NoteFailure('UNSUPPORTED_TEMPLATE');
    return this.preparedCreation(path, staticPlan, text, basis);
  }
  private resolveDestination(destination: string | DefaultNoteDestinationV1): string {
    return typeof destination === 'string'
      ? destination
      : this.dependencies.host.resolveCreateDestination(destination);
  }
  private async prepareTemplateCreation(
    request: { path: string; title: string; text: string },
    basis: CreationBasis,
    mode: string,
  ): Promise<PreparedNote> {
    const { path, title, text } = request;
    if ((mode === 'explicit-templater') !== (basis.template !== undefined))
      throw new NoteFailure('INVALID_ARGUMENT');
    const plan = await this.templateFirstPlan(path, basis.template?.path, title);
    const template = await this.acceptedTemplate(plan.templatePath);
    return this.preparedTemplateFirst(plan, text, { ...basis, template });
  }
  private async templateFirstPlan(
    path: string,
    template: string | undefined,
    title: string,
  ): Promise<TemplateFirstPlan> {
    try {
      return await this.templates.planTemplateFirstNote(path, template, title);
    } catch {
      throw new NoteFailure('UNSUPPORTED_TEMPLATE');
    }
  }
  private async acceptedTemplate(
    path: string | undefined,
  ): Promise<AcceptedNoteSource | undefined> {
    if (path === undefined) return undefined;
    const read = await this.sources.acquire(path);
    if (read.type === 'error' || read.value === undefined)
      throw new NoteFailure('TARGET_UNAVAILABLE');
    this.dependencies.host.file(read.value);
    return read.value;
  }
  private preparedTemplateFirst(
    plan: TemplateFirstPlan,
    text: string,
    basis: CreationBasis,
  ): PreparedNote {
    bounded(text);
    if (plan.retainedBytes > NOTE_LIMITS.maxPlanTextBytes) throw new NoteFailure('RESOURCE_LIMIT');
    const checkContent = (content: string): void => {
      bounded(content);
      if (this.sources.prospective(plan.path, content).type !== 'ok')
        throw new NoteFailure('TARGET_UNAVAILABLE');
    };
    const check = (): void => {
      basis.destinationCurrent();
      if (!plan.current()) throw new NoteFailure('REVISION_CONFLICT');
      if (!sameMeaning(basis.observation, this.capture()))
        throw new NoteFailure('REVISION_CONFLICT');
      if (basis.template !== undefined) this.current(basis.template);
    };
    check();
    checkContent('');
    if (!preservedFrontmatter('', text)) throw new NoteFailure('FRONTMATTER_REQUIRES_PROPERTY_API');
    if (this.dependencies.protection.ranges(text).length !== 0)
      throw new NoteFailure('TASK_CONTENT_REQUIRES_TASK_API');
    let result: Promise<NoteCommitOutcome> | undefined;
    return {
      kind: 'create',
      path: plan.path,
      before: null,
      after: text,
      creationPreview: {
        type: 'template-first',
        ...(plan.templatePath === undefined ? {} : { template: { path: plan.templatePath } }),
        requestedBody: { text, complete: true },
        placement: 'append-after-template',
      },
      retainedBytes:
        utf8(text) +
        plan.retainedBytes +
        (basis.template === undefined ? 0 : utf8(basis.template.content)),
      validate: () => {
        check();
        if (this.app.vault.getAbstractFileByPath(plan.path) !== null)
          throw new NoteFailure('DESTINATION_EXISTS');
      },
      refineBody: (body) => this.preparedTemplateFirst(plan, body, basis),
      commit: (current) =>
        (result ??= this.dependencies.serialize(plan.path, () =>
          this.commitTemplateFirst(
            plan,
            text,
            () => {
              current?.();
              check();
            },
            checkContent,
          ),
        )),
    };
  }
  private async commitTemplateFirst(
    plan: TemplateFirstPlan,
    text: string,
    check: () => void,
    checkContent: (content: string) => void,
  ): Promise<NoteCommitOutcome> {
    let initialized: InitializedNote | undefined;
    let phase: NonNullable<NoteCommitOutcome['phase']> = 'provision';
    try {
      check();
      if (!(await plan.validate())) throw new NoteFailure('REVISION_CONFLICT');
      checkContent('');
      initialized = await this.templates.createTemplateFirstNote(
        plan,
        check,
        checkContent,
        (file) => this.reconcileOwnedCreation(plan.path, file, '', check),
      );
      phase = 'readback';
      const source = await this.initializedSource(plan, initialized, check);
      checkContent(source.content);
      check();
      phase = 'content';
      const outcome = await this.appendInitialized(source, text, check);
      return this.templateFirstOutcome(outcome, initialized);
    } catch (cause) {
      return this.templateFirstFailure(cause, initialized, phase);
    }
  }
  private async initializedSource(
    plan: TemplateFirstPlan,
    initialized: InitializedNote,
    check: () => void,
  ): Promise<AcceptedNoteSource> {
    const { file, content } = initialized;
    await this.reconcileOwnedCreation(plan.path, file, content, check);
    const read = this.sources.get(plan.path);
    const source = read.type === 'ok' ? read.value : undefined;
    if (
      source?.content !== content ||
      !this.sources.matchesFile(source, file) ||
      file.path !== plan.path
    )
      throw new NoteFailure('READBACK_UNAVAILABLE');
    return source;
  }
  private async reconcileOwnedCreation(
    path: string,
    file: TFile,
    content: string,
    check: () => void,
  ): Promise<void> {
    const stamp = { ...file.stat };
    const current = (): void => {
      check();
      if (
        file.path !== path ||
        this.app.vault.getAbstractFileByPath(path) !== file ||
        !sameNoteFileStamp(stamp, file.stat)
      )
        throw new NoteFailure('READBACK_UNAVAILABLE');
    };
    // A native create/metadata acquisition can supersede a read without changing bytes.
    // Retry only reconciliation under the same file/stamp; provisioning and templates never replay.
    for (let attempt = 0; attempt < 3; attempt++) {
      current();
      const accepted = await this.sources.reconcile(path, file, content);
      current();
      if (accepted) return;
    }
    throw new NoteFailure('READBACK_UNAVAILABLE');
  }
  private async appendInitialized(
    source: AcceptedNoteSource,
    text: string,
    check: () => void,
  ): Promise<NoteCommitOutcome> {
    const range = [...this.sections(source)]
      .reverse()
      .find((range) => range.editable && range.to === source.content.length);
    if (range === undefined) throw new NoteFailure('SECTION_NOT_EDITABLE');
    const prepared = this.prepareEdit(source, range, text, true);
    const edit = this.editBases.get(prepared);
    if (edit === undefined) throw new NoteFailure('INTERNAL_ERROR');
    let stamp: NoteFileStamp | undefined;
    const outcome = await this.commitPreparedSection({ ...edit, guard: check }, (acknowledged) => {
      stamp = acknowledged;
    });
    return await this.recoverAcknowledgedCreation(edit, stamp, check, outcome);
  }
  private async recoverAcknowledgedCreation(
    edit: EditBasis,
    stamp: NoteFileStamp | undefined,
    check: () => void,
    outcome: NoteCommitOutcome,
  ): Promise<NoteCommitOutcome> {
    if (
      outcome.code !== 'READBACK_UNAVAILABLE' ||
      outcome.noteEffects !== 'committed' ||
      stamp === undefined ||
      this.dependencies.protection.ranges(edit.source.content).length !== 0
    )
      return outcome;
    try {
      await this.reconcileOwnedCreation(edit.source.path, edit.file, edit.candidate, () => {
        check();
        if (!sameNoteFileStamp(stamp, edit.file.stat))
          throw new NoteFailure('READBACK_UNAVAILABLE');
      });
      const read = this.sources.get(edit.source.path);
      const source = read.type === 'ok' ? read.value : undefined;
      if (!this.acceptedEdit(edit, source)) return outcome;
      return {
        noteEffects: 'committed',
        destinationEffects: 'unchanged',
        source,
        section: this.editedRange(edit),
      };
    } catch {
      // Preserve the acknowledged write's original failure when exact readback cannot recover.
      return outcome;
    }
  }
  private templateFirstOutcome(
    outcome: NoteCommitOutcome,
    initialized: InitializedNote,
  ): NoteCommitOutcome {
    return {
      ...outcome,
      noteEffects: 'committed',
      destinationEffects: initialized.effects.destinationEffects,
      completion: outcome.code === undefined ? 'complete' : 'incomplete',
      phase: outcome.code === 'READBACK_UNAVAILABLE' ? 'readback' : 'content',
      templateEffects: initialized.effects.templateEffects,
      contentEffects: outcome.noteEffects,
    };
  }
  private templateFirstFailure(
    cause: unknown,
    initialized: InitializedNote | undefined,
    phase: NonNullable<NoteCommitOutcome['phase']>,
  ): NoteCommitOutcome {
    if (cause instanceof TemplateFirstFailure)
      return {
        ...cause.effects,
        code: cause.cause instanceof NoteFailure ? cause.cause.code : 'CREATE_FAILED',
        completion: 'incomplete',
        contentEffects: 'unchanged',
      };
    const effects = initialized?.effects ?? {
      noteEffects: 'unchanged' as const,
      destinationEffects: 'unchanged' as const,
      templateEffects: 'unchanged' as const,
    };
    return {
      ...effects,
      code: cause instanceof NoteFailure ? cause.code : 'CREATE_FAILED',
      completion: 'incomplete',
      phase,
      contentEffects: 'unchanged',
    };
  }

  private preparedCreation(
    path: string,
    staticPlan: Extract<StaticNotePlan, { type: 'ready' }>,
    text: string,
    basis: CreationBasis,
  ): PreparedNote {
    const { template, observation } = basis;
    bounded(text);
    const content = join(
      staticPlan.content,
      text,
      staticPlan.content.includes('\r\n') ? '\r\n' : '\n',
    );
    bounded(content);
    const check = (): void => {
      basis.destinationCurrent();
      if (!sameMeaning(observation, this.capture())) throw new NoteFailure('REVISION_CONFLICT');
      if (template !== undefined) this.current(template);
      if (this.app.vault.getAbstractFileByPath(path) !== null)
        throw new NoteFailure('DESTINATION_EXISTS');
      if (!preservedFrontmatter(staticPlan.content, content))
        throw new NoteFailure('FRONTMATTER_REQUIRES_PROPERTY_API');
      if (this.dependencies.protection.ranges(content).length !== 0)
        throw new NoteFailure('TASK_CONTENT_REQUIRES_TASK_API');
      if (this.sources.prospective(path, content).type !== 'ok')
        throw new NoteFailure('TARGET_UNAVAILABLE');
    };
    check();
    let result: Promise<NoteCommitOutcome> | undefined;
    return {
      kind: 'create',
      refineBody: (body) => this.preparedCreation(path, staticPlan, body, basis),
      validate: check,
      path,
      before: null,
      after: content,
      retainedBytes:
        utf8(content) +
        utf8(staticPlan.content) +
        (template === undefined ? 0 : utf8(template.content)),
      commit: () =>
        (result ??= this.dependencies.serialize(path, () =>
          this.commitCreation({
            path,
            content,
            plan: staticPlan,
            validate: async () => {
              check();
              return await staticPlan.validate();
            },
            check,
          }),
        )),
    };
  }
  private async commitCreation(request: PreparedStaticNoteRequest): Promise<NoteCommitOutcome> {
    try {
      const saved = await this.templates.createStaticNote(request);
      return await this.created(request.path, saved.file, saved.content, saved.destinationEffects);
    } catch (cause) {
      return await this.creationFailure(request.path, cause);
    }
  }
  private async creationFailure(path: string, cause: unknown): Promise<NoteCommitOutcome> {
    if (!(cause instanceof StaticNoteFailure))
      return {
        code: cause instanceof NoteFailure ? cause.code : 'CREATE_FAILED',
        noteEffects: 'unchanged',
        destinationEffects: 'unchanged',
      };
    if (cause.owned !== undefined)
      return await this.created(
        path,
        cause.owned.file,
        cause.owned.content,
        cause.destinationEffects ?? 'unknown',
      );
    const knownDestination = cause.effects === 'partial' ? 'committed' : 'unchanged';
    return {
      code: 'CREATE_FAILED',
      noteEffects: cause.effects === 'unknown' ? 'unknown' : 'unchanged',
      destinationEffects: cause.destinationEffects ?? knownDestination,
    };
  }
  private async created(
    path: string,
    file: TFile,
    content: string,
    destinationEffects: NoteCommitOutcome['destinationEffects'],
  ): Promise<NoteCommitOutcome> {
    try {
      const installed = await this.sources.reconcile(path, file, content);
      const source = installed ? this.sources.get(path) : undefined;
      return {
        noteEffects: 'committed',
        destinationEffects,
        ...(source?.type === 'ok' && source.value !== undefined
          ? { source: source.value }
          : { code: 'READBACK_UNAVAILABLE' }),
      };
    } catch {
      return { code: 'READBACK_UNAVAILABLE', noteEffects: 'committed', destinationEffects };
    }
  }
}
