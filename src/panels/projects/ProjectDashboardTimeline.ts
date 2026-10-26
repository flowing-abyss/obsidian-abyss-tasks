import {
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from '../../projects/projectDateValue';
import { ProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import type { ProjectTimelineEditIntent } from '../../projects/projectTimelineEdits';
import { planProjectTimelineEndpointEdit } from '../../projects/projectTimelineEndpointEdits';
import {
  projectTimelineRange,
  type ProjectTimelineRange,
  type ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';
import type { Project } from '../../projects/types';
import type {
  TimelineContextOverlay,
  TimelineContextOverlayLayout,
} from '../timeline/TimelineContextOverlay';
import { reportProjectTimelineRangeFailure as reportFailure } from './projectTimelineFeedback';
import {
  freezeProjectTimelineRangeBinding,
  ProjectTimelinePointerInteraction,
  sameProjectTimelineRangeBinding,
  sameProjectTimelineRangeSource,
  type FrozenProjectTimelineRangeSource,
  type ProjectTimelineRangeCapture,
  type ProjectTimelineRangeEditRequest,
} from './projectTimelineInteraction';
import {
  captureProjectTimelineRange,
  projectTimelineRangeChanges,
} from './projectTimelineRangeSource';

type Endpoint = 'start' | 'end';
export interface ProjectDashboardTimelineContext extends TimelineContextOverlayLayout {
  project(): Project | undefined;
  fields(): readonly ProjectFieldCatalogItem[];
  apply(changes: readonly ProjectCellChange[]): Promise<ProjectEditResult>;
  history(direction: 'undo' | 'redo'): Promise<ProjectEditResult>;
}

/** Project bounds share the task axis and guarded project commands, without occupying a row. */
export class ProjectDashboardTimeline implements TimelineContextOverlay {
  readonly #root: HTMLElement;
  readonly #track: HTMLElement;
  readonly #handles: Record<Endpoint, HTMLButtonElement>;
  readonly #tracks = new Map<HTMLElement, Record<Endpoint, HTMLElement>>();
  readonly #interaction: ProjectTimelinePointerInteraction;
  readonly #identity: string;
  readonly #migrationCleanup: () => void;
  #destroyed = false;
  #suspended = false;
  #revision = 0;
  #displayedRange: ProjectTimelineRange | undefined;
  #paintSignature = '';
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    host: HTMLElement,
    readonly context: ProjectDashboardTimelineContext,
  ) {
    this.#identity = `project\u0000${context.project()?.path ?? ''}`;
    this.#root = host.createDiv({ cls: 'abyss-project-timeline-boundaries' });
    this.#root.dataset['occurrenceId'] = this.#identity;
    this.#track = this.#root.createDiv({ cls: 'abyss-project-timeline-track' });
    this.#handles = { start: this.#createHandle('start'), end: this.#createHandle('end') };
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
      clickEndpoint: (source, endpoint) => {
        this.#activate(source, endpoint);
      },
      previewRange: (_identity, range) => {
        this.#paint(range ?? this.range());
      },
    });
    this.#migrationCleanup = this.#root.onWindowMigrated(() => {
      this.cancel();
    });
  }
  #createHandle(endpoint: Endpoint): HTMLButtonElement {
    const button = this.#track.createEl('button', {
      cls: `clickable-icon abyss-project-boundary-handle is-${endpoint}`,
      attr: { type: 'button', 'data-timeline-part': endpoint },
    });
    button.createSpan({ cls: 'abyss-project-boundary-label' });
    button.addEventListener('click', (event) => {
      if (event.detail === 0) this.#activateCurrent(endpoint);
    });
    return button;
  }
  #activateCurrent(endpoint: Endpoint): void {
    const capture = this.#capture();
    if (capture.kind === 'ready') this.#activate(capture.source, endpoint);
    else reportFailure(capture.reason);
  }
  #activate(source: FrozenProjectTimelineRangeSource, endpoint: Endpoint): void {
    const day = boundaryDay(source.range, endpoint);
    if (day !== undefined) {
      const percent = boundaryPercent(day, this.context.window());
      const { first, last } = this.#exposed();
      if (percent < first || percent > last) this.context.revealDay(day);
      return;
    }
    void this.#commit({
      kind: 'pointer',
      source,
      intent: {
        type: endpoint === 'start' ? 'setStart' : 'setEnd',
        day: localDay(this.context.now()),
      },
    }).then((result) => {
      if (result.failed.length > 0) reportFailure(result);
    }, reportFailure);
  }
  range(): ProjectTimelineRange {
    const project = this.context.project();
    return project === undefined
      ? { kind: 'unscheduled' }
      : projectTimelineRange(project, this.context.fields());
  }
  update(window: ProjectTimelineWindow): void {
    if (this.#destroyed) return;
    this.#suspended = false;
    const range = this.range(),
      exposed = this.#exposed();
    const signature = JSON.stringify([
      range,
      window.startDay,
      window.dayCount,
      exposed.first,
      exposed.last,
    ]);
    if (signature !== this.#paintSignature || this.#interaction.pinnedOccurrences().length > 0) {
      this.#paintSignature = signature;
      this.#paint(range);
    }
    this.#interaction.reconcileAfterRender();
  }
  mountTrack(track: HTMLElement): () => void {
    const lines = {
      start: track.createSpan({
        cls: 'abyss-project-boundary-line is-start',
        attr: { 'aria-hidden': 'true' },
      }),
      end: track.createSpan({
        cls: 'abyss-project-boundary-line is-end',
        attr: { 'aria-hidden': 'true' },
      }),
    };
    this.#tracks.set(track, lines);
    this.#paintLines(lines, this.#displayedRange ?? this.range());
    return () => {
      this.#tracks.delete(track);
      lines.start.remove();
      lines.end.remove();
    };
  }
  #paint(range: ProjectTimelineRange): void {
    if (this.#destroyed) return;
    this.#displayedRange = range;
    this.#paintHandle('start', range);
    this.#paintHandle('end', range);
    for (const lines of this.#tracks.values()) this.#paintLines(lines, range);
  }
  #paintHandle(endpoint: Endpoint, range: ProjectTimelineRange): void {
    const handle = this.#handles[endpoint];
    const day = boundaryDay(range, endpoint);
    const percent = boundaryPercent(day ?? localDay(this.context.now()), this.context.window());
    const { first, last } = this.#exposed();
    const exposedPercent = ((percent - first) / Math.max(Number.EPSILON, last - first)) * 100;
    handle.toggleClass('is-missing', day === undefined);
    handle.toggleClass('is-offscreen', percent < first || percent > last);
    handle.toggleClass('is-near-start', exposedPercent < 5);
    handle.toggleClass('is-near-end', exposedPercent > 95);
    handle.style.left = `${Math.max(first, Math.min(last, percent))}%`;
    const label = endpoint === 'start' ? 'Start' : 'End';
    handle.setAttribute('aria-label', `${label}: ${day ?? 'Not set'}`);
    handle.disabled = range.kind === 'malformed';
    handle.firstElementChild?.setText(`${label}${boundaryLabelSuffix(day, exposedPercent)}`);
  }
  #exposed(): { readonly first: number; readonly last: number } {
    const track = this.#track.getBoundingClientRect();
    const scroll = this.context.scroll;
    const summary = track.left - scroll.getBoundingClientRect().left + scroll.scrollLeft;
    const usable = scroll.clientWidth - summary;
    if (track.width <= 0 || usable <= 0) return { first: 0, last: 100 };
    return {
      first: Math.max(0, (scroll.scrollLeft / track.width) * 100),
      last: Math.min(100, ((scroll.scrollLeft + usable) / track.width) * 100),
    };
  }
  #paintLines(lines: Record<Endpoint, HTMLElement>, range: ProjectTimelineRange): void {
    for (const endpoint of ['start', 'end'] as const) {
      const day = boundaryDay(range, endpoint);
      const percent = day === undefined ? -1 : boundaryPercent(day, this.context.window());
      lines[endpoint].hidden = percent < 0 || percent > 100;
      lines[endpoint].style.left = `${Math.max(0, Math.min(100, percent))}%`;
    }
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
    for (const lines of this.#tracks.values()) {
      lines.start.remove();
      lines.end.remove();
    }
    this.#tracks.clear();
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
  #commit(
    request: ProjectTimelineRangeEditRequest,
    endpoint?: Endpoint,
  ): Promise<ProjectEditResult> {
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
        this.#intent(source, request, endpoint),
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
  #intent(
    source: FrozenProjectTimelineRangeSource,
    request: ProjectTimelineRangeEditRequest,
    endpoint: Endpoint | undefined,
  ): ProjectTimelineEditIntent {
    if (request.kind === 'pointer' || endpoint === undefined) return request.intent;
    const day = boundaryDay(source.range, endpoint) ?? localDay(this.context.now());
    const ordinal = projectCalendarDayOrdinal(day);
    if (ordinal === undefined) throw new ProjectEditValidationError('Invalid project date.');
    const shifted = projectCalendarDayFromOrdinal(ordinal + request.intent.deltaDays);
    if (shifted === undefined) throw new ProjectEditValidationError('Invalid project date.');
    return {
      type: endpoint === 'start' ? 'setStart' : 'setEnd',
      day: shifted,
    };
  }
  readonly #keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.altKey) return;
    if (event.ctrlKey || event.metaKey) {
      this.#historyKeydown(event);
      return;
    }
    const endpoint = (['start', 'end'] as const).find((key) => event.target === this.#handles[key]);
    if (endpoint === undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.#activateCurrent(endpoint);
      return;
    }
    this.#arrow(event, endpoint);
  };
  #arrow(event: KeyboardEvent, endpoint: Endpoint): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const captured = this.#capture();
    if (captured.kind === 'rejected') {
      reportFailure(captured.reason);
      return;
    }
    void this.#commit(
      {
        kind: 'keyboard',
        target: freezeProjectTimelineRangeBinding(captured.source),
        intent: { type: 'move', deltaDays: event.key === 'ArrowLeft' ? -1 : 1 },
      },
      endpoint,
    ).then((result) => {
      if (result.failed.length > 0) reportFailure(result);
    }, reportFailure);
  }
}

function boundaryLabelSuffix(day: string | undefined, percent: number): string {
  if (day === undefined) return ' +';
  if (percent < 0) return ' ←';
  if (percent > 100) return ' →';
  return '';
}
function boundaryDay(range: ProjectTimelineRange, endpoint: Endpoint): string | undefined {
  if (endpoint === 'start')
    return range.kind === 'closed' || range.kind === 'open-end' ? range.startDay : undefined;
  return range.kind === 'closed' || range.kind === 'open-start' ? range.endDay : undefined;
}
function boundaryPercent(day: string, window: ProjectTimelineWindow): number {
  const first = projectCalendarDayOrdinal(window.startDay),
    point = projectCalendarDayOrdinal(day);
  return first === undefined || point === undefined
    ? -1
    : ((point - first + 0.5) / window.dayCount) * 100;
}
function localDay(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
