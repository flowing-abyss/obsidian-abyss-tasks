import {
  commandReferenceInputs,
  mapReferenceShape,
  outputReferenceKind,
  record,
  type CommandReferenceKind,
} from './commandReferenceShapes';
import { CommandFailure } from './commandTypes';

/** Turn-local SDK projection only. Neither aliases nor this book enter application state. */
export class CommandReferenceBook {
  private readonly aliases = new Map<string, { kind: CommandReferenceKind; value: string }>();
  private readonly values = new Map<string, string>();
  private sequence = 0;
  constructor(private readonly turn: string) {}
  private issue(kind: CommandReferenceKind, value: string): string {
    const key = `${kind}\0${value}`;
    const existing = this.values.get(key);
    if (existing !== undefined) return existing;
    if (this.aliases.size >= 4096)
      throw new CommandFailure(
        'REFERENCE_LIMIT',
        'This turn has too many references. Read a smaller scope.',
      );
    const alias = `@${this.turn}:${kind}${++this.sequence}`;
    this.aliases.set(alias, { kind, value });
    this.values.set(key, alias);
    return alias;
  }
  private resolve(kind: CommandReferenceKind, value: string): string {
    if (!value.startsWith('@')) return value;
    const reference = this.aliases.get(value);
    if (reference?.kind !== kind)
      throw new CommandFailure('REFERENCE', 'Use an exact current reference of the required kind.');
    return reference.value;
  }
  project(value: unknown, parent = ''): unknown {
    if (Array.isArray(value)) return value.map((item: unknown) => this.project(item, parent));
    const input = record(value);
    if (input === undefined) return value;
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => {
        if (key === 'input' && (input['kind'] === 'task' || input['kind'] === 'note')) {
          const shape = commandReferenceInputs[input['kind']];
          if (shape !== undefined)
            return [
              key,
              record(
                mapReferenceShape({ input: item }, shape, (kind, ref) => this.issue(kind, ref)),
              )?.['input'],
            ];
        }
        const kind = outputReferenceKind(key, input, parent);
        return [
          key,
          typeof item === 'string' && kind !== undefined
            ? this.issue(kind, item)
            : this.project(item, key),
        ];
      }),
    );
  }
  input(name: string, value: unknown): unknown {
    const shape = commandReferenceInputs[name];
    return shape === undefined
      ? value
      : mapReferenceShape(value, shape, (kind, ref) => this.resolve(kind, ref));
  }
}
