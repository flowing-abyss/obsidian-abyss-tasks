import { Notice, setIcon, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectStore } from '../../projects/ProjectStore';
import { statusGroupKey } from '../../projects/projectTableModel';
import { orderedGroups } from '../../projects/status';
import type { CalendarSettings } from '../../settings/types';
import {
  prepareStatisticsDataset,
  STATISTICS_VIEWS,
  StatisticsSession,
  type StatisticsAction,
  type StatisticsDataset,
  type StatisticsProject,
  type StatisticsRequest,
  type StatisticsViewModel,
  type StatisticsWork,
} from '../../statistics';
import { StatisticsCancelled } from '../../statistics/statisticsWork';
import type { TaskQueryApi, TaskStatisticsSnapshot, TaskStatisticsSource } from '../../tasks';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import type { TrackedTimeContext } from '../../ui/timeTracking/formatTracked';
import type { TrackingTicker } from '../../ui/timeTracking/TrackingTicker';
import type { StatisticsChartRenderer } from './StatisticsChart';
import {
  restoreStatisticsControlFocus,
  statisticsButton,
  StatisticsControls,
  type StatisticsChoices,
} from './StatisticsControls';
import { StatisticsDetails } from './StatisticsDetails';
import { StatisticsEvidence, type StatisticsEvidenceHost } from './StatisticsEvidence';
import { statisticsMarkTitle } from './statisticsFormat';
import type { StatisticsNavigationPort } from './StatisticsNavigation';
import { StatisticsSections } from './StatisticsSections';
import { StatisticsWorkScheduler } from './StatisticsWorkScheduler';
interface StatisticsModeOptions {
  readonly state: AppState;
  readonly app: App;
  readonly settings: CalendarSettings;
  readonly source: TaskStatisticsSource;
  readonly projects: Pick<ProjectStore, 'list' | 'onUpdate' | 'whenSettled'>;
  readonly renderer: StatisticsChartRenderer;
  readonly context: () => TrackedTimeContext;
  readonly interactionOwnership?: InteractionOwnershipPort | undefined;
  readonly ticker?: TrackingTicker | undefined;
  readonly queries?: Pick<TaskQueryApi, 'resolve'> | undefined;
  readonly host: StatisticsEvidenceHost & {
    renderComplete(): void;
    header?: ((header: HTMLElement, title: HTMLElement, controls: HTMLElement) => void) | undefined;
  };
}
interface Observation {
  source: TaskStatisticsSnapshot;
  catalog: string;
  dataset: StatisticsDataset;
  session: StatisticsSession;
  context: TrackedTimeContext;
  running: boolean;
}
/** Retained session navigation and a causally joined task/project observation. No persistence. */
export class StatisticsMode {
  private choices_abyssPrivate: StatisticsChoices = {
    view: 'rhythm',
    scope: { type: 'all' },
    period: 'week',
    group: 'project',
  };
  readonly navigation: StatisticsNavigationPort;
  private readonly navigationListeners_abyssPrivate = new Set<() => void>();
  private readonly details_abyssPrivate: StatisticsDetails;
  private title_abyssPrivate: HTMLElement | undefined;
  private keyboardActivation_abyssPrivate = false;
  private selectionOpener_abyssPrivate: HTMLElement | SVGElement | null = null;
  private root_abyssPrivate: HTMLElement | undefined;
  private controlsHost_abyssPrivate: HTMLElement | undefined;
  private readonly rowPositions_abyssPrivate = new Map<string, number>();
  private label_abyssPrivate: HTMLElement | undefined;
  private status_abyssPrivate: HTMLElement | undefined;
  private content_abyssPrivate: HTMLElement | undefined;
  private actions_abyssPrivate: HTMLElement | undefined;
  private evidenceHost_abyssPrivate: HTMLElement | undefined;
  private sections_abyssPrivate: StatisticsSections | undefined;
  private scheduler_abyssPrivate: StatisticsWorkScheduler | undefined;
  private readonly controls_abyssPrivate: StatisticsControls;
  private readonly evidence_abyssPrivate: StatisticsEvidence;
  private readonly unsubs_abyssPrivate: Array<() => void> = [];
  private mounted_abyssPrivate = false;
  private destroyed_abyssPrivate = false;
  private generation_abyssPrivate = 0;
  private running_abyssPrivate = false;
  private requested_abyssPrivate = false;
  private forceClock_abyssPrivate = true;
  private background_abyssPrivate = false;
  private contextPending_abyssPrivate = true;
  private scrollTop_abyssPrivate = 0;
  private observation_abyssPrivate: Observation | undefined;
  private model_abyssPrivate: StatisticsViewModel | undefined;
  private earlierPeriod_abyssPrivate: StatisticsChoices['period'] | undefined;
  private midnight_abyssPrivate: number | undefined;
  private minute_abyssPrivate: number | undefined;
  private owner_abyssPrivate: Window | undefined;
  private document_abyssPrivate: Document | undefined;
  constructor(private readonly options_abyssPrivate: StatisticsModeOptions) {
    this.controls_abyssPrivate = new StatisticsControls(options_abyssPrivate.app, (next) => {
      this.change_abyssPrivate(next);
    });
    this.navigation = {
      snapshot: () => ({
        view: this.choices_abyssPrivate.view,
        group: this.choices_abyssPrivate.group,
        scopeLabel: this.controls_abyssPrivate.scopeLabel(this.choices_abyssPrivate.scope),
      }),
      subscribe: (listener) => {
        this.navigationListeners_abyssPrivate.add(listener);
        return () => {
          this.navigationListeners_abyssPrivate.delete(listener);
        };
      },
      selectView: (view) => {
        this.change_abyssPrivate({ view, page: undefined, focusKey: undefined });
      },
      selectGroup: (group) => {
        this.change_abyssPrivate({
          view: 'allocation',
          group,
          focusKey: undefined,
          page: undefined,
        });
      },
      openScope: () => {
        this.controls_abyssPrivate.openScope(this.choices_abyssPrivate.scope);
      },
    };
    this.details_abyssPrivate = new StatisticsDetails(options_abyssPrivate.interactionOwnership);
    this.evidence_abyssPrivate = new StatisticsEvidence(
      options_abyssPrivate.source,
      options_abyssPrivate.queries ?? { resolve: (ref) => ({ type: 'not-found', ref }) },
      options_abyssPrivate.host,
    );
  }
  render(host: HTMLElement): void {
    if (this.destroyed_abyssPrivate) return;
    if (this.isAttached_abyssPrivate(host)) {
      this.refresh();
      return;
    }
    this.unmount();
    this.document_abyssPrivate = host.ownerDocument;
    this.owner_abyssPrivate = host.ownerDocument.defaultView ?? undefined;
    if (this.owner_abyssPrivate === undefined) return;
    this.mounted_abyssPrivate = true;
    this.contextPending_abyssPrivate = true;
    this.forceClock_abyssPrivate = true;
    this.scheduler_abyssPrivate = new StatisticsWorkScheduler(this.owner_abyssPrivate);
    this.root_abyssPrivate = host.createDiv({ cls: 'abyss-statistics' });
    this.header_abyssPrivate(this.root_abyssPrivate);
    const context = this.root_abyssPrivate.createDiv({ cls: 'abyss-statistics-context-row' });
    this.label_abyssPrivate = context.createDiv({ cls: 'abyss-statistics-context' });
    this.status_abyssPrivate = this.root_abyssPrivate.createDiv({
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.actions_abyssPrivate = context.createDiv({
      cls: 'abyss-statistics-actions',
    });
    this.content_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-statistics-content',
    });
    this.evidenceHost_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-statistics-evidence',
    });
    this.evidenceHost_abyssPrivate.hidden = true;
    this.root_abyssPrivate.addEventListener(
      'pointerdown',
      () => {
        this.keyboardActivation_abyssPrivate = false;
      },
      true,
    );
    this.root_abyssPrivate.addEventListener(
      'keydown',
      (event) => {
        this.keyboardActivation_abyssPrivate = event.key === 'Enter' || event.key === ' ';
      },
      true,
    );
    this.sections_abyssPrivate = new StatisticsSections(
      this.content_abyssPrivate,
      this.options_abyssPrivate.renderer,
      (id) => {
        this.select_abyssPrivate(id);
      },
      {
        positions: this.rowPositions_abyssPrivate,
        onFailure: (error) => {
          this.failure_abyssPrivate(error);
        },
      },
    );
    this.subscribe_abyssPrivate();
    this.armMidnight_abyssPrivate();
    this.status_abyssPrivate.setText('Preparing analysis…');
    this.schedule_abyssPrivate(false);
  }
  private header_abyssPrivate(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'abyss-center-header' });
    const title = header.createEl('h2', {
        text: this.viewTitle_abyssPrivate(),
        cls: 'abyss-center-title',
        attr: { tabindex: '-1' },
      }),
      headerControls = header.createDiv({ cls: 'abyss-center-controls' });
    this.title_abyssPrivate = title;
    this.controlsHost_abyssPrivate = headerControls.createDiv({ cls: 'abyss-statistics-controls' });
    const details = headerControls.createEl('button', {
      cls: 'abyss-view-state-btn',
      attr: { type: 'button', 'aria-label': 'About this view' },
    });
    setIcon(details, 'info');
    details.addEventListener('click', () => {
      if (this.model_abyssPrivate !== undefined && this.root_abyssPrivate !== undefined)
        this.details_abyssPrivate.open(this.root_abyssPrivate, details, this.model_abyssPrivate);
    });
    this.options_abyssPrivate.host.header?.(header, title, headerControls);
    this.renderControls_abyssPrivate();
  }
  private renderControls_abyssPrivate(): void {
    if (this.controlsHost_abyssPrivate !== undefined)
      this.controls_abyssPrivate.render(this.controlsHost_abyssPrivate, this.choices_abyssPrivate);
  }
  private isAttached_abyssPrivate(host: HTMLElement): boolean {
    return (
      this.mounted_abyssPrivate &&
      this.root_abyssPrivate?.parentElement === host &&
      this.document_abyssPrivate === host.ownerDocument
    );
  }
  private subscribe_abyssPrivate(): void {
    this.unsubs_abyssPrivate.push(
      this.options_abyssPrivate.source.subscribeStatistics(() => {
        this.schedule_abyssPrivate(true);
      }),
    );
    this.unsubs_abyssPrivate.push(
      this.options_abyssPrivate.projects.onUpdate(() => {
        this.schedule_abyssPrivate(true);
      }),
    );
    if (this.options_abyssPrivate.ticker !== undefined)
      this.unsubs_abyssPrivate.push(
        this.options_abyssPrivate.ticker.subscribe(() => {
          const now = this.options_abyssPrivate.context().nowMs;
          if (
            this.clockAccruing_abyssPrivate() &&
            Math.floor(now / 60000) !==
              Math.floor((this.observation_abyssPrivate?.context.nowMs ?? now) / 60000)
          ) {
            this.forceClock_abyssPrivate = true;
            this.schedule_abyssPrivate(true);
          }
        }),
      );
  }
  refresh(): void {
    if (!this.mounted_abyssPrivate) return;
    this.schedule_abyssPrivate(true);
  }
  followNote(oldPath: string, newPath?: string): void {
    if (
      this.choices_abyssPrivate.scope.type === 'project' &&
      this.choices_abyssPrivate.scope.path === oldPath &&
      newPath !== undefined
    )
      this.choices_abyssPrivate = {
        ...this.choices_abyssPrivate,
        scope: { type: 'project', path: newPath },
      };
    this.schedule_abyssPrivate(true);
  }
  private viewTitle_abyssPrivate(): string {
    return (
      STATISTICS_VIEWS.find((view) => view.id === this.choices_abyssPrivate.view)?.title ??
      'Analysis'
    );
  }
  private notifyNavigation_abyssPrivate(): void {
    for (const listener of this.navigationListeners_abyssPrivate) listener();
  }
  private change_abyssPrivate(next: Partial<StatisticsChoices>): void {
    if (next.period !== undefined) this.earlierPeriod_abyssPrivate = undefined;
    this.details_abyssPrivate.close();
    this.clearSelection_abyssPrivate(false);
    if (next.view === 'patterns') this.forceClock_abyssPrivate = true;
    this.choices_abyssPrivate = { ...this.choices_abyssPrivate, ...next };
    this.title_abyssPrivate?.setText(this.viewTitle_abyssPrivate());
    this.notifyNavigation_abyssPrivate();
    this.contextPending_abyssPrivate = true;
    this.generation_abyssPrivate++;
    if (this.content_abyssPrivate !== undefined) {
      this.content_abyssPrivate.inert = true;
      this.content_abyssPrivate.setAttribute('inert', '');
      this.content_abyssPrivate.setAttribute('aria-busy', 'true');
    }
    this.label_abyssPrivate?.setText('Preparing analysis…');
    this.status_abyssPrivate?.empty();
    this.renderControls_abyssPrivate();
    this.schedule_abyssPrivate(false);
  }
  private schedule_abyssPrivate(background: boolean): void {
    if (!this.mounted_abyssPrivate) return;
    this.requested_abyssPrivate = true;
    this.background_abyssPrivate = !this.contextPending_abyssPrivate && background;
    if (!this.running_abyssPrivate)
      void this.run_abyssPrivate().catch((error: unknown) => {
        this.failure_abyssPrivate(error);
      });
  }
  private async run_abyssPrivate(): Promise<void> {
    this.running_abyssPrivate = true;
    try {
      while (this.mounted_abyssPrivate && this.requested_abyssPrivate) {
        this.requested_abyssPrivate = false;
        await this.attempt_abyssPrivate();
      }
    } catch (error) {
      if (!(error instanceof StatisticsCancelled)) this.failure_abyssPrivate(error);
    } finally {
      this.running_abyssPrivate = false;
      if (this.mounted_abyssPrivate && this.requested_abyssPrivate)
        this.schedule_abyssPrivate(this.background_abyssPrivate);
    }
  }
  private async attempt_abyssPrivate(): Promise<void> {
    const generation = this.generation_abyssPrivate;
    const work = {
      yieldControl: () => this.yieldControl_abyssPrivate(),
      isCancelled: () => !this.mounted_abyssPrivate || generation !== this.generation_abyssPrivate,
    };
    const { source, projects } = this.options_abyssPrivate;
    await source.whenStatisticsSettled();
    if (work.isCancelled()) return;
    const snapshot = source.readStatistics();
    await projects.whenSettled();
    if (work.isCancelled()) return;
    const descriptors = this.projectDescriptors_abyssPrivate();
    const catalog = JSON.stringify(descriptors);
    if (!source.isStatisticsCurrent(snapshot)) {
      this.requested_abyssPrivate = true;
      return;
    }
    const observation = await this.prepareObservation_abyssPrivate(
      snapshot,
      descriptors,
      catalog,
      work,
    );
    if (observation === undefined) return;
    await this.controls_abyssPrivate.prepare(observation.dataset, work);
    const request: StatisticsRequest = {
      ...this.choices_abyssPrivate,
      ...observation.context,
      firstDayOfWeek: this.options_abyssPrivate.settings.firstDayOfWeek,
    };
    const model = await observation.session.view(request, work);
    if (model === undefined) return;
    if (work.isCancelled()) return;
    if (!source.isStatisticsCurrent(snapshot) || catalog !== this.catalog_abyssPrivate()) {
      this.requested_abyssPrivate = true;
      return;
    }
    this.accept_abyssPrivate(observation, model);
  }
  private async yieldControl_abyssPrivate(): Promise<void> {
    await this.scheduler_abyssPrivate?.yieldControl();
  }
  private async prepareObservation_abyssPrivate(
    snapshot: TaskStatisticsSnapshot,
    descriptors: readonly StatisticsProject[],
    catalog: string,
    work: StatisticsWork,
  ): Promise<Observation | undefined> {
    const previous = this.observation_abyssPrivate;
    if (previous?.source === snapshot && previous.catalog === catalog)
      return this.forceClock_abyssPrivate
        ? { ...previous, context: this.options_abyssPrivate.context() }
        : previous;
    const dataset = await prepareStatisticsDataset(snapshot, descriptors, work);
    if (dataset === undefined) return undefined;
    return {
      source: snapshot,
      catalog,
      dataset,
      session: new StatisticsSession(dataset),
      running: dataset.entries.some((entry) => entry.state === 'running'),
      context: this.options_abyssPrivate.context(),
    };
  }
  private accept_abyssPrivate(observation: Observation, model: StatisticsViewModel): void {
    const changed = this.model_abyssPrivate !== model || this.contextPending_abyssPrivate;
    if (changed) {
      this.details_abyssPrivate.close();
      this.sections_abyssPrivate?.update(model);
      if (
        (model.view === 'allocation' || model.view === 'movement') &&
        model.coverage.source.ready &&
        model.coverage.source.sourceIssues.length === 0 &&
        !model.actions.some((action) => action.type === 'focus' && action.focusKey === undefined)
      )
        this.choices_abyssPrivate = { ...this.choices_abyssPrivate, focusKey: undefined };
      this.clearSelection_abyssPrivate(false);
      this.contextPending_abyssPrivate = false;
      this.observation_abyssPrivate = observation;
      this.install_abyssPrivate(model);
    } else {
      this.renderActions_abyssPrivate(model);
      this.options_abyssPrivate.host.renderComplete();
    }
    this.forceClock_abyssPrivate = false;
    this.requested_abyssPrivate = false;
    this.armMinute_abyssPrivate();
  }
  private failure_abyssPrivate(error: unknown): void {
    console.error('[abyss-tasks] Statistics preparation failed', { error });
    if (!this.mounted_abyssPrivate) return;
    const text =
      this.background_abyssPrivate && this.model_abyssPrivate !== undefined
        ? 'Analysis is stale. Could not refresh the last valid observation.'
        : 'Could not prepare Analysis.';
    this.status_abyssPrivate?.setText(text);
    if (!this.background_abyssPrivate)
      new Notice('Could not prepare analysis. Use retry in the panel.');
    this.showRetry_abyssPrivate();
  }
  private showRetry_abyssPrivate(): void {
    if (this.status_abyssPrivate !== undefined)
      statisticsButton(this.status_abyssPrivate, 'Retry', () => {
        void this.retry_abyssPrivate().catch((cause: unknown) => {
          this.failure_abyssPrivate(cause);
        });
      });
  }
  private async retry_abyssPrivate(): Promise<void> {
    try {
      await this.options_abyssPrivate.source.refreshStatistics();
      this.forceClock_abyssPrivate = true;
      this.schedule_abyssPrivate(false);
    } catch (error) {
      console.error('[abyss-tasks] Statistics retry failed', { error });
      new Notice('Could not refresh analysis sources. Try again.');
    }
  }
  private catalog_abyssPrivate(): string {
    return JSON.stringify(this.projectDescriptors_abyssPrivate());
  }
  private projectDescriptors_abyssPrivate(): StatisticsProject[] {
    return this.options_abyssPrivate.projects.list().map((project) => ({
      path: project.path,
      name: project.name,
      statusKey: statusGroupKey(project),
    }));
  }
  private install_abyssPrivate(model: StatisticsViewModel): void {
    const restoreScroll = this.model_abyssPrivate === undefined;
    this.model_abyssPrivate = model;
    this.title_abyssPrivate?.setText(model.title);
    this.notifyNavigation_abyssPrivate();
    const through =
      model.view === 'patterns' && this.observation_abyssPrivate !== undefined
        ? ` · Through ${new Date(model.asOfMs + this.observation_abyssPrivate.context.offsetAt(model.asOfMs) * 60000).toISOString().slice(11, 16)}`
        : '';
    this.label_abyssPrivate?.setText(
      `${this.controls_abyssPrivate.scopeLabel(this.choices_abyssPrivate.scope)} · ${
        model.currentState
          ? `Current state · ${new Date(model.asOfMs).toLocaleDateString('en')}`
          : `${formatRange(model.dateLabel)}${through}`
      }`,
    );
    this.sourceStatus_abyssPrivate(model);
    if (this.content_abyssPrivate !== undefined) {
      this.content_abyssPrivate.inert = false;
      this.content_abyssPrivate.removeAttribute('inert');
      this.content_abyssPrivate.removeAttribute('aria-busy');
    }
    this.renderControls_abyssPrivate();
    this.renderActions_abyssPrivate(model);
    this.options_abyssPrivate.host.renderComplete();
    if (restoreScroll && this.content_abyssPrivate !== undefined)
      this.content_abyssPrivate.scrollTop = this.scrollTop_abyssPrivate;
  }
  private sourceStatus_abyssPrivate(model: StatisticsViewModel): void {
    this.status_abyssPrivate?.empty();
    if (!model.coverage.source.ready)
      this.status_abyssPrivate?.setText(
        'The task index is still loading. This observation is incomplete.',
      );
    if (model.coverage.source.sourceIssues.length > 0) {
      this.status_abyssPrivate?.setText(
        `${model.coverage.source.sourceIssues.length} sources unavailable · partial coverage`,
      );
      for (const issue of model.coverage.source.sourceIssues)
        this.status_abyssPrivate?.createDiv({ text: `${issue.path}: ${issue.reason}` });
      this.showRetry_abyssPrivate();
    }
  }
  private renderActions_abyssPrivate(model: StatisticsViewModel): void {
    const host = this.actions_abyssPrivate;
    if (host === undefined) return;
    const focused = host.querySelector(':focus');
    host.empty();
    this.controls_abyssPrivate.prepareGroups(
      model.view === 'allocation'
        ? model.chartActions.flatMap(([, action]) =>
            action.type === 'focus' && action.focusKey !== undefined ? [action] : [],
          )
        : [],
    );
    if (model.view === 'allocation' && model.chartActions.length > 8) {
      const find = statisticsButton(host, 'Find group', () => {
        this.controls_abyssPrivate.openGroup();
      });
      find.setAttribute('aria-haspopup', 'dialog');
      find.setAttribute('aria-label', 'Find group');
    }
    this.controls_abyssPrivate.renderProjectStatus(
      host,
      this.choices_abyssPrivate,
      orderedGroups(
        this.options_abyssPrivate.settings.projects.statuses,
        this.options_abyssPrivate.projects.list(),
      ),
    );
    const previous = this.earlierPeriod_abyssPrivate;
    if (previous !== undefined && this.choices_abyssPrivate.period === 'all')
      statisticsButton(host, 'Return to previous period', () => {
        this.change_abyssPrivate({ period: previous, page: undefined, weekStart: undefined });
      });
    for (const action of model.actions)
      statisticsButton(host, action.label, () => {
        this.action_abyssPrivate(action);
      });
    restoreStatisticsControlFocus(host, focused);
  }
  private action_abyssPrivate(action: StatisticsAction): void {
    switch (action.type) {
      case 'cohorts':
        this.change_abyssPrivate({ cohortsExpanded: action.expanded, page: 0 });
        break;
      case 'scope':
        this.change_abyssPrivate({ scope: action.scope, page: undefined });
        break;
      case 'period': {
        const previous = this.choices_abyssPrivate.period;
        this.change_abyssPrivate({ period: action.period, page: undefined, weekStart: undefined });
        if (action.period === 'all' && previous !== 'all')
          this.earlierPeriod_abyssPrivate = previous;
        break;
      }
      case 'week':
        this.change_abyssPrivate({ weekStart: action.weekStart, page: undefined });
        break;
      case 'page':
        this.change_abyssPrivate({ page: action.page });
        break;
      case 'focus':
      case 'chain':
        this.change_abyssPrivate({ focusKey: action.focusKey });
        break;
    }
  }
  private select_abyssPrivate(id: string): void {
    const model = this.model_abyssPrivate;
    if (
      this.contextPending_abyssPrivate ||
      model === undefined ||
      this.evidenceHost_abyssPrivate === undefined
    )
      return;
    const action = model.chartActions.find(([key]) => key === id)?.[1];
    if (action !== undefined) {
      this.action_abyssPrivate(action);
      return;
    }
    const keyboard = this.keyboardActivation_abyssPrivate;
    this.keyboardActivation_abyssPrivate = false;
    this.selectionOpener_abyssPrivate = this.evidenceHost_abyssPrivate.ownerDocument
      .activeElement as HTMLElement | SVGElement | null;
    this.evidenceHost_abyssPrivate.hidden = false;
    this.evidence_abyssPrivate.render(
      this.evidenceHost_abyssPrivate,
      model,
      { id, label: selectionLabel(model, id) },
      () => {
        this.clearSelection_abyssPrivate(true);
      },
    );
    if (keyboard)
      this.evidenceHost_abyssPrivate
        .querySelector<HTMLElement>('h3')
        ?.focus({ preventScroll: true });
    this.options_abyssPrivate.host.renderComplete();
  }
  private clearSelection_abyssPrivate(explicit: boolean): void {
    const host = this.evidenceHost_abyssPrivate;
    if (host === undefined || host.hidden === true) return;
    const focused = host.contains(host.ownerDocument.activeElement);
    const opener = this.selectionOpener_abyssPrivate;
    this.evidence_abyssPrivate.clear();
    host.empty();
    host.hidden = true;
    this.selectionOpener_abyssPrivate = null;
    if (focused) {
      const target = explicit && opener?.isConnected === true ? opener : this.title_abyssPrivate;
      target?.focus({ preventScroll: true });
    }
  }

  private clockAccruing_abyssPrivate(): boolean {
    return (
      this.observation_abyssPrivate?.running === true ||
      this.choices_abyssPrivate.view === 'patterns'
    );
  }
  private armMinute_abyssPrivate(): void {
    if (this.clockAccruing_abyssPrivate() && this.minute_abyssPrivate !== undefined) return;
    if (this.minute_abyssPrivate !== undefined)
      this.owner_abyssPrivate?.clearTimeout(this.minute_abyssPrivate);
    this.minute_abyssPrivate = undefined;
    if (!this.clockAccruing_abyssPrivate()) return;
    this.minute_abyssPrivate = this.owner_abyssPrivate?.setTimeout(() => {
      this.minute_abyssPrivate = undefined;
      this.forceClock_abyssPrivate = true;
      this.schedule_abyssPrivate(true);
    }, 60000);
  }
  private armMidnight_abyssPrivate(): void {
    if (this.owner_abyssPrivate === undefined) return;
    const { nowMs } = this.options_abyssPrivate.context(),
      next = new Date(nowMs);
    next.setHours(24, 0, 0, 0);
    this.midnight_abyssPrivate = this.owner_abyssPrivate.setTimeout(
      () => {
        this.forceClock_abyssPrivate = true;
        this.schedule_abyssPrivate(true);
        this.armMidnight_abyssPrivate();
      },
      Math.max(1, next.getTime() - nowMs),
    );
  }
  private clearClocks_abyssPrivate(): void {
    for (const timer of [this.midnight_abyssPrivate, this.minute_abyssPrivate])
      if (timer !== undefined) this.owner_abyssPrivate?.clearTimeout(timer);
    this.midnight_abyssPrivate = undefined;
    this.minute_abyssPrivate = undefined;
  }
  unmount(): void {
    this.scrollTop_abyssPrivate =
      this.content_abyssPrivate?.scrollTop ?? this.scrollTop_abyssPrivate;
    this.mounted_abyssPrivate = false;
    this.generation_abyssPrivate++;
    this.requested_abyssPrivate = false;
    for (const off of this.unsubs_abyssPrivate.splice(0)) off();
    this.clearClocks_abyssPrivate();
    this.details_abyssPrivate.close();
    this.controls_abyssPrivate.destroy();
    this.scheduler_abyssPrivate?.destroy();
    this.scheduler_abyssPrivate = undefined;
    this.sections_abyssPrivate?.destroy();
    this.sections_abyssPrivate = undefined;
    this.evidence_abyssPrivate.clear();
    this.root_abyssPrivate?.remove();
    this.root_abyssPrivate = undefined;
    this.content_abyssPrivate = undefined;
    this.evidenceHost_abyssPrivate = undefined;
    this.title_abyssPrivate = undefined;
    this.model_abyssPrivate = undefined;
  }
  destroy(): void {
    this.unmount();
    this.evidence_abyssPrivate.destroy();
    this.navigationListeners_abyssPrivate.clear();
    this.rowPositions_abyssPrivate.clear();
    this.destroyed_abyssPrivate = true;
    this.observation_abyssPrivate = undefined;
  }
}

function formatRange(label: string): string {
  return label.replace(/\d{4}-\d{2}-\d{2}/g, (date) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString('en', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  );
}
function selectionLabel(model: StatisticsViewModel, id: string): string {
  for (const section of model.sections) {
    const metric = section.metrics.find((metric) => metric.selectionId === id);
    if (metric !== undefined) return metric.label;
    const legend = section.legend.find((item) => item.selectionId === id);
    if (legend !== undefined) return legend.label;
    for (const chart of section.charts) {
      const mark = chart.marks.find((mark) => mark.selectionId === id);
      if (mark !== undefined) return statisticsMarkTitle(mark, chart);
    }
  }
  return 'Selected records';
}
