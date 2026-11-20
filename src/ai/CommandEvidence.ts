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
function narrows(lookup: UnresolvedLookup, next: CommandDiscovery, task: TaskVersion): boolean {
  const original = lookup.discovery;
  const sameCandidate = original.query === next.query && lookup.candidates.has(versionKey(task));
  // An incomplete page may never have included this physical row. Its exact path/line and
  // every original filter must survive a fresh, complete, more specific search.
  const coordinate =
    !original.complete &&
    typeof original.scope['sourceLine'] === 'number' &&
    next.complete &&
    next.query.toLowerCase().includes(original.query.toLowerCase());
  return (
    (sameCandidate || coordinate) &&
    Object.entries(original.scope).every(([field, value]) =>
      retainedFilter(field, value, next.scope[field]),
    )
  );
}
/** Accepted operation facts, never a model-authored interpretation of user obligations. */
export class CommandEvidence {
  private readonly facts_abyssPrivate: CommandFact[] = [];
  private readonly removed_abyssPrivate = new Set<string>();
  private readonly discoveries_abyssPrivate = new Map<string, CommandDiscovery>();
  private readonly latest_abyssPrivate = new Map<string, CommandDiscovery>();
  private readonly unresolvedLookups_abyssPrivate = new Map<string, UnresolvedLookup>();
  private readonly taskChanges_abyssPrivate = new Map<
    string,
    Map<TaskEffect, { revision: string; prepared: boolean }>
  >();
  private readonly retryResults_abyssPrivate = new Set<string>();
  private readonly changeLookups_abyssPrivate = new Map<string, string>();
  private readonly displayCorrections_abyssPrivate = new Map<string, Set<string>>();
  private readonly savedDescendants_abyssPrivate = new Map<string, Set<string>>();
  private readonly parentCorrections_abyssPrivate = new Set<string>();
  private acceptedTaskChangeSequence_abyssPrivate = 0;
  private readonly factSequence_abyssPrivate = new WeakMap<CommandFact, number>();
  private selected_abyssPrivate = false;
  clearFocus(empty = true): void {
    this.selected_abyssPrivate = empty;
    this.discard_abyssPrivate((fact) => fact.action === 'focus');
  }
  remove(target: string): void {
    this.removed_abyssPrivate.add(target);
    this.discard_abyssPrivate((fact) => fact.target === target);
  }
  private discard_abyssPrivate(matches: (fact: CommandFact) => boolean): void {
    for (let index = this.facts_abyssPrivate.length - 1; index >= 0; index--) {
      const fact = this.facts_abyssPrivate[index];
      if (fact !== undefined && matches(fact)) this.facts_abyssPrivate.splice(index, 1);
    }
  }
  accept(fact: CommandFact): void {
    if (
      fact.target !== undefined &&
      this.removed_abyssPrivate.has(fact.target) &&
      fact.removal !== true
    )
      return;
    if (fact.action === 'change' && fact.target !== undefined)
      this.changed_abyssPrivate(fact, fact.target);
    this.facts_abyssPrivate.push(fact);
    if (
      fact.action === 'change' &&
      fact.entity === 'task' &&
      fact.target !== undefined &&
      fact.revision !== undefined
    ) {
      this.factSequence_abyssPrivate.set(fact, ++this.acceptedTaskChangeSequence_abyssPrivate);
    }
  }
  private changed_abyssPrivate(fact: CommandFact, target: string): void {
    if (fact.removal === true) this.remove(target);
    else this.discard_abyssPrivate((old) => old.entity === fact.entity && old.target === target);
    if (fact.entity === 'task' && fact.revision !== undefined)
      this.settleTaskEffect(
        { target, revision: fact.revision },
        fact.removal === true ? 'remove' : 'change',
      );
  }
  requestedRemoval(task: TaskVersion): boolean {
    return (
      this.taskChanges_abyssPrivate.get(task.target)?.get('remove')?.revision === task.revision
    );
  }
  settleTaskEffect(task: TaskVersion, effect: TaskEffect): void {
    const required = this.taskChanges_abyssPrivate.get(task.target)?.get(effect);
    if (required?.revision === task.revision) required.prepared = true;
  }
  allowRemoval(target: string): void {
    if (this.taskChanges_abyssPrivate.size === 0 && this.unresolvedLookups_abyssPrivate.size === 0)
      return;
    if (this.taskChanges_abyssPrivate.get(target)?.has('remove') === true) return;
    throw new CommandFailure(
      'REMOVE_SCOPE',
      'This task is outside the requested removal. Nothing was staged. Use the verified removal target, or locate each additional removal explicitly requested by the user.',
    );
  }
  private retryableDiscovery_abyssPrivate(previous: string): CommandDiscovery {
    const old = this.discoveries_abyssPrivate.get(previous);
    if (
      old === undefined ||
      !old.complete ||
      old.count !== 0 ||
      this.latest_abyssPrivate.get(this.queryKey_abyssPrivate(old)) !== old ||
      this.retryResults_abyssPrivate.has(previous)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Use the issued evidence from the first empty search for this task.',
      );
    return old;
  }
  retryTaskLookup(previous: string, next: string, purpose: unknown): void {
    const old = this.retryableDiscovery_abyssPrivate(previous),
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
    this.retryResults_abyssPrivate.add(next);
  }
  private correctionRoots_abyssPrivate(
    previous: string,
    next: string,
    page: readonly TaskVersion[],
  ): string[] {
    const old = this.discoveries_abyssPrivate.get(previous),
      current = this.discoveries_abyssPrivate.get(next);
    const matching = page
      .map(versionKey)
      .filter((key) => this.changeLookups_abyssPrivate.get(key) === previous);
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
    for (const key of this.correctionRoots_abyssPrivate(previous, next, page))
      this.displayCorrections_abyssPrivate.set(key, new Set([key]));
  }
  correctParentLookup(previous: string, next: string, page: readonly TaskVersion[]): void {
    const [root, ...other] = this.correctionRoots_abyssPrivate(previous, next, page);
    const task = page.find((candidate) => versionKey(candidate) === root);
    if (
      page.length !== 1 ||
      root === undefined ||
      other.length > 0 ||
      task === undefined ||
      this.taskChanges_abyssPrivate.get(task.target)?.get('change')?.revision !== task.revision ||
      !this.savedDescendants_abyssPrivate.has(root)
    )
      throw new CommandFailure(
        'LOOKUP_RETRY',
        'Use the same verified parent to locate its requested child.',
      );
    this.parentCorrections_abyssPrivate.add(root);
  }
  observeSavedBranch(tree: TaskBranch): void {
    const key = versionKey(tree);
    if (this.changeLookups_abyssPrivate.has(key) && tree.children.length > 0) {
      const descendants = new Set<string>();
      for (const child of tree.children) addBranch(child, descendants);
      this.savedDescendants_abyssPrivate.set(key, descendants);
    }
    for (const branch of this.displayCorrections_abyssPrivate.values()) {
      if (branch.has(key)) addBranch(tree, branch);
    }
  }
  private correctedRoots_abyssPrivate(displayed: readonly TaskVersion[]): Set<string> {
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
        this.parentCorrections_abyssPrivate.delete(key);
        this.changeLookups_abyssPrivate.set(key, evidence);
      }
    if (task === undefined) this.recordUnresolvedLookup_abyssPrivate(key, fact, effect, page);
    else this.recordResolvedLookup_abyssPrivate(key, fact, effect, task);
    return fact;
  }
  missingTaskCoordinate(id?: string): boolean {
    const current = this.discoveries_abyssPrivate.get(id ?? '');
    return [...this.unresolvedLookups_abyssPrivate.values()].some(
      ({ discovery }) =>
        discovery.scope['sourceLine'] !== undefined &&
        (id === undefined ||
          (discovery === current && discovery.complete && discovery.count === 0)),
    );
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
      this.taskChanges_abyssPrivate.get(task.target) ??
      new Map<TaskEffect, { revision: string; prepared: boolean }>();
    required.set(effect, { revision: task.revision, prepared: retained });
    this.taskChanges_abyssPrivate.set(task.target, required);
  }
  private resolveNarrowed_abyssPrivate(
    fact: CommandDiscovery,
    effect: TaskEffect,
    task: TaskVersion,
  ): boolean {
    let retained = false;
    for (const [key, other] of this.unresolvedLookups_abyssPrivate) {
      if (other.effect === effect && narrows(other, fact, task)) {
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
    return this.facts_abyssPrivate.some((fact) => {
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
  private preparedDescendant_abyssPrivate(root: string): boolean {
    const branch = this.savedDescendants_abyssPrivate.get(root);
    return this.facts_abyssPrivate.some(
      (fact) =>
        fact.action === 'change' &&
        fact.entity === 'task' &&
        fact.removal !== true &&
        fact.target !== undefined &&
        fact.revision !== undefined &&
        branch?.has(versionKey({ target: fact.target, revision: fact.revision })) === true,
    );
  }
  private checkUnresolvedLookups_abyssPrivate(corrected: Set<string>): void {
    const unresolved = [...this.unresolvedLookups_abyssPrivate.values()].filter(
      (lookup) =>
        lookup.effect !== 'change' ||
        !lookup.discovery.complete ||
        ![...corrected].some(
          (key) =>
            lookup.candidates.has(key) &&
            this.discoveries_abyssPrivate.get(this.changeLookups_abyssPrivate.get(key) ?? '') ===
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
      this.facts_abyssPrivate.some((fact) => fact.action === 'research' && fact.entity === 'web') &&
      !this.facts_abyssPrivate.some(
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
    allowDisplayRetry?: boolean,
  ): void {
    const corrected = this.correctedRoots_abyssPrivate(displayed);
    this.checkUnresolvedLookups_abyssPrivate(corrected);
    for (const root of this.parentCorrections_abyssPrivate) {
      if (this.preparedDescendant_abyssPrivate(root)) corrected.add(root);
    }
    for (const [target, required] of this.taskChanges_abyssPrivate) {
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
      throw this.pendingChangeFailure_abyssPrivate(
        versionKey({ target, revision: change.revision }),
        this.displayRetrySubject_abyssPrivate(displayed, allowDisplayRetry),
        references,
        current,
      );
    }
  }
  private displayRetrySubject_abyssPrivate(
    displayed: readonly TaskVersion[],
    allowed: boolean | undefined,
  ): TaskVersion | undefined {
    return allowed !== false && this.taskChanges_abyssPrivate.size === 1 && displayed.length === 1
      ? displayed[0]
      : undefined;
  }
  private currentChangeLookup_abyssPrivate(
    root: string,
    references?: Partial<Pick<CommandReferenceBook, 'issuedFindEvidence'>>,
  ): { lookup: CommandDiscovery; retryOf: string } | undefined {
    const id = this.changeLookups_abyssPrivate.get(root);
    if (id === undefined) return undefined;
    const lookup = this.discoveries_abyssPrivate.get(id);
    const retryOf = references?.issuedFindEvidence?.([id])[0];
    return retryOf !== undefined &&
      lookup?.complete === true &&
      lookup.count === 1 &&
      this.latest_abyssPrivate.get(this.queryKey_abyssPrivate(lookup)) === lookup
      ? { lookup, retryOf }
      : undefined;
  }
  private pendingChangeFailure_abyssPrivate(
    root: string,
    selected: TaskVersion | undefined,
    references?: Partial<Pick<CommandReferenceBook, 'issuedFindEvidence' | 'issuedTaskEdit'>>,
    current?: unknown,
  ): CommandFailure {
    let message = this.pendingTaskChangeMessage_abyssPrivate(root, references, current);
    const correction = this.currentChangeLookup_abyssPrivate(root, references);
    if (correction !== undefined) {
      const { lookup, retryOf } = correction;
      if (this.preparedDescendant_abyssPrivate(root)) {
        const scope = { ...lookup.scope };
        Reflect.deleteProperty(scope, 'limit');
        const find = { query: lookup.query, ...scope, purpose: 'locate-child', retryOf };
        message = `If parent only locates prepared child: find(${JSON.stringify(find)}), then finish; do not repeat child edit. Edit parent only if requested.`;
      } else if (selected !== undefined && versionKey(selected) === root) {
        message = `If the user only wants to select or show this task, repeat the same find with identical query and filters, purpose:"show-only", retryOf:"${retryOf}", then finish with its selection. For a requested edit: ${message}`;
      }
    }
    return new CommandFailure('PENDING_TASK_CHANGE', message);
  }
  private pendingTaskChangeMessage_abyssPrivate(
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
    this.latest_abyssPrivate.set(this.queryKey_abyssPrivate(fact), fact);
    return evidence;
  }
  /** Candidates for the generation's find schema. Execution still checks purpose, filters and targets. */
  retryableFindEvidence(): string[] {
    const changes = new Set(this.changeLookups_abyssPrivate.values());
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
              !this.retryResults_abyssPrivate.has(id) &&
              this.latest_abyssPrivate.get(this.queryKey_abyssPrivate(fact)) === fact)),
      )
      .map(([id]) => id);
  }
  question(kind: string, evidence: string): CommandDiscovery {
    const fact = this.discoveries_abyssPrivate.get(evidence);
    if (
      fact !== undefined &&
      this.latest_abyssPrivate.get(this.queryKey_abyssPrivate(fact)) === fact
    ) {
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
    if (this.facts_abyssPrivate.some((fact) => ['create', 'change'].includes(fact.action)))
      return 'prepared';
    if (
      this.selected_abyssPrivate ||
      this.facts_abyssPrivate.some((fact) => fact.action === 'focus')
    )
      return 'selected';
    if (
      this.facts_abyssPrivate.some(
        (fact) =>
          ['inspect', 'research'].includes(fact.action) &&
          fact.entity !== 'catalog' &&
          (fact.complete !== false || coverage === 'page'),
      )
    )
      return 'observed';
    const searches = [...this.latest_abyssPrivate.values()].filter(
      (fact) => fact.entity !== 'catalog',
    );
    if (searches.length > 0 && (coverage === 'page' || searches.every((fact) => fact.complete)))
      return 'found';
    throw new CommandFailure(
      'UNGROUNDED_FINISH',
      'No current accepted result is ready. Prepare, inspect or select the requested content, or complete discovery; partial pages require coverage:page.',
    );
  }
}
