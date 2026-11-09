import type { App, TFile } from 'obsidian';
import { frontmatterRange } from '../markdown/frontmatterRange';
import { sameNoteFileStamp } from '../markdown/noteFileStamp';
import { readVaultText } from '../markdown/readVaultText';
import type { NoteHostAdapter } from './NoteHostAdapter';
import type { AcceptedNoteSource, NoteSourceReadApi, TaskReadObservation } from './NoteSourceApi';
import {
  NoteTemplateService,
  StaticNoteFailure,
  type PreparedStaticNoteRequest,
  type StaticNotePlan,
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
interface EditBasis {
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
    return {
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
  }
  private async commitPreparedSection(basis: EditBasis): Promise<NoteCommitOutcome> {
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
    requestedPath: string,
    title: string,
    text: string,
    options: {
      readonly template?: AcceptedNoteSource;
      readonly collision?: 'reject' | 'suffix';
    } = {},
  ): Promise<PreparedNote> {
    const { template, collision = 'reject' } = options;
    const path = this.creationPath(requestedPath, collision);
    bounded(text);
    const observation = this.capture();
    if (template !== undefined) this.current(template);
    const staticPlan = await this.templates.planStaticNote(path, template?.path ?? '', title);
    if (staticPlan.type !== 'ready') throw new NoteFailure('UNSUPPORTED_TEMPLATE');
    return this.preparedCreation(path, staticPlan, text, { template, observation });
  }
  private preparedCreation(
    path: string,
    staticPlan: Extract<StaticNotePlan, { type: 'ready' }>,
    text: string,
    basis: { template: AcceptedNoteSource | undefined; observation: TaskReadObservation },
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
