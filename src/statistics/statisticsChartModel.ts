import type { StatisticsTone } from './types';
export type StatisticsAxis =
  | {
      readonly type: 'number';
      readonly domain: readonly [number, number];
      readonly label: string;
      readonly unit?: string | undefined;
      readonly ticks?: readonly number[] | undefined;
    }
  | {
      readonly type: 'band';
      readonly categories: readonly string[];
      readonly label: string;
    };
export interface StatisticsMark {
  readonly key: string;
  readonly x: number | string;
  readonly y: number | string;
  readonly x2?: number | undefined;
  readonly y2?: number | undefined;
  readonly series?: string | undefined;
  readonly selectionId?: string | undefined;
  readonly label?: string | undefined;
  readonly detail?: string | undefined;
  readonly weight?: number | undefined;
  readonly numerator?: number | undefined;
  readonly denominator?: number | undefined;
  readonly state?: 'measured' | 'unknown' | 'immature' | 'unavailable' | undefined;
  readonly overdue?: number | undefined;
}
export interface StatisticsChartModel {
  readonly id: string;
  readonly accessibleLabel: string;
  readonly kind: 'bars' | 'lines' | 'scatter' | 'heatmap' | 'timeline' | 'network';
  readonly x: StatisticsAxis;
  readonly y: StatisticsAxis;
  readonly series: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly tone: StatisticsTone;
    readonly muted?: boolean | undefined;
  }>;
  readonly marks: readonly StatisticsMark[];
  readonly edges?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly selectionId?: string | undefined;
  }>;
  readonly layout?: 'stacked' | 'diverging' | 'facets' | 'density' | undefined;
  readonly facet?: {
    readonly key: string | undefined;
    readonly label: string;
  };
  readonly guides?: ReadonlyArray<{
    readonly axis: 'x' | 'y';
    readonly value: number;
    readonly label: string;
  }>;
}
export function numeric(label: string, max: number, min = 0, unit?: string): StatisticsAxis {
  return { type: 'number', label, domain: [min, Math.max(min + 1, max)], unit };
}
export function bands(label: string, categories: readonly string[]): StatisticsAxis {
  return { type: 'band', label, categories };
}
