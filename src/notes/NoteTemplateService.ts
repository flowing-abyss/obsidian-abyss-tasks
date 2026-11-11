import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { sameNoteFileStamp } from '../markdown/noteFileStamp';
import { readVaultText } from '../markdown/readVaultText';
import {
  TemplaterAdapter,
  type TemplaterPreparation,
  type TemplaterSession,
} from './TemplaterAdapter';
import type { NoteEffect } from './noteApi';

interface FailedPreparation {
  readonly content: string | undefined;
  readonly templatePath: string;
  readonly title: string;
  readonly uncertain: boolean;
}

interface TemplateApplication {
  readonly file: TFile;
  readonly template: TFile;
  readonly title: string;
  readonly expectedContent: string;
  readonly session: TemplaterSession | undefined;
  readonly guard?: TemplateCreationGuard;
}
interface TemplateCreationGuard {
  readonly adapter: TemplaterAdapter | undefined;
  check(file?: TFile): void | Promise<void>;
  finalCheck(): void;
  attempting(): void;
  created(file: TFile): void | Promise<void>;
  rendering(): void;
  applied(): void;
  checkContent(content: string): void;
  checkLive(file: TFile, content: string): void;
}
export interface TemplateFirstPlan {
  readonly path: string;
  readonly templatePath: string | undefined;
  readonly retainedBytes: number;
  current(): boolean;
  validate(): Promise<boolean>;
}
interface TemplateFirstBasis {
  readonly title: string;
  readonly policy: TemplaterPreparation;
  readonly template: TFile | undefined;
  readonly raw: string | undefined;
  readonly stamp: TFile['stat'] | undefined;
}
export interface TemplateFirstEffects {
  phase: 'provision' | 'template' | 'readback';
  noteEffects: NoteEffect;
  destinationEffects: NoteEffect;
  templateEffects: NoteEffect;
}
export class TemplateFirstFailure extends Error {
  constructor(
    readonly effects: Readonly<TemplateFirstEffects>,
    readonly cause: unknown,
  ) {
    super('Template-first note creation did not complete.');
  }
}

export interface StaticNoteRequest {
  readonly path: string;
  readonly templatePath: string;
  readonly title: string;
  capture(file: TFile): { readonly content: string; current(): boolean };
  prepare(body: string | undefined): string;
  check(content: string): void;
}

export interface PreparedStaticNoteRequest {
  readonly path: string;
  readonly plan: StaticNotePlan;
  readonly content: string;
  validate(): Promise<boolean>;
  check(content: string): void;
}
type StaticDestinationEffect = 'unchanged' | 'committed' | 'unknown';
export interface PreparedStaticNoteResult {
  readonly file: TFile;
  readonly content: string;
  readonly destinationEffects: StaticDestinationEffect;
}

export class StaticNoteFailure extends Error {
  constructor(
    readonly effects: 'unchanged' | 'partial' | 'unknown' | 'committed',
    readonly cause: unknown,
    readonly owned?: { file: TFile; content: string },
    readonly destinationEffects?: PreparedStaticNoteResult['destinationEffects'],
  ) {
    super('Static note creation failed.');
  }
}
export class ExecutableTemplateError extends Error {}
export class StaleStaticNoteError extends Error {}

interface FolderGuard {
  check(): void | Promise<void>;
  finalCheck?(): void;
  attempting(): void;
  created(): void;
}

function finalFolderCheck(guard: FolderGuard | undefined): void {
  guard?.finalCheck?.();
}

function renderCoreTemplate(raw: string, title: string): string {
  const now = window.moment();
  return raw
    .replace(/\{\{\s*date\s*\}\}/giu, now.format('YYYY-MM-DD'))
    .replace(/\{\{\s*time\s*\}\}/giu, now.format('HH:mm'))
    .replace(/\{\{\s*title\s*\}\}/giu, () => title);
}

const inFlightByApp = new WeakMap<App, Map<string, Promise<TFile>>>();
const failedByApp = new WeakMap<App, Map<string, FailedPreparation>>();

class InvalidNotePathError extends Error {
  constructor(readonly filePath: string) {
    super(`Invalid note path: ${filePath}`);
    this.name = 'InvalidNotePathError';
  }
}

class MissingNoteTemplateError extends Error {
  constructor(readonly templatePath: string) {
    super(`Could not find the selected note template: ${templatePath}`);
    this.name = 'MissingNoteTemplateError';
  }
}

