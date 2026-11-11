import { asSchema, type FlexibleSchema, type Schema } from 'ai';
import { record } from './commandReferenceShapes';

type Definition = Awaited<Schema['jsonSchema']>;
type Node = Definition | boolean;
interface Budget {
  root: Definition;
  nodes: number;
  changed: boolean;
  exhausted: boolean;
}
function allowed(budget: Budget, depth: number): boolean {
  if (++budget.nodes <= 2048 && depth <= 16) return true;
  budget.exhausted = true;
  return false;
}
function alternatives(nodes: readonly Node[], budget: Budget, depth: number): Definition[] {
  return nodes.flatMap((node) => {
    if (!allowed(budget, depth)) return [{}];
    if (typeof node === 'boolean') return node ? [{}] : [];
    if (node.allOf !== undefined) return [{}];
    if (node.$ref !== undefined) {
      const resolved = localReference(node.$ref, budget.root);
      return resolved === undefined ? [{}] : alternatives([resolved], budget, depth + 1);
    }
    const branches = node.oneOf ?? node.anyOf;
    return branches === undefined ? [node] : alternatives(branches, budget, depth + 1);
  });
}
function localReference(reference: string, root: Definition): Node | undefined {
  if (!reference.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const part of reference.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    const object = record(node);
    if (object === undefined || !Object.prototype.hasOwnProperty.call(object, key))
      return undefined;
    node = object[key];
  }
  return typeof node === 'boolean' ? node : record(node);
}
function containersOnly(nodes: readonly Definition[]): boolean {
  return nodes.length > 0 && nodes.every((node) => node.type === 'object' || node.type === 'array');
}
function decode(value: unknown, nodes: readonly Definition[], budget: Budget): unknown {
  if (typeof value !== 'string' || !containersOnly(nodes)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') return value;
    if (!nodes.some((node) => node.type === (Array.isArray(parsed) ? 'array' : 'object')))
      return value;
    budget.changed = true;
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) return value;
    throw error;
  }
}
function repair(value: unknown, schemas: readonly Node[], budget: Budget, depth = 0): unknown {
  if (!allowed(budget, depth)) return value;
  const nodes = alternatives(schemas, budget, depth);
  const current = decode(value, nodes, budget);
  if (Array.isArray(current)) {
    const items = nodes.flatMap((node) =>
      node.items === undefined || Array.isArray(node.items) ? [true] : [node.items],
    );
    return current.map((item: unknown) => repair(item, items, budget, depth + 1));
  }
  const object = record(current);
  if (object === undefined) return current;
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => {
      const fields = nodes.flatMap((node) => {
        const field = node.properties?.[key];
        if (field !== undefined) return [field];
        return node.additionalProperties === false ? [] : [true];
      });
      return [key, fields.length === 0 ? item : repair(item, fields, budget, depth + 1)];
    }),
  );
}

function explicitBranch(node: Definition, object: Record<string, unknown>): boolean {
  const constants = Object.entries(node.properties ?? {}).flatMap(([key, field]) => {
    if (
      typeof field === 'boolean' ||
      field.const === undefined ||
      !Object.prototype.hasOwnProperty.call(object, key)
    )
      return [];
    return [[key, field.const] as const];
  });
  return (
    constants.length > 0 &&
    constants.every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(object, key) &&
        JSON.stringify(object[key]) === JSON.stringify(value),
    )
  );
}

function soleInput(value: unknown, schema: Definition, budget: Budget): unknown {
  const object = record(value);
  if (
    object === undefined ||
    Object.keys(object).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(object, 'input')
  )
    return value;
  const nodes = alternatives([schema], budget, 0);
  if (
    nodes.length === 0 ||
    !nodes.every(
      (node) =>
        node.type === 'object' &&
        node.additionalProperties === false &&
        node.properties?.['input'] === undefined &&
        node.patternProperties === undefined,
    )
  )
    return value;
  const inner = decode(object['input'], nodes, budget);
  const payload = record(inner);
  if (payload === undefined) return value;
  // Only explicit literal operands identify a branch; never infer an omitted default.
  if (nodes.length > 1 && nodes.filter((node) => explicitBranch(node, payload)).length !== 1)
    return value;
  budget.changed = true;
  return repair(inner, [schema], budget);
}

/** Repair lossless container encoding only; canonical validation still authorizes execution. */
export async function repairEncodedContainers(
  input: string,
  schema: FlexibleSchema<unknown>,
): Promise<string | undefined> {
  if (input.length > 131072) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const canonical = asSchema(schema);
  if (canonical.validate === undefined) return undefined;
  if ((await canonical.validate(parsed)).success) return undefined;
  const schemaDefinition = await canonical.jsonSchema;
  const budget: Budget = { root: schemaDefinition, nodes: 0, changed: false, exhausted: false };
  const unwrapped = soleInput(parsed, schemaDefinition, budget);
  const candidate = unwrapped === parsed ? repair(parsed, [schemaDefinition], budget) : unwrapped;
  if (!budget.changed || budget.exhausted) return undefined;
  const validated = await canonical.validate(candidate);
  return validated.success ? JSON.stringify(candidate) : undefined;
}
