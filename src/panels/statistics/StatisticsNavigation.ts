import type { StatisticsViewId } from '../../statistics';

/** Transient navigation only; observing this port never acquires task sources. */
export interface StatisticsNavigationPort {
  snapshot(): { readonly view: StatisticsViewId; readonly scopeLabel: string };
  subscribe(listener: () => void): () => void;
  selectView(view: StatisticsViewId): void;
  openScope(): void;
}