class NoteContentChangedError extends Error {}

/** Signals that note creation succeeded but applying its Templater template did not. */
export class CreatedNoteTemplateError extends Error {
  readonly createdPath: string;
  readonly cause: unknown;

  constructor(createdPath: string, cause: unknown) {
    super(`Could not apply the template to ${createdPath}.`);
    this.name = 'CreatedNoteTemplateError';
    this.createdPath = createdPath;
    this.cause = cause;
  }
}

function mapFor<T>(owner: WeakMap<App, Map<string, T>>, app: App): Map<string, T> {
  const existing = owner.get(app);
  if (existing !== undefined) return existing;
  const created = new Map<string, T>();
  owner.set(app, created);
  return created;
}

function notePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (
    trimmed.length === 0 ||
    trimmed.endsWith('/') ||
    /^(?:\/|\\|[A-Za-z]:[\\/])/u.test(trimmed) ||
    trimmed.includes('\\') ||
    trimmed
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new InvalidNotePathError(filePath);
  }
  const normalized = normalizePath(trimmed);
  if (!normalized.toLowerCase().endsWith('.md')) throw new InvalidNotePathError(filePath);
  return normalized;
}

interface StaticPlanBasis {
  readonly path: string;
  readonly original: TFile | null;
  readonly content: string;
  readonly templatePath: string;
  readonly template: TFile | undefined;
  readonly raw: string | undefined;
  readonly stamp: TFile['stat'] | undefined;
}
interface StaticPlanState {
  owned: { file: TFile; content: string } | undefined;
  effects: 'unchanged' | 'committed' | 'unknown';
}
interface StaticPlanResult {
  readonly path?: string;
  readonly effects: 'unchanged' | 'committed' | 'unknown';
}
export type StaticNotePlan =
  | { readonly type: 'unsupported-template' }
  | {
      readonly type: 'ready';
      readonly content: string;
      sharesBasis(other: StaticNotePlan): boolean;
      refresh(
        current?: { readonly file: object; readonly content: string },
        allowCreated?: boolean,
      ): Promise<StaticNotePlan | undefined>;
      validate(): Promise<boolean>;
      check(file: object, live: string): boolean;
      provision(validate: () => Promise<boolean>): Promise<{
        readonly path?: string;
        readonly effects: 'unchanged' | 'committed' | 'unknown';
      }>;
    };

export class NoteTemplateService {
  private readonly staticPlanBases = new WeakMap<object, StaticPlanBasis>();
  private readonly templateFirstBases = new WeakMap<TemplateFirstPlan, TemplateFirstBasis>();
  constructor(private readonly app: App) {}

  async planTemplateFirstNote(
    path: string,
    explicitTemplatePath?: string,
    title = '',
  ): Promise<TemplateFirstPlan> {
    notePath(path);
    const basis = await this.captureTemplateFirstBasis(path, explicitTemplatePath, title);
    const plan: TemplateFirstPlan = {
      path,
      templatePath: basis.template?.path,
      retainedBytes: new TextEncoder().encode(basis.raw ?? '').length,
      current: () => this.templateFirstNativeBasisCurrent(plan, basis),
      validate: async () =>
        this.app.vault.getAbstractFileByPath(path) === null &&
        (await this.templateFirstBasisCurrent(plan, basis)),
    };
    if (!(await plan.validate())) throw new StaleStaticNoteError();
    this.templateFirstBases.set(plan, basis);
    return plan;
  }
  private async captureTemplateFirstBasis(
    path: string,
    explicitTemplatePath: string | undefined,
    title: string,
  ): Promise<TemplateFirstBasis> {
    const policy = TemplaterAdapter.prepare(this.app, path, explicitTemplatePath === undefined);
    const selected = explicitTemplatePath ?? policy.templatePath;
    const template = selected === undefined ? undefined : this.resolveTemplate(selected);
    const stamp = template === undefined ? undefined : { ...template.stat };
    const raw = template === undefined ? undefined : await readVaultText(this.app.vault, template);
    if (raw?.includes('<%') === true && policy.adapter === undefined)
      throw new ExecutableTemplateError();
    return { policy, template, raw, stamp, title };
  }

