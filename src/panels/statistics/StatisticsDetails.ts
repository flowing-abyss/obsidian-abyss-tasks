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
    element.createDiv({ text: `${statisticsNumber(coverage.nodes)} Tasks & subtasks in scope` });
    for (const [label, count] of [
      ['Archived', coverage.archive],
      ['Unusable time entries', coverage.brokenEntries],
      ['Date issues', coverage.dateIssues],
    ] as const)
      if (count > 0) element.createDiv({ text: `${label}: ${statisticsNumber(count)}` });
    for (const issue of model.coverage.source.sourceIssues)
      element.createDiv({ text: `${issue.path}: ${issue.reason}` });
  }
  private section_abyssPrivate(
    element: HTMLElement,
    section: StatisticsSection,
    select: (id: string) => void,
  ): void {
    element.createEl('h4', { text: section.title });
    element.createEl('p', { text: `Definition: ${section.context}` });
    const metrics = section.metrics.filter(
      (metric) => metric.role === 'coverage' && metric.value !== 0,
    );
    if (metrics.length === 0) return;
    const list = element.createDiv({
      cls: 'abyss-statistics-coverage',
      attr: { role: 'list', 'aria-label': `${section.title} coverage` },
    });
    for (const metric of metrics) this.metric_abyssPrivate(list, metric, select);
  }
  private metric_abyssPrivate(
    element: HTMLElement,
    metric: StatisticsMetric,
    select: (id: string) => void,
  ): void {
    const row = element.createDiv({ attr: { role: 'listitem' } });
    const text = `${metric.label}: ${metric.value === null ? 'Unavailable' : statisticsNumber(metric.value)}`;
    const id = metric.selectionId;
    if (id === undefined) row.createDiv({ text });
    else
      statisticsButton(row, text, () => {
        this.close();
        select(id);
      });
    if (metric.context !== undefined)
      row.createDiv({ cls: 'abyss-statistics-context', text: metric.context });
  }
  close(): void {
    this.popover_abyssPrivate?.close();
  }
}
