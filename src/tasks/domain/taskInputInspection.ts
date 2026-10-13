import type {
  TaskInputCarrier,
  TaskInputInspection,
  TaskInputPlanningRole,
  TaskInputRange,
} from './taskInputTypes';
import { parseTaskLineSourceModel, taskLineAtomicRanges } from './taskLineSourceModel';
import { localDate, localTime } from './validation';

const PREFIX = '- [ ] ';

function planningRole(kind: string): kind is TaskInputPlanningRole {
  return kind === 'due' || kind === 'scheduled' || kind === 'start' || kind === 'time';
}

function carrierValue(
  role: TaskInputPlanningRole,
  value: string | number | undefined,
): TaskInputCarrier['value'] {
  if (typeof value !== 'string') return undefined;
  try {
    return role === 'time' ? localTime(value) : localDate(value);
  } catch {
    // A known but invalid authored value still owns its protected source range.
    return undefined;
  }
}

/** Reads canonical source occurrences in raw UTF-16 coordinates, without applying creation policy. */
export function inspectTaskInput(raw: string): TaskInputInspection {
  const model = parseTaskLineSourceModel(PREFIX + raw);
  if (model === null) return { tags: [], carriers: [], protectedRanges: [] };
  const range = ({ from, to }: TaskInputRange): TaskInputRange => ({
    from: from - PREFIX.length,
    to: to - PREFIX.length,
  });
  const tags = model.carriers
    .filter(({ kind }) => kind === 'tag')
    .map((carrier) => ({
      value: raw.slice(carrier.from - PREFIX.length, carrier.to - PREFIX.length),
      range: range(carrier),
    }));
  const carriers: TaskInputCarrier[] = [];
  for (const carrier of model.carriers) {
    const role = carrier.kind === 'malformed-known' ? carrier.malformedKind : carrier.kind;
    if (role === undefined || !planningRole(role)) continue;
    const value = carrierValue(role, carrier.value);
    carriers.push({ role, range: range(carrier), ...(value === undefined ? {} : { value }) });
  }
  const protectedRanges = [
    ...taskLineAtomicRanges(PREFIX + raw),
    ...model.carriers.filter(({ kind }) => kind !== 'title'),
  ]
    .map(range)
    .sort((left, right) => {
      const order = left.from - right.from;
      return order !== 0 ? order : left.to - right.to;
    });
  return { tags, carriers, protectedRanges };
}
