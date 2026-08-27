import type { TaskIndexEvent, TaskQueryApi } from '../../tasks/application/TaskApplicationApi';
import type { TaskRef, TaskSnapshot } from '../../tasks/domain/types';

export type DependencyDiagnostic =
  | { readonly type: 'missing-prerequisite'; readonly id: string }
  | { readonly type: 'duplicate-id'; readonly id: string; readonly candidates: readonly TaskRef[] }
  | { readonly type: 'self-edge'; readonly id: string }
  | { readonly type: 'cycle'; readonly ids: readonly string[] };
export type DependencyProjection =
  | { readonly type: 'ready'; readonly ref: TaskRef }
  | { readonly type: 'blocked'; readonly ref: TaskRef; readonly prerequisites: readonly TaskRef[] }
  | {
      readonly type: 'invalid';
      readonly ref: TaskRef;
      readonly diagnostics: readonly DependencyDiagnostic[];
    };
interface Node {
  readonly key: string;
  task: TaskSnapshot;
  id?: string;
  dependencies: readonly string[];
}
type Listener = (affected: readonly TaskRef[]) => void;
const refKey = (ref: TaskRef): string => `${ref.filePath}\u0000${ref.line}\u0000${ref.revision}`;
const compareRefs = (a: TaskRef, b: TaskRef): number =>
  a.filePath.localeCompare(b.filePath) || a.line - b.line || a.revision.localeCompare(b.revision);
const copyRef = (ref: TaskRef): TaskRef => ({ ...ref });
function projectionKey(p: DependencyProjection): string {
  if (p.type === 'ready') return 'ready';
  if (p.type === 'blocked') return `blocked:${p.prerequisites.map(refKey).join(',')}`;
  return JSON.stringify(p.diagnostics);
}
function copyProjection(p: DependencyProjection): DependencyProjection {
  if (p.type === 'ready') return { type: 'ready', ref: copyRef(p.ref) };
  if (p.type === 'blocked')
    return { type: 'blocked', ref: copyRef(p.ref), prerequisites: p.prerequisites.map(copyRef) };
  return {
    type: 'invalid',
    ref: copyRef(p.ref),
    diagnostics: p.diagnostics.map((d) =>
      d.type === 'duplicate-id' ? { ...d, candidates: d.candidates.map(copyRef) } : { ...d },
    ),
  };
}

