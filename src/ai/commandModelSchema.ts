import {
  asSchema,
  jsonSchema,
  type FlexibleSchema,
  type LanguageModelMiddleware,
  type Schema,
} from 'ai';
import { z } from 'zod';
import type { CommandReferenceBook } from './CommandReferenceBook';
type JsonSchema = Awaited<Schema['jsonSchema']>;
type Definition = JsonSchema | boolean;
type ModelTools = Parameters<
  NonNullable<LanguageModelMiddleware['wrapGenerate']>
>[0]['params']['tools'];

/** Decorate this generation's original SDK tools. The executable schema stays on the command adapter. */
export function commandEditTools(
  tools: ModelTools,
  book: CommandReferenceBook | undefined,
  current: () => unknown,
  options?: { workingRoot: string | undefined; retryEvidence: readonly string[] },
): ModelTools {
  if (tools === undefined || book === undefined) return tools;
  const projected = projectFindRetries(tools, book, options?.retryEvidence ?? []);
  return projectEdits(projected, book, current, options?.workingRoot);
}
function projectFindRetries(
  tools: NonNullable<ModelTools>,
  book: CommandReferenceBook,
  eligible: readonly string[],
): NonNullable<ModelTools> {
  const find = tools.find((tool) => tool.type === 'function' && tool.name === 'find');
  if (find?.type !== 'function') return tools;
  const schema = find.inputSchema;
  const field = object(schema.properties?.['retryOf']);
  if (
    field?.type !== 'string' ||
    schema.required?.includes('retryOf') === true ||
    ['enum', 'const', '$ref'].some((key) => key in field)
  )
    return tools;
  const aliases = book.issuedFindEvidence(eligible);
  const properties = { ...schema.properties };
  if (aliases.length === 0) delete properties['retryOf'];
  else properties['retryOf'] = { ...field, enum: aliases };
  return tools.map((tool) =>
    tool === find ? { ...find, inputSchema: { ...schema, properties } } : tool,
  );
}
function projectEdits(
  tools: NonNullable<ModelTools>,
  book: CommandReferenceBook,
  current: () => unknown,
  workingRoot?: string,
): ModelTools {
  const change = tools.find((tool) => tool.type === 'function' && tool.name === 'change_task');
  if (change?.type !== 'function') return tools;
  const schema = change.inputSchema;
  const field = schema.properties?.['edit'];
  if (
    typeof field !== 'object' ||
    field.type !== 'string' ||
    ['enum', 'const', '$ref'].some((key) => key in field)
  )
    return tools;
  const catalog = current();
  const choices = book.issuedEditChoices(catalog);
  if (choices.length === 0) return tools;
  const labels = choices.map(({ edit, label }) => `${edit} (${label})`).join(', ');
  const editField = {
    ...field,
    enum: choices.map((choice) => choice.edit),
    description: [field.description, `Copy the edit handle for the requested row. ${labels}.`]
      .filter(Boolean)
      .join(' '),
  };
  const parentEdit = book.issuedTaskEdit(workingRoot, catalog);
  return tools.map((tool) => {
    if (tool === change)
      return {
        ...tool,
        inputSchema: { ...schema, properties: { ...schema.properties, edit: editField } },
      };
    if (tool.type === 'function' && tool.name === 'create_task' && parentEdit !== undefined)
      return {
        ...tool,
        description: `For a subtask of the working task use change_task with edit "${parentEdit}" and operation {"type":"add-child","markdownTitle":"…"}; replace … with the requested child title. ${tool.description ?? ''}`,
      };
    return tool;
  });
}

