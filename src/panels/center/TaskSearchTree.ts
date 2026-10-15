import { Component, type App } from 'obsidian';
import { pairAnchorsToTokens, parseLinks, type LinkToken } from '../../markdown/links';
import type {
  SubtaskSnapshot,
  TaskSearchEvidence,
  TaskSearchTreeNode,
  TaskSnapshot,
  TaskTextTarget,
} from '../../tasks';
import { sameTaskNodeRef, taskNodeAddress } from '../../tasks';
import type { RenderTaskTextOptions } from '../../ui/renderTaskText';
import {
  RetainedTaskText,
  type PreparedTaskTextUpdate,
  type RetainedTaskTextInput,
} from '../../ui/retainedTaskText';
import type { TaskRenderOutcome, TaskTextRender } from '../../ui/taskRenderScope';
import { taskNodeRef, type TaskSelectionNode } from '../../ui/taskSelection';
import type { TaskCardSearchPresentation } from './TaskCardRenderer';
import { mountTaskSearchKeyboardActivation } from './taskSearchKeyboardActivation';

export type TaskSearchSemanticEvidence = TaskSearchEvidence & {
  readonly field: 'tag' | 'metadata';
  readonly provenance: Extract<TaskSearchEvidence['provenance'], { readonly type: 'semantic' }>;
};
export function isTaskSearchSemanticEvidence(
  evidence: TaskSearchEvidence,
): evidence is TaskSearchSemanticEvidence {
  return (
    (evidence.field === 'tag' || evidence.field === 'metadata') &&
    evidence.provenance.type === 'semantic'
  );
}
export interface TaskSearchTreeRenderOptions {
  readonly app: App;
  readonly root: TaskSnapshot;
  readonly base: TaskSelectionNode;
  readonly search: TaskCardSearchPresentation;
  readonly textOptions: Omit<
    RenderTaskTextOptions,
    'app' | 'sourcePath' | 'presentation' | 'onRendered' | 'onEditLink'
  >;
  readonly track: (render: TaskTextRender) => void;
  readonly editLink: (target: TaskTextTarget, occurrence: number, token: LinkToken) => void;
  readonly renderChildStatus: (
    host: HTMLElement,
    child: SubtaskSnapshot,
    current: () => SubtaskSnapshot | undefined,
  ) => void;
  readonly metadataKey: (
    node: TaskSelectionNode,
    evidence: readonly TaskSearchSemanticEvidence[],
  ) => string;
  readonly renderMetadata: (
    host: HTMLElement,
    node: TaskSelectionNode,
    evidence: readonly TaskSearchSemanticEvidence[],
    owner: Component,
  ) => void;
}
function matchingDescriptionAnchors(
  element: HTMLElement,
  markdown: string,
  evidence: readonly TaskSearchEvidence[],
): readonly HTMLAnchorElement[] {
  const ranges = evidence
    .filter(
      (item) =>
        item.field === 'link-target' &&
        item.provenance.type === 'field' &&
        item.provenance.field === 'description',
    )
    .flatMap((item) => item.matches.flatMap((match) => match.sourceRanges));
  if (ranges.length === 0) return [];
  const tokens = parseLinks(markdown);
  const anchors = [...element.querySelectorAll('a')];
  const occurrences = pairAnchorsToTokens(
    anchors.map((anchor) => ({
      text: anchor.textContent,
      href: anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '',
    })),
    tokens,
  );
  // Display-only correspondence requires the complete authored link sequence. Edit handlers
  // were already installed (or declined) using stronger whole-field source alignment.
  if (
    anchors.length !== tokens.length ||
    occurrences.some((occurrence, index) => occurrence !== index)
  )
    return [];
  const matching: HTMLAnchorElement[] = [];
  for (const [index, token] of tokens.entries()) {
    if (
      ranges.some(
        (range) => range.from >= token.index && range.to <= token.index + token.raw.length,
      )
    )
      matching.push(...anchors.slice(index, index + 1));
  }
  return matching;
}

