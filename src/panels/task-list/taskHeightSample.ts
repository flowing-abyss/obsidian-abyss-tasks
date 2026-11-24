import type { RowMeasurement } from '../virtualization/rowViewport';
import type { TaskListRows } from './taskListRows';

export interface TaskHeightSample {
  readonly height: number;
  readonly width: number;
  readonly font: string;
  readonly variant?: string;
  readonly keys: readonly string[];
}

export function retainHeightSample<T>(
  sample: TaskHeightSample | undefined,
  rows: TaskListRows<T>,
): TaskHeightSample | undefined {
  if (sample === undefined || rows.taskCount === 0) return sample;
  return sample.keys.some((key) => rows.indexOf(key) >= 0) ? sample : undefined;
}

export function sampleTaskHeights<T>(
  rows: TaskListRows<T>,
  measurements: readonly RowMeasurement[],
  previous: TaskHeightSample | undefined,
  {
    width,
    font,
    variant,
    top,
  }: { width: number; font: string; variant?: string | undefined; top: number },
): TaskHeightSample | undefined {
  if (width <= 0) return;
  if (previous !== undefined) {
    // A native list scrollbar can change the pane width mid-fling. Timeline supplies the
    // independent summary width, so an actual change there also applies at a deep anchor.
    if (variant === undefined && top > 0) return;
    if (previous.width === width && previous.font === font && previous.variant === variant) return;
  }
  const tasks = measurements.filter(
    ({ key, height }) => rows.indexOf(key) >= 0 && Number.isFinite(height) && height > 0,
  );
  if (tasks.length < 2) return;
  const height = tasks.reduce((sum, row) => sum + row.height, 0) / tasks.length;
  return {
    height,
    width,
    font,
    ...(variant !== undefined && { variant }),
    keys: tasks.map(({ key }) => key),
  };
}
