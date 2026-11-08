import { parseLinks } from '../../../markdown/links';
import type {
  TaskMergePreservation,
  TaskMergePreservationEntry,
  TaskSourceCopyEvidence,
} from '../../application/TaskSourceCopyApi';
import {
  parseTaskLineSourceModel,
  type TaskLineSourceModel,
} from '../../domain/taskLineSourceModel';
import { taskNodeSourceLine, taskTreeNodes } from '../../domain/taskSearchProjection';
import { sameTaskNodeRef, type TaskSnapshot } from '../../domain/types';
import type { TaskBlockEditor } from './TaskBlockEditor';
import { readTaskDescriptionLine } from './taskBlockSyntax';

function entry(
  kind: TaskMergePreservationEntry['kind'],
  field: string,
  retained: boolean,
  reason: string,
): TaskMergePreservationEntry {
  return { kind, field, state: retained ? 'retained' : 'held', ...(retained ? {} : { reason }) };
}
function containsLines(destination: string | undefined, source: string): boolean {
  return destination !== undefined && `\n${destination}\n`.includes(`\n${source}\n`);
}
function spanRetained(
  roots: { source: TaskSnapshot; destination: TaskSnapshot },
  kind: TaskLineSourceModel['spans'][number]['kind'],
  raw: string,
): boolean {
  const { source, destination } = roots;
  if (
    [
      'created',
      'start',
      'scheduled',
      'due',
      'completion',
      'cancelled',
      'time',
      'duration',
    ].includes(kind)
  ) {
    const field = kind as keyof TaskSnapshot['planning'];
    return (
      source.planning[field] !== undefined && source.planning[field] === destination.planning[field]
    );
  }
  if (kind === 'prefix' || kind === 'separator') return true;
  if (kind === 'title')
    return (
      source.markdownTitle === destination.markdownTitle ||
      containsLines(destination.description, source.markdownTitle)
    );
  if (kind === 'tag') return destination.tags.includes(raw);
  if (kind === 'priority') return source.priority === destination.priority;
  if (kind === 'on-completion') return source.onCompletion === destination.onCompletion;
  return false;
}
function headerEntries(
  source: TaskSnapshot,
  destination: TaskSnapshot,
): TaskMergePreservationEntry[] {
  const model = parseTaskLineSourceModel(source.source.originalMarkdown);
  if (model === null) return [entry('header', 'syntax', false, 'Source header is not classified.')];
  const entries: TaskMergePreservationEntry[] = [
    entry(
      'header',
      'status',
      source.statusSymbol === destination.statusSymbol,
      'Source and destination statuses differ.',
    ),
  ];
  for (const span of model.spans) {
    const raw = model.original.slice(span.from, span.to);
    const retained = spanRetained({ source, destination }, span.kind, raw);
    entries.push(
      entry(
        'header',
        span.kind,
        retained,
        `Source ${span.kind} is not preserved by the destination.`,
      ),
    );
  }
  const classified = model.carriers.filter((carrier) => carrier.kind !== 'tag');
  if (new Set(classified.map((carrier) => carrier.kind)).size !== classified.length)
    entries.push(
      entry(
        'constraint',
        'duplicate-fields',
        false,
        'Repeated root fields need explicit resolution.',
      ),
    );
  // The canonical title is free-form Markdown, not a parser for third-party inline fields or identity/link semantics.
  if (/[[\]<>^]|%%|::/u.test(source.markdownTitle))
    entries.push(
      entry(
        'constraint',
        'unclassified-header',
        false,
        'Root inline markup, identity or links need a separate preservation policy.',
      ),
    );
  return entries;
}
function permittedCopies(
  source: TaskSnapshot,
  copies: readonly TaskSourceCopyEvidence[],
): readonly TaskSourceCopyEvidence[] {
  return copies.filter(
    (copy) =>
      copy.state === 'retained' &&
      sameTaskNodeRef(
        { type: 'task', ref: source.ref },
        { type: 'task', ref: copy.sourceRoot.ref },
      ) &&
      source.source.originalBlock === copy.sourceRoot.source.originalBlock,
  );
}
function bodyEntries(
  source: TaskSnapshot,
  destination: TaskSnapshot,
  copies: readonly TaskSourceCopyEvidence[],
  editor: TaskBlockEditor,
): TaskMergePreservationEntry[] {
  const covered = new Set([0]);
  const entries: TaskMergePreservationEntry[] = [];
  const own = (from: number, count: number): void => {
    for (let i = from; i < from + count; i++) covered.add(i);
  };
  for (const [index, child] of source.subtasks.entries()) {
    const range = editor.ownedTaskSubtree(source.source.originalBlock, child.ref.relativeLine);
    const retained = copies.some(
      (copy) =>
        copy.type === 'subtree' &&
        copy.tasks.some(
          (pair) =>
            sameTaskNodeRef(pair.source, { type: 'subtask', ref: child.ref }) &&
            sameTaskNodeRef(
              pair.destination.type === 'subtask' ? pair.destination.ref.parent : pair.destination,
              { type: 'task', ref: destination.ref },
            ),
        ),
    );
    entries.push(
      entry(
        'subtree',
        `child:${index + 1}`,
        retained,
        'Source child has no intact copy under the destination root.',
      ),
    );
    if (range !== undefined) own(range.fromLine, range.toLine - range.fromLine + 1);
  }
  for (const [index, comment] of source.comments.entries()) {
    const retained = copies.some((copy) =>
      copy.comments.some(
        (pair) =>
          JSON.stringify(pair.source) === JSON.stringify(comment.ref) &&
          sameTaskNodeRef(pair.destination.parent, { type: 'task', ref: destination.ref }),
      ),
    );
    entries.push(
      entry(
        'comment',
        `comment:${index + 1}`,
        retained,
        'Source comment has no intact copy under the destination root.',
      ),
    );
    own(comment.ref.relativeLine, comment.ref.originalMarkdown.split('\n').length);
  }
  entries.push(...residualEntries(source, destination, covered));
  return entries;
}
function residualEntries(
  source: TaskSnapshot,
  destination: TaskSnapshot,
  covered: ReadonlySet<number>,
): TaskMergePreservationEntry[] {
  const lines = source.source.originalBlock.split(/\r?\n/u),
    entries: TaskMergePreservationEntry[] = [];
  const description = source.description;
  const descriptionRetained =
    description === undefined || containsLines(destination.description, description);
  for (let at = 1; at < lines.length; at++) {
    if (covered.has(at)) continue;
    if (readTaskDescriptionLine(lines[at] ?? '') !== undefined)
      entries.push(
        entry(
          'description',
          `description:${at}`,
          descriptionRetained,
          'Source description is not retained in the destination.',
        ),
      );
    else
      entries.push(
        entry('residual', `body:${at}`, false, 'Unclassified source-owned body content remains.'),
      );
  }
  return entries;
}
function lifecycleEntries(side: string, root: TaskSnapshot): TaskMergePreservationEntry[] {
  const entries: TaskMergePreservationEntry[] = [];
  for (const { node } of taskTreeNodes(root)) {
    if (node.recurrence !== undefined)
      entries.push(
        entry(
          'constraint',
          `${side}-recurrence`,
          false,
          'Recurring ancestry needs a separate merge policy.',
        ),
      );
    if (node.timeEntries.length > 0)
      entries.push(
        entry(
          'constraint',
          `${side}-tracking`,
          false,
          'Tracked ownership is not eligible for flat merge cleanup.',
        ),
      );
  }
  return entries;
}
function orderEntries(
  source: TaskSnapshot,
  copies: readonly TaskSourceCopyEvidence[],
): TaskMergePreservationEntry[] {
  const children = source.subtasks.map((child) =>
    copies
      .flatMap((copy) => copy.tasks)
      .filter((pair) => sameTaskNodeRef(pair.source, { type: 'subtask', ref: child.ref }))
      .map((pair) => taskNodeSourceLine(pair.destination)),
  );
  const comments = source.comments.map((comment) =>
    copies
      .flatMap((copy) => copy.comments)
      .filter((pair) => JSON.stringify(pair.source) === JSON.stringify(comment.ref))
      .map((pair) => taskNodeSourceLine(pair.destination.parent) + pair.destination.relativeLine),
  );
  return [
    entry(
      'constraint',
      'child-order',
      sourceOrder(children),
      'Source children need one proved copy each in source order.',
    ),
    entry(
      'constraint',
      'comment-order',
      sourceOrder(comments),
      'Source comments need one proved copy each in source order.',
    ),
  ];
}
function sourceOrder(positions: ReadonlyArray<readonly number[]>): boolean {
  let previous = -1;
  for (const matches of positions) {
    const at = matches[0];
    if (matches.length !== 1 || at === undefined || at <= previous) return false;
    previous = at;
  }
  return true;
}
function sourceIdentityEntries(source: TaskSnapshot): TaskMergePreservationEntry[] {
  for (const { node } of taskTreeNodes(source)) {
    const line =
      'source' in node
        ? node.source.originalMarkdown
        : (node.ref.originalBlock.split('\n')[0] ?? '');
    const model = parseTaskLineSourceModel(line);
    if (
      model?.spans.some((span) => ['task-id', 'depends-on', 'block-id'].includes(span.kind)) ===
      true
    )
      return [
        entry(
          'constraint',
          'source-identity',
          false,
          'Source identities and incoming references need a separate migration proof.',
        ),
      ];
  }
  return [];
}
export function assessTaskMerge(
  source: TaskSnapshot,
  destination: TaskSnapshot,
  copies: readonly TaskSourceCopyEvidence[],
  editor: TaskBlockEditor,
): TaskMergePreservation {
  const entries = [
    ...headerEntries(source, destination),
    ...bodyEntries(source, destination, permittedCopies(source, copies), editor),
    ...orderEntries(source, permittedCopies(source, copies)),
    ...sourceIdentityEntries(source),
  ];
  if (sameTaskNodeRef({ type: 'task', ref: source.ref }, { type: 'task', ref: destination.ref }))
    entries.push(
      entry('constraint', 'overlap', false, 'Source and destination must be disjoint roots.'),
    );
  entries.push(
    ...lifecycleEntries('source', source),
    ...lifecycleEntries('destination', destination),
  );
  if (
    source.ref.filePath !== destination.ref.filePath &&
    parseLinks(source.description ?? '').length > 0
  )
    entries.push(
      entry(
        'constraint',
        'description-links',
        false,
        'Cross-file description links have no source-copy proof.',
      ),
    );
  return {
    sourceRoot: source,
    state: entries.every((e) => e.state === 'retained') ? 'covered' : 'held',
    entries,
  };
}
