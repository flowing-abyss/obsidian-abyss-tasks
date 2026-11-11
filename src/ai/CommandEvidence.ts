import { CommandFailure } from './commandTypes';
export interface CommandFact {
  action: 'create' | 'change' | 'find' | 'focus' | 'inspect' | 'research';
  entity: 'task' | 'note' | 'project' | 'web' | 'catalog';
  target?: string;
  revision?: string;
  removal?: boolean;
  complete?: boolean;
}
export interface CommandDiscovery {
  entity: CommandFact['entity'];
  query: string;
  scope: Record<string, unknown>;
  complete: boolean;
  count: number;
  unsupported?: boolean;
}
type TaskEffect = 'change' | 'remove';
type TaskVersion = { target: string; revision: string };
interface TaskBranch extends TaskVersion {
  readonly children: readonly TaskBranch[];
}
interface UnresolvedLookup {
  discovery: CommandDiscovery;
  effect: TaskEffect;
  candidates: Set<string>;
}
function retainedFilter(field: string, prior: unknown, next: unknown): boolean {
  if (!['tagsAll', 'dates'].includes(field) || !Array.isArray(prior) || !Array.isArray(next))
    return JSON.stringify(prior) === JSON.stringify(next);
  const values = new Set(next.map((value: unknown) => JSON.stringify(value)));
  return prior.every((value: unknown) => values.has(JSON.stringify(value)));
}
function versionKey(task: TaskVersion): string {
  return JSON.stringify([task.target, task.revision]);
}
function addBranch(node: TaskBranch, versions: Set<string>): void {
  versions.add(versionKey(node));
  for (const child of node.children) addBranch(child, versions);
}
function narrows(original: CommandDiscovery, next: CommandDiscovery): boolean {
  return (
    original.query === next.query &&
    Object.entries(original.scope).every(([field, value]) =>
      retainedFilter(field, value, next.scope[field]),
    )
  );
}
/** Accepted operation facts, never a model-authored interpretation of user obligations. */
export class CommandEvidence {
  private readonly facts: CommandFact[] = [];
  private readonly removed = new Set<string>();
  private readonly discoveries = new Map<string, CommandDiscovery>();
  private readonly latest = new Map<string, CommandDiscovery>();
  private readonly unresolvedLookups = new Map<string, UnresolvedLookup>();
  private readonly taskChanges = new Map<
    string,
    Map<TaskEffect, { revision: string; prepared: boolean }>
  >();
  private readonly retryResults = new Set<string>();
  private readonly changeLookups = new Map<string, string>();
  private readonly displayCorrections = new Map<string, Set<string>>();
  private readonly savedDescendants = new Map<string, Set<string>>();
  private readonly parentCorrections = new Set<string>();
  private selected = false;
  clearFocus(empty = true): void {
    this.selected = empty;
    this.discard_abyssPrivate((fact) => fact.action === 'focus');
  }
  remove(target: string): void {
    this.removed.add(target);
    this.discard_abyssPrivate((fact) => fact.target === target);
  }
  private discard_abyssPrivate(matches: (fact: CommandFact) => boolean): void {
    for (let index = this.facts.length - 1; index >= 0; index--) {
      const fact = this.facts[index];
      if (fact !== undefined && matches(fact)) this.facts.splice(index, 1);
    }
  }
  accept(fact: CommandFact): void {
    if (fact.target !== undefined && this.removed.has(fact.target) && fact.removal !== true) return;
    if (fact.action === 'change' && fact.target !== undefined) this.changed(fact, fact.target);
    this.facts.push(fact);
  }
  private changed(fact: CommandFact, target: string): void {
    if (fact.removal === true) this.remove(target);
    else this.discard_abyssPrivate((old) => old.entity === fact.entity && old.target === target);
    if (fact.entity === 'task' && fact.revision !== undefined)
      this.settleTaskEffect(
        { target, revision: fact.revision },
        fact.removal === true ? 'remove' : 'change',
      );
  }
  requestedRemoval(task: TaskVersion): boolean {
    return this.taskChanges.get(task.target)?.get('remove')?.revision === task.revision;
  }
  settleTaskEffect(task: TaskVersion, effect: TaskEffect): void {
    const required = this.taskChanges.get(task.target)?.get(effect);
    if (required?.revision === task.revision) required.prepared = true;
  }
  allowRemoval(target: string): void {
    if (this.taskChanges.size === 0 && this.unresolvedLookups.size === 0) return;
    if (this.taskChanges.get(target)?.has('remove') === true) return;
    throw new CommandFailure(
      'REMOVE_SCOPE',
      'This task is outside the requested removal. Nothing was staged. Use the verified removal target, or locate each additional removal explicitly requested by the user.',
    );
  }
  private retryableDiscovery(previous: string): CommandDiscovery {
    const old = this.discoveries.get(previous);
    if (
      old === undefined ||
      !old.complete ||
      old.count !== 0 ||
      this.latest.get(this.queryKey_abyssPrivate(old)) !== old ||
      this.retryResults.has(previous)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Use the issued evidence from the first empty search for this task.',
      );
    return old;
  }
  retryTaskLookup(previous: string, next: string, purpose: unknown): void {
    const old = this.retryableDiscovery(previous),
      current = this.discoveries.get(next);
    const key = JSON.stringify([purpose, this.queryKey_abyssPrivate(old)]);
    if (
      current === undefined ||
      this.unresolvedLookups.get(key)?.discovery !== old ||
      old.query === current.query ||
      JSON.stringify(old.scope) !== JSON.stringify(current.scope)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Retry the empty lookup with alternate wording, the same purpose and the same filters.',
      );
    this.unresolvedLookups.delete(key);
    this.retryResults.add(next);
  }
  private correctionRoots(previous: string, next: string, page: readonly TaskVersion[]): string[] {
    const old = this.discoveries.get(previous),
      current = this.discoveries.get(next);
    const matching = page.map(versionKey).filter((key) => this.changeLookups.get(key) === previous);
    if (
      old === undefined ||
      current === undefined ||
      matching.length === 0 ||
      !old.complete ||
      !current.complete ||
      this.queryKey_abyssPrivate(old) !== this.queryKey_abyssPrivate(current)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Reclassifying a change lookup needs the same completed lookup, its evidence and identical query and filters.',
      );
    return matching;
  }
  correctDisplayLookup(previous: string, next: string, page: readonly TaskVersion[]): void {
    for (const key of this.correctionRoots(previous, next, page))
      this.displayCorrections.set(key, new Set([key]));
  }
  correctParentLookup(previous: string, next: string, page: readonly TaskVersion[]): void {
    const [root, ...other] = this.correctionRoots(previous, next, page);
    const task = page.find((candidate) => versionKey(candidate) === root);
    if (
      page.length !== 1 ||
      root === undefined ||
      other.length > 0 ||
      task === undefined ||
      this.taskChanges.get(task.target)?.get('change')?.revision !== task.revision ||
      !this.savedDescendants.has(root)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Use the same verified parent to locate its requested child.',
      );
    this.parentCorrections.add(root);
  }
  observeSavedBranch(tree: TaskBranch): void {
    const key = versionKey(tree);
    if (this.changeLookups.has(key) && tree.children.length > 0) {
      const descendants = new Set<string>();
      for (const child of tree.children) addBranch(child, descendants);
      this.savedDescendants.set(key, descendants);
    }
    for (const branch of this.displayCorrections.values()) {
      if (branch.has(key)) addBranch(tree, branch);
    }
  }
  private correctedRoots(displayed: readonly TaskVersion[]): Set<string> {
    const roots = new Set<string>();
    for (const task of displayed) {
      const version = versionKey(task);
      const matches = [...this.displayCorrections].filter(([, branch]) => branch.has(version));
      if (matches.length === 0) return new Set();
      for (const [root] of matches) roots.add(root);
    }
    return roots;
  }
  expectTaskChange(
    evidence: string,
    effect: TaskEffect,
    task: TaskVersion | undefined,
    page: readonly TaskVersion[],
  ): CommandDiscovery {
    const fact = this.discoveries.get(evidence);
    if (fact?.entity !== 'task') throw new CommandFailure('REFERENCE', 'Repeat the task lookup.');
    const key = JSON.stringify([effect, this.queryKey_abyssPrivate(fact)]);
    if (effect === 'change')
      for (const key of page.map(versionKey)) {
        this.displayCorrections.delete(key);
        this.parentCorrections.delete(key);
        this.changeLookups.set(key, evidence);
      }
    if (task === undefined) {
      const candidates = this.unresolvedLookups.get(key)?.candidates ?? new Set<string>();
      for (const candidate of page) candidates.add(versionKey(candidate));
      this.unresolvedLookups.set(key, { discovery: fact, effect, candidates });
    } else {
      this.unresolvedLookups.delete(key);
      this.resolveNarrowed(fact, effect, task);
      const required =
        this.taskChanges.get(task.target) ??
        new Map<TaskEffect, { revision: string; prepared: boolean }>();
      required.set(effect, { revision: task.revision, prepared: false });
      this.taskChanges.set(task.target, required);
    }
    return fact;
  }
  private resolveNarrowed(fact: CommandDiscovery, effect: TaskEffect, task: TaskVersion): void {
    for (const [key, other] of this.unresolvedLookups) {
      if (
        other.effect === effect &&
        narrows(other.discovery, fact) &&
        other.candidates.has(versionKey(task))
      )
        this.unresolvedLookups.delete(key);
    }
  }
  private preparedDescendant(root: string): boolean {
    const branch = this.savedDescendants.get(root);
    return this.facts.some(
      (fact) =>
        fact.action === 'change' &&
        fact.entity === 'task' &&
        fact.removal !== true &&
        fact.target !== undefined &&
        fact.revision !== undefined &&
        branch?.has(versionKey({ target: fact.target, revision: fact.revision })) === true,
    );
  }
  private checkUnresolvedLookups(corrected: Set<string>): void {
    if (
      [...this.unresolvedLookups.values()].some(
        (lookup) =>
          lookup.effect !== 'change' ||
          !lookup.discovery.complete ||
          ![...corrected].some(
            (key) =>
              lookup.candidates.has(key) &&
              this.discoveries.get(this.changeLookups.get(key) ?? '') === lookup.discovery,
          ),
      )
    )
      throw new CommandFailure(
        'PENDING_TASK_CHANGE',
        'No unique task was verified for the requested change. Narrow the lookup or ask with its discovery evidence.',
      );
  }
  checkTaskChanges(displayed: readonly TaskVersion[] = []): void {
    const corrected = this.correctedRoots(displayed);
    this.checkUnresolvedLookups(corrected);
    for (const root of this.parentCorrections) {
      if (this.preparedDescendant(root)) corrected.add(root);
    }
    for (const [target, required] of this.taskChanges) {
      const removal = required.get('remove');
      if (removal !== undefined && !removal.prepared)
        throw new CommandFailure(
          'PENDING_TASK_CHANGE',
          'The requested removal has no preview. Use change_task with the matched task’s edit and operation:{"type":"remove"}.',
        );
      const change = required.get('change');
      if (
        change === undefined ||
        change.prepared ||
        corrected.has(versionKey({ target, revision: change.revision }))
      )
        continue;
      throw new CommandFailure(
        'PENDING_TASK_CHANGE',
        'The requested edit has no preview on that lookup target. If the target only locates the requested child, repeat the same find with purpose:"locate-child" and retryOf set to its evidence. Keep any accepted child edits. If the user only asked for display, repeat with purpose:"show-only" and retryOf, then finish with exact selection.',
      );
    }
  }
  discovery(fact: CommandDiscovery): string {
    const evidence = `discovery:${this.discoveries.size + 1}`;
    this.discoveries.set(evidence, fact);
    this.latest.set(this.queryKey_abyssPrivate(fact), fact);
    return evidence;
  }
  /** Candidates for the generation's find schema. Execution still checks purpose, filters and targets. */
  retryableFindEvidence(): string[] {
    const changes = new Set(this.changeLookups.values());
    const pending = new Set([...this.unresolvedLookups.values()].map((lookup) => lookup.discovery));
    return [...this.discoveries]
      .filter(
        ([id, fact]) =>
          fact.complete &&
          (changes.has(id) ||
            (fact.count === 0 &&
              pending.has(fact) &&
              !this.retryResults.has(id) &&
              this.latest.get(this.queryKey_abyssPrivate(fact)) === fact)),
      )
      .map(([id]) => id);
  }
  question(kind: string, evidence: string): CommandDiscovery {
    const fact = this.discoveries.get(evidence);
    if (fact !== undefined && this.latest.get(this.queryKey_abyssPrivate(fact)) === fact) {
      if (this.supports_abyssPrivate(kind, fact)) return fact;
      if (fact.entity === 'task' && fact.complete && fact.count === 1)
        throw new CommandFailure(
          'UNGROUNDED_QUESTION',
          'The task search is complete with one match. Use its edit handle for the requested change, or inspect its target.',
        );
    }
    throw new CommandFailure(
      'UNGROUNDED_QUESTION',
      'Use the issued evidence for this specific accepted query and its completeness.',
    );
  }
  private queryKey_abyssPrivate(fact: CommandDiscovery): string {
    return JSON.stringify([fact.entity, fact.query, fact.scope]);
  }
  private supports_abyssPrivate(kind: string, fact: CommandDiscovery): boolean {
    if (kind === 'unsupported') return fact.unsupported === true;
    if (kind === 'incomplete') return !fact.complete;
    if (!fact.complete || fact.entity === 'catalog') return false;
    return kind === 'not-found' ? fact.count === 0 : kind === 'ambiguous' && fact.count > 1;
  }
  ready(coverage?: 'page'): 'prepared' | 'selected' | 'observed' | 'found' {
    if (this.facts.some((fact) => ['create', 'change'].includes(fact.action))) return 'prepared';
    if (this.selected || this.facts.some((fact) => fact.action === 'focus')) return 'selected';
    if (
      this.facts.some(
        (fact) =>
          ['inspect', 'research'].includes(fact.action) &&
          fact.entity !== 'catalog' &&
          (fact.complete !== false || coverage === 'page'),
      )
    )
      return 'observed';
    const searches = [...this.latest.values()].filter((fact) => fact.entity !== 'catalog');
    if (searches.length > 0 && (coverage === 'page' || searches.every((fact) => fact.complete)))
      return 'found';
    throw new CommandFailure(
      'UNGROUNDED_FINISH',
      'No current accepted result is ready. Prepare, inspect or select the requested content, or complete discovery; partial pages require coverage:page.',
    );
  }
}