interface FieldRecord {
  readonly element: HTMLElement;
  readonly wrapper: HTMLElement;
  readonly text: RetainedTaskText;
}
interface EntryRecord {
  readonly target: ReturnType<typeof taskNodeRef>;
  readonly host: HTMLElement;
  readonly body: HTMLElement;
  readonly owner: Component;
  readonly stagingHost: HTMLElement;
  readonly row: HTMLElement | undefined;
  readonly title: FieldRecord | undefined;
  description: FieldRecord | undefined;
  readonly comments: Map<number, FieldRecord>;
  options: TaskSearchTreeRenderOptions;
  tree: TaskSearchTreeNode;
  node: TaskSelectionNode;
  desired: boolean;
  metadataKey: string;
  metadataOwner: Component | undefined;
}
interface TreePreparation {
  readonly desired: Map<string, EntryRecord>;
  readonly candidates: Map<string, EntryRecord>;
  readonly updates: PreparedTaskTextUpdate[];
  readonly placements: Array<readonly [HTMLElement, readonly HTMLElement[]]>;
  readonly removed: FieldRecord[];
  readonly added: Array<readonly [EntryRecord, number, FieldRecord]>;
  readonly descriptions: EntryRecord[];
}
export interface TaskSearchTreeMount {
  readonly settled: Promise<TaskRenderOutcome>;
  update(options: TaskSearchTreeRenderOptions): void;
  destroy(): void;
}
function isCurrent(record: EntryRecord): boolean {
  return record.desired && record.options.textOptions.isCurrent?.() !== false;
}
function modified(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
}
function activateField(event: MouseEvent, record: EntryRecord): void {
  if (!isCurrent(record)) {
    event.stopPropagation();
    return;
  }
  const { search } = record.options;
  if (search.mode === 'filter' && (record.tree === search.context.tree || modified(event))) return;
  const win = record.host.ownerDocument.defaultView;
  if (
    win !== null &&
    event.target instanceof win.Element &&
    event.target.closest('a, button, .abyss-status-control, .abyss-task-tag, .abyss-task-date') !==
      null
  )
    return;
  event.stopPropagation();
  search.onActivate(record.tree.address);
}
function reconcile(container: HTMLElement, elements: readonly HTMLElement[]): void {
  for (const child of [...container.children])
    if (!elements.includes(child as HTMLElement)) child.remove();
  let cursor = container.firstChild;
  for (const element of elements) {
    if (element === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(element, cursor);
  }
  while (cursor !== null) {
    const next = cursor.nextSibling;
    container.removeChild(cursor);
    cursor = next;
  }
}
function fieldInput(
  record: EntryRecord,
  markdown: string,
  target: TaskTextTarget,
  decoration: Pick<RetainedTaskTextInput['decoration'], 'kind' | 'continuation'>,
): RetainedTaskTextInput {
  const options = record.options;
  const evidence = record.tree.evidence;
  const destinations = evidence.filter(
    (item) =>
      item.field === 'link-target' &&
      item.provenance.type === 'field' &&
      item.provenance.field === 'description',
  );
  return {
    source: {
      target,
      markdown,
      path: options.root.source.filePath,
      presentation: target.type === 'comment' ? 'markdown' : target.type,
    },
    decoration: {
      ...decoration,
      query: options.search.query,
      segment: options.search.segment,
      ...(decoration.kind === 'excerpt'
        ? {
            destinations: JSON.stringify(destinations.map((item) => item.matches)),
            anchors: (element: HTMLElement) =>
              matchingDescriptionAnchors(element, markdown, evidence),
          }
        : {}),
    },
    callbacks: {
      app: options.app,
      isCurrent: () => isCurrent(record),
      onRenderFailure: (error) => {
        record.options.textOptions.onRenderFailure?.(error);
      },
      onEditLink: (occurrence, token) => {
        options.editLink(target, occurrence, token);
      },
    },
  };
}
function createField(
  element: HTMLElement,
  wrapper: HTMLElement,
  lifetime: { owner: Component; current: () => EntryRecord | undefined; stagingHost: HTMLElement },
): FieldRecord {
  lifetime.owner.registerDomEvent(element, 'click', (event) => {
    const record = lifetime.current();
    if (record === undefined) {
      event.stopPropagation();
      return;
    }
    activateField(event, record);
  });
  return {
    element,
    wrapper,
    text: new RetainedTaskText(element, lifetime.owner, lifetime.stagingHost),
  };
}
function createEntry(
  tree: TaskSearchTreeNode,
  node: TaskSelectionNode,
  options: TaskSearchTreeRenderOptions,
  hosts: { context: HTMLElement; base: HTMLElement; owner: Component },
): EntryRecord {
  const host = hosts.context.createDiv({ cls: 'abyss-subtask-content' });
  host.remove();
  const owner = hosts.owner.addChild(new Component());
  const stagingHost =
    hosts.context.closest<HTMLElement>('.abyss-panel-view') ?? hosts.context.ownerDocument.body;
  const isBase = tree === options.search.context.tree;
  const row = isBase
    ? undefined
    : host.createDiv({ cls: 'abyss-subtask-row abyss-task-card-main-row' });
  const body =
    row === undefined
      ? hosts.base
      : row.createDiv({ cls: 'abyss-subtask-content abyss-task-body' });
  const titleRow =
    row === undefined ? undefined : body.createDiv({ cls: 'abyss-subtask-title-row' });
  const title =
    titleRow === undefined
      ? undefined
      : createField(titleRow.createSpan({ cls: 'abyss-subtask-label' }), titleRow, {
          owner,
          current: () => record,
          stagingHost,
        });
  const record: EntryRecord = {
    target: taskNodeRef(node),
    host,
    body,
    owner,
    stagingHost,
    row,
    title,
    description: undefined,
    comments: new Map(),
    options,
    tree,
    node,
    desired: true,
    metadataKey: '',
    metadataOwner: undefined,
  };
  if (row !== undefined)
    mountTaskSearchKeyboardActivation(row, owner, () => {
      if (isCurrent(record)) record.options.search.onActivate(record.tree.address);
    });
  return record;
}
function releaseEntry(record: EntryRecord, parent: Component): void {
  record.desired = false;
  record.title?.text.destroy();
  record.description?.text.destroy();
  for (const field of record.comments.values()) field.text.destroy();
  parent.removeChild(record.owner);
  record.host.remove();
}
function commentLines(tree: TaskSearchTreeNode): Set<number> {
  return new Set(
    tree.evidence.flatMap((evidence) =>
      evidence.provenance.type === 'field' &&
      evidence.provenance.field === 'comment' &&
      evidence.provenance.commentLine !== undefined
        ? [evidence.provenance.commentLine]
        : [],
    ),
  );
}
function prepareComments(
  record: EntryRecord,
  plan: TreePreparation,
): Array<{ line: number; element: HTMLElement }> {
  const lines = commentLines(record.tree);
  const ordered: Array<{ line: number; element: HTMLElement }> = [];
  for (const comment of record.node.comments) {
    if (!lines.has(comment.ref.relativeLine)) continue;
    let field = record.comments.get(comment.ref.relativeLine);
    if (field === undefined) {
      const wrapper = record.host.createDiv({ cls: 'abyss-comment-row' });
      wrapper.remove();
      field = createField(wrapper.createEl('p', { cls: 'abyss-comment-text' }), wrapper, {
        owner: record.owner,
        stagingHost: record.stagingHost,
        current: () =>
          commentLines(record.tree).has(comment.ref.relativeLine) ? record : undefined,
      });
      record.comments.set(comment.ref.relativeLine, field);
      plan.added.push([record, comment.ref.relativeLine, field]);
    }
    plan.updates.push(
      field.text.prepare(
        fieldInput(
          record,
          comment.text,
          { type: 'comment', ref: comment.ref },
          { kind: 'complete' },
        ),
      ),
    );
    ordered.push({ line: comment.ref.relativeLine, element: field.wrapper });
  }
  for (const [line, field] of record.comments) if (!lines.has(line)) plan.removed.push(field);
  return ordered;
}
function descriptionPresentation(record: EntryRecord): {
  markdown: string;
  preview: boolean;
  continuation: boolean;
  show: boolean;
} {
  const matched = record.tree.evidence.some(
    (evidence) =>
      evidence.provenance.type === 'field' && evidence.provenance.field === 'description',
  );
  const preview =
    record.tree === record.options.search.context.tree &&
    record.options.search.mode === 'filter' &&
    !matched;
  const source = record.node.description ?? '';
  let markdown = '';
  if (matched) markdown = source;
  else if (preview) markdown = source.split('\n')[0] ?? '';
  const continuation =
    preview &&
    source
      .split('\n')
      .slice(1)
      .some((line) => line.trim().length > 0);
  return { markdown, preview, continuation, show: markdown !== '' || continuation };
}
function prepareDescriptionField(
  record: EntryRecord,
  plan: TreePreparation,
  presentation: ReturnType<typeof descriptionPresentation>,
): FieldRecord | undefined {
  const { show, markdown, preview, continuation } = presentation;
  if (!show) {
    if (record.description !== undefined) plan.removed.push(record.description);
    return;
  }
  if (record.description === undefined) {
    const element = record.host.createDiv({ cls: 'abyss-task-desc' });
    element.remove();
    record.description = createField(element, element, {
      owner: record.owner,
      stagingHost: record.stagingHost,
      current: () => record,
    });
    plan.descriptions.push(record);
  }
  const field = record.description;
  plan.updates.push(
    field.text.prepare(
      fieldInput(
        record,
        markdown,
        { type: 'description', target: record.target },
        { kind: preview ? 'preview' : 'excerpt', continuation },
      ),
    ),
  );
  return field;
}
function prepareDescription(
  record: EntryRecord,
  plan: TreePreparation,
  baseTextHost: HTMLElement,
): void {
  const presentation = descriptionPresentation(record);
  const field = prepareDescriptionField(record, plan, presentation);
  const elements = record.title === undefined ? [] : [record.title.wrapper];
  if (!presentation.preview && field !== undefined) elements.push(field.element);
  plan.placements.push([record.body, elements]);
  if (record.tree === record.options.search.context.tree)
    plan.placements.push([
      baseTextHost,
      [...(presentation.preview && field !== undefined ? [field.element] : []), record.body],
    ]);
}
function prepareHeader(record: EntryRecord, changed: boolean, plan: TreePreparation): void {
  const { title, node, row, options } = record;
  if (title !== undefined) {
    title.element.toggleClass('is-done', node.status === 'done');
    plan.updates.push(
      title.text.prepare(
        fieldInput(
          record,
          node.markdownTitle,
          { type: 'title', target: record.target },
          { kind: 'complete' },
        ),
      ),
    );
  }
  if (row === undefined) return;
  if (!('source' in node))
    options.renderChildStatus(row, node, () =>
      isCurrent(record) && !('source' in record.node) ? record.node : undefined,
    );
  refreshEntryMetadata(record, changed);
}
function refreshEntryMetadata(record: EntryRecord, changed: boolean): void {
  const { row, node, options } = record;
  if (row === undefined) return;
  const evidence = record.tree.evidence.filter(isTaskSearchSemanticEvidence);
  const key = options.metadataKey(node, evidence);
  if (!changed && record.metadataKey === key && record.metadataOwner !== undefined) return;
  record.metadataKey = key;
  if (record.metadataOwner !== undefined) record.owner.removeChild(record.metadataOwner);
  record.metadataOwner = record.owner.addChild(new Component());
  row.querySelector(':scope > .abyss-task-meta-right')?.remove();
  options.renderMetadata(row, node, evidence, record.metadataOwner);
}

class RetainedSearchTree implements TaskSearchTreeMount {
  readonly #host: HTMLElement;
  readonly #baseTextHost: HTMLElement;
  readonly #context: HTMLElement;
  readonly #base: HTMLElement;
  readonly #owner: Component;
  readonly #parent: Component;
  #records = new Map<string, EntryRecord>();
  #cancel = (): void => {};
  #live = true;
  settled: Promise<TaskRenderOutcome> = Promise.resolve({ type: 'ready' });
  constructor(host: HTMLElement, baseTextHost: HTMLElement, options: TaskSearchTreeRenderOptions) {
    this.#host = host;
    this.#baseTextHost = baseTextHost;
    this.#parent = options.textOptions.component;
    this.#owner = this.#parent.addChild(new Component());
    this.#context = host.createDiv({ cls: 'abyss-search-context' });
    this.#base = baseTextHost.createDiv({ cls: 'abyss-search-context' });
    this.update(options);
  }
  #entry(
    tree: TaskSearchTreeNode,
    node: TaskSelectionNode,
    options: TaskSearchTreeRenderOptions,
    plan: TreePreparation,
  ): EntryRecord {
    const key = taskNodeAddress(taskNodeRef(node));
    let record = plan.candidates.get(key);
    if (record !== undefined && !sameTaskNodeRef(record.target, taskNodeRef(node)))
      record = undefined;
    record ??= createEntry(tree, node, options, {
      context: this.#context,
      base: this.#base,
      owner: this.#owner,
    });
    plan.candidates.set(key, record);
    return record;
  }
  #prepare(options: TaskSearchTreeRenderOptions): TreePreparation {
    const plan: TreePreparation = {
      desired: new Map(),
      candidates: new Map(this.#records),
      updates: [],
      placements: [],
      removed: [],
      added: [],
      descriptions: [],
    };
    const pending = [{ tree: options.search.context.tree, node: options.base }];
    while (pending.length > 0) {
      const item = pending.pop();
      if (item === undefined) break;
      const record = this.#entry(item.tree, item.node, options, plan);
      const changed =
        record.node !== item.node || record.options.search.mode !== options.search.mode;
      record.options = options;
      record.tree = item.tree;
      record.node = item.node;
      record.desired = true;
      plan.desired.set(taskNodeAddress(record.target), record);
      prepareHeader(record, changed, plan);
      prepareDescription(record, plan, this.#baseTextHost);
      const ordered = prepareComments(record, plan);
      this.#children(record, plan, pending, ordered);
      ordered.sort((a, b) => a.line - b.line);
      plan.placements.push([
        record.tree === options.search.context.tree ? this.#context : record.host,
        [...(record.row === undefined ? [] : [record.row]), ...ordered.map((item) => item.element)],
      ]);
    }
    return plan;
  }
  #children(
    record: EntryRecord,
    plan: TreePreparation,
    pending: Array<{ tree: TaskSearchTreeNode; node: TaskSelectionNode }>,
    ordered: Array<{ line: number; element: HTMLElement }>,
  ): void {
    const children = new Map(record.node.subtasks.map((child) => [child.ref.relativeLine, child]));
    for (const tree of record.tree.children) {
      const line = tree.address.childLines[tree.address.childLines.length - 1];
      if (line === undefined) continue;
      const node = children.get(line);
      if (node === undefined) continue;
      const child = this.#entry(tree, node, record.options, plan);
      ordered.push({ line, element: child.host });
      pending.push({ tree, node });
    }
  }
  #focusedRemoval(plan: TreePreparation): boolean {
    const active = this.#host.ownerDocument.activeElement;
    return (
      [...this.#records.values()].some(
        (record) =>
          plan.desired.get(taskNodeAddress(record.target)) !== record &&
          (record.host.contains(active) || record.description?.element.contains(active) === true),
      ) || plan.removed.some((field) => field.element.contains(active))
    );
  }
  #commit(plan: TreePreparation): boolean {
    if (this.#focusedRemoval(plan) || !plan.updates.every((update) => update.canCommit()))
      return false;
    for (const update of plan.updates) update.commit();
    for (const [host, elements] of plan.placements) reconcile(host, elements);
    for (const [key, record] of this.#records)
      if (plan.desired.get(key) !== record) releaseEntry(record, this.#owner);
    for (const field of plan.removed) {
      field.text.destroy();
      field.wrapper.remove();
    }
    this.#removeComments(plan);
    this.#records = plan.desired;
    if (this.#context.childElementCount === 0) this.#host.remove();
    return true;
  }
  #removeComments(plan: TreePreparation): void {
    for (const record of plan.desired.values())
      if (record.description !== undefined && plan.removed.includes(record.description))
        record.description = undefined;
    for (const record of plan.desired.values())
      for (const [line, field] of record.comments)
        if (plan.removed.includes(field)) record.comments.delete(line);
  }
  #cancelPreparation(plan: TreePreparation): void {
    for (const update of plan.updates) update.cancel();
    for (const [key, record] of plan.candidates)
      if (this.#records.get(key) !== record) releaseEntry(record, this.#owner);
    for (const record of plan.descriptions)
      if (this.#records.get(taskNodeAddress(record.target)) === record) {
        record.description?.text.destroy();
        record.description = undefined;
      }
    for (const [record, line, field] of plan.added)
      if (this.#records.get(taskNodeAddress(record.target)) === record) {
        field.text.destroy();
        field.wrapper.remove();
        record.comments.delete(line);
      }
  }
  update(options: TaskSearchTreeRenderOptions): void {
    this.#cancel();
    for (const record of this.#records.values()) record.desired = false;
    const plan = this.#prepare(options);
    let done = false;
    let resolve!: (outcome: TaskRenderOutcome) => void;
    this.settled = new Promise((r) => {
      resolve = r;
    });
    const finish = (outcome: TaskRenderOutcome): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(outcome);
    };
    const commit = (): void => {
      if (done || !this.#live || options.textOptions.isCurrent?.() === false) return;
      if (this.#commit(plan)) finish({ type: 'ready' });
    };
    const blur = (): void => {
      this.#host.ownerDocument.defaultView?.queueMicrotask(commit);
    };
    const cleanup = (): void => {
      this.#host.removeEventListener('focusout', blur);
      this.#baseTextHost.removeEventListener('focusout', blur);
    };
    this.#host.addEventListener('focusout', blur);
    this.#baseTextHost.addEventListener('focusout', blur);
    this.#cancel = () => {
      if (done) return;
      this.#cancelPreparation(plan);
      finish({ type: 'cancelled' });
    };
    const failed = (error: unknown): void => {
      this.#cancelPreparation(plan);
      finish({ type: 'failed', error });
      options.textOptions.onRenderFailure?.(error);
    };
    void Promise.all(plan.updates.map((update) => update.ready)).then((outcomes) => {
      if (done) return;
      const failure = outcomes.find((outcome) => outcome.type !== 'ready');
      if (failure !== undefined) {
        this.#cancelPreparation(plan);
        finish(failure);
      } else commit();
    }, failed);
    commit();
    options.track({ settled: this.settled, cancel: this.#cancel });
  }
  destroy(): void {
    this.#live = false;
    this.#cancel();
    for (const record of this.#records.values()) releaseEntry(record, this.#owner);
    this.#records.clear();
    this.#context.remove();
    this.#base.remove();
    this.#parent.removeChild(this.#owner);
  }
}
export function mountTaskSearchTree(
  host: HTMLElement,
  baseTextHost: HTMLElement,
  options: TaskSearchTreeRenderOptions,
): TaskSearchTreeMount {
  return new RetainedSearchTree(host, baseTextHost, options);
}
export function renderTaskSearchTree(
  host: HTMLElement,
  baseTextHost: HTMLElement,
  options: TaskSearchTreeRenderOptions,
): void {
  const mount = mountTaskSearchTree(host, baseTextHost, options);
  options.textOptions.component.register(() => {
    mount.destroy();
  });
}
