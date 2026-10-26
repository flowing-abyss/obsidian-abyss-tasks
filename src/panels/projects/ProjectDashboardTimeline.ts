import { setIcon } from 'obsidian';
import { ProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import type { ProjectTimelineAxisLayout } from '../../projects/projectTimelineAxis';
import { planProjectTimelineEndpointEdit } from '../../projects/projectTimelineEndpointEdits';
import {
  projectTimelineBarGeometry,
  projectTimelineRange,
  type ProjectTimelineRange,
  type ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';
import type { Project } from '../../projects/types';
import type { TimelineContextRow, TimelineContextRowLayout } from '../timeline/TimelineContextRow';
import {
  createTimelineRangeHandle,
  patchTimelineGrid,
  patchTimelineToday,
} from '../timeline/timelinePresentation';
import { reportProjectTimelineRangeFailure as reportFailure } from './projectTimelineFeedback';
import {
  applyProjectTimelineBarGeometry,
  freezeProjectTimelineRangeBinding,
  ProjectTimelinePointerInteraction,
  sameProjectTimelineRangeBinding,
  sameProjectTimelineRangeSource,
  type ProjectTimelineRangeCapture,
  type ProjectTimelineRangeEditRequest,
} from './projectTimelineInteraction';
import {
  captureProjectTimelineRange,
  projectTimelineRangeChanges,
} from './projectTimelineRangeSource';

export interface ProjectDashboardTimelineContext extends TimelineContextRowLayout {
  project(): Project | undefined;
  fields(): readonly ProjectFieldCatalogItem[];
  apply(changes: readonly ProjectCellChange[]): Promise<ProjectEditResult>;
  history(direction: 'undo' | 'redo'): Promise<ProjectEditResult>;
}

/** One project range, sharing its task timeline's axis and the overview's guarded edit policy. */
export class ProjectDashboardTimeline implements TimelineContextRow {
  readonly #root: HTMLElement;
  readonly #name: HTMLElement;
  readonly #track: HTMLElement;
  readonly #grid: HTMLElement;
  readonly #bar: HTMLElement;
  readonly #state: HTMLButtonElement;
  readonly #interaction: ProjectTimelinePointerInteraction;
  readonly #identity: string;
  readonly #migrationCleanup: () => void;
  #destroyed = false;
  #suspended = false;
  #revision = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    host: HTMLElement,
    readonly context: ProjectDashboardTimelineContext,
  ) {
    this.#identity = `project\u0000${context.project()?.path ?? ''}`;
    this.#root = host.createDiv({
      cls: 'abyss-project-timeline-row abyss-project-dashboard-range',
    });
    this.#root.dataset['occurrenceId'] = this.#identity;
    const summary = this.#root.createDiv({ cls: 'abyss-project-timeline-summary' });
    setIcon(summary.createSpan({ cls: 'abyss-project-dashboard-range-icon' }), 'folder');
    this.#name = summary.createSpan({ cls: 'abyss-project-timeline-name' });
    this.#track = this.#root.createDiv({
      cls: 'abyss-project-timeline-track',
      attr: { tabindex: '0', 'data-timeline-part': 'track', 'aria-label': 'Project dates' },
    });
    this.#grid = this.#track.createDiv({
      cls: 'abyss-project-timeline-grid',
      attr: { 'aria-hidden': 'true' },
    });
    this.#bar = this.#track.createDiv({
      cls: 'abyss-project-timeline-bar',
      attr: { tabindex: '0', role: 'button', 'data-timeline-part': 'bar' },
    });
    for (const endpoint of ['start', 'end'] as const)
      createTimelineRangeHandle(this.#bar, endpoint);
    this.#state = this.#track.createEl('button', { cls: 'abyss-project-timeline-state' });
    this.#state.addEventListener('click', () => {
      const day = rangeBounds(this.range())[0];
      if (day !== undefined) context.revealDay(day);
    });
    this.#track.addEventListener('keydown', this.#keydown);
    this.#interaction = new ProjectTimelinePointerInteraction({
      root: this.#root,
      scroll: context.scroll,
      window: () => context.window(),
      captureRangeSource: () => this.#capture(),
      commitRangeEdit: (request) => this.#commit(request),
      reportRangeFailure: reportFailure,
      finishEditor: () => Promise.resolve(true),
      selectRange: (_identity, element) => {
        element.focus({ preventScroll: true });
      },
    });
    this.#migrationCleanup = this.#root.onWindowMigrated(() => {
      this.cancel();
    });
  }
  range(): ProjectTimelineRange {
    const project = this.context.project();
    return project === undefined
      ? { kind: 'unscheduled' }
      : projectTimelineRange(project, this.context.fields());
  }
  update(window: ProjectTimelineWindow, axis: ProjectTimelineAxisLayout): void {
    if (this.#destroyed) return;
    this.#suspended = false;
    this.#name.setText(this.context.project()?.name ?? 'Project');
    const range = this.range();
    const geometry = projectTimelineBarGeometry(range, window);
    this.#bar.hidden = geometry === undefined;
    if (geometry !== undefined) applyProjectTimelineBarGeometry(this.#bar, range, geometry);
    this.#bar.setAttribute('aria-label', `Project dates: ${rangeBounds(range).join(' – ')}`);
    this.#state.hidden = geometry !== undefined;
    this.#state.className = `abyss-project-timeline-state is-${range.kind}`;
    this.#state.setText(
      range.kind === 'unscheduled' ? 'Unscheduled' : rangeBounds(range).join(' – '),
    );
    if (range.kind === 'malformed') this.#state.setText('Invalid project dates');
    this.#state.disabled = range.kind === 'unscheduled' || range.kind === 'malformed';
    patchTimelineGrid(this.#grid, axis);
    patchTimelineToday(this.#track, window, this.context.now());
    this.#interaction.reconcileAfterRender();
  }
  cancel(): void {
    this.#revision++;
    this.#suspended = true;
    this.#interaction.cancelActive();
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#revision++;
    this.#interaction.destroy();
    this.#migrationCleanup();
    this.#track.removeEventListener('keydown', this.#keydown);
    this.#root.remove();
  }
  #capture(): ProjectTimelineRangeCapture {
    const project = this.context.project();
    if (
      this.#destroyed ||
      this.#suspended ||
      !this.#root.isConnected ||
      project === undefined ||
      `project\u0000${project.path}` !== this.#identity
    )
      return { kind: 'rejected', reason: 'This project range is no longer visible.' };
    return captureProjectTimelineRange(project, this.context.fields(), this.#identity);
  }
  #commit(request: ProjectTimelineRangeEditRequest): Promise<ProjectEditResult> {
    return this.#enqueue(async () => {
      const captured = this.#capture();
      if (captured.kind === 'rejected') throw new ProjectEditValidationError(captured.reason);
      const current = captured.source;
      const same =
        request.kind === 'pointer'
          ? sameProjectTimelineRangeSource(request.source, current)
          : sameProjectTimelineRangeBinding(request.target, current);
      if (!same)
        throw new ProjectEditValidationError(
          'The project dates changed after this Timeline edit started. Try again.',
        );
      const source = request.kind === 'pointer' ? request.source : current;
      const plan = planProjectTimelineEndpointEdit(
        source.range,
        {
          start: { exists: source.start.expectedExists, value: source.start.expectedValue },
          end: { exists: source.end.expectedExists, value: source.end.expectedValue },
        },
        request.intent,
      );
      if (plan.kind === 'rejected') throw new ProjectEditValidationError(plan.reason);
      return this.context.apply(projectTimelineRangeChanges(source, plan));
    });
  }
  #enqueue(mutation: () => Promise<ProjectEditResult>): Promise<ProjectEditResult> {
    const revision = this.#revision;
    const result = this.#queue.then(() => {
      if (revision !== this.#revision || this.#capture().kind === 'rejected')
        throw new ProjectEditValidationError('This project range edit was cancelled.');
      return mutation();
    });
    // The initiating pointer/keyboard boundary reports rejection; the queue must remain usable.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  #historyKeydown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'z') return;
    event.preventDefault();
    event.stopPropagation();
    void this.#enqueue(() => this.context.history(event.shiftKey ? 'redo' : 'undo')).then(
      (result) => {
        if (result.failed.length > 0) reportFailure(result);
      },
      reportFailure,
    );
  }
  readonly #keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.altKey) return;
    if (event.ctrlKey || event.metaKey) {
      this.#historyKeydown(event);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const captured = this.#capture();
    if (captured.kind === 'rejected') {
      reportFailure(captured.reason);
      return;
    }
    const deltaDays = event.key === 'ArrowLeft' ? -1 : 1;
    void this.#commit({
      kind: 'keyboard',
      target: freezeProjectTimelineRangeBinding(captured.source),
      intent: { type: event.shiftKey ? 'adjustEnd' : 'move', deltaDays },
    }).then((result) => {
      if (result.failed.length > 0) reportFailure(result);
    }, reportFailure);
  };
}
function rangeBounds(range: ProjectTimelineRange): readonly string[] {
  if (range.kind === 'closed') return [range.startDay, range.endDay];
  if (range.kind === 'open-end') return [range.startDay];
  return range.kind === 'open-start' ? [range.endDay] : [];
}