  async createTemplateFirstNote(
    plan: TemplateFirstPlan,
    validate: () => void,
    checkContent: (content: string) => void,
    acceptBlank: (file: TFile) => Promise<void>,
  ): Promise<{
    readonly file: TFile;
    readonly content: string;
    readonly effects: Readonly<TemplateFirstEffects>;
  }> {
    const effects: TemplateFirstEffects = {
      phase: 'provision',
      noteEffects: 'unchanged',
      destinationEffects: 'unchanged',
      templateEffects: 'unchanged',
    };
    const basis = this.templateFirstBases.get(plan);
    try {
      if (basis === undefined) throw new StaleStaticNoteError();
      const finalCheck = (): void => {
        validate();
        if (
          !this.templateFirstDestinationCurrent(plan.path, undefined) ||
          !this.templateFirstNativeBasisCurrent(plan, basis)
        )
          throw new StaleStaticNoteError();
      };
      const check = async (file?: TFile): Promise<void> => {
        validate();
        if (
          !this.templateFirstDestinationCurrent(plan.path, file) ||
          !(await this.templateFirstBasisCurrent(plan, basis))
        )
          throw new StaleStaticNoteError();
      };
      await check();
      await this.ensureFolders(plan.path, {
        check,
        finalCheck,
        attempting: () => {
          if (effects.destinationEffects === 'unchanged') effects.destinationEffects = 'unknown';
        },
        created: () => {
          effects.destinationEffects = 'committed';
        },
      });
      const file = await this.createPreparedNote(
        plan.path,
        basis.template,
        plan.templatePath ?? '',
        {
          title: basis.title,
          guard: this.templateFirstGuard({
            plan,
            basis,
            effects,
            validate,
            checkContent,
            acceptBlank,
            check,
            finalCheck,
          }),
        },
      );
      return await this.readTemplateFirstResult({ plan, file, effects, check });
    } catch (cause) {
      if (cause instanceof TemplateFirstFailure) throw cause;
      throw new TemplateFirstFailure({ ...effects }, cause);
    }
  }

  private templateFirstGuard(context: {
    plan: TemplateFirstPlan;
    basis: TemplateFirstBasis;
    effects: TemplateFirstEffects;
    readonly validate: () => void;
    readonly checkContent: (content: string) => void;
    readonly acceptBlank: (file: TFile) => Promise<void>;
    readonly check: (file?: TFile) => Promise<void>;
    readonly finalCheck: () => void;
  }): TemplateCreationGuard {
    const { plan, basis, effects, validate, checkContent, acceptBlank, check } = context;
    return {
      adapter: basis.policy.adapter,
      check,
      finalCheck: context.finalCheck,
      attempting: () => {
        effects.noteEffects = 'unknown';
      },
      created: async (file) => {
        effects.noteEffects = 'committed';
        effects.phase = 'template';
        await acceptBlank(file);
      },
      rendering: () => {
        effects.templateEffects = 'unknown';
      },
      applied: () => {
        effects.templateEffects = 'committed';
      },
      checkContent,
      checkLive: (file, content) => {
        validate();
        if (
          !this.templateFirstDestinationCurrent(plan.path, file) ||
          !this.templateFirstNativeBasisCurrent(plan, basis)
        )
          throw new StaleStaticNoteError();
        checkContent(content);
      },
    };
  }
  private async readTemplateFirstResult(context: {
    readonly plan: TemplateFirstPlan;
    readonly file: TFile;
    readonly effects: TemplateFirstEffects;
    readonly check: (file: TFile) => Promise<void>;
  }): Promise<{
    readonly file: TFile;
    readonly content: string;
    readonly effects: Readonly<TemplateFirstEffects>;
  }> {
    const { file, check } = context;
    const effects: TemplateFirstEffects = { ...context.effects, phase: 'readback' };
    try {
      await check(file);
      const stamp = { ...file.stat };
      const content = await readVaultText(this.app.vault, file);
      await check(file);
      if (!sameNoteFileStamp(stamp, file.stat)) throw new StaleStaticNoteError();
      return { file, content, effects };
    } catch (cause) {
      throw new TemplateFirstFailure(effects, cause);
    }
  }

