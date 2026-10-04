import type { StatisticsChartModel } from '../../statistics';

export interface StatisticsChartHandle {
  update(model: StatisticsChartModel): void;
  destroy(): void;
}

export interface StatisticsChartRenderer {
  mount(
    host: HTMLElement,
    model: StatisticsChartModel,
    onSelect: (selectionId: string) => void,
  ): StatisticsChartHandle;
}
