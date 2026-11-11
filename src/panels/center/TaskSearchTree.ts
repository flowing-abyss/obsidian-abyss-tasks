import { Component, type App } from 'obsidian';
import { pairAnchorsToTokens, parseLinks, type LinkToken } from '../../markdown/links';
import type {
  SubtaskSnapshot,
  TaskSearchEvidence,
  TaskSearchTreeNode,
  TaskSnapshot,
  TaskTextTarget,
} from '../../tasks';
import { taskNodeAddress } from '../../tasks';
import type { RenderTaskTextOptions } from '../../ui/renderTaskText';
import { type RetainedTaskTextInput } from '../../ui/retainedTaskText';
import type { TaskRenderOutcome, TaskTextRender } from '../../ui/taskRenderScope';
import { taskNodeRef, type TaskSelectionNode } from '../../ui/taskSelection';
import {
  mountTaskTreeDisplay,
  type TaskDisplayField,
  type TaskDisplayNode,
  type TaskTreeDisplayMount,
  type TaskTreeDisplayOptions,
} from '../../ui/taskTreeDisplay';
import type { TaskCardSearchPresentation } from './TaskCardRenderer';

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
  readonly fullDescription?: boolean;
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
  readonly onChildContextMenu: (
    event: MouseEvent,
    child: SubtaskSnapshot,
    row: HTMLElement,
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

interface NativeRecord {
  readonly node: TaskSelectionNode;
  readonly tree: TaskSearchTreeNode;
  readonly options: TaskSearchTreeRenderOptions;
  current(): boolean;
}
export interface TaskSearchTreeMount {
  readonly settled: Promise<TaskRenderOutcome>;
  update(options: TaskSearchTreeRenderOptions): void;
  destroy(): void;
}
function fieldInput(
  record: NativeRecord,
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
      isCurrent: () => record.current(),
      onRenderFailure: (error) => {
        record.options.textOptions.onRenderFailure?.(error);
      },
      onEditLink: (occurrence, token) => {
        options.editLink(target, occurrence, token);
      },
    },
  };
}
function descriptionContinues(source: string): boolean {
  return source
    .split('\n')
    .slice(1)
    .some((line) => line.trim().length > 0);
}
function descriptionMode(record: NativeRecord, matched: boolean): 'hidden' | 'preview' | 'full' {
  if (matched) return 'full';
  if (record.tree !== record.options.search.context.tree || record.options.search.mode !== 'filter')
    return 'hidden';
  return record.options.fullDescription === true ? 'full' : 'preview';
}
function descriptionPresentation(record: NativeRecord): {
  markdown: string;
  preview: boolean;
  continuation: boolean;
  show: boolean;
} {
  const matched = record.tree.evidence.some(
    (evidence) =>
      evidence.provenance.type === 'field' && evidence.provenance.field === 'description',
  );
  const mode = descriptionMode(record, matched);
  const preview = mode === 'preview';
  const source = record.node.description ?? '';
  let markdown = '';
  if (mode === 'full') markdown = source;
  else if (preview) markdown = source.split('\n')[0] ?? '';
  const continuation = preview && descriptionContinues(source);
  return { markdown, preview, continuation, show: markdown !== '' || continuation };
}