  private templateFirstDestinationCurrent(path: string, file: TFile | undefined): boolean {
    return file === undefined
      ? this.app.vault.getAbstractFileByPath(path) === null
      : file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
  }
  private async templateFirstBasisCurrent(
    plan: TemplateFirstPlan,
    basis: TemplateFirstBasis,
  ): Promise<boolean> {
    if (!this.templateFirstNativeBasisCurrent(plan, basis)) return false;
    if (basis.template === undefined) return true;
    return (
      this.resolveTemplate(plan.templatePath ?? '') === basis.template &&
      sameNoteFileStamp(basis.stamp, basis.template.stat) &&
      (await readVaultText(this.app.vault, basis.template)) === basis.raw &&
      sameNoteFileStamp(basis.stamp, basis.template.stat) &&
      basis.policy.current()
    );
  }
  private templateFirstNativeBasisCurrent(
    plan: TemplateFirstPlan,
    basis: TemplateFirstBasis,
  ): boolean {
    return (
      basis.policy.current() &&
      (basis.template === undefined ||
        (this.resolveTemplate(plan.templatePath ?? '') === basis.template &&
          sameNoteFileStamp(basis.stamp, basis.template.stat)))
    );
  }

  /** Read-only static provisioning plan; executable templates are never run by this capability. */
  async planStaticNote(
    filePath: string,
    templatePath: string,
    title: string,
  ): Promise<StaticNotePlan> {
    const basis = await this.captureStaticPlan(filePath, templatePath, title);
    if (basis === undefined) return { type: 'unsupported-template' };
    if (
      !this.staticTemplateCurrent(basis) ||
      this.app.vault.getAbstractFileByPath(basis.path) !== basis.original
    )
      throw new StaleStaticNoteError();
    return this.staticPlan(basis, {
      owned: basis.original === null ? undefined : { file: basis.original, content: basis.content },
      effects: 'unchanged',
    });
  }

  private staticPlan(basis: StaticPlanBasis, state: StaticPlanState): StaticNotePlan {
    const check = (file: object, live: string): boolean =>
      file instanceof TFile &&
      state.owned?.file === file &&
      state.owned.content === live &&
      this.app.vault.getAbstractFileByPath(basis.path) === file &&
      this.staticTemplateCurrent(basis);
    const validate = async (): Promise<boolean> => {
      if (!(await this.verifyStaticTemplate(basis))) return false;
      if (state.owned === undefined)
        return this.app.vault.getAbstractFileByPath(basis.path) === null;
      return check(state.owned.file, await readVaultText(this.app.vault, state.owned.file));
    };
    const plan: StaticNotePlan = {
      type: 'ready',
      content: state.owned?.content ?? basis.content,
      sharesBasis: (other) => {
        const peer = this.staticPlanBases.get(other);
        return (
          peer?.path === basis.path &&
          peer.original === basis.original &&
          peer.content === basis.content &&
          peer.templatePath === basis.templatePath &&
          peer.template === basis.template &&
          peer.raw === basis.raw &&
          sameNoteFileStamp(peer.stamp, basis.stamp)
        );
      },
      refresh: (current, allowCreated = false) =>
        this.refreshStaticPlan(basis, state, { current, allowCreated, validate }),
      validate,
      check,
      provision: (validateOuter) =>
        this.provisionStaticPlan(
          basis,
          state,
          async () => (await validateOuter()) && (await validate()),
        ),
    };
    this.staticPlanBases.set(plan, basis);
    return plan;
  }

  private async refreshStaticPlan(
    basis: StaticPlanBasis,
    state: StaticPlanState,
    options: {
      current: { readonly file: object; readonly content: string } | undefined;
      allowCreated: boolean;
      validate: () => Promise<boolean>;
    },
  ): Promise<StaticNotePlan | undefined> {
    if (!(await this.verifyStaticTemplate(basis))) return undefined;
    const { current } = options;
    if (current === undefined)
      return (await options.validate()) ? this.staticPlan(basis, { ...state }) : undefined;
    if (!this.staticRefreshIdentity(basis, state, current.file, options.allowCreated))
      return undefined;
    if (
      this.app.vault.getAbstractFileByPath(basis.path) !== current.file ||
      (await readVaultText(this.app.vault, current.file)) !== current.content ||
      this.app.vault.getAbstractFileByPath(basis.path) !== current.file ||
      !this.staticTemplateCurrent(basis)
    )
      return undefined;
    return this.staticPlan(basis, {
      owned: { file: current.file, content: current.content },
      effects: 'unchanged',
    });
  }

