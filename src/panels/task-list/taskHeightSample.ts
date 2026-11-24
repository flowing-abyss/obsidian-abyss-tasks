import type { RowMeasurement } from '../virtualization/rowViewport';
import type { TaskListRows } from './taskListRows';

export interface TaskHeightSample {
  readonly height: number;
  readonly width: number;
  readonly font: string;
  readonly fontLoad: number;
  readonly variant?: string;
  readonly keys: readonly string[];
}

const fontLoads = new WeakMap<Promise<FontFaceSet>, number>();
let nextFontLoad = 1;

// Each font loading cycle has a new ready promise. A saved sample can recognize it
// after reopening without retaining the document that supplied the fonts.
function fontLoadId(ready: Promise<FontFaceSet> | undefined): number {
  if (ready === undefined) return 0;
  const known = fontLoads.get(ready);
  if (known !== undefined) return known;
  const id = nextFontLoad++;
  fontLoads.set(ready, id);
  return id;
}

export function retainHeightSample<T>(
  sample: TaskHeightSample | undefined,
  rows: TaskListRows<T>,
): TaskHeightSample | undefined {
  if (sample === undefined || rows.taskCount === 0) return sample;
  return sample.keys.some((key) => rows.indexOf(key) >= 0) ? sample : undefined;
}

interface SampleLayout {
  readonly width: number;
  readonly font: string;
  readonly fonts: FontFaceSet;
  readonly variant?: string | undefined;
  readonly top: number;
}

function canReuseSample(
  sample: TaskHeightSample,
  { width, font, variant, top }: SampleLayout,
): boolean {
  // A native scrollbar can change the list width mid-fling. Timeline measures its
  // summary independently, so changes to that width also apply at a deep anchor.
  if (variant === undefined && top > 0) return true;
  return sample.width === width && sample.font === font && sample.variant === variant;
}

export function sampleTaskHeights<T>(
  rows: TaskListRows<T>,
  measurements: readonly RowMeasurement[],
  previous: TaskHeightSample | undefined,
  layout: SampleLayout,
): TaskHeightSample | undefined {
  const { width, font, fonts, variant } = layout;
  if (width <= 0 || fonts.status === 'loading') return;
  const fontLoad = fontLoadId(fonts.ready);
  if (previous?.fontLoad === fontLoad && canReuseSample(previous, layout)) return;
  const tasks = measurements.filter(
    ({ key, height }) => rows.indexOf(key) >= 0 && Number.isFinite(height) && height > 0,
  );
  if (tasks.length < 2) return;
  const height = tasks.reduce((sum, row) => sum + row.height, 0) / tasks.length;
  return {
    height,
    width,
    font,
    fontLoad,
    ...(variant !== undefined && { variant }),
    keys: tasks.map(({ key }) => key),
  };
}
