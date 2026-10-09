import { setIcon } from 'obsidian';
import type { StatisticsEvidenceRow, StatisticsViewModel } from '../../statistics';
import {
  formatTrackedDuration,
  rootTaskNodeSnapshot,
  sameTaskNodeRef,
  taskNodeAddress,
  taskNodeSourceLine,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskNodeSnapshot,
  type TaskQueryApi,
  type TaskSnapshot,
  type TaskStatisticsSource,
} from '../../tasks';
import {
  rootTaskNodeRef,
  taskNodeRef,
  taskSelectionRefPath,
  type TaskSelectionNode,
} from '../../ui/taskSelection';
import { statisticsButton } from './StatisticsControls';
import { statisticsNumber } from './statisticsFormat';
export interface StatisticsEvidenceHost {
  beginEvidence?(): void;
  renderNode(
    host: HTMLElement,
    projection: TaskNodeSnapshot,
    activate: () => void,
  ): { destroy(): void };
  select(stack: TaskSelectionNode[]): void;
  openSource(path: string, line: number): Promise<void>;
}
export class StatisticsEvidence {
  private offset_abyssPrivate = 0;
  private selection_abyssPrivate = '';
  private readonly mounts_abyssPrivate = new Map<string, { destroy(): void }>();
  private generation_abyssPrivate = 0;
  constructor(
    private readonly source_abyssPrivate: TaskStatisticsSource,
    private readonly queries_abyssPrivate: Pick<TaskQueryApi, 'resolve'>,
    private readonly host_abyssPrivate: StatisticsEvidenceHost,
  ) {}
  render(
    element: HTMLElement,
    model: StatisticsViewModel,
    selection: { readonly id: string; readonly label: string },
    close: () => void,
  ): void {
    this.clear();
    this.host_abyssPrivate.beginEvidence?.();
    element.empty();
    this.offset_abyssPrivate = 0;
    this.selection_abyssPrivate = selection.id;
    const header = element.createDiv({ cls: 'abyss-statistics-evidence-header' });
    header.createEl('h3', { text: selection.label, attr: { tabindex: '-1' } });
    const total = model.evidence(selection.id, 0, 0).total;
    header.createSpan({
      text: `${total} matching ${total === 1 ? 'record' : 'records'}`,
      cls: 'abyss-statistics-evidence-count',
    });
    const clear = header.createEl('button', {
      cls: 'abyss-view-state-btn',
      attr: { type: 'button', 'aria-label': 'Clear selection' },
    });
    setIcon(clear, 'x');
    clear.addEventListener('click', close);
    const records = element.createDiv({ cls: 'abyss-statistics-evidence-records' });
    records.createDiv({
      cls: 'abyss-statistics-context',
      text: model.currentState
        ? `Current state · ${new Date(model.asOfMs).toLocaleDateString('en')}`
        : model.dateLabel,
    });
    this.more_abyssPrivate(records, model);
  }
  private more_abyssPrivate(element: HTMLElement, model: StatisticsViewModel): void {
    const generation = this.generation_abyssPrivate;
    const page = model.evidence(this.selection_abyssPrivate, this.offset_abyssPrivate, 50);
    for (const row of page.rows) this.row_abyssPrivate(element, row, model.asOfMs);
    this.offset_abyssPrivate += page.rows.length;
    if (page.nextOffset !== undefined) {
      const button = statisticsButton(element, 'Load more', () => {
        if (generation !== this.generation_abyssPrivate) return;
        button.remove();
        this.more_abyssPrivate(element, model);
      });
    }
  }
  clear(): void {
    this.generation_abyssPrivate++;
    for (const mount of this.mounts_abyssPrivate.values()) mount.destroy();
    this.mounts_abyssPrivate.clear();
  }
  destroy(): void {
    this.clear();
  }
  private current_abyssPrivate(
    node: TaskNodeRef,
    fileKind: 'live' | 'archive' | undefined,
  ): TaskNodeSnapshot | undefined {
    const rootRef = rootTaskNodeRef(node);
    const snapshot = this.source_abyssPrivate.readStatistics();
    const kind = fileKind ?? snapshot.files.find((file) => file.path === rootRef.filePath)?.kind;
    if (kind === 'live') {
      const resolution = this.queries_abyssPrivate.resolve(rootRef);
      if (resolution.type !== 'exact') return undefined;
      return exactProjection(resolution.task, node);
    }
    if (
      kind !== 'archive' ||
      !this.source_abyssPrivate.isStatisticsCurrent(snapshot) ||
      snapshot.issues.some((issue) => issue.path === rootRef.filePath)
    )
      return undefined;
    const root = snapshot.files
      .find((file) => file.kind === 'archive' && file.path === rootRef.filePath)
      ?.roots.find((root) => sameTaskNodeRef(taskNodeRef(root), { type: 'task', ref: rootRef }));
    return root === undefined ? undefined : exactProjection(root, node);
  }
  private row_abyssPrivate(element: HTMLElement, row: StatisticsEvidenceRow, asOfMs: number): void {
    const group = element.createDiv({ cls: 'abyss-statistics-evidence-row' });
    group.dataset['evidenceKey'] = row.key;
    const pair = row.relatedNode === undefined ? '' : row.key;
    if (row.relatedNode !== undefined) {
      group.createDiv({ text: 'From', cls: 'abyss-statistics-context' });
      this.node_abyssPrivate(group, row.relatedNode, {
        fileKind: undefined,
        title: 'Related task unavailable',
        pair,
      });
      group.createDiv({ text: 'To', cls: 'abyss-statistics-context' });
    }
    this.node_abyssPrivate(group, row.node, { fileKind: row.fileKind, title: row.title, pair });
    this.context_abyssPrivate(group, row, asOfMs);
  }
  private node_abyssPrivate(
    group: HTMLElement,
    target: TaskNodeRef,
    context: {
      readonly fileKind: 'live' | 'archive' | undefined;
      readonly title: string;
      readonly pair: string;
    },
  ): void {
    const { fileKind, title, pair } = context;
    const projection = this.current_abyssPrivate(target, fileKind);
    const rootRef = rootTaskNodeRef(target);
    const kind =
      fileKind ??
      this.source_abyssPrivate.readStatistics().files.find((file) => file.path === rootRef.filePath)
        ?.kind;
    const generation = this.generation_abyssPrivate;
    if (kind === 'archive') {
      group.createDiv({ text: `Archived · ${rootRef.filePath}`, cls: 'abyss-statistics-context' });
      const action = statisticsButton(
        group,
        `Open archived source · ${projection?.node.title ?? title}`,
        () => {
          if (generation !== this.generation_abyssPrivate) return;
          if (this.current_abyssPrivate(target, kind) === undefined) {
            this.stale_abyssPrivate(group);
            return;
          }
          void this.host_abyssPrivate
            .openSource(rootRef.filePath, taskNodeSourceLine(target))
            .catch((error: unknown) => {
              if (generation !== this.generation_abyssPrivate) return;
              console.error('[abyss-tasks] Could not open Statistics source', { error });
              group.createDiv({
                text: 'Could not open the retained source. Try again.',
                attr: { role: 'alert' },
              });
            });
        },
      );
      action.classList.add('abyss-statistics-evidence-action');
      if (projection === undefined) this.stale_abyssPrivate(group);
      return;
    }
    if (projection === undefined) {
      group.createDiv({ text: title });
      this.stale_abyssPrivate(group);
      return;
    }
    const key = JSON.stringify([pair, rootRef.revision, taskNodeAddress(target)]);
    if (this.mounts_abyssPrivate.has(key)) return;
    const mount = this.host_abyssPrivate.renderNode(group, projection, () => {
      if (generation !== this.generation_abyssPrivate) return;
      const current = this.current_abyssPrivate(target, kind);
      if (current === undefined) this.stale_abyssPrivate(group);
      else this.host_abyssPrivate.select([current.root, ...current.path]);
    });
    this.mounts_abyssPrivate.set(key, mount);
  }
  private stale_abyssPrivate(group: HTMLElement): void {
    group.createDiv({
      text: 'This source changed or was removed. Refresh Analysis to inspect current evidence.',
      attr: { role: 'status' },
    });
  }
  private context_abyssPrivate(
    group: HTMLElement,
    row: StatisticsEvidenceRow,
    asOfMs: number,
  ): void {
    if (row.entryTiming !== undefined) {
      group.createDiv({
        text: entryContext(row, asOfMs),
        cls: 'abyss-statistics-context',
      });
    }
    if (row.context !== undefined)
      group.createDiv({ text: row.context, cls: 'abyss-statistics-context' });
    if (row.atMs !== undefined)
      group.createDiv({
        text: new Date(row.atMs).toLocaleString('en'),
        cls: 'abyss-statistics-context',
      });
    if (row.contributionMinutes !== undefined)
      group.createDiv({
        text: `Selected contribution · ${statisticsNumber(row.contributionMinutes)} recorded minutes`,
        cls: 'abyss-statistics-context',
      });
  }
}

