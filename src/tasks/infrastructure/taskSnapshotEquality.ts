import type { TaskSnapshot } from '../domain/types';

type ValuePair = readonly [unknown, unknown];

function normalizedNumber(value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

function queueArrayValues(
  left: readonly unknown[],
  right: readonly unknown[],
  pending: ValuePair[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++)
    pending.push([left[index] ?? null, right[index] ?? null]);
  return true;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function alreadyChecked(
  left: object,
  right: object,
  checked: WeakMap<object, WeakSet<object>>,
): boolean {
  const previous = checked.get(left);
  if (previous === undefined) {
    checked.set(left, new WeakSet([right]));
    return false;
  }
  if (previous.has(right)) return true;
  previous.add(right);
  return false;
}

function queueValues(left: object, right: object, pending: ValuePair[]): boolean {
  if (Array.isArray(left)) return Array.isArray(right) && queueArrayValues(left, right, pending);
  return !Array.isArray(right) && queueObjectValues(left, right, pending);
}

function queueObjectValues(left: object, right: object, pending: ValuePair[]): boolean {
  const leftValues = left as Readonly<Record<string, unknown>>;
  const rightValues = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftValues).filter((key) => leftValues[key] !== undefined);
  const rightKeys = Object.keys(rightValues).filter((key) => rightValues[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index];
    if (key === undefined || key !== rightKeys[index]) return false;
    pending.push([leftValues[key], rightValues[key]]);
  }
  return true;
}

/**
 * Exact JSON-value equality for canonical immutable snapshot plain data. Host objects and
 * custom toJSON methods are outside this boundary. Pair memoization preserves shared ancestry
 * without confusing two independently detached right-hand references.
 */
export function sameTaskSnapshots(
  left: readonly TaskSnapshot[],
  right: readonly TaskSnapshot[],
): boolean {
  const pending: ValuePair[] = [[left, right]];
  const checked = new WeakMap<object, WeakSet<object>>();
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const first = normalizedNumber(pair[0]);
    const second = normalizedNumber(pair[1]);
    if (first === second) continue;
    if (!isObject(first) || !isObject(second)) return false;
    if (alreadyChecked(first, second, checked)) continue;
    if (!queueValues(first, second, pending)) return false;
  }
  return true;
}
