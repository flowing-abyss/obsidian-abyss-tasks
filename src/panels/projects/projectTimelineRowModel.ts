import type { RowViewportRow } from '../virtualization/rowViewport';

export interface TimelineViewportRow extends RowViewportRow {
  readonly kind: 'group' | 'project';
  readonly groupKey: string;
  readonly occurrenceId?: string;
}

export function timelineViewportRows(
  groups: ReadonlyArray<{
    readonly key: string;
    readonly collapsed: boolean;
    readonly rows: ReadonlyArray<{
      readonly occurrenceId: string;
      readonly revision: string;
      readonly estimatedHeight: number;
    }>;
  }>,
  layoutRevision: string,
  headerHeight: number,
): readonly TimelineViewportRow[] {
  return groups.flatMap((group): TimelineViewportRow[] => [
    ...(headerHeight <= 0
      ? []
      : [
          {
            key: `timeline-header:${JSON.stringify(group.key)}`,
            kind: 'group' as const,
            groupKey: group.key,
            estimatedHeight: headerHeight,
            measurementRevision: layoutRevision,
          },
        ]),
    ...(group.collapsed
      ? []
      : group.rows.map((row): TimelineViewportRow => ({
          key: row.occurrenceId,
          kind: 'project',
          groupKey: group.key,
          occurrenceId: row.occurrenceId,
          estimatedHeight: row.estimatedHeight,
          measurementRevision: JSON.stringify([layoutRevision, row.revision]),
        }))),
  ]);
}