function nativeField(
  record: NativeRecord,
  key: string,
  input: {
    markdown: string;
    target: TaskTextTarget;
    decoration: Pick<RetainedTaskTextInput['decoration'], 'kind' | 'continuation'>;
  },
): TaskDisplayField {
  return { key, input: fieldInput(record, input.markdown, input.target, input.decoration) };
}
function descriptionField(
  record: NativeRecord,
  key: string,
  target: ReturnType<typeof taskNodeRef>,
): Pick<TaskDisplayNode, 'description' | 'descriptionPreview'> {
  const presentation = descriptionPresentation(record);
  if (!presentation.show) return {};
  let kind: RetainedTaskTextInput['decoration']['kind'] = 'excerpt';
  if (record.options.fullDescription === true && record.tree === record.options.search.context.tree)
    kind = 'complete';
  else if (presentation.preview) kind = 'preview';
  return {
    descriptionPreview: presentation.preview,
    description: nativeField(record, `${key}:description`, {
      markdown: presentation.markdown,
      target: { type: 'description', target },
      decoration: { kind, continuation: presentation.continuation },
    }),
  };
}
function isModified(event: MouseEvent | undefined): boolean {
  return event !== undefined && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey);
}
function activate(record: NativeRecord, event: MouseEvent | undefined): void {
  if (!record.current()) return;
  const { options, tree } = record;
  if (
    options.search.mode === 'filter' &&
    (tree === options.search.context.tree || isModified(event))
  )
    return;
  event?.stopPropagation();
  options.search.onActivate(tree.address);
}
class NativeSearchTree implements TaskSearchTreeMount {
  private options: TaskSearchTreeRenderOptions;
  private readonly context: HTMLElement;
  private readonly mount: TaskTreeDisplayMount;
  private live = true;
  private latest = new Map<string, NativeRecord>();
  private readonly metadata = new WeakMap<HTMLElement, { key: string; owner: Component }>();
  constructor(
    private readonly host: HTMLElement,
    private readonly baseTextHost: HTMLElement,
    options: TaskSearchTreeRenderOptions,
  ) {
    this.options = options;
    this.context = host.createDiv({ cls: 'abyss-search-context' });
    this.mount = mountTaskTreeDisplay(this.context, this.project(options));
    this.retireWhenSettled();
    options.track({
      settled: this.settled,
      cancel: () => {
        this.mount.cancelPending();
      },
    });
  }
  private retireEmptyHost(): void {
    if (
      this.options.search.context.tree.children.length === 0 &&
      this.context.querySelector('.abyss-comment-row') === null
    )
      this.host.remove();
  }
  private retireWhenSettled(): void {
    const settled = this.mount.settled;
    void settled.then(
      (outcome) => {
        if (this.live && this.mount.settled === settled && outcome.type === 'ready')
          this.retireEmptyHost();
      },
      (error: unknown) => {
        this.options.textOptions.onRenderFailure?.(error);
      },
    );
  }
  get settled(): Promise<TaskRenderOutcome> {
    return this.mount.settled;
  }
  private node(
    tree: TaskSearchTreeNode,
    node: TaskSelectionNode,
    options: TaskSearchTreeRenderOptions,
  ): TaskDisplayNode {
    const target = taskNodeRef(node);
    const key = taskNodeAddress(target);
    const record: NativeRecord = {
      tree,
      node,
      options,
      current: () =>
        this.live &&
        this.options.textOptions.isCurrent?.() !== false &&
        this.latest.get(key) === record,
    };
    this.latest.set(key, record);
    return {
      kind: 'task',
      key,
      identity: { type: 'title', target },
      ...(tree === options.search.context.tree
        ? {}
        : {
            title: nativeField(record, `${key}:title`, {
              markdown: node.markdownTitle,
              target: { type: 'title', target },
              decoration: { kind: 'complete' },
            }),
          }),
      ...descriptionField(record, key, target),
      entries: this.entries(record, key),
      complete: true,
      done: node.status === 'done',
      onActivate: (event) => {
        activate(record, event);
      },
      onContextMenu: (event, row) => {
        if (!record.current() || 'source' in node) return;
        event.preventDefault();
        event.stopPropagation();
        options.onChildContextMenu(event, node, row);
      },
      renderHeader: (row, owner) => {
        this.renderHeader(record, key, row, owner);
      },
    };
  }
  private entries(record: NativeRecord, key: string): TaskDisplayNode['entries'] {
    const { tree, node, options } = record;
    const ordered: Array<{ line: number; value: TaskDisplayNode['entries'][number] }> = [];
    const lines = new Set(
      tree.evidence.flatMap((evidence) =>
        evidence.provenance.type === 'field' &&
        evidence.provenance.field === 'comment' &&
        evidence.provenance.commentLine !== undefined
          ? [evidence.provenance.commentLine]
          : [],
      ),
    );
    for (const comment of node.comments) {
      if (!lines.has(comment.ref.relativeLine)) continue;
      const commentKey = `${key}:comment:${comment.ref.relativeLine}`;
      ordered.push({
        line: comment.ref.relativeLine,
        value: {
          kind: 'comment',
          key: commentKey,
          field: nativeField(record, commentKey, {
            markdown: comment.text,
            target: { type: 'comment', ref: comment.ref },
            decoration: { kind: 'complete' },
          }),
        },
      });
    }
    for (const childTree of tree.children) {
      const line = childTree.address.childLines[childTree.address.childLines.length - 1];
      const child = node.subtasks.find((candidate) => candidate.ref.relativeLine === line);
      if (child !== undefined && line !== undefined)
        ordered.push({ line, value: this.node(childTree, child, options) });
    }
    ordered.sort((a, b) => a.line - b.line);
    return ordered.map((entry) => entry.value);
  }
  private currentChild(key: string): SubtaskSnapshot | undefined {
    const current = this.latest.get(key);
    return current !== undefined && current.current() && !('source' in current.node)
      ? current.node
      : undefined;
  }
  private renderHeader(
    record: NativeRecord,
    key: string,
    row: HTMLElement,
    owner: Component,
  ): void {
    const { node, tree, options } = record;
    if (!('source' in node)) options.renderChildStatus(row, node, () => this.currentChild(key));
    const evidence = tree.evidence.filter(isTaskSearchSemanticEvidence);
    const metadataKey = options.metadataKey(node, evidence);
    const previous = this.metadata.get(row);
    if (previous?.key === metadataKey) return;
    if (previous !== undefined) owner.removeChild(previous.owner);
    const metadataOwner = owner.addChild(new Component());
    row.querySelector(':scope > .abyss-task-meta-right')?.remove();
    options.renderMetadata(row, node, evidence, metadataOwner);
    this.metadata.set(row, { key: metadataKey, owner: metadataOwner });
  }
  private project(options: TaskSearchTreeRenderOptions): TaskTreeDisplayOptions {
    this.latest = new Map();
    return {
      owner: options.textOptions.component,
      roots: [this.node(options.search.context.tree, options.base, options)],
      baseTextHost: this.baseTextHost,
      isCurrent: () => this.live && this.options.textOptions.isCurrent?.() !== false,
      ...(options.textOptions.onRenderFailure === undefined
        ? {}
        : { onRenderFailure: options.textOptions.onRenderFailure }),
    };
  }
  update(options: TaskSearchTreeRenderOptions): void {
    this.options = options;
    this.mount.update(this.project(options));
    this.retireWhenSettled();
    options.track({
      settled: this.settled,
      cancel: () => {
        this.mount.cancelPending();
      },
    });
  }
  destroy(): void {
    if (!this.live) return;
    this.live = false;
    this.mount.destroy();
    this.context.remove();
  }
}
export function mountTaskSearchTree(
  host: HTMLElement,
  baseTextHost: HTMLElement,
  options: TaskSearchTreeRenderOptions,
): TaskSearchTreeMount {
  return new NativeSearchTree(host, baseTextHost, options);
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
