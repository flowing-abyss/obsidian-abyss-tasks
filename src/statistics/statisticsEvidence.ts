import { required } from './statisticsWork';
import type {
  StatisticsDataset,
  StatisticsEntry,
  StatisticsEvidencePage,
  StatisticsEvidenceRow,
  StatisticsScopedCoverage,
  StatisticsTask,
  StatisticsViewModel,
} from './types';
interface Selection {
  readonly length: number;
  readonly matches?: ((index: number) => boolean) | undefined;
  readonly row: (index: number) => StatisticsEvidenceRow;
}
/** Dense selections page directly; sparse selections count without allocating discarded source rows. */
export class EvidenceRegistry {
  private readonly selections = new Map<string, Selection>();
  readonly coverage: StatisticsViewModel['coverage'];
  constructor(
    private readonly dataset: StatisticsDataset,
    scope: StatisticsScopedCoverage,
  ) {
    this.coverage = Object.freeze({ source: dataset.coverage, scope });
  }
  taskRow(task: StatisticsTask, context?: string): StatisticsEvidenceRow {
    return {
      key: task.key,
      title: task.title,
      fileKind: task.fileKind,
      filePath: task.filePath,
      node: task.ref,
      context,
    };
  }
  entryRow(
    entry: StatisticsEntry,
    contributionMinutes?: number,
    context?: string,
  ): StatisticsEvidenceRow {
    return {
      ...this.taskRow(required(this.dataset.tasks[entry.owner]), context),
      key: entry.key,
      entry: entry.ref,
      entryTiming: { startMs: entry.startMs, endMs: entry.endMs },
      contributionMinutes,
    };
  }
  tasks(id: string, indices: readonly number[]): string {
    this.selections.set(id, {
      length: indices.length,
      row: (index) => this.taskRow(required(this.dataset.tasks[required(indices[index])])),
    });
    return id;
  }
  taskQuery(id: string, predicate: (task: StatisticsTask) => boolean): string {
    this.selections.set(id, {
      length: this.dataset.tasks.length,
      matches: (index) => predicate(required(this.dataset.tasks[index])),
      row: (index) => this.taskRow(required(this.dataset.tasks[index])),
    });
    return id;
  }
  entryQuery(id: string, contribution: (entry: StatisticsEntry) => number | undefined): string {
    this.selections.set(id, {
      length: this.dataset.entries.length,
      matches: (index) => contribution(required(this.dataset.entries[index])) !== undefined,
      row: (index) => {
        const entry = required(this.dataset.entries[index]);
        return this.entryRow(entry, contribution(entry));
      },
    });
    return id;
  }
  rows(id: string, length: number, row: (index: number) => StatisticsEvidenceRow): string {
    this.selections.set(id, { length, row });
    return id;
  }
  readonly page = (id: string, offset: number, limit: number): StatisticsEvidencePage => {
    const selection = this.selections.get(id);
    if (selection === undefined) return { total: 0, rows: [] };
    const start = pageNumber(offset, 0),
      size = Math.min(50, pageNumber(limit, 50));
    return selection.matches === undefined
      ? this.densePage(selection, start, size)
      : this.sparsePage(selection, start, size);
  };
  private densePage(selection: Selection, start: number, size: number): StatisticsEvidencePage {
    const rows: StatisticsEvidenceRow[] = [];
    for (let index = start; index < Math.min(selection.length, start + size); index++)
      rows.push(selection.row(index));
    return pageResult(rows, start, selection.length);
  }
  private sparsePage(selection: Selection, start: number, size: number): StatisticsEvidencePage {
    const rows: StatisticsEvidenceRow[] = [];
    let total = 0;
    for (let index = 0; index < selection.length; index++) {
      if (!required(selection.matches)(index)) continue;
      if (total >= start && rows.length < size) rows.push(selection.row(index));
      total++;
    }
    return pageResult(rows, start, total);
  }
}
function pageNumber(value: number, fallback: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : fallback));
}
function pageResult(
  rows: readonly StatisticsEvidenceRow[],
  start: number,
  total: number,
): StatisticsEvidencePage {
  return { total, rows, nextOffset: start + rows.length < total ? start + rows.length : undefined };
}
