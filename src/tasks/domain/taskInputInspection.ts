import { htmlElementBarriers, inputTextBarriers } from './taskInputGuards';
import type {
  TaskInputCarrier,
  TaskInputInspection,
  TaskInputMetadataRole,
  TaskInputRange,
  TaskInputSourceProtection,
} from './taskInputTypes';
import { parseTaskLineSourceModel, taskLineAtomicRanges } from './taskLineSourceModel';
import { prefixTaskMarkdown } from './taskTags';
import { localDate, localTime } from './validation';

import { parseRecurrenceRule } from './recurrence';

const PREFIX = '- [ ] ';

function metadataRole(kind: string): kind is TaskInputMetadataRole {
  return (
    kind === 'due' ||
    kind === 'scheduled' ||
    kind === 'start' ||
    kind === 'time' ||
    kind === 'recurrence'
  );
}

function carrierValue(
  role: TaskInputMetadataRole,
  value: string | number | undefined,
): TaskInputCarrier['value'] {
  if (typeof value !== 'string') return undefined;
  if (role === 'recurrence') return parseRecurrenceRule(value).type === 'valid' ? value : undefined;
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
    if (role === undefined || !metadataRole(role)) continue;
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

/** Proves source ownership before creation policy removes prefix-owned fallback tags. */
export function inspectTaskInputProtection(
  prefix: string,
  markdownBody: string,
): TaskInputSourceProtection {
  const composed = prefixTaskMarkdown(prefix, markdownBody);
  const boundary = composed.length - markdownBody.length;
  const atoms = inputTextBarriers(composed, inspectTaskInput(composed).protectedRanges).sort(
    (a, b) => a.from - b.from,
  );
  const ranges = [...atoms, ...htmlElementBarriers(composed, atoms)];
  return {
    allowSourceTransforms: !ranges.some(({ from, to }) => from < boundary && boundary < to),
  };
}
