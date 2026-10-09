import type { StatisticsRequest, StatisticsViewId } from '../../statistics';

/** Transient navigation only; observing this port never acquires task sources. */
export interface StatisticsNavigationPort {
  snapshot(): {
    readonly view: StatisticsViewId;
    readonly scopeLabel: string;
    readonly group: StatisticsRequest['group'];
  };
  subscribe(listener: () => void): () => void;
  selectView(view: StatisticsViewId): void;
  selectGroup(group: StatisticsRequest['group']): void;
  openScope(): void;
}
