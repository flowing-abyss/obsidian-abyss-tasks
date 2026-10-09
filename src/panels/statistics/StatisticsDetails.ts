import type { StatisticsMetric, StatisticsSection, StatisticsViewModel } from '../../statistics';
import { openAnchoredPopover, type AnchoredPopover } from '../../ui/anchoredPopover';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { statisticsButton } from './StatisticsControls';
import { statisticsNumber } from './statisticsFormat';

/** One owned information surface for the accepted observation. */
export class StatisticsDetails {
  private popover_abyssPrivate: AnchoredPopover | undefined;
  constructor(private readonly ownership_abyssPrivate?: InteractionOwnershipPort) {}
  open(
    owner: HTMLElement,
    anchor: HTMLElement,
    model: StatisticsViewModel,
    select: (id: string) => void,
  ): void {
    this.close();
    const popover = openAnchoredPopover({
      owner,
      anchor,
      boundary: owner,
      preferred: 'below-end',
      cls: 'abyss-statistics-details',
      ownership: this.ownership_abyssPrivate,
      attr: { role: 'dialog', 'aria-label': 'Analysis details' },
      onClose: (restore) => {
        this.popover_abyssPrivate = undefined;
        if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
      },
    });
    this.popover_abyssPrivate = popover;
    const element = popover.element;
    element.createEl('h3', { text: `${model.title} details` });
    this.coverage_abyssPrivate(element, model);
    for (const section of model.sections) this.section_abyssPrivate(element, section, select);
    popover.reposition();
  }
  private coverage_abyssPrivate(element: HTMLElement, model: StatisticsViewModel): void {
    const coverage = model.coverage.scope;
    element.createEl('p', {
      text: `${coverage.nodes} Tasks & subtasks in scope · ${coverage.live} live · ${coverage.archive} archived · ${coverage.entries} time entries · ${coverage.brokenEntries} broken entries · ${coverage.dateIssues} date issues`,
    });
    element.createEl('p', {
      text: `Recurring: ${model.coverage.source.recurrence}. Current project membership and tags classify retained history.`,
    });
    for (const issue of model.coverage.source.sourceIssues)
      element.createDiv({ text: `${issue.path}: ${issue.reason}` });
  }
  private section_abyssPrivate(
    element: HTMLElement,
    section: StatisticsSection,
    select: (id: string) => void,
  ): void {
    element.createEl('h4', { text: section.title });
    element.createEl('p', { text: section.context });
    for (const metric of section.metrics) {
      if (metric.role === 'coverage') this.metric_abyssPrivate(element, metric, select);
      if (metric.context !== undefined) element.createEl('p', { text: metric.context });
    }
  }
  private metric_abyssPrivate(
    element: HTMLElement,
    metric: StatisticsMetric,
    select: (id: string) => void,
  ): void {
    const text = `${metric.label}: ${metric.value === null ? 'Unavailable' : statisticsNumber(metric.value)}`;
    const id = metric.selectionId;
    if (id === undefined) element.createDiv({ text });
    else
      statisticsButton(element, text, () => {
        this.close();
        select(id);
      });
  }
  close(): void {
    this.popover_abyssPrivate?.close();
  }
}
