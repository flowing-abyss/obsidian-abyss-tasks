import type { ProjectWorkspaceLayout, ProjectWorkspaceScope } from './ProjectsDashboardView';

export interface LogicalViewportSession {
  firstKey: string | null;
  firstIndex: number;
  focusedKey: string | null;
  restoreFocus: boolean;
}

export interface WorkNoteBoardSession {
  selectedColumnKey: string | null;
  focusedKey: string | null;
  restoreFocus: boolean;
  readonly columns: Record<string, LogicalViewportSession>;
}

export interface WorkNotesSession {
  readonly list: LogicalViewportSession;
  readonly board: WorkNoteBoardSession;
}

function viewport(): LogicalViewportSession {
  return { firstKey: null, firstIndex: 0, focusedKey: null, restoreFocus: false };
}

export function logicalViewportFirst(
  session: LogicalViewportSession | undefined,
  keys: readonly string[],
): number {
  if (!session) return 0;
  const keyedFirst = session.firstKey === null ? -1 : keys.indexOf(session.firstKey);
  return Math.max(0, keyedFirst < 0 ? session.firstIndex : keyedFirst);
}

export function boardColumnViewport(
  session: WorkNoteBoardSession | undefined,
  columnKey: string,
): LogicalViewportSession | undefined {
  if (!session) return undefined;
  const current = session.columns[columnKey];
  if (current) return current;
  const created = viewport();
  session.columns[columnKey] = created;
  return created;
}

/** Ephemeral Project workspace continuity; never persisted to settings or the vault. */
export class ProjectWorkspaceSession {
  private projectPath: string | null = null;
  scope: ProjectWorkspaceScope = 'tasks';
  layout: ProjectWorkspaceLayout = 'list';
  readonly workNotes: WorkNotesSession = {
    list: viewport(),
    board: {
      selectedColumnKey: null,
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    } satisfies WorkNoteBoardSession,
  };
  readonly timelines = {
    tasks: viewport(),
    workNotes: viewport(),
  };
  /** Portfolio continuity is independent of whichever Project workspace is open. */
  readonly portfolioTimeline = viewport();

  openProject(path: string): void {
    if (this.projectPath === path) return;
    this.reset();
    this.projectPath = path;
  }

  closeProject(): void {
    this.reset();
    this.projectPath = null;
  }

  private reset(): void {
    this.scope = 'tasks';
    this.layout = 'list';
    Object.assign(this.workNotes.list, viewport());
    this.workNotes.board.selectedColumnKey = null;
    this.workNotes.board.focusedKey = null;
    this.workNotes.board.restoreFocus = false;
    Object.assign(this.timelines.tasks, viewport());
    Object.assign(this.timelines.workNotes, viewport());
    for (const key of Object.keys(this.workNotes.board.columns)) {
      delete this.workNotes.board.columns[key];
    }
  }
}
