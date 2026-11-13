import { record } from './commandReferenceShapes';
import { flatPatchKeys, isTaskOperationType } from './commandSchemas';
import { CommandFailure } from './commandTypes';
const mutations = new Set(['task', 'note', 'project', 'status', 'link', 'cleanup']);
const refinements = new Set(['edit', 'append', 'batch', 'refresh', 'hierarchy']);
function comparisonOperation(value: unknown): Record<string, unknown> | undefined {
  const operation = record(value);
  if (operation?.['type'] !== 'set') return operation;
  return {
    type: 'patch',
    patch: Object.fromEntries(flatPatchKeys(operation).map((key) => [key, true])),
  };
}
function payload(
  name: string,
  value: unknown,
): { name: string; input: Record<string, unknown> } | undefined {
  let toolName = name;
  let input = record(value);
  input = record(input?.['input']) ?? input;
  if (name === 'create_task' && input !== undefined) {
    toolName = 'task';
    input = {
      ...input,
      kind: 'create',
      destination: input['destination'] ?? { type: 'configured-default' },
    };
  }
  if (name === 'change_task' && input !== undefined) {
    toolName = 'task';
    const shape = comparisonOperation(input['operation']);
    input = { kind: 'append', operation: { ...shape, target: input['edit'] } };
  }
  return input === undefined || !mutations.has(toolName) ? undefined : { name: toolName, input };
}
function operand(
  input: Record<string, unknown>,
  key: string,
  identity: (value: string) => string,
): string {
  const value = input[key];
  return typeof value === 'string' ? identity(value) : '';
}
function taskOperation(
  input: Record<string, unknown>,
  identity: (value: string) => string,
): readonly string[] {
  const operation = record(input['operation']) ?? input;
  const type = operation['type'] ?? input['kind'];
  if (!isTaskOperationType(type)) return [];
  const operationTarget = operand(operation, 'target', identity);
  const rootTarget = input['kind'] === 'edit' ? operand(input, 'target', identity) : '';
  const target = operationTarget !== '' ? operationTarget : rootTarget;
  if (type === 'add-comment')
    return [
      JSON.stringify([
        'operation',
        'add-comment',
        target,
        operation['text'],
        operation['text'] !== undefined,
      ]),
    ];
  const base = [
    'operation',
    type,
    target,
    ...['source', 'parent', 'relativeTo'].map((key) => operand(operation, key, identity)),
    type === 'add-child' ? operation['markdownTitle'] : null,
    null,
  ];
  const fields = Object.keys(record(operation['patch']) ?? {});
  return (fields.length === 0 ? [''] : fields).map((field) => JSON.stringify([...base, field]));
}
function missingCommentFallback(key: string): string | undefined {
  if (!key.startsWith('task:[')) return undefined;
  const tuple: unknown = JSON.parse(key.slice(5));
  if (
    !Array.isArray(tuple) ||
    tuple[0] !== 'operation' ||
    tuple[1] !== 'add-comment' ||
    typeof tuple[3] !== 'string' ||
    tuple[4] !== true
  )
    return undefined;
  tuple[3] = null;
  tuple[4] = false;
  return `task:${JSON.stringify(tuple)}`;
}
function taskCreationKeys(
  input: Record<string, unknown>,
  identity: (value: string) => string,
): readonly string[] {
  const title = record(input['tree'])?.['markdownTitle'];
  // No entity was identified or prepared. Keep its ordinary schema-error obligation.
  if (typeof title !== 'string' || title === '') return [];
  const destination = record(input['destination']);
  const insertion = record(destination?.['insertion']);
  const location =
    destination === undefined
      ? null
      : [
          destination['type'],
          operand(destination, 'target', identity),
          destination['path'],
          insertion === undefined
            ? null
            : [insertion['type'], insertion['heading'], insertion['position']],
        ];
  return [JSON.stringify(['create', title, location])];
}
function taskKeys(
  input: Record<string, unknown>,
  identity: (value: string) => string,
): readonly string[] {
  const kind = input['kind'];
  if (kind === 'create') return taskCreationKeys(input, identity);
  if (kind === 'refresh') return [JSON.stringify(['refresh', operand(input, 'plan', identity)])];
  if (kind === 'edit' && input['operation'] === undefined) {
    const target = operand(input, 'target', identity);
    return target === '' ? [] : [JSON.stringify(['edit-basis', target])];
  }
  if (typeof kind !== 'string' || !refinements.has(kind)) return [];
  if (kind === 'batch' && Array.isArray(input['operations'])) {
    const assignments = new Set<string>();
    return input['operations'].slice(0, 20).flatMap((value: unknown) => {
      const operation = record(value) ?? {};
      const keys = taskOperation(operation, identity);
      if (['add-child', 'add-comment'].includes(String(operation['type']))) return keys;
      return keys.filter((key) => {
        if (assignments.has(key)) return false;
        assignments.add(key);
        return true;
      });
    });
  }
  return taskOperation(input, identity);
}
function subjectKey(input: Record<string, unknown>, identity: (value: string) => string): string {
  if (input['kind'] === 'create') {
    const name = input['name'];
    const destination = record(input['destination']);
    return JSON.stringify([
      'create',
      input['title'] ?? (typeof name === 'string' ? name.trim() : name),
      input['path'] ??
        (destination === undefined
          ? null
          : [destination['type'], destination['fileName'], destination['fromPath']]),
    ]);
  }
  const operation = record(input['operation']) ?? {};
  return JSON.stringify([
    input['kind'],
    ...[
      'target',
      'plan',
      'proposal',
      'taskTarget',
      'destinationPlan',
      'notePlan',
      'path',
      'field',
      'comment',
    ].map((key) => operand(input, key, identity)),
    operation['type'],
    operand(operation, 'section', identity),
    operation['type'] === 'append' ? operation['text'] : null,
  ]);
}
function unidentifiedProject(
  name: string,
  input: Record<string, unknown>,
  identity: (value: string) => string,
): boolean {
  return (
    name === 'project' &&
    input['kind'] !== 'create' &&
    operand(input, 'target', identity) === '' &&
    operand(input, 'proposal', identity) === ''
  );
}
function declaredProjectFields(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length > 65536) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Identity evidence only. Undecodable arguments retain the normal schema error.
    return [];
  }
}
function projectFields(
  input: Record<string, unknown>,
  identity: (value: string) => string,
): string[] {
  const fields = declaredProjectFields(input['fields'])
    .slice(0, 50)
    .map((field: unknown) => operand(record(field) ?? {}, 'fieldId', identity))
    .filter((field) => field !== '');
  if (input['statusId'] !== undefined) fields.push('status');
  if (input['name'] !== undefined) fields.push('name');
  return fields;
}
function subjectKeys(
  name: string,
  input: Record<string, unknown>,
  identity: (value: string) => string,
): readonly string[] {
  const normalized =
    name === 'project' && input['kind'] === undefined ? { ...input, kind: 'update' } : input;
  if (unidentifiedProject(name, normalized, identity)) return [];
  const base = subjectKey(normalized, identity);
  if (name !== 'project' || !['update', 'refine-create'].includes(String(normalized['kind'])))
    return [base];
  const fields = projectFields(input, identity);
  if (fields.length === 0 && input['fields'] !== undefined) return [];
  return [...new Set(fields.length === 0 ? [''] : fields)].map((field) =>
    JSON.stringify([base, field]),
  );
}
/** A successful operation on B cannot erase an unresolved failure on A. Transient, read-only evidence. */
export class CommandPendingOperations {
  private readonly failed_abyssPrivate = new Map<string, { count: number; refinement: boolean }>();
  private readonly retries_abyssPrivate = new Map<string, string>();
  private retrySequence_abyssPrivate = 0;
  private readonly schemaRefinements_abyssPrivate = new Map<string, number>();
  rejectSchema(basis: string, generation: number): void {
    this.schemaRefinements_abyssPrivate.set(basis, generation);
  }
  resolveSchema(basis: string | undefined, generation: number): void {
    if (
      basis !== undefined &&
      (this.schemaRefinements_abyssPrivate.get(basis) ?? generation) < generation
    )
      this.schemaRefinements_abyssPrivate.delete(basis);
  }
  constructor(
    private readonly identity_abyssPrivate: (value: string) => string,
    private readonly turn_abyssPrivate = '',
  ) {}
  private creationDestination_abyssPrivate(value: unknown): string {
    const input = record(record(value)?.['input']) ?? {};
    return JSON.stringify([input['intent'], input['destination']]);
  }
  checkRetry(token: string | undefined, value: unknown): void {
    if (
      token !== undefined &&
      this.retries_abyssPrivate.get(token) !== this.creationDestination_abyssPrivate(value)
    )
      throw new CommandFailure(
        'RETRY',
        'Use an unconsumed current create retryOf with the same intent and exact destination.',
      );
    if (token !== undefined) this.blockRetry(token);
  }
  rejectCreate(value: unknown, token?: string): string {
    const retry = token ?? `create:${this.turn_abyssPrivate}:${++this.retrySequence_abyssPrivate}`;
    this.retries_abyssPrivate.set(retry, this.creationDestination_abyssPrivate(value));
    return retry;
  }
  blockRetry(token: string): void {
    this.retries_abyssPrivate.set(token, '');
  }
  resolveCreate(token: string | undefined): void {
    if (token !== undefined) this.retries_abyssPrivate.delete(token);
  }
  private keys_abyssPrivate(
    name: string,
    value: unknown,
  ): ReadonlyArray<{ key: string; refinement: boolean }> {
    const parsed = payload(name, value);
    if (parsed === undefined) return [];
    const subjects =
      parsed.name === 'task'
        ? taskKeys(parsed.input, this.identity_abyssPrivate)
        : subjectKeys(parsed.name, parsed.input, this.identity_abyssPrivate);
    return subjects.map((subject) => ({
      key: `${parsed.name}:${subject}`,
      refinement: parsed.name === 'task' && parsed.input['kind'] !== 'create',
    }));
  }
  private resolutionKey_abyssPrivate(key: string, unknownDestination: string | undefined): string {
    if (this.failed_abyssPrivate.has(key)) return key;
    const fallback = missingCommentFallback(key);
    return fallback !== undefined && this.failed_abyssPrivate.has(fallback)
      ? fallback
      : (unknownDestination ?? key);
  }
  reject(name: string, value: unknown): void {
    const counts = new Map<string, number>();
    for (const entry of this.keys_abyssPrivate(name, value)) {
      const count = (counts.get(entry.key) ?? 0) + 1;
      counts.set(entry.key, count);
      this.failed_abyssPrivate.set(entry.key, {
        count: Math.max(this.failed_abyssPrivate.get(entry.key)?.count ?? 0, count),
        refinement: entry.refinement,
      });
    }
  }
  resolve(name: string, value: unknown): void {
    const parsed = payload(name, value);
    const unknownDestination =
      parsed?.name === 'task' && parsed.input['kind'] === 'create'
        ? this.keys_abyssPrivate(name, { ...parsed.input, destination: undefined })[0]?.key
        : undefined;
    for (const entry of this.keys_abyssPrivate(name, value)) {
      const key = this.resolutionKey_abyssPrivate(entry.key, unknownDestination);
      const current = this.failed_abyssPrivate.get(key);
      if (current === undefined) continue;
      if (current.count <= 1) this.failed_abyssPrivate.delete(key);
      else this.failed_abyssPrivate.set(key, { ...current, count: current.count - 1 });
    }
  }
  get unresolved(): boolean {
    return (
      this.failed_abyssPrivate.size > 0 ||
      this.retries_abyssPrivate.size > 0 ||
      this.schemaRefinements_abyssPrivate.size > 0
    );
  }
  get taskRefinement(): boolean {
    return (
      this.schemaRefinements_abyssPrivate.size > 0 ||
      [...this.failed_abyssPrivate.values()].some((entry) => entry.refinement)
    );
  }
}
