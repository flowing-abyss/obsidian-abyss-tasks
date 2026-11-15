import type { CommandReferenceBook } from './CommandReferenceBook';
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
  /** Accepted change sequence when the original discovery began. */
  after: number;
}
const ALL_TASK_STATUSES = ['open', 'in-progress', 'done', 'cancelled'] as const;
function retainedFilter(field: string, prior: unknown, next: unknown): boolean {
  if (field === 'statuses' && Array.isArray(prior) && next === undefined)
    return (
      prior.length === ALL_TASK_STATUSES.length &&
      ALL_TASK_STATUSES.every((status) => prior.includes(status))
    );
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
  private readonly discoveries_abyssPrivate = new Map<string, CommandDiscovery>();
  private readonly latest = new Map<string, CommandDiscovery>();
  private readonly unresolvedLookups_abyssPrivate = new Map<string, UnresolvedLookup>();
  private readonly taskChanges = new Map<
    string,
    Map<TaskEffect, { revision: string; prepared: boolean }>
  >();
  private readonly retryResults = new Set<string>();
  private readonly changeLookups = new Map<string, string>();
  private readonly displayCorrections_abyssPrivate = new Map<string, Set<string>>();
  private readonly savedDescendants = new Map<string, Set<string>>();
  private readonly parentCorrections = new Set<string>();
  private acceptedTaskChangeSequence_abyssPrivate = 0;
  private readonly factSequence_abyssPrivate = new WeakMap<CommandFact, number>();
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
    if (
      fact.action === 'change' &&
      fact.entity === 'task' &&
      fact.target !== undefined &&
      fact.revision !== undefined
    ) {
      this.factSequence_abyssPrivate.set(fact, ++this.acceptedTaskChangeSequence_abyssPrivate);
    }
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
    if (this.taskChanges.size === 0 && this.unresolvedLookups_abyssPrivate.size === 0) return;
    if (this.taskChanges.get(target)?.has('remove') === true) return;
    throw new CommandFailure(
      'REMOVE_SCOPE',
      'This task is outside the requested removal. Nothing was staged. Use the verified removal target, or locate each additional removal explicitly requested by the user.',
    );
  }
  private retryableDiscovery(previous: string): CommandDiscovery {
    const old = this.discoveries_abyssPrivate.get(previous);
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
      current = this.discoveries_abyssPrivate.get(next);
    const key = JSON.stringify([purpose, this.queryKey_abyssPrivate(old)]);
    if (
      current === undefined ||
      this.unresolvedLookups_abyssPrivate.get(key)?.discovery !== old ||
      old.query === current.query ||
      JSON.stringify(old.scope) !== JSON.stringify(current.scope)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Retry the empty lookup with alternate wording, the same purpose and the same filters.',
      );
    this.unresolvedLookups_abyssPrivate.delete(key);
    this.retryResults.add(next);
  }
  private correctionRoots(previous: string, next: string, page: readonly TaskVersion[]): string[] {
    const old = this.discoveries_abyssPrivate.get(previous),
      current = this.discoveries_abyssPrivate.get(next);
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
      this.displayCorrections_abyssPrivate.set(key, new Set([key]));
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
    for (const branch of this.displayCorrections_abyssPrivate.values()) {
      if (branch.has(key)) addBranch(tree, branch);
    }
  }
  private correctedRoots(displayed: readonly TaskVersion[]): Set<string> {
    const roots = new Set<string>();
    for (const task of displayed) {
      const version = versionKey(task);
      const matches = [...this.displayCorrections_abyssPrivate].filter(([, branch]) =>
        branch.has(version),
      );
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
    const fact = this.discoveries_abyssPrivate.get(evidence);
    if (fact?.entity !== 'task') throw new CommandFailure('REFERENCE', 'Repeat the task lookup.');
    const key = JSON.stringify([effect, this.queryKey_abyssPrivate(fact)]);
    if (effect === 'change')
      for (const key of page.map(versionKey)) {
        this.displayCorrections_abyssPrivate.delete(key);
        this.parentCorrections.delete(key);
        this.changeLookups.set(key, evidence);
      }
    if (task === undefined) this.recordUnresolvedLookup_abyssPrivate(key, fact, effect, page);
    else this.recordResolvedLookup_abyssPrivate(key, fact, effect, task);
    return fact;
  }
  private recordUnresolvedLookup_abyssPrivate(
    key: string,
    fact: CommandDiscovery,
    effect: TaskEffect,
    page: readonly TaskVersion[],
  ): void {
    const previous = this.unresolvedLookups_abyssPrivate.get(key);
    const candidates = previous?.candidates ?? new Set<string>();
    for (const candidate of page) candidates.add(versionKey(candidate));
    this.unresolvedLookups_abyssPrivate.set(key, {
      discovery: fact,
      effect,
      candidates,
      after: previous?.after ?? this.acceptedTaskChangeSequence_abyssPrivate,
    });
  }
  private recordResolvedLookup_abyssPrivate(
    key: string,
    fact: CommandDiscovery,
    effect: TaskEffect,
    task: TaskVersion,
  ): void {
    const retained = this.resolveNarrowed_abyssPrivate(fact, effect, task);
    this.unresolvedLookups_abyssPrivate.delete(key);
    const required =
      this.taskChanges.get(task.target) ??
      new Map<TaskEffect, { revision: string; prepared: boolean }>();
    required.set(effect, { revision: task.revision, prepared: retained });
    this.taskChanges.set(task.target, required);
  }
  private resolveNarrowed_abyssPrivate(
    fact: CommandDiscovery,
    effect: TaskEffect,
    task: TaskVersion,
  ): boolean {
    let retained = false;
    for (const [key, other] of this.unresolvedLookups_abyssPrivate) {
      if (
        other.effect === effect &&
        narrows(other.discovery, fact) &&
        other.candidates.has(versionKey(task))
      ) {
        if (
          effect === 'change' &&
          fact.complete &&
          fact.unsupported !== true &&
          this.hasRetainedAcceptedChange_abyssPrivate(other, task)
        )
          retained = true;
        this.unresolvedLookups_abyssPrivate.delete(key);
      }
    }
    return retained;
  }
  private hasRetainedAcceptedChange_abyssPrivate(
    lookup: UnresolvedLookup,
    task?: TaskVersion,
  ): boolean {
    if (
      task === undefined &&
      (lookup.effect !== 'change' ||
        !lookup.discovery.complete ||
        lookup.discovery.unsupported === true ||
        lookup.discovery.count < 2)
    )
      return false;
    return this.facts.some((fact) => {
      const sequence = this.factSequence_abyssPrivate.get(fact);
      return (
        sequence !== undefined &&
        sequence > lookup.after &&
        fact.action === 'change' &&
        fact.entity === 'task' &&
        fact.removal !== true &&
        fact.target !== undefined &&
        fact.revision !== undefined &&
        (task === undefined
          ? lookup.candidates.has(versionKey({ target: fact.target, revision: fact.revision }))
          : fact.target === task.target && fact.revision === task.revision)
      );
    });
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
    const unresolved = [...this.unresolvedLookups_abyssPrivate.values()].filter(
      (lookup) =>
        lookup.effect !== 'change' ||
        !lookup.discovery.complete ||
        ![...corrected].some(
          (key) =>
            lookup.candidates.has(key) &&
            this.discoveries_abyssPrivate.get(this.changeLookups.get(key) ?? '') ===
              lookup.discovery,
        ),
    );
    if (unresolved.length > 0) {
      const retained = unresolved.find((lookup) =>
        this.hasRetainedAcceptedChange_abyssPrivate(lookup),
      );
      if (retained !== undefined) {
        const scope = { ...retained.discovery.scope };
        Reflect.deleteProperty(scope, 'limit');
        const scopeHint =
          Object.keys(scope).length > 0 ? ` with filters ${JSON.stringify(scope)}` : '';
        const otherLookupsHint =
          unresolved.length > 1 ? ' Resolve any other outstanding lookup before finishing.' : '';
        throw new CommandFailure(
          'PENDING_TASK_CHANGE',
          `Preview kept. ${JSON.stringify(retained.discovery.query)}${scopeHint} is ambiguous: repeat with user's discriminator; finish without repeating it, or ask with evidence.${otherLookupsHint}`,
        );
      }
      throw new CommandFailure(
        'PENDING_TASK_CHANGE',
        'No unique task was verified for the requested change. Narrow the lookup or ask with its discovery evidence.',
      );
    }
  }
  requiresTaskContentPreparation(): boolean {
    return (
      this.facts.some((fact) => fact.action === 'research' && fact.entity === 'web') &&
      !this.facts.some(
        (fact) =>
          ['create', 'change'].includes(fact.action) &&
          fact.entity === 'task' &&
          fact.removal !== true,
      )
    );
  }
  checkTaskChanges(
    displayed: readonly TaskVersion[] = [],
    references?: Partial<Pick<CommandReferenceBook, 'issuedFindEvidence' | 'issuedTaskEdit'>>,
    current?: unknown,
  ): void {
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
      throw this.pendingChangeFailure(
        versionKey({ target, revision: change.revision }),
        references,
        current,
      );
    }
  }
  private pendingChangeFailure(
    root: string,
    references?: Partial<Pick<CommandReferenceBook, 'issuedFindEvidence' | 'issuedTaskEdit'>>,
    current?: unknown,
  ): CommandFailure {
    const id = this.changeLookups.get(root);
    const lookup = id === undefined ? undefined : this.discoveries_abyssPrivate.get(id);
    const retryOf = id === undefined ? undefined : references?.issuedFindEvidence?.([id])[0];
    const correction = this.parentCorrection(root, lookup, retryOf);
    if (correction !== undefined) return new CommandFailure('PENDING_TASK_CHANGE', correction);
    return new CommandFailure(
      'PENDING_TASK_CHANGE',
      this.pendingTaskChangeMessage(root, references, current),
    );
  }
  private parentCorrection(
    root: string,
    lookup: CommandDiscovery | undefined,
    retryOf: string | undefined,
  ): string | undefined {
    if (
      retryOf === undefined ||
      lookup?.complete !== true ||
      lookup.count !== 1 ||
      this.latest.get(this.queryKey_abyssPrivate(lookup)) !== lookup ||
      !this.preparedDescendant(root)
    )
      return undefined;
    const scope = { ...lookup.scope };
    Reflect.deleteProperty(scope, 'limit');
    const find = { query: lookup.query, ...scope, purpose: 'locate-child', retryOf };
    return `If parent only locates prepared child: find(${JSON.stringify(find)}), then finish; do not repeat child edit. Edit parent only if requested.`;
  }
  private pendingTaskChangeMessage(
    root: string,
    references?: Partial<Pick<CommandReferenceBook, 'issuedTaskEdit'>>,
    current?: unknown,
  ): string {
    const [target] = JSON.parse(root) as [string, string];
    const edit = references?.issuedTaskEdit?.(target, current);
    return edit === undefined
      ? 'Prepare change_task first; refresh stale edit references.'
      : `Pending: change_task(edit:"${edit}",operation:requested). Finish cannot prepare content.`;
  }
  discovery(fact: CommandDiscovery): string {
    const evidence = `discovery:${this.discoveries_abyssPrivate.size + 1}`;
    this.discoveries_abyssPrivate.set(evidence, fact);
    this.latest.set(this.queryKey_abyssPrivate(fact), fact);
    return evidence;
  }
  /** Candidates for the generation's find schema. Execution still checks purpose, filters and targets. */
  retryableFindEvidence(): string[] {
    const changes = new Set(this.changeLookups.values());
    const pending = new Set(
      [...this.unresolvedLookups_abyssPrivate.values()].map((lookup) => lookup.discovery),
    );
    return [...this.discoveries_abyssPrivate]
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
    const fact = this.discoveries_abyssPrivate.get(evidence);
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
