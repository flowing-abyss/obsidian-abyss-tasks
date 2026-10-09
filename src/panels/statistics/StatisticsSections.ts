import type {
  StatisticsChartModel,
  StatisticsSection,
  StatisticsViewModel,
} from '../../statistics';
import type { StatisticsChartRenderer } from './StatisticsChart';
import { StatisticsCharts } from './StatisticsCharts';
import { statisticsButton } from './StatisticsControls';
import {
  statisticsIntensityPaint,
  statisticsNumber,
  statisticsSeriesOpacity,
  statisticsSeriesPaint,
} from './statisticsFormat';
/** Owns keyed section surfaces. A cached model does not update its engine mounts. */
export class StatisticsSections {
  private readonly sections_abyssPrivate = new Map<
    string,
    { element: HTMLElement; charts: StatisticsCharts; model: StatisticsSection }
  >();
  constructor(
    private readonly host_abyssPrivate: HTMLElement,
    private readonly renderer_abyssPrivate: StatisticsChartRenderer,
    private readonly select_abyssPrivate: (id: string) => void,
  ) {}
  update(view: StatisticsViewModel): void {
    const staged = this.stage_abyssPrivate(view);
    this.host_abyssPrivate.classList.toggle(
      'abyss-statistics-content--rhythm',
      view.view === 'rhythm',
    );
    for (const [key, section] of this.sections_abyssPrivate)
      if (staged.has(key) || !view.sections.some((model) => model.id === key)) {
        section.charts.destroy();
        section.element.remove();
        this.sections_abyssPrivate.delete(key);
      }
    for (const [key, section] of staged) this.sections_abyssPrivate.set(key, section);
    for (const model of view.sections) {
      const section = this.sections_abyssPrivate.get(model.id);
      if (section !== undefined) this.host_abyssPrivate.append(section.element);
    }
  }
  private stage_abyssPrivate(
    view: StatisticsViewModel,
  ): Map<string, { element: HTMLElement; charts: StatisticsCharts; model: StatisticsSection }> {
    const staged = new Map<
      string,
      { element: HTMLElement; charts: StatisticsCharts; model: StatisticsSection }
    >();
    try {
      for (const model of view.sections) {
        if (this.sections_abyssPrivate.get(model.id)?.model === model) continue;
        const section = this.build_abyssPrivate(model);
        staged.set(model.id, section);
      }
    } catch (error) {
      for (const section of staged.values()) {
        section.charts.destroy();
        section.element.remove();
      }
      throw error;
    }
    return staged;
  }
  private build_abyssPrivate(model: StatisticsSection): {
    element: HTMLElement;
    charts: StatisticsCharts;
    model: StatisticsSection;
  } {
    const element = this.host_abyssPrivate.createEl('section', { cls: 'abyss-statistics-section' });
    const heading = element.createDiv({ cls: 'abyss-statistics-section-heading' });
    heading.createEl('h3', { text: model.title });
    const charts = new StatisticsCharts(
      element.createDiv(),
      this.renderer_abyssPrivate,
      this.select_abyssPrivate,
    );
    try {
      charts.update(model.charts);
    } catch (error) {
      charts.destroy();
      element.remove();
      throw error;
    }
    this.legend_abyssPrivate(element, model);
    this.intensity_abyssPrivate(element, model);
    this.metrics_abyssPrivate(element, model);
    if (model.charts.length > 0 && model.charts.every((chart) => chart.marks.length === 0))
      element.createDiv({ text: 'No eligible records in this selection.' });
    return { element, charts, model };
  }
  private metrics_abyssPrivate(element: HTMLElement, model: StatisticsSection): void {
    const metrics = element.createDiv({ cls: 'abyss-statistics-metrics' });
    for (const metric of model.metrics.filter((value) => value.role !== 'coverage')) {
      const value = metric.value === null ? 'Unavailable' : statisticsNumber(metric.value);
      const item =
        metric.selectionId === undefined
          ? metrics.createDiv({ cls: 'abyss-statistics-metric' })
          : metrics.createEl('button', {
              cls: 'abyss-statistics-metric',
              attr: { type: 'button' },
            });
      item.createSpan({
        cls: 'abyss-statistics-metric-value',
        text: `${value}${metricUnit(metric.unit, metric.value)}`,
      });
      item.createSpan({ cls: 'abyss-statistics-metric-label', text: metric.label });
      const id = metric.selectionId;
      if (id !== undefined)
        item.addEventListener('click', () => {
          this.select_abyssPrivate(id);
        });
    }
  }
  private legend_abyssPrivate(element: HTMLElement, model: StatisticsSection): void {
    const peers =
      model.legend.length > 0
        ? model.legend
        : [
            ...new Map(
              model.charts
                .flatMap((chart) => (chart.series.length > 1 ? chart.series : []))
                .map((series) => [series.key, series]),
            ).values(),
          ];
    if (peers.length <= 1) return;
    {
      const legend = element.createDiv({
        cls: 'abyss-statistics-legend',
        attr: { 'aria-label': 'Chart key' },
      });
      for (const item of peers) {
        const selectionId = 'selectionId' in item ? item.selectionId : undefined;
        const label =
          'value' in item ? `${item.label} · ${statisticsNumber(item.value ?? 0)}` : item.label;
        const entry =
          selectionId === undefined
            ? legend.createSpan({ text: label })
            : statisticsButton(legend, label, () => {
                this.select_abyssPrivate(selectionId);
              });
        const swatch = entry.createSpan({ cls: 'abyss-statistics-swatch' });
        entry.prepend(swatch);
        setStatisticsKey(swatch, 'paint', statisticsSeriesPaint(item, peers));
        setStatisticsKey(swatch, 'opacity', String(statisticsSeriesOpacity(item)));
      }
    }
  }
  private intensity_abyssPrivate(element: HTMLElement, model: StatisticsSection): void {
    for (const chart of model.charts) this.intensityChart_abyssPrivate(element, chart);
  }
  private intensityChart_abyssPrivate(element: HTMLElement, chart: StatisticsChartModel): void {
    const scale = chart.intensityScale;
    if (scale === undefined) return;
    const key = element.createDiv({
      cls: 'abyss-statistics-intensity',
      attr: { 'aria-label': scale.unit },
    });
    key.createSpan({ text: scale.unit });
    const max = scale.domain[1];
    const labels = [
      '0',
      `>0–<${statisticsNumber(max * 0.34)}`,
      `${statisticsNumber(max * 0.34)}–<${statisticsNumber(max * 0.67)}`,
      `${statisticsNumber(max * 0.67)}–${statisticsNumber(max)}`,
    ];
    for (const [index, level] of (['zero', 'low', 'medium', 'high'] as const).entries()) {
      const item = key.createSpan({
          text: ['0', '', '', statisticsNumber(max)][index] ?? '',
          attr: { 'aria-label': labels[index] ?? '', title: labels[index] ?? '' },
        }),
        swatch = item.createSpan({ cls: 'abyss-statistics-swatch' });
      item.prepend(swatch);
      setStatisticsKey(swatch, 'paint', statisticsIntensityPaint(level));
    }
    for (const [level, label] of [
      ['immature', 'Not yet observable'],
      ['unknown', 'Unknown timing'],
      ['unavailable', 'No elapsed exposure'],
    ] as const)
      if (chart.marks.some((mark) => mark.state === level)) {
        const item = key.createSpan({ text: label }),
          swatch = item.createSpan({ cls: 'abyss-statistics-swatch' });
        item.prepend(swatch);
        setStatisticsKey(swatch, 'paint', statisticsIntensityPaint(level));
      }
  }
  destroy(): void {
    for (const section of this.sections_abyssPrivate.values()) section.charts.destroy();
    this.sections_abyssPrivate.clear();
    this.host_abyssPrivate.empty();
  }
}

function setStatisticsKey(element: HTMLElement, key: 'paint' | 'opacity', value: string): void {
  element.style.setProperty(`--abyss-statistics-key-${key}`, value);
}

function metricUnit(unit: string | undefined, value: number | null): string {
  if (unit === 'minutes') return ' min';
  if (unit !== 'days') return '';
  return value === 1 ? ' day' : ' days';
}