  private staticRefreshIdentity(
    basis: StaticPlanBasis,
    state: StaticPlanState,
    file: object,
    allowCreated: boolean,
  ): file is TFile {
    const expected = state.owned?.file ?? basis.original;
    return file instanceof TFile && (expected === null ? allowCreated : file === expected);
  }

  private async captureStaticPlan(
    filePath: string,
    templatePath: string,
    title: string,
  ): Promise<StaticPlanBasis | undefined> {
    const path = notePath(filePath);
    const original = this.app.vault.getAbstractFileByPath(path);
    if (original !== null && !(original instanceof TFile)) throw new InvalidNotePathError(path);
    if (original !== null)
      return {
        path,
        original,
        content: await readVaultText(this.app.vault, original),
        templatePath: '',
        template: undefined,
        raw: undefined,
        stamp: undefined,
      };
    const template = this.resolveTemplate(templatePath);
    const stamp = template === undefined ? undefined : { ...template.stat };
    const raw = template === undefined ? undefined : await readVaultText(this.app.vault, template);
    if (raw?.includes('<%') === true) return undefined;
    TemplaterAdapter.fromApp(this.app, true);
    return {
      path,
      original,
      content: raw === undefined ? '' : renderCoreTemplate(raw, title),
      templatePath,
      template,
      raw,
      stamp,
    };
  }

  private staticTemplateCurrent(basis: StaticPlanBasis): boolean {
    return (
      basis.original !== null ||
      (this.resolveTemplate(basis.templatePath) === basis.template &&
        sameNoteFileStamp(basis.stamp, basis.template?.stat))
    );
  }

  private async verifyStaticTemplate(basis: StaticPlanBasis): Promise<boolean> {
    return (
      this.staticTemplateCurrent(basis) &&
      (basis.template === undefined ||
        (await readVaultText(this.app.vault, basis.template)) === basis.raw) &&
      this.staticTemplateCurrent(basis)
    );
  }

  private async provisionStaticPlan(
    basis: StaticPlanBasis,
    state: StaticPlanState,
    validate: () => Promise<boolean>,
  ): Promise<StaticPlanResult> {
    const verify = async (): Promise<void> => {
      if (!(await validate())) throw new StaleStaticNoteError();
    };
    try {
      await verify();
      if (state.owned !== undefined) return { path: basis.path, effects: state.effects };
      await this.ensureFolders(basis.path, {
        check: verify,
        attempting: () => {
          if (state.effects === 'unchanged') state.effects = 'unknown';
        },
        created: () => {
          state.effects = 'committed';
        },
      });
      const owned = await this.commitStaticNote(
        basis.path,
        basis.content,
        {
          check: verify,
          verifyTemplate: async () => {
            if (!(await this.verifyStaticTemplate(basis))) throw new StaleStaticNoteError();
          },
        },
        state.effects,
      );
      this.acceptStaticPlan(state, owned);
      if (!(await this.verifyStaticTemplate(basis))) return { effects: state.effects };
      return { path: basis.path, effects: state.effects };
    } catch (cause) {
      this.rejectStaticPlan(state, cause);
      return { effects: state.effects };
    }
  }

  private acceptStaticPlan(state: StaticPlanState, owned: { file: TFile; content: string }): void {
    state.owned = owned;
    state.effects = 'committed';
  }

  private rejectStaticPlan(state: StaticPlanState, cause: unknown): void {
    if (!(cause instanceof StaticNoteFailure)) return;
    if (cause.owned !== undefined) state.owned = cause.owned;
    state.effects = cause.effects === 'partial' ? 'committed' : cause.effects;
  }

  ensureNote(filePath: string, templatePath: string, title: string): Promise<TFile> {
    const path = notePath(filePath);
    const inFlight = mapFor(inFlightByApp, this.app);
    const active = inFlight.get(path);
    if (active !== undefined) return active;
    const operation = this.ensureNoteUnshared(path, templatePath.trim(), title);
    inFlight.set(path, operation);
    void operation.then(
      () => {
        if (inFlight.get(path) === operation) inFlight.delete(path);
      },
      () => {
        if (inFlight.get(path) === operation) inFlight.delete(path);
      },
    );
    return operation;
  }

  async createNoteFromTemplate(
    filePath: string,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    const path = notePath(filePath);
    if (this.app.vault.getAbstractFileByPath(path) !== null) {
      throw new Error(`A note already exists at ${path}.`);
    }
    const template = this.resolveTemplate(templatePath.trim());
    await this.ensureFolders(path);
    return await this.createPreparedNote(path, template, templatePath.trim(), { title });
  }

