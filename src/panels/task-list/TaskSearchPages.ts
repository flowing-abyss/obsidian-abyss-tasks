import type {
  TaskSearchOccurrence,
  TaskSearchOrganization,
} from '../../task-lists/taskSearchOrganization';
import { TaskSearchError, type TaskSearchApi, type TaskSearchHydratedHit } from '../../tasks';
export interface TaskSearchPageModel {
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly rootTotal: number;
  readonly occurrences: readonly TaskSearchOccurrence[];
  readonly roots: readonly TaskSearchHydratedHit[];
  readonly groupCounts: ReadonlyMap<string, number>;
}
export class TaskSearchPages {
  #organization: TaskSearchOrganization | null = null;
  #revision = 0;
  constructor(private readonly search: TaskSearchApi) {}
  set(organization: TaskSearchOrganization): void {
    this.#revision++;
    this.#organization = organization;
  }
  async page(index: number, signal: AbortSignal): Promise<TaskSearchPageModel> {
    const organization = this.#organization;
    const revision = this.#revision;
    if (organization === null) throw new TaskSearchError('disposed', 'Search pages closed');
    const pageCount = Math.max(1, Math.ceil(organization.occurrences.length / 50));
    if (!Number.isInteger(index) || index < 0 || index >= pageCount)
      throw new TaskSearchError('invalid-request', 'Invalid page');
    const occurrences = organization.occurrences.slice(index * 50, (index + 1) * 50);
    const distinct = new Map(
      occurrences.map((o) => [o.address.rootId, { address: o.address, score: o.score }]),
    );
    const roots = await this.search.resolvePage([...distinct.values()], signal);
    if (signal.aborted) throw new TaskSearchError('aborted', 'Search cancelled');
    if (revision !== this.#revision) throw new TaskSearchError('stale', 'Search pages replaced');
    const page = {
      page: index,
      pageCount,
      total: organization.occurrences.length,
      rootTotal: organization.rootTotal,
      occurrences,
      roots,
      groupCounts: organization.groupCounts,
    };
    return page;
  }
  dispose(): void {
    this.#revision++;
    this.#organization = null;
  }
}
