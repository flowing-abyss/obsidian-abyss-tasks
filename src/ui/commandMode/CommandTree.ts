import type { App, Component } from 'obsidian';
import type { ContentPlanV1, TaskTreeV1 } from '../../../api';
import { checkedWriteResult } from '../../ai/commandSchemas';
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
import { commandNodeFields, type CommandNodeFields } from './commandFieldChanges';
import type { CommandProjectFields } from './CommandProjects';
import { CommandTreeHeader, type CommandTaskBinding } from './CommandTreeHeader';
import { CommandTreeReader } from './CommandTreeReader';
/** Paint evidence only: one latest proposal per owner-retained session, never serialized. */
export type CommandPresentationMemory = Map<
  string,
  {
    readonly proposalRevision: number;
    readonly projects?: ReadonlyMap<string, CommandProjectFields>;
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
  readonly plan?: ContentPlanV1;
  readonly current: Map<string, CommandNodeFields>;
  readonly committed: ReadonlyMap<string, string>;
}
interface NodeProjection {
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
  private continuations(state: CommandSessionSnapshot): ReadonlyMap<string, string> {
    const proven = new Map<string, string>();
    for (const pair of state.journal.flatMap(receiptPairs)) {
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
    this.state = state;
    if (signature === this.signature) return;
    this.signature = signature;
    if (this.sessionId !== state.id) {
      this.keys.clear();
      this.previous.clear();
      this.expanded.clear();
      this.reading.clear();
      this.sessionId = state.id;
    }
    const committed = this.continuations(state),
      current = new Map<string, CommandNodeFields>(),
      covered = new Set<string>();
    this.bindings.clear();
    const roots = this.proposalRoots({ current, committed, covered });
    roots.push(...this.savedRoots({ current, committed, covered }));
    this.previous = current;
    this.retainPresentation();
    this.mount.update({
      owner: this.options.component,
      roots,
      motion: true,
      isCurrent: () => this.live && this.options.isCurrent(),
      onRenderFailure: () => {
        this.options.failure('Could not render the task text.');
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
  private retainPresentation(): void {
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
    const projects = this.options.presentation.get(this.state.id)?.projects ?? new Map();
    if (owners.size + projects.size === 0) this.options.presentation.delete(this.state.id);
    else
      this.options.presentation.set(this.state.id, {
        proposalRevision: this.state.proposal.revision,
        owners,
        projects,
      });
    const retained = new Set(this.options.owner.recent().map((record) => record.snapshot.id));
    retained.add(this.state.id);
    for (const id of this.options.presentation.keys())
      if (!retained.has(id)) this.options.presentation.delete(id);
  }
  private proposalRoots(context: {
    current: Map<string, CommandNodeFields>;
    committed: ReadonlyMap<string, string>;
    covered: Set<string>;
  }): TaskDisplayNode[] {
    const roots: TaskDisplayNode[] = [];
    for (const change of this.state.proposal.changes) {
      if (change.kind !== 'task' && change.kind !== 'cleanup') continue;
      const tree = change.plan.after ?? change.plan.before;
      if (tree === null) continue;
      nodes(tree).forEach((node) => context.covered.add(node.target));
      roots.push(
        this.project(
          tree,
          { ...context, baseline: baseline(change.plan.before), plan: change.plan },
          change.plan.after === null,
        ),
      );
    }
    return roots;
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
      if (nodes(full).some((node) => !node.complete)) this.expand(full);
      nodes(full).forEach((node) => context.covered.add(node.target));
      roots.push(this.project(full, { ...context, baseline: baseline(full) }, false));
    }
    return roots;
  }
  private savedCandidates(): readonly TaskTreeV1[] {
    const latest = new Map<string, TaskTreeV1>();
    for (const tree of [
      ...this.state.entities.tasks.map((page) => page.tree).reverse(),
      ...this.state.actual,
    ]) {
      if (!latest.has(tree.target))
        latest.set(tree.target, this.expanded.get(`${tree.target}:${tree.revision}`) ?? tree);
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
    return {
      key,
      ...(change === undefined ? {} : { change }),
      input: {
        source: { target: { type: 'display', key }, markdown, path: node.path, presentation },
        decoration: {
          kind: 'complete',
          ...(input.previousMarkdown === undefined
            ? {}
            : { previousMarkdown: input.previousMarkdown }),
        },
        callbacks: {
          app: this.options.app,
          isCurrent: () => this.live && this.options.isCurrent(),
          onRenderFailure: () => {
            this.options.failure('Could not render the task text.');
          },
          beforeOpenLink: async ({ href, sourcePath }) => this.options.allowLink(href, sourcePath),
        },
      },
    };
  }
  private project(tree: TaskTreeV1, projection: Projection, removed: boolean): TaskDisplayNode {
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
    this.bindings.set(key, {
      tree,
      ...(projection.plan === undefined ? {} : { plan: projection.plan }),
      removed,
    });
    const node: NodeProjection = {
      tree,
      key,
      before,
      comparison: fields.comparison,
      path: this.sourcePath(tree, projection.plan),
      fields,
      removed,
      added:
        fields.added &&
        (fields.comparison === undefined || this.state.presentation?.changes === 'cumulative'),
      projection,
    };
    return this.display(node);
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
          before: node.before,
          comparison: node.comparison,
          state: this.state,
        });
      },
      onActivate: (event) => {
        event?.stopPropagation();
        this.focus(node.key);
      },
    };
  }
  private description(node: NodeProjection): Pick<TaskDisplayNode, 'description'> {
    const description = node.tree.description ?? node.before?.description;
    if (description === undefined) return {};
    return {
      description: this.field(node, {
        key: `${node.key}:description`,
        markdown: description,
        presentation: 'description',
        previousMarkdown:
          node.tree.description === undefined ? undefined : node.comparison?.description,
        change: fieldChange(
          node.tree.description,
          node.comparison?.description ?? node.before?.description,
          node,
        ),
      }),
    };
  }
  private entries(node: NodeProjection): TaskDisplayNode['entries'] {
    const entries: Array<TaskDisplayNode['entries'][number]> = [];
    for (const entry of node.tree.entries) {
      if (entry.kind === 'child') {
        const child = node.tree.children.find((child) => child.target === entry.target);
        if (child !== undefined) entries.push(this.project(child, node.projection, node.removed));
      } else if (entry.kind === 'comment') this.comment(node, entry.target, entries);
    }
    this.removedComments(node, entries);
    this.removedChildren(node, entries);
    return entries;
  }
  private comment(
    node: NodeProjection,
    target: string,
    entries: Array<TaskDisplayNode['entries'][number]>,
  ): void {
    const field = node.fields.comments.find((field) => field.comment.target === target);
    if (field === undefined) return;
    entries.push({
      kind: 'comment',
      key: field.key,
      field: this.field(node, {
        key: field.key,
        markdown: field.comment.text,
        presentation: 'markdown',
        change: node.removed ? 'removed' : field.change,
        previousMarkdown: field.previousMarkdown,
      }),
    });
  }
  private removedComments(
    node: NodeProjection,
    entries: Array<TaskDisplayNode['entries'][number]>,
  ): void {
    for (const removal of node.fields.removed) {
      const field = removal.field;
      entries.splice(Math.max(0, Math.min(removal.index, entries.length)), 0, {
        kind: 'comment',
        key: field.key,
        field: this.field(node, {
          key: field.key,
          markdown: field.comment.text,
          presentation: 'markdown',
          change: 'removed',
        }),
      });
    }
  }
  private removedChildren(
    node: NodeProjection,
    entries: Array<TaskDisplayNode['entries'][number]>,
  ): void {
    if (node.before === undefined || node.projection.plan === undefined || node.removed) return;
    for (const [index, entry] of node.before.entries.entries()) {
      if (
        entry.kind !== 'child' ||
        node.tree.children.some((child) => child.target === entry.target)
      )
        continue;
      const deleted = node.before.children.find((child) => child.target === entry.target);
      if (deleted !== undefined)
        entries.splice(
          Math.min(index, entries.length),
          0,
          this.project(deleted, node.projection, true),
        );
    }
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
      'Could not focus this task',
    );
  }
  private expand(seed: TaskTreeV1): void {
    const key = `${seed.target}:${seed.revision}`;
    if (this.reading.has(key)) return;
    this.reading.add(key);
    const session = this.state.id,
      current = (): boolean => this.live && session === this.state.id;
    void new CommandTreeReader(this.options.owner, current).tree(seed).then(
      (tree) => {
        if (!current()) return;
        this.expanded.set(key, tree);
        this.signature = '';
        this.update(this.options.owner.snapshot());
      },
      () => {
        if (current()) this.options.failure('Could not expand the complete task tree.');
      },
    );
  }
  destroy(): void {
    this.live = false;
    this.mount.destroy();
    this.bindings.clear();
  }
}