  /** Creates final, prevalidated content without running template code or opening an existing note. */
  createStaticNote(request: PreparedStaticNoteRequest): Promise<PreparedStaticNoteResult>;
  createStaticNote(request: StaticNoteRequest): Promise<{ file: TFile; content: string }>;
  async createStaticNote(
    request: StaticNoteRequest | PreparedStaticNoteRequest,
  ): Promise<{ file: TFile; content: string }> {
    if ('plan' in request) return this.createSealedStaticNote(request);
    const path = notePath(request.path);
    if (path !== request.path) throw new StaleStaticNoteError();
    TemplaterAdapter.fromApp(this.app, true);
    const template = this.resolveTemplate(request.templatePath);
    const stamp = template === undefined ? undefined : { ...template.stat };
    const capture = template === undefined ? undefined : request.capture(template);
    if (capture?.content.includes('<%') === true) throw new ExecutableTemplateError();
    const body =
      capture === undefined ? undefined : renderCoreTemplate(capture.content, request.title);
    const content = request.prepare(body);
    const check = (): void => {
      if (
        this.resolveTemplate(request.templatePath) !== template ||
        !sameNoteFileStamp(stamp, template?.stat) ||
        capture?.current() === false
      )
        throw new StaleStaticNoteError();
      request.check(content);
    };
    const verifyTemplate = async (): Promise<void> => {
      if (
        template !== undefined &&
        (await readVaultText(this.app.vault, template)) !== capture?.content
      )
        throw new StaleStaticNoteError();
    };
    check();
    await verifyTemplate();
    check();
    const folders: { effects: StaticNoteFailure['effects'] } = { effects: 'unchanged' };
    try {
      await this.ensureFolders(path, {
        check,
        attempting: () => {
          if (folders.effects === 'unchanged') folders.effects = 'unknown';
        },
        created: () => {
          folders.effects = 'partial';
        },
      });
      return await this.commitStaticNote(path, content, { check, verifyTemplate }, folders.effects);
    } catch (cause) {
      if (cause instanceof StaticNoteFailure) throw cause;
      throw new StaticNoteFailure(folders.effects, cause);
    }
  }

  private async createSealedStaticNote(
    request: PreparedStaticNoteRequest,
  ): Promise<PreparedStaticNoteResult> {
    const basis = this.staticPlanBases.get(request.plan);
    if (
      basis?.original !== null ||
      basis.path !== request.path ||
      notePath(request.path) !== request.path
    )
      throw new StaleStaticNoteError();
    const finalCheck = (): void => {
      if (
        !this.staticTemplateCurrent(basis) ||
        this.app.vault.getAbstractFileByPath(basis.path) !== null
      )
        throw new StaleStaticNoteError();
      request.check(request.content);
    };
    const check = async (): Promise<void> => {
      if (
        !(await request.validate()) ||
        !(await this.verifyStaticTemplate(basis)) ||
        this.app.vault.getAbstractFileByPath(basis.path) !== null
      )
        throw new StaleStaticNoteError();
      finalCheck();
    };
    const folders: { effects: PreparedStaticNoteResult['destinationEffects'] } = {
      effects: 'unchanged',
    };
    try {
      await check();
      await this.ensureFolders(basis.path, {
        check,
        finalCheck,
        attempting: () => {
          if (folders.effects === 'unchanged') folders.effects = 'unknown';
        },
        created: () => {
          folders.effects = 'committed';
        },
      });
      const result = await this.commitStaticNote(
        basis.path,
        request.content,
        { check, verifyTemplate: check, finalCheck },
        folders.effects === 'committed' ? 'partial' : folders.effects,
      );
      return { ...result, destinationEffects: folders.effects };
    } catch (cause) {
      if (cause instanceof StaticNoteFailure)
        throw new StaticNoteFailure(cause.effects, cause.cause, cause.owned, folders.effects);
      throw new StaticNoteFailure(
        folders.effects === 'committed' ? 'partial' : folders.effects,
        cause,
        undefined,
        folders.effects,
      );
    }
  }