function evidenceInstant(ms: number): string {
  return new Date(ms).toLocaleString('en', { timeZoneName: 'short' });
}

function exactProjection(root: TaskSnapshot, target: TaskNodeRef): TaskNodeSnapshot | undefined {
  const stack = taskSelectionRefPath(root, target);
  if (stack === undefined) return undefined;
  if (target.type === 'task') return rootTaskNodeSnapshot(root);
  const path = stack.filter((node): node is SubtaskSnapshot => 'parent' in node.ref);
  const node = path[path.length - 1];
  return node === undefined ? undefined : { root, target, path, node };
}

function entryContext(row: StatisticsEvidenceRow, asOfMs: number): string {
  const startMs = row.entryTiming?.startMs;
  const endMs = row.entryTiming?.endMs;
  if (startMs === undefined) return `Unusable recording · ${row.entry?.originalMarkdown ?? ''}`;
  if (endMs === undefined)
    return `Running session · ${evidenceInstant(startMs)} → Through ${evidenceInstant(asOfMs)}`;
  if (endMs > asOfMs)
    return `Session · ${evidenceInstant(startMs)} → Through ${evidenceInstant(asOfMs)} · Recorded end ${evidenceInstant(endMs)}`;
  return `Full session · ${evidenceInstant(startMs)} → ${evidenceInstant(endMs)} · ${formatTrackedDuration(endMs - startMs)}`;
}
