import { Notice, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectStore } from '../../projects/ProjectStore';
import type { CalendarSettings } from '../../settings/types';
import {
  prepareStatisticsDataset,
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
import type { TrackedTimeContext } from '../../ui/timeTracking/formatTracked';
import type { TrackingTicker } from '../../ui/timeTracking/TrackingTicker';
import type { StatisticsChartRenderer } from './StatisticsChart';
import { statisticsButton, StatisticsControls, type StatisticsChoices } from './StatisticsControls';
import { StatisticsEvidence, type StatisticsEvidenceHost } from './StatisticsEvidence';
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
  private root_abyssPrivate: HTMLElement | undefined;
  private controlsHost_abyssPrivate: HTMLElement | undefined;
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
  private midnight_abyssPrivate: number | undefined;
  private minute_abyssPrivate: number | undefined;
  private owner_abyssPrivate: Window | undefined;
  private document_abyssPrivate: Document | undefined;
  constructor(private readonly options_abyssPrivate: StatisticsModeOptions) {
    this.controls_abyssPrivate = new StatisticsControls(options_abyssPrivate.app, (next) => {
      this.change_abyssPrivate(next);
    });
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
    this.root_abyssPrivate.scrollTop = this.scrollTop_abyssPrivate;
    const header = this.root_abyssPrivate.createDiv({ cls: 'abyss-center-header' });
    const title = header.createEl('h2', { text: 'Statistics' }),
      headerControls = header.createDiv({ cls: 'abyss-center-controls' });
    this.options_abyssPrivate.host.header?.(header, title, headerControls);
    this.controlsHost_abyssPrivate = this.root_abyssPrivate.createDiv();
    const context = this.root_abyssPrivate.createDiv({ cls: 'abyss-statistics-context-row' });
    this.label_abyssPrivate = context.createDiv({ cls: 'abyss-statistics-context' });
    this.status_abyssPrivate = this.root_abyssPrivate.createDiv({
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.actions_abyssPrivate = context.createDiv({
      cls: 'abyss-statistics-actions',
    });
    this.content_abyssPrivate = this.root_abyssPrivate.createDiv();
    this.evidenceHost_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-statistics-evidence',
    });
    this.sections_abyssPrivate = new StatisticsSections(
      this.content_abyssPrivate,
      this.options_abyssPrivate.renderer,
      (id) => {
        this.select_abyssPrivate(id);
      },
    );
    this.controls_abyssPrivate.render(
      this.controlsHost_abyssPrivate,
      this.choices_abyssPrivate,
      this.observation_abyssPrivate?.dataset,
    );
    this.subscribe_abyssPrivate();
    this.armMidnight_abyssPrivate();
    this.status_abyssPrivate.setText('Preparing analysis…');
    this.schedule_abyssPrivate(false);
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
            this.observation_abyssPrivate?.running === true &&
            Math.floor(now / 60000) !==
              Math.floor(this.observation_abyssPrivate.context.nowMs / 60000)
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
  private change_abyssPrivate(next: Partial<StatisticsChoices>): void {
    this.choices_abyssPrivate = { ...this.choices_abyssPrivate, ...next };
    this.contextPending_abyssPrivate = true;
    this.generation_abyssPrivate++;
    if (this.evidenceHost_abyssPrivate !== undefined) this.evidenceHost_abyssPrivate.empty();
    if (this.content_abyssPrivate !== undefined) this.content_abyssPrivate.hidden = true;
    this.label_abyssPrivate?.setText('Preparing analysis…');
    this.status_abyssPrivate?.empty();
    if (this.controlsHost_abyssPrivate !== undefined)
      this.controls_abyssPrivate.render(
        this.controlsHost_abyssPrivate,
        this.choices_abyssPrivate,
        this.observation_abyssPrivate?.dataset,
      );
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
    const descriptors = projects.list().map(({ path, name }) => ({ path, name }));
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
      this.sections_abyssPrivate?.update(model);
      this.contextPending_abyssPrivate = false;
      this.observation_abyssPrivate = observation;
      this.install_abyssPrivate(model);
    } else this.options_abyssPrivate.host.renderComplete();
    this.forceClock_abyssPrivate = false;
    this.requested_abyssPrivate = false;
    this.armMinute_abyssPrivate();
  }
  private failure_abyssPrivate(error: unknown): void {
    console.error('[abyss-tasks] Statistics preparation failed', { error });
    if (!this.mounted_abyssPrivate) return;
    const text =
      this.background_abyssPrivate && this.model_abyssPrivate !== undefined
        ? 'Statistics is stale. Could not refresh the last valid observation.'
        : 'Could not prepare Statistics.';
    this.status_abyssPrivate?.setText(text);
    if (!this.background_abyssPrivate)
      new Notice('Could not prepare statistics. Use retry in the panel.');
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
      new Notice('Could not refresh statistics sources. Try again.');
    }
  }
  private catalog_abyssPrivate(): string {
    return JSON.stringify(
      this.options_abyssPrivate.projects.list().map(({ path, name }) => ({ path, name })),
    );
  }
  private install_abyssPrivate(model: StatisticsViewModel): void {
    this.model_abyssPrivate = model;
    this.label_abyssPrivate?.setText(
      model.currentState
        ? `Current state · ${new Date(model.asOfMs).toLocaleDateString('en')}`
        : model.dateLabel,
    );
    this.sourceStatus_abyssPrivate(model);
    if (this.content_abyssPrivate !== undefined) this.content_abyssPrivate.hidden = false;
    this.evidenceHost_abyssPrivate?.empty();
    if (this.controlsHost_abyssPrivate !== undefined)
      this.controls_abyssPrivate.render(
        this.controlsHost_abyssPrivate,
        this.choices_abyssPrivate,
        this.observation_abyssPrivate?.dataset,
      );
    this.renderActions_abyssPrivate(model);
    this.options_abyssPrivate.host.renderComplete();
  }
  private sourceStatus_abyssPrivate(model: StatisticsViewModel): void {
    this.status_abyssPrivate?.empty();
    if (!model.coverage.source.ready)
      this.status_abyssPrivate?.setText(
        'The task index is still loading. This observation is incomplete.',
      );
    if (model.coverage.source.sourceIssues.length > 0)
      this.status_abyssPrivate?.setText(
        `${model.coverage.source.sourceIssues.length} sources unavailable · partial coverage`,
      );
  }
  private renderActions_abyssPrivate(model: StatisticsViewModel): void {
    this.actions_abyssPrivate?.empty();
    if (this.actions_abyssPrivate !== undefined) {
      for (const action of model.actions)
        statisticsButton(this.actions_abyssPrivate, action.label, () => {
          this.action_abyssPrivate(action);
        });
      if (!model.currentState && this.choices_abyssPrivate.period !== 'all')
        statisticsButton(this.actions_abyssPrivate, 'View earlier activity', () => {
          this.change_abyssPrivate({ period: 'all', weekStart: undefined, page: undefined });
        });
      const details = this.actions_abyssPrivate.createEl('details');
      details.createEl('summary', { text: 'Data coverage' });
      const coverage = model.coverage.scope;
      details.createEl('p', {
        text: `${coverage.nodes} Tasks & subtasks in scope · ${coverage.live} live · ${coverage.archive} archived · ${coverage.entries} time entries · ${coverage.brokenEntries} broken entries · ${coverage.dateIssues} date issues`,
      });
      details.createEl('p', {
        text: `Recurring: ${model.coverage.source.recurrence}. Current project membership and tags classify retained history.`,
      });
      for (const issue of model.coverage.source.sourceIssues)
        details.createDiv({ text: `${issue.path}: ${issue.reason}` });
    }
  }
  private action_abyssPrivate(action: StatisticsAction): void {
    switch (action.type) {
      case 'scope':
        this.change_abyssPrivate({ scope: action.scope, page: undefined });
        break;
      case 'period':
        this.change_abyssPrivate({ period: action.period, page: undefined, weekStart: undefined });
        break;
      case 'week':
        this.change_abyssPrivate({ weekStart: action.weekStart });
        break;
      case 'page':
        this.change_abyssPrivate({ page: action.page });
        break;
      case 'chain':
        this.change_abyssPrivate({ focusKey: action.focusKey });
        break;
    }
  }
  private select_abyssPrivate(id: string): void {
    const model = this.model_abyssPrivate;
    if (model === undefined || this.evidenceHost_abyssPrivate === undefined) return;
    const action = model.chartActions.find(([key]) => key === id)?.[1];
    if (action !== undefined) {
      this.action_abyssPrivate(action);
      return;
    }
    const opener = this.evidenceHost_abyssPrivate.ownerDocument.activeElement as
      HTMLElement | SVGElement | null;
    if (this.content_abyssPrivate !== undefined) this.content_abyssPrivate.hidden = true;
    this.evidence_abyssPrivate.render(this.evidenceHost_abyssPrivate, model, id, () => {
      this.evidenceHost_abyssPrivate?.empty();
      if (this.content_abyssPrivate !== undefined) this.content_abyssPrivate.hidden = false;
      if (opener?.isConnected === true) opener.focus();
    });
    this.evidenceHost_abyssPrivate.querySelector<HTMLButtonElement>('button')?.focus();
    this.options_abyssPrivate.host.renderComplete();
  }
  private armMinute_abyssPrivate(): void {
    if (this.observation_abyssPrivate?.running === true && this.minute_abyssPrivate !== undefined)
      return;
    if (this.minute_abyssPrivate !== undefined)
      this.owner_abyssPrivate?.clearTimeout(this.minute_abyssPrivate);
    this.minute_abyssPrivate = undefined;
    if (this.observation_abyssPrivate?.running !== true) return;
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
    this.mounted_abyssPrivate = false;
    this.generation_abyssPrivate++;
    this.requested_abyssPrivate = false;
    for (const off of this.unsubs_abyssPrivate.splice(0)) off();
    this.clearClocks_abyssPrivate();
    this.controls_abyssPrivate.destroy();
    this.scheduler_abyssPrivate?.destroy();
    this.scheduler_abyssPrivate = undefined;
    this.sections_abyssPrivate?.destroy();
    this.sections_abyssPrivate = undefined;
    this.scrollTop_abyssPrivate = this.root_abyssPrivate?.scrollTop ?? this.scrollTop_abyssPrivate;
    this.root_abyssPrivate?.remove();
    this.root_abyssPrivate = undefined;
    this.model_abyssPrivate = undefined;
  }
  destroy(): void {
    this.unmount();
    this.destroyed_abyssPrivate = true;
    this.observation_abyssPrivate = undefined;
  }
}
