import type { App, Component } from 'obsidian';
import type { ContentPlanV1, TaskTreeV1 } from '../../../api';
import { discardedHistoryPreview } from '../../ai/commandHistoryMetadata';
import { commandMessage } from '../../ai/commandMessages';
import { checkedWriteResult, commandPlanViews } from '../../ai/commandSchemas';
import type { CommandSessionOwner } from '../../ai/CommandSessionOwner';
import type { CommandJournalEntry, CommandSessionSnapshot } from '../../ai/commandTypes';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { runAsyncAction } from '../runAsyncAction';
import {
  mountTaskTreeDisplay,
  type TaskDisplayField,
  type TaskDisplayNode,
  type TaskTreeDisplayMount,
} from '../taskTreeDisplay';
import {
  commandCommentDisplay,
  commandNodeFields,
  removedCommentVisible,
  type CommandNodeFields,
  type CommentField,
} from './commandFieldChanges';
import type { CommandNotePaint } from './CommandNotes';
import type { CommandProjectFields } from './CommandProjects';
import { CommandTreeHeader, type CommandTaskBinding } from './CommandTreeHeader';
import { CommandTreeReader } from './CommandTreeReader';
import { discardedCreationTree } from './discardedCreationTree';
/** Paint evidence only: one latest proposal per owner-retained session, never serialized. */
export type CommandPresentationMemory = Map<
  string,
  {
    readonly proposalRevision: number;
    readonly projects?: ReadonlyMap<string, CommandProjectFields>;
    readonly notes?: ReadonlyMap<string, CommandNotePaint>;
    readonly touched?: ReadonlySet<string>;
    readonly owners: ReadonlyMap<
      string,
      { readonly plan: string; readonly revision: string; readonly fields: CommandNodeFields }
    >;
  }
