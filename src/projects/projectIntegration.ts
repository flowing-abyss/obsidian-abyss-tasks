import { noteNameOfPath } from '../markdown/noteName';
import { compileQuery, type CompiledQuery } from '../query/evaluateQuery';
import type { ProjectsSettings } from '../settings/types';
import type { ProjectSourceReadApi, TaskReadResult } from '../tasks';
import type { ProjectIntegrationReads, ProjectReadRecord, ProjectReadSummary } from './projectApi';
import { catalog, fieldsFor, schemaFor, statusFor } from './projectMetadataPolicy';
import { computeStats } from './projectStats';

/** Configuration that affects disclosure, interpretation or a prospective write. */
export function projectSemantics(settings: ProjectsSettings): string {
  const {
    membershipQuery,
    createFolder,
    defaultStatusId,
    templatePath,
    taskInsertionMode,
    taskInsertionSection,
    taskInsertionSectionPosition,
  } = settings;
  const fields = catalog(settings);
  return JSON.stringify({
    membershipQuery,
    createFolder,
    defaultStatusId,
    templatePath,
    schema: schemaFor(settings, fields),
    bindings: fields
      .filter((field) => field.type !== null && field.property !== undefined)
      .map(({ id, property }) => ({ id, property })),
    taskInsertionMode,
    taskInsertionSection,
    taskInsertionSectionPosition,
  });
}
class ProjectReads implements ProjectIntegrationReads {
  private semanticKey = '';
  private semanticToken: object = {};
  private membershipKey: string | undefined;
  private membership: CompiledQuery = () => false;
  constructor(
    private readonly source: ProjectSourceReadApi,
    private readonly settings: () => ProjectsSettings,
  ) {}
  semantics(): object {
    const next = projectSemantics(this.settings());
    if (next !== this.semanticKey) {
      this.semanticKey = next;
      this.semanticToken = {};
    }
    return this.semanticToken;
  }
  coverage(): TaskReadResult<true> {
    return this.source.coverage();
  }
  paths(): readonly string[] {
    return this.source.paths();
  }
  private matches(
    path: string,
    tags: readonly string[],
    frontmatter: Readonly<Record<string, unknown>>,
  ): boolean {
    const query = this.settings().membershipQuery;
    if (query !== this.membershipKey) {
      this.membershipKey = query;
      this.membership = compileQuery(query);
    }
    return this.membership(path, tags, frontmatter);
  }
  private read(
    path: string,
    detail: boolean,
    captured?: object,
  ): TaskReadResult<ProjectReadRecord | ProjectReadSummary | undefined> {
    const result = this.source.get(path);
    if (result.type === 'error') return result;
    if (result.value === undefined)
      return { type: 'ok', value: undefined, observation: result.observation };
    const value = result.value,
      current = this.settings();
    const tags = [...new Set(value.metadata.tags.map((tag) => tag.toLowerCase()))];
    if (!this.matches(path, tags, value.metadata.frontmatter))
      return { type: 'ok', value: undefined, observation: result.observation };
    const summary: ProjectReadSummary = {
      path,
      name: noteNameOfPath(path),
      identity: value.identity,
      version: value.version,
      semantics: captured ?? this.semantics(),
      status: statusFor(current, value.metadata.frontmatter),
      stats: computeStats(value.roots, {
        closedMs: value.tracked.closedMs,
        openStartsMs: [...value.tracked.openStartsMs],
      }),
    };
    return {
      type: 'ok',
      value: detail
        ? { ...summary, tags, fields: fieldsFor(catalog(current), value.metadata.frontmatter) }
        : summary,
      observation: result.observation,
    };
  }
  schema(): ReturnType<ProjectIntegrationReads['schema']> {
    return schemaFor(this.settings());
  }
  summary(path: string, captured?: object): TaskReadResult<ProjectReadSummary | undefined> {
    return this.read(path, false, captured);
  }
  get(path: string): TaskReadResult<ProjectReadRecord | undefined> {
    return this.read(path, true) as TaskReadResult<ProjectReadRecord | undefined>;
  }
  canDiscloseSource(path: string): boolean {
    const read = this.source.get(path);
    return read.type === 'ok' && read.value !== undefined;
  }
  matchesFile(proof: ProjectReadSummary, file: object): boolean {
    return proof.semantics === this.semantics() && this.source.matchesFile(proof, file);
  }
  guard(proof: ProjectReadSummary, live: string, candidate: string): TaskReadResult<true> {
    if (proof.semantics !== this.semantics()) return { type: 'error', reason: 'stale' };
    const current = this.read(proof.path, false);
    if (current.type === 'error') return current;
    if (current.value?.identity !== proof.identity || current.value.version !== proof.version)
      return { type: 'error', reason: 'stale' };
    const staged = this.source.candidate(proof, live, candidate);
    if (staged.type === 'error') return staged;
    return this.checkMembership(proof.path, staged);
  }
  prospective(path: string, candidate: string): TaskReadResult<true> {
    const staged = this.source.prospective(path, candidate);
    return staged.type === 'error' ? staged : this.checkMembership(path, staged);
  }
  private checkMembership(
    path: string,
    staged: Extract<ReturnType<ProjectSourceReadApi['prospective']>, { type: 'ok' }>,
  ): TaskReadResult<true> {
    return this.matches(
      path,
      staged.value.tags.map((tag) => tag.toLowerCase()),
      staged.value.frontmatter,
    )
      ? { type: 'ok', value: true, observation: staged.observation }
      : { type: 'error', reason: 'unavailable' };
  }
}
export function createProjectIntegrationReads(
  source: ProjectSourceReadApi,
  settings: () => ProjectsSettings,
): ProjectIntegrationReads {
  return new ProjectReads(source, settings);
}