  private async commitStaticNote(
    path: string,
    content: string,
    guard: { check(): void | Promise<void>; verifyTemplate(): Promise<void>; finalCheck?(): void },
    folderEffects: StaticNoteFailure['effects'],
  ): Promise<{ file: TFile; content: string }> {
    let session: TemplaterSession | undefined;
    let owned: { file: TFile; content: string } | undefined;
    let failure: StaticNoteFailure | undefined;
    let attempted = false;
    try {
      await guard.check();
      await guard.verifyTemplate();
      session = TemplaterAdapter.fromApp(this.app, true)?.begin(path);
      await guard.check();
      guard.finalCheck?.();
      attempted = true;
      owned = { file: await this.app.vault.create(path, content), content };
    } catch (cause) {
      const uncertain = attempted;
      failure = new StaticNoteFailure(uncertain ? 'unknown' : folderEffects, cause);
    }
    try {
      await session?.finish();
    } catch (cause) {
      if (owned !== undefined) throw new StaticNoteFailure('committed', cause, owned);
      // A failed create already retains its original ownership and I/O evidence.
    }
    if (failure !== undefined) throw failure;
    if (owned === undefined) throw new StaticNoteFailure('unknown', undefined);
    return owned;
  }

  private async ensureNoteUnshared(
    path: string,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    const failed = mapFor(failedByApp, this.app);
    const priorFailure = failed.get(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile && priorFailure === undefined) return existing;
    if (existing instanceof TFile && priorFailure !== undefined) {
      return await this.retryFailedNote(existing, priorFailure, templatePath, title);
    }
    if (existing !== null) throw new InvalidNotePathError(path);
    const template = this.resolveTemplate(templatePath);
    await this.ensureFolders(path);
    return await this.createPreparedNote(path, template, templatePath, { title });
  }

  private async retryFailedNote(
    file: TFile,
    priorFailure: FailedPreparation,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    const failed = mapFor(failedByApp, this.app);
    if (priorFailure.content === undefined) {
      throw new CreatedNoteTemplateError(
        file.path,
        new Error(`Template preparation left unresolved content in ${file.path}.`),
      );
    }
    const content = await readVaultText(this.app.vault, file, 'cached');
    if (content !== priorFailure.content) {
      failed.delete(file.path);
      return file;
    }
    if (priorFailure.uncertain) {
      throw new CreatedNoteTemplateError(
        file.path,
        new Error(`Template preparation left unresolved content in ${file.path}.`),
      );
    }
    const requestedTemplate = templatePath.length > 0 ? templatePath : priorFailure.templatePath;
    const requestedTitle = title.length > 0 ? title : priorFailure.title;
    return await this.retryTemplate(file, this.resolveTemplate(requestedTemplate), {
      content: priorFailure.content,
      templatePath: requestedTemplate,
      title: requestedTitle,
      uncertain: false,
    });
  }

  private resolveTemplate(templatePath: string): TFile | undefined {
    if (templatePath.length === 0) return undefined;
    const template = this.app.metadataCache.getFirstLinkpathDest(templatePath, '');
    if (!(template instanceof TFile)) throw new MissingNoteTemplateError(templatePath);
    return template;
  }