>;
export interface CommandTreeOptions {
  readonly app: App;
  readonly owner: CommandSessionOwner;
  readonly registry: StatusRegistry;
  readonly component: Component;
  readonly presentation: CommandPresentationMemory;
  readonly isCurrent: () => boolean;
  readonly failure: (message: string) => void;
  readonly allowLink: (href: string, sourcePath: string) => boolean;
  readonly formatDate?: (date: string) => string;
  readonly getDateClass?: (date: string) => string;
  readonly getTagColor?: (tag: string) => string | undefined;
  readonly showSource?: (path: string) => boolean;
}
interface Projection {
  readonly baseline: ReadonlyMap<string, TaskTreeV1>;
  readonly retainedHierarchy?: ReadonlySet<string>;
  readonly plan?: ContentPlanV1;
  readonly current: Map<string, CommandNodeFields>;
  readonly committed: ReadonlyMap<string, string>;
}
interface NodeProjection {
  readonly depth: number;
  readonly tree: TaskTreeV1;
  readonly key: string;
  readonly before: TaskTreeV1 | undefined;
  readonly comparison: TaskTreeV1 | undefined;
  readonly path: string;
  readonly fields: CommandNodeFields;
  readonly removed: boolean;
  readonly added: boolean;
  readonly projection: Projection;
}
function nodes(tree: TaskTreeV1 | null): TaskTreeV1[] {
  return tree === null ? [] : [tree, ...tree.children.flatMap(nodes)];
}
function baseline(tree: TaskTreeV1 | null): ReadonlyMap<string, TaskTreeV1> {
  return new Map(nodes(tree).map((node) => [node.target, node]));
}
function receiptPairs(entry: CommandJournalEntry): ReadonlyArray<{
  readonly preparedTarget: string;
  readonly committedTarget: string;
  readonly committedRevision: string;
}> {
  if (entry.state !== 'settled' || entry.effects !== 'committed' || entry.receipt === undefined)
    return [];
  const result = checkedWriteResult({ ok: true, receipt: entry.receipt });
  if (
    !result.ok ||
    !('contentContinuity' in result.receipt) ||
    result.receipt.snapshots !== 'complete'
  )
    return [];
  const mapping = result.receipt.contentContinuity.correspondence;
  return mapping.state === 'complete' ? mapping.tasks : [];
}
function projectionSignature(state: CommandSessionSnapshot): string {
  return JSON.stringify([
    state.id,
    state.recovery,
    state.blocked,
    state.proposal.revision,
    state.presentation,
    state.exchanges.filter((exchange) => exchange.role === 'user').length,
    state.focus,
    state.actual.map((tree) => [tree.target, tree.revision, tree.complete]),
    state.entities.tasks.map((page) => [
      page.tree.target,
      page.tree.revision,
      page.tree.complete,
      page.nextCursor,
    ]),
    state.journal.map((entry) => [entry.id, entry.state, entry.effects]),
  ]);
}
function fieldChange(
  current: string | undefined,
  before: string | undefined,
  node: NodeProjection,
): TaskDisplayField['change'] {
  if (node.removed || (current === undefined && before !== undefined)) return 'removed';
  if (
    node.added ||
    (before === undefined && current !== undefined && node.comparison !== undefined)
  )
    return 'added';
  return before !== undefined && before !== current ? 'changed' : undefined;
}
export class CommandTree {
  private readonly mount: TaskTreeDisplayMount;
  private readonly scope: HTMLElement;
  private readonly headers: CommandTreeHeader;
  private state: CommandSessionSnapshot;
  private readonly keys = new Map<string, string>();
  private previous = new Map<string, CommandNodeFields>();
  private readonly bindings = new Map<string, CommandTaskBinding>();
  private readonly expanded = new Map<string, TaskTreeV1>();
  private readonly reading = new Set<string>();
  private signature = '';
  private sessionId = '';
  private sequence = 0;
  private live = true;
  constructor(
    host: HTMLElement,
    private readonly options: CommandTreeOptions,
  ) {
    this.state = options.owner.snapshot();
    this.scope = host.createDiv({ cls: 'abyss-command-tree-scope abyss-command-scope-label' });
    this.scope.hidden = true;
    host.after(this.scope);
    this.mount = mountTaskTreeDisplay(host, {
      owner: options.component,
      roots: [],
      motion: true,
      isCurrent: options.isCurrent,
    });
    this.headers = new CommandTreeHeader(options, (key) => this.bindings.get(key));
  }
  private key(target: string): string {
    let key = this.keys.get(target);
    if (key === undefined) {
      key = `task-${++this.sequence}`;
      this.keys.set(target, key);
    }
    return key;
  }
  private touched = new Set<string>();
  get settled(): TaskTreeDisplayMount['settled'] {
    return this.mount.settled;
  }
  get hasTasks(): boolean {
    return this.bindings.size > 0;
  }
  private continuations(state: CommandSessionSnapshot): ReadonlyMap<string, string> {
    const proven = new Map<string, string>();
    for (const pair of state.journal.flatMap(receiptPairs)) {
      if (this.touched.has(pair.preparedTarget)) this.touched.add(pair.committedTarget);
      const key = this.keys.get(pair.preparedTarget);
      if (key !== undefined && this.previous.has(key)) {
        this.keys.set(pair.committedTarget, key);
        proven.set(pair.committedTarget, pair.committedRevision);
      }
    }
    return proven;
  }
  update(state: CommandSessionSnapshot): void {
    if (!this.live) return;
    const signature = projectionSignature(state);
    const sameEvidence = this.state.recoveryEvidence === state.recoveryEvidence;
    this.state = state;
    if (signature === this.signature && sameEvidence) return;
    this.signature = signature;
    if (this.sessionId !== state.id) {
      this.keys.clear();
      this.previous.clear();
      this.expanded.clear();
      this.reading.clear();
      this.sessionId = state.id;
      this.touched = new Set(this.options.presentation.get(state.id)?.touched);
    }
    const committed = this.continuations(state),
      current = new Map<string, CommandNodeFields>(),
      covered = new Set<string>();
    this.bindings.clear();
    const roots = this.proposalRoots({ current, committed, covered });
    const creation = discardedCreationTree(state, this.options.registry);
    if (creation !== undefined)
      roots.push(
        this.project(creation, { current, committed, baseline: baseline(creation) }, false),
      );
    roots.push(...this.savedRoots({ current, committed, covered }));
    this.scope.hidden = !roots.some((root) => this.incomplete(root));
    this.scope.textContent = this.scope.hidden
      ? ''
      : commandMessage('Incomplete saved tree. Review current source to see the rest.');
    this.previous = current;
    this.retainPresentation();
    this.mount.update({
      owner: this.options.component,
      roots,
      motion: true,
      isCurrent: () => this.live && this.options.isCurrent(),
      onRenderFailure: () => {
        this.options.failure(commandMessage('Could not render the task text.'));
      },
    });
  }
  private restoredFields(
    target: string,
    plan: ContentPlanV1 | undefined,
  ): CommandNodeFields | undefined {
    const record = this.options.presentation.get(this.state.id);
    if (record?.proposalRevision !== this.state.proposal.revision || plan === undefined)
      return undefined;
    const owner = record.owners.get(target);
    return owner?.plan === plan.target && owner.revision === plan.revision
      ? owner.fields
      : undefined;
  }
  private retainedOwners(): ReadonlyMap<
    string,
    { readonly plan: string; readonly revision: string; readonly fields: CommandNodeFields }
  > {
    const owners = new Map<string, { plan: string; revision: string; fields: CommandNodeFields }>();
    for (const [key, fields] of this.previous) {
      const binding = this.bindings.get(key);
      if (binding?.plan === undefined) continue;
      owners.set(binding.tree.target, {
        plan: binding.plan.target,
        revision: binding.plan.revision,
        fields,
      });
    }
    return owners;
  }
  private retainPresentation(): void {
    const owners = this.retainedOwners();
    const projects = this.options.presentation.get(this.state.id)?.projects ?? new Map();
    const retained = this.options.presentation.get(this.state.id);
    this.options.presentation.set(this.state.id, {
      ...retained,
      proposalRevision: this.state.proposal.revision,
      owners,
      projects,
      touched: new Set([
        ...(this.options.presentation.get(this.state.id)?.touched ?? []),
        ...this.touched,
      ]),
    });
    for (const id of this.options.presentation.keys())
      if (id !== this.state.id && !this.options.owner.hasHistory(id))
        this.options.presentation.delete(id);
  }
  private proposalRoots(context: {
    current: Map<string, CommandNodeFields>;
    committed: ReadonlyMap<string, string>;
    covered: Set<string>;
  }): TaskDisplayNode[] {
    const roots: TaskDisplayNode[] = [];
    for (const change of this.state.proposal.changes) {
      if (change.kind === 'project-move') {
        nodes(change.before).forEach((node) => context.covered.add(node.target));
        roots.push(
          this.project(change.before, { ...context, baseline: baseline(change.before) }, false),
        );
        continue;
      }
      if (change.kind !== 'task' && change.kind !== 'cleanup') continue;
      roots.push(...this.planRoots(change.plan, context));
    }
    return roots;
  }
  private planRoots(
    plan: ContentPlanV1,
    context: Pick<Projection, 'current' | 'committed'> & { covered: Set<string> },
  ): TaskDisplayNode[] {
    const roots: TaskDisplayNode[] = [];
    const views = commandPlanViews(plan);
    const previous = new Map(views.flatMap((view) => [...baseline(view.before)]));
    const retainedHierarchy =
      plan.kind === 'hierarchy'
        ? new Set(
            views.flatMap((view) =>
              view.after === null ? [] : nodes(view.after).map((node) => node.target),
            ),
          )
        : undefined;
    for (const view of views) {
      const tree = view.after ?? view.before;
      if (tree === null) continue;
      nodes(tree).forEach((node) => context.covered.add(node.target));
      if (view.after === null && retainedHierarchy?.has(tree.target) === true) continue;
      roots.push(
        this.project(
          tree,
          {
            ...context,
            baseline: previous,
            plan,
            ...(retainedHierarchy === undefined ? {} : { retainedHierarchy }),
          },
          view.after === null,
        ),
      );
    }
    return roots;
  }
  private incomplete(node: TaskDisplayNode): boolean {
    return (
      !node.complete ||
      node.entries.some((entry) => entry.kind === 'task' && this.incomplete(entry))
    );
  }
  private savedRoots(context: {
    current: Map<string, CommandNodeFields>;
    committed: ReadonlyMap<string, string>;
    covered: Set<string>;
  }): TaskDisplayNode[] {
    const roots: TaskDisplayNode[] = [];
    const selected = new Map(
      this.state.focus
        .filter((focus) => focus.kind === 'task')
        .map((focus) => [focus.target, focus.revision]),
    );
    for (const full of this.savedCandidates()) {
      if (context.covered.has(full.target) || !this.showSaved(full, selected)) continue;
      if (this.canExpand() && nodes(full).some((node) => !node.complete)) this.expand(full);
      nodes(full).forEach((node) => context.covered.add(node.target));
      roots.push(this.project(full, { ...context, baseline: baseline(full) }, false));
    }
    return roots;
  }
  private savedCandidates(): readonly TaskTreeV1[] {
    const latest = new Map<string, TaskTreeV1>();
    const discoveries = this.state.entities.tasks.map((page) => page.tree).reverse();
    const candidates = this.canExpand()
      ? [...discoveries, ...this.state.actual]
      : [...this.state.actual, ...discoveries];
    for (const tree of candidates) {
      if (!latest.has(tree.target)) latest.set(tree.target, this.savedTree(tree));
    }
    const trees = [...latest.values()];
    return trees.filter(
      (tree) =>
        !trees.some(
          (parent) =>
            parent.target !== tree.target &&
            nodes(parent).some(
              (child) => child.target === tree.target && child.revision === tree.revision,
            ),
        ),
    );
  }
  private savedTree(tree: TaskTreeV1): TaskTreeV1 {
    return this.canExpand() ? (this.expanded.get(`${tree.target}:${tree.revision}`) ?? tree) : tree;
  }
  private showSaved(tree: TaskTreeV1, selected: ReadonlyMap<string, string | undefined>): boolean {
    if (this.state.proposal.changes.length > 0 || this.state.actual.length === 0)
      return nodes(tree).some(
        (node) => selected.has(node.target) && selected.get(node.target) === node.revision,
      );
    return true;
  }
  private field(
    node: NodeProjection,
    input: {
      key: string;
      markdown: string;
      presentation: 'title' | 'description' | 'markdown';
      change?: TaskDisplayField['change'];
      previousMarkdown?: string | undefined;
    },
  ): TaskDisplayField {
    const { key, markdown, presentation, change } = input;
    const previousMarkdown = change === 'added' ? '' : input.previousMarkdown;
    return {
      key,
      ...(change === undefined ? {} : { change }),
      input: {
        source: { target: { type: 'display', key }, markdown, path: node.path, presentation },
        decoration: {
          kind: 'complete',
          ...(change === 'removed' ? { removed: true } : {}),
          ...(previousMarkdown === undefined
            ? {}
            : {
                previousMarkdown,
                compareMarkdown: presentation !== 'title',
              }),
        },
        callbacks: {
          app: this.options.app,
          isCurrent: () => this.live && this.options.isCurrent(),
          onRenderFailure: () => {
            this.options.failure(commandMessage('Could not render the task text.'));
          },
          beforeOpenLink: async ({ href, sourcePath }) => this.options.allowLink(href, sourcePath),
        },
      },
    };
  }
  private project(
    tree: TaskTreeV1,
    projection: Projection,
    removed: boolean,
    depth = 0,
  ): TaskDisplayNode {
    const key = this.key(tree.target),
      before = projection.baseline.get(tree.target),
      previous = this.previous.get(key) ?? this.restoredFields(tree.target, projection.plan);
    const fields = commandNodeFields({
      key,
      tree,
      before,
      previous,
      state: this.state,
      plan: projection.plan,
      committed: projection.committed.get(tree.target) === tree.revision,
    });
    projection.current.set(key, fields);
    if (fields.sessionChanged || removed || this.pendingStatus(tree)) this.touched.add(tree.target);
    this.bindings.set(key, {
      tree,
      ...(projection.plan === undefined ? {} : { plan: projection.plan }),
      removed,
    });
    const node: NodeProjection = {
      depth,
      tree,
      key,
      before,
      comparison: this.state.presentation?.changes === 'cumulative' ? before : fields.comparison,
      path: this.sourcePath(tree, projection.plan),
      fields,
      removed,
      added: this.added(fields),
      projection,
    };
    return this.display(node);
  }
  private added(fields: CommandNodeFields): boolean {
    return (
      fields.added &&
      (fields.comparison === undefined || this.state.presentation?.changes === 'cumulative')
    );
  }
  private pendingStatus(tree: TaskTreeV1): boolean {
    return this.state.proposal.changes.some(
      (change) =>
        change.kind === 'status' &&
        change.target === tree.target &&
        change.symbol !== tree.statusSymbol,
    );
  }
  private sourcePath(tree: TaskTreeV1, plan: ContentPlanV1 | undefined): string {
    return tree.source?.path ?? plan?.destination?.path ?? plan?.before?.source?.path ?? '';
  }
  private display(node: NodeProjection): TaskDisplayNode {
    let change: 'added' | 'removed' | undefined;
    if (node.removed) change = 'removed';
    else if (node.added) change = 'added';
    return {
      kind: 'task',
      key: node.key,
      identity: { type: 'display', key: node.key },
      title: this.field(node, {
        key: `${node.key}:title`,
        markdown: node.tree.markdownTitle,
        presentation: 'title',
        change: fieldChange(node.tree.markdownTitle, node.comparison?.markdownTitle, node),
        previousMarkdown: node.comparison?.markdownTitle,
      }),
      ...this.description(node),
      entries: this.entries(node),
      complete: node.tree.complete,
      done: node.tree.status === 'done',
      ...(change === undefined ? {} : { change }),
      renderHeader: (host, owner) => {
        this.headers.render(host, owner, {
          key: node.key,
          depth: node.depth,
          before: node.before,
          comparison: node.comparison,
          state: this.state,
          sessionChanged: this.touched.has(node.tree.target),
          added: node.added,
        });
      },
      onActivate: (event) => {
        event?.stopPropagation();
        if (discardedHistoryPreview(this.state) === undefined) this.focus(node.key);
      },
    };
  }
  private description(node: NodeProjection): Pick<TaskDisplayNode, 'description'> {
    const description = node.tree.description ?? node.comparison?.description;
    if (description === undefined) return {};
    return {
      description: this.field(node, {
        key: `${node.key}:description`,
        markdown: description,
        presentation: 'description',
        previousMarkdown:
          node.tree.description === undefined ? undefined : node.comparison?.description,
        change: fieldChange(node.tree.description, node.comparison?.description, node),
      }),
    };
  }
  private movedElsewhere(
    node: NodeProjection,
    children: ReadonlyMap<string, TaskTreeV1>,
    target: string,
  ): boolean {
    return !children.has(target) && node.projection.retainedHierarchy?.has(target) === true;
  }
  private childEntry(
    node: NodeProjection,
    children: ReadonlyMap<string, TaskTreeV1>,
    before: ReadonlyMap<string, TaskTreeV1>,
    key: string,
  ): TaskDisplayNode | undefined {
    if (this.movedElsewhere(node, children, key)) return undefined;
    const child = children.get(key) ?? before.get(key);
    return child === undefined
      ? undefined
      : this.project(child, node.projection, node.removed || !children.has(key), node.depth + 1);
  }
  private entries(node: NodeProjection): TaskDisplayNode['entries'] {
    const entries: Array<TaskDisplayNode['entries'][number]> = [];
    const childEntries: TaskDisplayNode[] = [];
    const comments = new Map(node.fields.comments.map((field) => [field.key, field]));
    const removed = new Map(
      node.fields.removed
        .filter((field) =>
          removedCommentVisible(
            field,
            node.fields,
            this.state.presentation?.changes === 'cumulative',
          ),
        )
        .map((field) => [field.key, field]),
    );
    const children = new Map(node.tree.children.map((child) => [child.target, child]));
    const before = new Map(node.comparison?.children.map((child) => [child.target, child]));
    for (const entry of node.fields.order) {
      if (entry.kind === 'comment') {
        const field = comments.get(entry.key) ?? removed.get(entry.key);
        if (field !== undefined) entries.push(this.comment(node, field, removed.has(entry.key)));
      } else {
        const child = this.childEntry(node, children, before, entry.key);
        if (child !== undefined) childEntries.push(child);
      }
    }
    return [...entries, ...childEntries];
  }
  private comment(
    node: NodeProjection,
    field: CommentField,
    removed: boolean,
  ): TaskDisplayNode['entries'][number] {
    const cumulative = this.state.presentation?.changes === 'cumulative';
    const display = commandCommentDisplay(field, cumulative);
    const previous = cumulative ? field.original : field.removedMarkdown;
    return {
      kind: 'comment',
      key: field.key,
      field: this.field(node, {
        key: field.key,
        markdown: removed ? (previous ?? field.comment.text) : field.comment.text,
        presentation: 'markdown',
        change: node.removed || removed ? 'removed' : display.change,
        previousMarkdown: removed ? undefined : display.previousMarkdown,
      }),
    };
  }
  private focus(key: string): void {
    const binding = this.bindings.get(key);
    if (binding === undefined || binding.removed) return;
    runAsyncAction(
      this.options.owner.focus({
        kind: 'task',
        target: binding.tree.target,
        ...(binding.plan === undefined
          ? { revision: binding.tree.revision }
          : { plan: binding.plan.target, expectedPlanRevision: binding.plan.revision }),
      }),
      commandMessage('Could not focus this task'),
    );
  }
  private canExpand(): boolean {
    return (
      this.state.recovery !== 'historical' &&
      this.state.recovery !== 'uncertain' &&
      !this.state.blocked
    );
  }
  private expand(seed: TaskTreeV1): void {
    const key = `${seed.target}:${seed.revision}`;
    if (this.reading.has(key)) return;
    this.reading.add(key);
    const session = this.state.id,
      current = (): boolean => this.live && session === this.state.id && this.canExpand();
    void new CommandTreeReader(this.options.owner, current).tree(seed).then(
      (tree) => {
        this.reading.delete(key);
        if (!current()) return;
        this.expanded.set(key, tree);
        this.signature = '';
        this.update(this.options.owner.snapshot());
      },
      () => {
        this.reading.delete(key);
        if (current())
          this.options.failure(commandMessage('Could not expand the complete task tree.'));
      },
    );
  }
  destroy(): void {
    this.live = false;
    this.mount.destroy();
    this.scope.remove();
    this.bindings.clear();
  }
}
