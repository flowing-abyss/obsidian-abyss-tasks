import type { RowMeasurement } from '../virtualization/rowViewport';
import type { TaskListRows } from './taskListRows';

export interface TaskHeightSample {
  readonly height: number;
  readonly width: number;
  readonly font: string;
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
  { width, font, top }: { width: number; font: string; top: number },
): TaskHeightSample | undefined {
  // A scrollbar can change the content width during a fling. Keep its estimate until the list reopens at the top.
  if (previous !== undefined && (top > 0 || (previous.width === width && previous.font === font)))
    return;
  const tasks = measurements.filter(
    ({ key, height }) => rows.indexOf(key) >= 0 && Number.isFinite(height) && height > 0,
  );
  if (tasks.length < 2) return;
  const height = tasks.reduce((sum, row) => sum + row.height, 0) / tasks.length;
  return { height, width, font, keys: tasks.map(({ key }) => key) };
}
