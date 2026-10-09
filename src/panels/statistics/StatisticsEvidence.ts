import { setIcon } from 'obsidian';
import type { StatisticsEvidenceRow, StatisticsViewModel } from '../../statistics';
import {
  sameTaskNodeRef,
  type TaskQueryApi,
  type TaskSnapshot,
  type TaskStatisticsSource,
} from '../../tasks';
import { taskNodeRef, taskSelectionRefPath, type TaskSelectionNode } from '../../ui/taskSelection';
import { statisticsButton } from './StatisticsControls';
import { statisticsNumber } from './statisticsFormat';
export interface StatisticsEvidenceHost {
  beginEvidence?(): void;
  renderRoot(host: HTMLElement, root: TaskSnapshot, activate: () => void): void;
  select(stack: TaskSelectionNode[]): void;
  openSource(path: string, line: number): Promise<void>;
}
export class StatisticsEvidence {
  private offset_abyssPrivate = 0;
  private selection_abyssPrivate = '';
  private readonly roots_abyssPrivate = new Map<string, { count: number; label: HTMLElement }>();
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
    this.host_abyssPrivate.beginEvidence?.();
    element.empty();
    this.offset_abyssPrivate = 0;
    this.selection_abyssPrivate = selection.id;
    this.roots_abyssPrivate.clear();
    const header = element.createDiv({ cls: 'abyss-statistics-evidence-header' });
    header.createEl('h3', { text: selection.label, attr: { tabindex: '-1' } });
    header.createSpan({
      text: `${model.evidence(selection.id, 0, 0).total} matching records`,
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
    const page = model.evidence(this.selection_abyssPrivate, this.offset_abyssPrivate, 50);
    for (const row of page.rows) this.row_abyssPrivate(element, row);
    this.offset_abyssPrivate += page.rows.length;
    if (page.nextOffset !== undefined) {
      const button = statisticsButton(element, 'Load more', () => {
        button.remove();
        this.more_abyssPrivate(element, model);
      });
    }
  }
  private current_abyssPrivate(row: StatisticsEvidenceRow): TaskSelectionNode[] | undefined {
    let rootRef = row.node;
    while (rootRef.type === 'subtask') rootRef = rootRef.ref.parent;
    if (row.fileKind === 'live') {
      const resolution = this.queries_abyssPrivate.resolve(rootRef.ref);
      if (resolution.type !== 'exact') return undefined;
      return taskSelectionRefPath(resolution.task, row.node);
    }
    const snapshot = this.source_abyssPrivate.readStatistics();
    if (
      !this.source_abyssPrivate.isStatisticsCurrent(snapshot) ||
      snapshot.issues.some((issue) => issue.path === row.filePath)
    )
      return undefined;
    const root = snapshot.files
      .find((file) => file.kind === 'archive' && file.path === row.filePath)
      ?.roots.find((root) => sameTaskNodeRef(taskNodeRef(root), rootRef));
    return root === undefined ? undefined : taskSelectionRefPath(root, row.node);
  }
  private row_abyssPrivate(element: HTMLElement, row: StatisticsEvidenceRow): void {
    const group = element.createDiv({ cls: 'abyss-statistics-evidence-row' });
    group.dataset['evidenceKey'] = row.key;
    const stack = this.current_abyssPrivate(row);
    const root = stack?.[0];
    if (root !== undefined && 'source' in root && row.fileKind === 'live')
      this.root_abyssPrivate(group, row, root);
    if (row.fileKind === 'archive')
      group.createDiv({ text: `Archived · ${row.filePath}`, cls: 'abyss-statistics-context' });
    if (row.fileKind === 'archive' || row.node.type === 'subtask') {
      group.classList.toggle('abyss-statistics-evidence-row--child', row.fileKind === 'live');
      const label = `${evidenceAction(row)} · ${row.title}`;
      const action = statisticsButton(group, label, () => {
        const current = this.current_abyssPrivate(row);
        if (current === undefined) {
          this.stale_abyssPrivate(group);
          return;
        }
        if (row.fileKind === 'live') this.host_abyssPrivate.select(current);
        else {
          let line = 0,
            ref = row.node;
          while (ref.type === 'subtask') {
            line += ref.ref.relativeLine;
            ref = ref.ref.parent;
          }
          line += ref.ref.line;
          void this.host_abyssPrivate.openSource(row.filePath, line).catch((error: unknown) => {
            console.error('[abyss-tasks] Could not open Statistics source', { error });
            group.createDiv({
              text: 'Could not open the retained source. Try again.',
              attr: { role: 'alert' },
            });
          });
        }
      });
      action.classList.add('abyss-statistics-evidence-action');
    } else if (root === undefined) {
      group.createDiv({ text: row.title });
      this.stale_abyssPrivate(group);
    }
    this.context_abyssPrivate(group, row);
  }
  private root_abyssPrivate(
    group: HTMLElement,
    row: StatisticsEvidenceRow,
    root: TaskSnapshot,
  ): void {
    const key = JSON.stringify(root.ref);
    if (!this.roots_abyssPrivate.has(key)) {
      this.host_abyssPrivate.renderRoot(group, root, () => {
        const current = this.queries_abyssPrivate.resolve(root.ref);
        if (current.type === 'exact') this.host_abyssPrivate.select([current.task]);
        else this.stale_abyssPrivate(group);
      });
      this.roots_abyssPrivate.set(key, {
        count: 0,
        label: group.createDiv({ cls: 'abyss-statistics-context' }),
      });
    }
    if (row.node.type === 'subtask') {
      const matched = this.roots_abyssPrivate.get(JSON.stringify(root.ref));
      if (matched !== undefined)
        matched.label.setText(`${++matched.count} matched subtask records shown`);
    }
  }
  private stale_abyssPrivate(group: HTMLElement): void {
    group.createDiv({
      text: 'This source changed or was removed. Refresh Analysis to inspect current evidence.',
      attr: { role: 'status' },
    });
  }
  private context_abyssPrivate(group: HTMLElement, row: StatisticsEvidenceRow): void {
    if (row.context !== undefined)
      group.createDiv({ text: row.context, cls: 'abyss-statistics-context' });
    if (row.atMs !== undefined)
      group.createDiv({
        text: new Date(row.atMs).toLocaleString('en'),
        cls: 'abyss-statistics-context',
      });
    if (row.contributionMinutes !== undefined)
      group.createDiv({
        text: `${statisticsNumber(row.contributionMinutes)} recorded minutes`,
        cls: 'abyss-statistics-context',
      });
  }
}

function evidenceAction(row: StatisticsEvidenceRow): string {
  if (row.fileKind === 'archive') return 'Open archived source';
  return row.node.type === 'subtask' ? 'Select matched subtask' : 'Select task';
}