function object(value: Definition | undefined): JsonSchema | undefined {
  return typeof value === 'object' ? value : undefined;
}
function literals(value: Definition | undefined): JsonSchema['enum'] {
  const schema = object(value);
  return schema?.enum ?? (schema?.const === undefined ? undefined : [schema.const]);
}
/** Prove exclusivity; overlapping unions must retain anyOf semantics. */
function forbidsKey(schema: JsonSchema, key: string): boolean {
  return (
    schema.additionalProperties === false &&
    schema.patternProperties === undefined &&
    schema.properties?.[key] === undefined
  );
}
function exclusive(subject: JsonSchema, other: JsonSchema): boolean {
  return (subject.required ?? []).some((key) => {
    if (forbidsKey(other, key)) return true;
    if (other.required?.includes(key) !== true) return false;
    const a = literals(subject.properties?.[key]),
      b = literals(other.properties?.[key]);
    return a !== undefined && b !== undefined && !a.some((value) => b.includes(value));
  });
}
function objectAlternatives(schema: JsonSchema): JsonSchema[] | undefined {
  const values = schema.anyOf ?? schema.oneOf;
  if (values === undefined || values.length < 2) return undefined;
  const branches = values.map(object);
  return branches.every((branch): branch is JsonSchema => branch?.type === 'object')
    ? branches
    : undefined;
}
const schemaMaps = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
  'dependencies',
]);
const schemaArrays = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const schemaSingles = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
type Visit = (schema: JsonSchema, path: readonly string[]) => JsonSchema;
/** Only applicators contain schemas; annotations and map keys remain literal data. */
function children(schema: JsonSchema, path: readonly string[], visit: Visit): JsonSchema {
  const result = { ...schema };
  const node = (value: unknown, at: readonly string[]): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? visit(value, at) : value;
  const entries: Array<[string, unknown]> = Object.entries(schema);
  for (const [key, value] of entries) {
    const at = [...path, key];
    if (schemaMaps.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value))
      Reflect.set(
        result,
        key,
        Object.fromEntries(
          Object.entries(value).map(([name, entry]: [string, unknown]) => [
            name,
            node(entry, [...at, name]),
          ]),
        ),
      );
    else if ((schemaArrays.has(key) || key === 'items') && Array.isArray(value))
      Reflect.set(
        result,
        key,
        value.map((entry: unknown, index) => node(entry, [...at, String(index)])),
      );
    else if (schemaSingles.has(key)) Reflect.set(result, key, node(value, at));
  }
  return result;
}
function project(
  schema: JsonSchema,
  path: readonly string[],
  referenced: readonly string[][],
  keepUnions: boolean,
): JsonSchema {
  const result = children(schema, path, (child, at) => project(child, at, referenced, keepUnions));
  if (typeof result.const === 'string' && result.enum === undefined) result.enum = [result.const];
  const branches = objectAlternatives(result);
  if (branches !== undefined) {
    result.type = 'object';
    if (
      !keepUnions &&
      result.anyOf !== undefined &&
      result.oneOf === undefined &&
      !referenced.some((target) =>
        [...path, 'anyOf'].every((token, index) => target[index] === token),
      ) &&
      branches.every((left, index) =>
        branches
          .slice(index + 1)
          .every((right) => exclusive(left, right) || exclusive(right, left)),
      )
    ) {
      result.oneOf = branches;
      Reflect.deleteProperty(result, 'anyOf');
    }
  }
  return result;
}
function schemaReferences(schema: JsonSchema): string[] {
  const refs: unknown[] = [schema.$ref, Reflect.get(schema, '$dynamicRef')];
  return refs.filter((ref): ref is string => typeof ref === 'string');
}
function projection(schema: JsonSchema): JsonSchema {
  const referenced: string[][] = [];
  let keepUnions = false;
  const scan: Visit = (value, path) => {
    // Custom schemas may establish other URI resources. Without URI resolution,
    // retain their union locations instead of moving potential reference targets.
    if (path.length > 0 && value.$id !== undefined) keepUnions = true;
    for (const ref of schemaReferences(value)) {
      if (!ref.startsWith('#')) {
        keepUnions = true;
        continue;
      }
      try {
        const fragment = decodeURIComponent(ref.slice(1));
        if (!fragment.startsWith('/')) continue;
        referenced.push(
          fragment
            .slice(1)
            .split('/')
            .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~')),
        );
      } catch {
        keepUnions = true;
      }
    }
    return children(value, path, scan);
  };
  scan(schema, []);
  return project(schema, [], referenced, keepUnions);
}
function combine(left: Definition, right: Definition): JsonSchema {
  if (JSON.stringify(left) === JSON.stringify(right)) return object(left) ?? { anyOf: [left] };
  const a = literals(left),
    b = literals(right);
  if (a === undefined || b === undefined) {
    const options = [...(object(left)?.anyOf ?? [left]), ...(object(right)?.anyOf ?? [right])];
    return {
      anyOf: [...new Map(options.map((option) => [JSON.stringify(option), option])).values()],
    };
  }
  const values = [...new Set([...a, ...b])];
  return {
    ...(values.every((value) => typeof value === 'string') ? { type: 'string' as const } : {}),
    enum: values,
  };
}
function presentationField(field: Definition): Definition {
  const visit: Visit = (node, path) => {
    const result = children(node, path, visit);
    delete result.description;
    return result;
  };
  return typeof field === 'boolean' ? field : visit(field, []);
}
/** Mirrors only closed owned unions; original branches still constrain them. */
function visibleUnion(schema: JsonSchema): JsonSchema {
  const branches = objectAlternatives(schema);
  if (
    branches === undefined ||
    branches.some(
      (branch) =>
        branch.additionalProperties !== false ||
        branch.patternProperties !== undefined ||
        branch.$ref !== undefined,
    )
  )
    return schema;
  const properties: Record<string, Definition> = {};
  for (const branch of branches)
    for (const [key, field] of Object.entries(branch.properties ?? {})) {
      const previous = properties[key];
      const shown = presentationField(field);
      properties[key] = previous === undefined ? shown : combine(previous, shown);
    }
  return {
    ...schema,
    properties,
    required: (branches[0]?.required ?? []).filter((key) =>
      branches.every((branch) => branch.required?.includes(key) === true),
    ),
  };
}
function creationDefinition(schema: JsonSchema, reference: string): JsonSchema | undefined {
  const definition = object(schema.$defs?.[reference.slice(8)]);
  if (
    definition?.type !== 'object' ||
    definition.additionalProperties !== false ||
    definition.properties?.['markdownTitle'] === undefined ||
    definition.properties['initial'] === undefined
  )
    return undefined;
  return definition;
}
function visibleTree(schema: JsonSchema): JsonSchema {
  const tree = object(schema.properties?.['tree']);
  if (tree?.$ref === undefined || !/^#\/\$defs\/__schema\d+$/.test(tree.$ref)) return schema;
  const definition = creationDefinition(schema, tree.$ref);
  if (definition === undefined) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      tree: {
        ...tree,
        type: definition.type,
        properties: Object.fromEntries(
          Object.entries(definition.properties ?? {}).map(([key, field]) => [
            key,
            presentationField(field),
          ]),
        ),
        required: definition.required,
      },
    },
  };
}
function presentationSafe(schema: JsonSchema): boolean {
  let safe = true;
  const scan: Visit = (node, path) => {
    if (
      ['$id', '$anchor', '$dynamicAnchor'].some((key) => Reflect.has(node, key)) ||
      schemaReferences(node).some((ref) => !ref.startsWith('#/'))
    )
      safe = false;
    return children(node, path, scan);
  };
  scan(schema, []);
  return safe;
}
function visibleTool(schema: JsonSchema, name: string): JsonSchema {
  if (!presentationSafe(schema)) return schema;
  if (['finish', 'interpret', 'project'].includes(name)) return visibleUnion(schema);
  if (name === 'create_task') return visibleTree(schema);
  const input = object(schema.properties?.['input']);
  return ['task', 'note', 'read'].includes(name) && input !== undefined
    ? { ...schema, properties: { ...schema.properties, input: visibleUnion(input) } }
    : schema;
}
/** Change only provider presentation; canonical validation/defaults own executable arguments. */
export function modelToolSchema<T>(input: FlexibleSchema<T>, name?: string): Schema<T> {
  const canonical = asSchema(input);
  return jsonSchema(
    // Command tools are Zod-owned. Custom SDK schemas retain their own dialect;
    // only native Zod conversion establishes the modern recursive representation.
    async () => {
      const owned = input instanceof z.ZodType;
      const projected = projection(
        owned
          ? (z.toJSONSchema(input, { target: 'draft-2020-12', io: 'input' }) as JsonSchema)
          : await canonical.jsonSchema,
      );
      return owned && name !== undefined ? visibleTool(projected, name) : projected;
    },
    canonical.validate === undefined ? {} : { validate: canonical.validate },
  );
}
