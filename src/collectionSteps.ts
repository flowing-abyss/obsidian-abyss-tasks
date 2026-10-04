/** Pure cooperative work. Undefined completion is reserved for iterator closure. */
export type CollectionStep = 'cheap' | 'atom';
export type CollectionSteps<T> = Generator<CollectionStep, T | undefined, void>;
export function drainCollectionSteps<T>(steps: CollectionSteps<T>): T {
  let next = steps.next();
  while (next.done !== true) next = steps.next();
  if (next.value === undefined) throw new Error('Collection ended without a result');
  return next.value;
}
function* orderedSteps<T>(
  values: readonly T[],
  compare: (a: T, b: T) => number,
): CollectionSteps<boolean> {
  for (let i = 1; i < values.length; i++) {
    const order = compare(values[i - 1] as T, values[i] as T);
    yield 'atom';
    if (order > 0) return false;
  }
  return true;
}
function* mergeRun<T>(
  source: readonly T[],
  destination: T[],
  compare: (a: T, b: T) => number,
  range: { start: number; width: number },
): CollectionSteps<boolean> {
  const { start, width } = range;
  const middle = Math.min(start + width, source.length),
    end = Math.min(start + width * 2, source.length);
  let left = start,
    right = middle,
    output = start;
  while (left < middle && right < end) {
    const order = compare(source[left] as T, source[right] as T);
    destination[output++] = order > 0 ? (source[right++] as T) : (source[left++] as T);
    yield 'atom';
  }
  while (left < middle) {
    destination[output++] = source[left++] as T;
    yield 'cheap';
  }
  while (right < end) {
    destination[output++] = source[right++] as T;
    yield 'cheap';
  }
  return true;
}
function* mergePass<T>(
  source: readonly T[],
  destination: T[],
  compare: (a: T, b: T) => number,
  width: number,
): CollectionSteps<boolean> {
  for (let start = 0; start < source.length; start += width * 2) {
    const completed = yield* mergeRun(source, destination, compare, { start, width });
    if (completed === undefined) throw new Error('Merge ended without a result');
  }
  return true;
}
/** Stable bottom-up merge over an exclusively owned dense reference vector. */
export function* stableSortSteps<T>(
  ownedValues: T[],
  compare: (left: T, right: T) => number,
): CollectionSteps<T[]> {
  let source = ownedValues,
    destination: T[] = [];
  try {
    if (source.length < 2) return source;
    const ordered = yield* orderedSteps(source, compare);
    if (ordered === undefined) throw new Error('Order check ended without a result');
    if (ordered) return source;
    for (const value of source) {
      destination.push(value);
      yield 'cheap';
    }
    for (let width = 1; width < source.length; width *= 2) {
      const completed = yield* mergePass(source, destination, compare, width);
      if (completed === undefined) throw new Error('Merge pass ended without a result');
      const previous = source;
      source = destination;
      destination = previous;
    }
    return source;
  } finally {
    source = [];
    destination = [];
  }
}
