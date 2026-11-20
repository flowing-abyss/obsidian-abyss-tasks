import {
  commandReferenceInputs,
  mapReferenceShape,
  outputReferenceKind,
  record,
  type CommandReferenceKind,
} from './commandReferenceShapes';
import { CommandFailure } from './commandTypes';

export class CommentRemovalMismatch extends CommandFailure {
  constructor(readonly edit: string) {
    super(
      'COMMENT_OPERATION',
      `No change was staged. This edit belongs to a comment. To remove that comment call change_task with {"edit":"${edit}","operation":{"type":"remove-comment"}}. Continue with the remaining requested changes.`,
    );
  }
}

interface EditChoice {
  edit: string;
  label: string;
}

function referenceKey(kind: CommandReferenceKind, value: string): string {
  return `${kind}\0${value}`;
}

function identifiesMetadata(operation: Record<string, unknown> | undefined): boolean {
  return (
    operation?.['type'] === 'set' ||
    (operation?.['type'] === 'patch' &&
      Object.keys(operation).every((key) => key === 'type' || key === 'patch'))
  );
}
function projectTaskSource(
  input: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> | undefined {
  const source = record(value);
  const line = source?.['line'];
  return source !== undefined &&
    typeof input['target'] === 'string' &&
    typeof input['revision'] === 'string' &&
    typeof input['markdownTitle'] === 'string' &&
    typeof source['path'] === 'string' &&
    Number.isInteger(line) &&
    (line as number) >= 0
    ? { ...source, line: (line as number) + 1 }
    : undefined;
}
/** Turn-local SDK projection only. Neither aliases nor this book enter application state. */
export class CommandReferenceBook {
  private readonly aliases_abyssPrivate = new Map<
    string,
    { kind: CommandReferenceKind; value: string }
  >();
  private readonly values_abyssPrivate = new Map<string, string>();
  private readonly edits_abyssPrivate = new Map<string, Record<string, unknown>>();
  private sequence = 0;
  constructor(private readonly turn: string) {}
  /** Comparison evidence for failed work only; never validates an executable reference. */
  identity(value: string): string {
    const edit = this.edits_abyssPrivate.get(value)?.['target'];
    return typeof edit === 'string' ? edit : (this.aliases_abyssPrivate.get(value)?.value ?? value);
  }
  issuedEntities(): ReadonlyArray<{ reference: string; kind: string }> {
    const kinds: Readonly<Record<string, string>> = { t: 'task', p: 'project', n: 'note' };
    return [...this.aliases_abyssPrivate]
      .flatMap(([reference, entry]) => {
        const kind = kinds[entry.kind];
        return kind === undefined ? [] : [{ reference, kind }];
      })
      .slice(-64);
  }
  issuedFindEvidence(candidates: readonly string[]): string[] {
    return candidates.flatMap((id) => this.issued_abyssPrivate('q', id) ?? []);
  }
  issuedTaskEdit(target: string | undefined, current: unknown): string | undefined {
    const rows = record(current)?.['taskReferences'];
    if (target === undefined || !Array.isArray(rows)) return undefined;
    const row: unknown = rows.find((value: unknown) => record(value)?.['target'] === target);
    return this.editChoice_abyssPrivate('task', row)?.edit;
  }
  /** List the complete small current catalog only when every binding has already been issued. */
  issuedEditChoices(current: unknown): readonly EditChoice[] {
    const catalog = record(current);
    const tasks = catalog?.['taskReferences'],
      comments = catalog?.['commentReferences'];
    if (
      catalog?.['truncated'] === true ||
      !Array.isArray(tasks) ||
      !Array.isArray(comments) ||
      tasks.length + comments.length > 12
    )
      return [];
    const choices = [
      ...tasks.map((row: unknown) => this.editChoice_abyssPrivate('task', row)),
      ...comments.map((row: unknown) => this.editChoice_abyssPrivate('comment', row)),
    ];
    return choices.every((choice): choice is EditChoice => choice !== undefined)
      ? [...new Map(choices.map((choice) => [choice.edit, choice])).values()]
      : [];
  }
  private editChoice_abyssPrivate(
    kind: 'task' | 'comment',
    value: unknown,
  ): EditChoice | undefined {
    const row = record(value);
    const binding = this.editBinding_abyssPrivate(row);
    if (row?.['kind'] !== kind || binding === undefined) return undefined;
    const key = JSON.stringify(binding);
    const edit = this.issued_abyssPrivate('b', key);
    const target = this.issued_abyssPrivate(kind === 'task' ? 't' : 'c', row['target']);
    if (
      edit === undefined ||
      target === undefined ||
      JSON.stringify(this.edits_abyssPrivate.get(edit)) !== key
    )
      return undefined;
    if (kind === 'task') return { edit, label: `task ${target}` };
    const task = this.issued_abyssPrivate('t', row['ownerTarget']);
    return task === undefined ? undefined : { edit, label: `comment ${target} on ${task}` };
  }
  private issued_abyssPrivate(kind: CommandReferenceKind, value: unknown): string | undefined {
    return typeof value === 'string'
      ? this.values_abyssPrivate.get(referenceKey(kind, value))
      : undefined;
  }
  private issue_abyssPrivate(kind: CommandReferenceKind, value: string): string {
    const key = referenceKey(kind, value);
    const existing = this.values_abyssPrivate.get(key);
    if (existing !== undefined) return existing;
    if (this.aliases_abyssPrivate.size >= 4096)
      throw new CommandFailure(
        'REFERENCE_LIMIT',
        'This turn has too many references. Read a smaller scope.',
      );
    const alias = `@${this.turn}:${kind}${++this.sequence}`;
    this.aliases_abyssPrivate.set(alias, { kind, value });
    this.values_abyssPrivate.set(key, alias);
    return alias;
  }
  private resolve_abyssPrivate(kind: CommandReferenceKind, value: string): string {
    if (!value.startsWith('@') && kind !== 'q') return value;
    const reference = this.aliases_abyssPrivate.get(value);
    if (reference?.kind !== kind)
      throw new CommandFailure('REFERENCE', 'Use an exact current reference of the required kind.');
    return reference.value;
  }
  /** Only an issued immutable edit capability can supply preparation authority. */
  edit(
    alias: string,
    type: string,
    current: unknown,
  ): { target: string; basis: Record<string, unknown> } {
    const entry = this.currentEdit_abyssPrivate(alias, current);
    const kind = ['update-comment', 'remove-comment'].includes(type) ? 'comment' : 'task';
    if (entry['kind'] === 'comment' && type === 'remove') throw new CommentRemovalMismatch(alias);
    if (entry['kind'] !== kind)
      throw new CommandFailure(
        'REFERENCE',
        'Use the current edit for the requested task or its specific comment.',
      );
    return { target: String(entry['target']), basis: { ...record(entry['editBasis']) } };
  }
  private currentEdit_abyssPrivate(alias: string, current: unknown): Record<string, unknown> {
    const entry = this.edits_abyssPrivate.get(alias);
    const rows =
      record(current)?.[entry?.['kind'] === 'comment' ? 'commentReferences' : 'taskReferences'];
    if (
      entry === undefined ||
      !Array.isArray(rows) ||
      !rows.some(
        (row: unknown) =>
          JSON.stringify(this.editBinding_abyssPrivate(record(row))) === JSON.stringify(entry),
      )
    )
      throw new CommandFailure(
        'REFERENCE',
        'Use this target’s current issued edit reference; stale, discovery-only and cross-owner references cannot edit.',
      );
    return entry;
  }
  /** Exact current task owner and immutable preparation basis; comparison only. */
  taskBasis(
    target: string,
    current: unknown,
    request?: Record<string, unknown>,
  ): string | undefined {
    const rows = record(current)?.['taskReferences'];
    if (!Array.isArray(rows)) return undefined;
    const row = record(rows.find((value: unknown) => record(value)?.['target'] === target));
    if (request !== undefined) {
      const expected =
        'revision' in request ? { revision: row?.['revision'] } : record(row?.['editBasis']);
      if (Object.entries(expected ?? {}).some(([key, value]) => request[key] !== value))
        return undefined;
    }
    return JSON.stringify(this.editBinding_abyssPrivate(row));
  }
  schemaRefinement(value: unknown, current: unknown): string | undefined {
    const input = record(value),
      operation = record(input?.['operation']);
    if (
      typeof input?.['edit'] !== 'string' ||
      !identifiesMetadata(operation) ||
      Object.entries(input).some(([key, value]) =>
        key === 'complete'
          ? typeof value !== 'boolean'
          : !['edit', 'operation', 'removeAnnotations'].includes(key),
      )
    )
      return undefined;
    try {
      return this.taskBasis(this.edit(input['edit'], 'patch', current).target, current);
    } catch {
      // Invalid capabilities retain ordinary rejected-operation accounting.
      return undefined;
    }
  }
  private editBinding_abyssPrivate(
    input: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (input === undefined || record(input['editBasis']) === undefined) return undefined;
    return {
      kind: input['kind'],
      target: input['target'],
      ownerTarget: input['ownerTarget'],
      editBasis: input['editBasis'],
    };
  }
  project(value: unknown, parent = ''): unknown {
    if (Array.isArray(value)) return value.map((item: unknown) => this.project(item, parent));
    const input = record(value);
    if (input === undefined) return value;
    const binding = this.editBinding_abyssPrivate(input);
    const edit =
      binding === undefined ? undefined : this.issue_abyssPrivate('b', JSON.stringify(binding));
    if (edit !== undefined && binding !== undefined) this.edits_abyssPrivate.set(edit, binding);
    const projected = Object.fromEntries(
      Object.entries(input).map(([key, item]) => {
        if (key === 'source') {
          const source = projectTaskSource(input, item);
          if (source !== undefined) return [key, source];
        }
        if (key === 'input' && (input['kind'] === 'task' || input['kind'] === 'note')) {
          const shape = commandReferenceInputs[input['kind']];
          if (shape !== undefined)
            return [
              key,
              record(
                mapReferenceShape({ input: item }, shape, (kind, ref) =>
                  this.issue_abyssPrivate(kind, ref),
                ),
              )?.['input'],
            ];
        }
        const kind = outputReferenceKind(key, input, parent);
        return [
          key,
          typeof item === 'string' && kind !== undefined
            ? this.issue_abyssPrivate(kind, item)
            : this.project(item, key),
        ];
      }),
    );
    return edit === undefined ? projected : { ...projected, edit };
  }
  input(name: string, value: unknown): unknown {
    const shape = commandReferenceInputs[name];
    return shape === undefined
      ? value
      : mapReferenceShape(value, shape, (kind, ref) => this.resolve_abyssPrivate(kind, ref));
  }
}