/** Read-only, incrementally maintained graph over TaskIndex snapshots. */
export class DependencyIndex {
  private readonly nodes = new Map<string, Node>();
  private readonly fileNodes = new Map<string, Set<string>>();
  private readonly candidates = new Map<string, Set<string>>();
  private readonly consumers = new Map<string, Set<string>>();
  private readonly forward = new Map<string, Set<string>>();
  private readonly reverse = new Map<string, Set<string>>();
  private readonly cycles = new Map<string, readonly string[]>();
  private readonly projections = new Map<string, DependencyProjection>();
  private readonly refs = new Map<string, string>();
  private listeners: Listener[] = [];
  private unsubscribe: (() => void) | undefined;
  private nextKey = 0;
  constructor(source?: Pick<TaskQueryApi, 'list' | 'subscribe'>) {
    if (source) {
      this.replace(source.list());
      this.unsubscribe = source.subscribe((e) => this.onEvent(source, e));
    }
  }
  get(ref: TaskRef): DependencyProjection | undefined {
    const p = this.projections.get(this.refs.get(refKey(ref)) ?? '');
    return p && copyProjection(p);
  }
  list(): readonly DependencyProjection[] {
    return [...this.projections.values()]
      .sort((a, b) => compareRefs(a.ref, b.ref))
      .map(copyProjection);
  }
  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== listener);
    };
  }
  destroy(): void {
    this.unsubscribe?.();
    this.listeners = [];
    for (const state of [
      this.nodes,
      this.fileNodes,
      this.candidates,
      this.consumers,
      this.forward,
      this.reverse,
      this.cycles,
      this.projections,
      this.refs,
    ])
      state.clear();
  }
  replace(tasks: readonly TaskSnapshot[]): void {
    const byFile = new Map<string, TaskSnapshot[]>();
    for (const task of tasks) {
      const file = byFile.get(task.source.filePath) ?? [];
      file.push(task);
      byFile.set(task.source.filePath, file);
    }
    const paths = new Set([...this.fileNodes.keys(), ...byFile.keys()]);
    this.updateFiles([...paths].map((path) => [path, byFile.get(path) ?? []] as const));
  }
  updateFile(path: string, tasks: readonly TaskSnapshot[]): void {
    this.updateFiles([[path, tasks]]);
  }
  private onEvent(source: Pick<TaskQueryApi, 'list'>, e: TaskIndexEvent): void {
    if (e.type === 'initialized') return this.replace(source.list());
    if (e.type === 'changed')
      return this.updateFiles(
        e.files.map((path) => [path, source.list({ filePath: path })] as const),
      );
    if (e.type === 'deleted') return this.updateFile(e.path, []);
    if (e.type === 'renamed')
      this.updateFiles([
        [e.oldPath, []],
        [e.newPath, source.list({ filePath: e.newPath })],
      ]);
  }

  private updateFiles(entries: readonly (readonly [string, readonly TaskSnapshot[]])[]): void {
    const old = entries.flatMap(([path]) =>
      [...(this.fileNodes.get(path) ?? [])].map((key) => this.nodes.get(key)!),
    );
    const previous = new Map(
      old.flatMap((node) => {
        const projection = this.projections.get(node.key);
        return projection === undefined ? [] : [[node.key, projection] as const];
      }),
    );
    const before = this.connected(old.map((node) => node.key));
    const changedIds = new Set<string>();
    for (const node of old) {
      if (node.id) changedIds.add(node.id);
      node.dependencies.forEach((id) => changedIds.add(id));
      this.remove(node);
    }
    const available = [...old];
    const transitions = new Map<string, TaskRef>();
    const inputChanged = new Set<string>();
    const added: Node[] = [];
    for (const [path, tasks] of entries)
      for (const task of tasks) {
        const match = this.match(task, available);
        const node = match ?? { key: `node:${this.nextKey++}`, task, dependencies: [] };
        if (match) {
          available.splice(available.indexOf(match), 1);
          if (
            match.task.status !== task.status ||
            match.task.title !== task.title ||
            match.id !== task.dependency?.id ||
            match.dependencies.join(',') !== (task.dependency?.dependsOn ?? []).join(',')
          ) {
            inputChanged.add(node.key);
          }
          if (refKey(match.task.ref) !== refKey(task.ref))
            transitions.set(node.key, copyRef(match.task.ref));
        }
        node.task = task;
        node.id = task.dependency?.id;
        node.dependencies = task.dependency?.dependsOn ?? [];
        this.add(path, node);
        added.push(node);
        if (node.id) changedIds.add(node.id);
        node.dependencies.forEach((id) => changedIds.add(id));
      }
    const seeds = new Set<string>([...before, ...added.map((node) => node.key)]);
    for (const id of changedIds)
      for (const key of [...(this.candidates.get(id) ?? []), ...(this.consumers.get(id) ?? [])])
        seeds.add(key);
    for (const key of seeds) this.rewire(key);
    const region = this.connected(seeds);
    for (const key of region) this.rewire(key);
    this.recompute(
      this.connected(region),
      transitions,
      available.map((node) => node.task.ref),
      previous,
      inputChanged,
    );
  }
  private match(task: TaskSnapshot, available: readonly Node[]): Node | undefined {
    const id = task.dependency?.id;
    const ids = id === undefined ? [] : available.filter((node) => node.id === id);
    if (ids.length === 1) return ids[0];
    const sources = available.filter(
      (node) => node.task.source.originalBlock === task.source.originalBlock,
    );
    if (sources.length === 1) return sources[0];
    const lines = available.filter(
      (node) =>
        node.task.source.filePath === task.source.filePath &&
        node.task.source.line === task.source.line,
    );
    return lines.length === 1 ? lines[0] : undefined;
  }
  private add(path: string, node: Node): void {
    this.nodes.set(node.key, node);
    (this.fileNodes.get(path) ?? this.fileNodes.set(path, new Set()).get(path)!).add(node.key);
    if (node.id)
      (this.candidates.get(node.id) ?? this.candidates.set(node.id, new Set()).get(node.id)!).add(
        node.key,
      );
    for (const id of node.dependencies)
      (this.consumers.get(id) ?? this.consumers.set(id, new Set()).get(id)!).add(node.key);
    this.forward.set(node.key, new Set());
    this.reverse.set(node.key, new Set());
  }
  private remove(node: Node): void {
    this.detach(node.key);
    this.nodes.delete(node.key);
    this.refs.delete(refKey(node.task.ref));
    this.projections.delete(node.key);
    this.cycles.delete(node.key);
    const file = this.fileNodes.get(node.task.source.filePath);
    file?.delete(node.key);
    if (file?.size === 0) this.fileNodes.delete(node.task.source.filePath);
    if (node.id) {
      const set = this.candidates.get(node.id);
      set?.delete(node.key);
      if (set?.size === 0) this.candidates.delete(node.id);
    }
    for (const id of node.dependencies) {
      const set = this.consumers.get(id);
      set?.delete(node.key);
      if (set?.size === 0) this.consumers.delete(id);
    }
  }
  private detach(key: string): void {
    for (const to of this.forward.get(key) ?? []) this.reverse.get(to)?.delete(key);
    for (const from of this.reverse.get(key) ?? []) this.forward.get(from)?.delete(key);
    this.forward.delete(key);
    this.reverse.delete(key);
  }
  private rewire(key: string): void {
    const node = this.nodes.get(key);
    if (!node) return;
    for (const to of this.forward.get(key) ?? []) this.reverse.get(to)?.delete(key);
    const edges = new Set<string>();
    for (const id of node.dependencies) {
      if (id === node.id) continue;
      const candidates = this.candidates.get(id);
      if (candidates?.size === 1) edges.add([...candidates][0]!);
    }
    this.forward.set(key, edges);
    for (const to of edges)
      (this.reverse.get(to) ?? this.reverse.set(to, new Set()).get(to)!).add(key);
  }
  private connected(seeds: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const queue = [...seeds].filter((key) => this.nodes.has(key));
    queue.forEach((key) => out.add(key));
    for (let i = 0; i < queue.length; i++)
      for (const next of [
        ...(this.forward.get(queue[i]!) ?? []),
        ...(this.reverse.get(queue[i]!) ?? []),
      ])
        if (!out.has(next)) {
          out.add(next);
          queue.push(next);
        }
    return out;
  }
  private recompute(
    region: ReadonlySet<string>,
    transitions: ReadonlyMap<string, TaskRef>,
    deleted: readonly TaskRef[],
    previous: ReadonlyMap<string, DependencyProjection>,
    inputChanged: ReadonlySet<string>,
  ): void {
    const prior = new Map([...region].map((key) => [key, this.projections.get(key)] as const));
    for (const [key, projection] of previous) prior.set(key, projection);
    for (const key of region) this.cycles.delete(key);
    this.tarjan(region);
    const affected = new Map<string, TaskRef>();
    for (const key of region) {
      const node = this.nodes.get(key);
      if (!node) continue;
      const next = this.project(node);
      const old = prior.get(key);
      this.projections.set(key, next);
      this.refs.set(refKey(node.task.ref), key);
      const from = transitions.get(key);
      if (from) {
        affected.set(refKey(from), from);
        affected.set(refKey(node.task.ref), copyRef(node.task.ref));
      }
      if (!old || inputChanged.has(key) || projectionKey(old) !== projectionKey(next))
        affected.set(refKey(node.task.ref), copyRef(node.task.ref));
    }
    for (const ref of deleted) affected.set(refKey(ref), copyRef(ref));
    const refs = [...affected.values()].sort(compareRefs);
    if (refs.length) for (const listener of this.listeners) listener(refs);
  }
  private tarjan(region: ReadonlySet<string>): void {
    let n = 0;
    const at = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const on = new Set<string>();
    const visit = (key: string): void => {
      at.set(key, n);
      low.set(key, n++);
      stack.push(key);
      on.add(key);
      for (const to of this.forward.get(key) ?? []) {
        if (!region.has(to)) continue;
        if (!at.has(to)) {
          visit(to);
          low.set(key, Math.min(low.get(key)!, low.get(to)!));
        } else if (on.has(to)) low.set(key, Math.min(low.get(key)!, at.get(to)!));
      }
      if (low.get(key) !== at.get(key)) return;
      const members: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member) {
          on.delete(member);
          members.push(member);
        }
      } while (member !== key);
      if (members.length > 1) {
        const ids = members
          .map((x) => this.nodes.get(x)?.id)
          .filter((id): id is string => id !== undefined)
          .sort((a, b) => a.localeCompare(b));
        for (const x of members) this.cycles.set(x, ids);
      }
    };
    for (const key of region) if (!at.has(key)) visit(key);
  }
  private project(node: Node): DependencyProjection {
    const diagnostics: DependencyDiagnostic[] = [];
    if (node.id && (this.candidates.get(node.id)?.size ?? 0) > 1)
      diagnostics.push({
        type: 'duplicate-id',
        id: node.id,
        candidates: this.refsFor(this.candidates.get(node.id)!),
      });
    for (const id of node.dependencies) {
      if (id === node.id) {
        diagnostics.push({ type: 'self-edge', id });
        continue;
      }
      const candidates = this.candidates.get(id);
      if (!candidates?.size) diagnostics.push({ type: 'missing-prerequisite', id });
      else if (candidates.size > 1)
        diagnostics.push({ type: 'duplicate-id', id, candidates: this.refsFor(candidates) });
    }
    const cycle = this.cycles.get(node.key);
    if (cycle) diagnostics.push({ type: 'cycle', ids: cycle });
    diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const ref = copyRef(node.task.ref);
    if (diagnostics.length) return { type: 'invalid', ref, diagnostics };
    const blocked = [...(this.forward.get(node.key) ?? [])]
      .map((key) => this.nodes.get(key)!)
      .filter((x) => x.task.status !== 'done')
      .map((x) => copyRef(x.task.ref))
      .sort(compareRefs);
    return blocked.length
      ? { type: 'blocked', ref, prerequisites: blocked }
      : { type: 'ready', ref };
  }
  private refsFor(keys: Iterable<string>): readonly TaskRef[] {
    return [...keys].map((key) => copyRef(this.nodes.get(key)!.task.ref)).sort(compareRefs);
  }
}