  private async ensureFolders(filePath: string, guard?: FolderGuard): Promise<void> {
    const slash = filePath.lastIndexOf('/');
    if (slash < 0) return;
    const segments = filePath.slice(0, slash).split('/');
    let current = '';
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      await guard?.check();
      await this.ensureFolder(current, filePath, guard);
    }
  }

  private async ensureFolder(path: string, filePath: string, guard?: FolderGuard): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    if (existing !== null) throw new InvalidNotePathError(filePath);
    try {
      await guard?.check();
      finalFolderCheck(guard);
      guard?.attempting();
      await this.app.vault.createFolder(path);
      guard?.created();
    } catch (cause) {
      if (guard !== undefined) throw cause;
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw cause;
    }
  }

  private async createPreparedNote(
    path: string,
    template: TFile | undefined,
    templatePath: string,
    options: { readonly title: string; readonly guard?: TemplateCreationGuard },
  ): Promise<TFile> {
    const { guard, title } = options;
    await guard?.check();
    const session = this.preparationSession(path, guard);
    let file: TFile | undefined;
    let failure: { readonly cause: unknown } | undefined;
    try {
      await guard?.check();
      guard?.finalCheck();
      guard?.attempting();
      file = await this.app.vault.create(path, '');
      await guard?.created(file);
      if (template !== undefined)
        await this.applyTemplate({
          file,
          template,
          title,
          expectedContent: '',
          session,
          ...(guard === undefined ? {} : { guard }),
        });
      mapFor(failedByApp, this.app).delete(path);
    } catch (cause) {
      failure = { cause };
    }
    failure = await this.finishPreparation(session, failure);
    return await this.finishCreatedPreparation({
      file,
      failure,
      path,
      templatePath,
      title,
      guarded: guard !== undefined,
    });
  }
  private preparationSession(
    path: string,
    guard: TemplateCreationGuard | undefined,
  ): TemplaterSession | undefined {
    return (guard === undefined ? this.templater() : guard.adapter)?.begin(path);
  }
  private async finishCreatedPreparation(state: {
    file: TFile | undefined;
    failure: { readonly cause: unknown } | undefined;
    path: string;
    templatePath: string;
    title: string;
    guarded: boolean;
  }): Promise<TFile> {
    const { file, failure, path, templatePath, title } = state;
    if (failure !== undefined) {
      if (!state.guarded && file !== undefined) {
        await this.recordFailedPreparation(file, templatePath, title, '');
        throw new CreatedNoteTemplateError(path, failure.cause);
      }
      throw failure.cause;
    }
    if (file === undefined) throw new Error('Note creation returned no file.');
    return file;
  }
  private async finishPreparation(
    session: TemplaterSession | undefined,
    failure: { readonly cause: unknown } | undefined,
  ): Promise<{ readonly cause: unknown } | undefined> {
    try {
      await session?.finish();
    } catch (cause) {
      return failure ?? { cause };
    }
    return failure;
  }

  private async retryTemplate(
    file: TFile,
    template: TFile | undefined,
    failure: FailedPreparation,
  ): Promise<TFile> {
    if (template === undefined) {
      mapFor(failedByApp, this.app).delete(file.path);
      return file;
    }
    const expectedContent = failure.content;
    if (expectedContent === undefined) {
      throw new CreatedNoteTemplateError(
        file.path,
        new Error(`Template preparation left unresolved content in ${file.path}.`),
      );
    }
    const session = this.templater()?.begin(file.path);
    try {
      await this.applyTemplate({
        file,
        template,
        title: failure.title,
        expectedContent,
        session,
      });
      mapFor(failedByApp, this.app).delete(file.path);
      return file;
    } catch (cause) {
      if (cause instanceof NoteContentChangedError) {
        mapFor(failedByApp, this.app).set(file.path, failure);
      } else {
        await this.recordFailedPreparation(
          file,
          failure.templatePath,
          failure.title,
          expectedContent,
        );
      }
      throw new CreatedNoteTemplateError(file.path, cause);
    } finally {
      await session?.finish();
    }
  }

  private async recordFailedPreparation(
    file: TFile,
    templatePath: string,
    title: string,
    expectedContent: string,
  ): Promise<void> {
    const failed = mapFor(failedByApp, this.app);
    failed.set(file.path, { content: undefined, templatePath, title, uncertain: true });
    try {
      const content = await readVaultText(this.app.vault, file, 'cached');
      failed.set(file.path, {
        content,
        templatePath,
        title,
        uncertain: content !== expectedContent,
      });
    } catch {
      // The unknown snapshot remains conservatively blocked under the owned failure record.
    }
  }

  private async applyTemplate({
    file,
    template,
    title,
    expectedContent,
    session,
    guard,
  }: TemplateApplication): Promise<void> {
    const path = file.path;
    let content: string;
    await guard?.check(file);
    guard?.rendering();
    if (session !== undefined) {
      content = await session.render(template, file);
    } else {
      const raw = await readVaultText(this.app.vault, template, 'cached');
      content = renderCoreTemplate(raw, title);
    }
    await guard?.check(file);
    guard?.checkContent(content);
    const written = await this.app.vault.process(file, (source) => {
      guard?.checkLive(file, content);
      if (
        guard !== undefined &&
        (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file)
      )
        throw new NoteContentChangedError();
      if (source !== expectedContent) {
        throw new NoteContentChangedError(
          `Note content changed while applying the template: ${file.path}`,
        );
      }
      return content;
    });
    if (guard !== undefined && written !== content) throw new NoteContentChangedError();
    guard?.applied();
  }

  private templater(): TemplaterAdapter | undefined {
    return TemplaterAdapter.fromApp(this.app);
  }
}
