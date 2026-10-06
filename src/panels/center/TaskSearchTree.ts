import type { App } from 'obsidian';
import type { LinkToken } from '../../markdown/links';
import { projectSearchText } from '../../markdown/searchText';
import type {
  SubtaskSnapshot,
  TaskSearchEvidence,
  TaskSearchTreeNode,
  TaskSnapshot,
  TaskTextTarget,
} from '../../tasks';
import { markSearchText } from '../../ui/markSearchText';
import type { RenderTaskTextOptions } from '../../ui/renderTaskText';
import {
  renderSubtaskTitleText,
  renderTaskCommentText,
  renderTaskDescriptionText,
  type TaskNodeTextMount,
} from '../../ui/taskNodeText';
import type { TaskTextRender } from '../../ui/taskRenderScope';
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
  readonly search: TaskCardSearchPresentation;
  readonly textOptions: Omit<
    RenderTaskTextOptions,
    'app' | 'sourcePath' | 'presentation' | 'onRendered' | 'onEditLink'
  >;
  readonly track: (render: TaskTextRender) => void;
  readonly editLink: (target: TaskTextTarget, occurrence: number, token: LinkToken) => void;
  readonly renderChildStatus: (host: HTMLElement, child: SubtaskSnapshot) => void;
  readonly renderSemantics: (
    host: HTMLElement,
    node: TaskSelectionNode,
    evidence: readonly TaskSearchSemanticEvidence[],
  ) => void;
}
interface TreeEntry {
  readonly tree: TaskSearchTreeNode;
  readonly node: TaskSelectionNode;
  readonly host: HTMLElement;
}
function fieldOptions(
  options: TaskSearchTreeRenderOptions,
  markdown: string,
  target: TaskTextTarget,
  presentation: 'title' | 'markdown',
): RenderTaskTextOptions {
  return {
    ...options.textOptions,
    app: options.app,
    sourcePath: options.root.source.filePath,
    presentation,
    onEditLink: (occurrence, token) => {
      options.editLink(target, occurrence, token);
    },
    onRendered: (element) => {
      markSearchText(
        element,
        projectSearchText(markdown, presentation === 'title' ? 'title' : 'prose'),
        options.search.query,
        options.search.segment,
      );
    },
  };
}
function activate(
  element: HTMLElement,
  tree: TaskSearchTreeNode,
  options: TaskSearchTreeRenderOptions,
): void {
  options.textOptions.component.registerDomEvent(element, 'click', (event) => {
    const target = event.target;
    const win = element.ownerDocument.defaultView;
    if (
      win !== null &&
      target instanceof win.Element &&
      target.closest('a, button, .abyss-status-control, .abyss-task-tag, .abyss-task-date') !== null
    )
      return;
    event.stopPropagation();
    options.search.onActivate(tree.address);
  });
}
function trackField(
  entry: TreeEntry,
  options: TaskSearchTreeRenderOptions,
  mount: TaskNodeTextMount,
): void {
  options.track(mount.render);
  activate(mount.element, entry.tree, options);
}
function renderHeader(entry: TreeEntry, options: TaskSearchTreeRenderOptions): HTMLElement {
  const { node, host, tree } = entry;
  if ('source' in node) return host;
  const row = host.createDiv({ cls: 'abyss-subtask-row' });
  mountTaskSearchKeyboardActivation(row, options.textOptions.component, () => {
    options.search.onActivate(tree.address);
  });
  options.renderChildStatus(row, node);
  const body = row.createDiv({ cls: 'abyss-subtask-content' });
  const titleRow = body.createDiv({ cls: 'abyss-subtask-title-row' });
  const title = renderSubtaskTitleText(
    titleRow,
    node,
    fieldOptions(
      options,
      node.markdownTitle,
      { type: 'title', target: taskNodeRef(node) },
      'title',
    ),
  );
  trackField(entry, options, title);
  options.renderSemantics(
    body.createDiv({ cls: 'abyss-task-meta-right' }),
    node,
    tree.evidence.filter(isTaskSearchSemanticEvidence),
  );
  return body;
}
function contributingComments(
  entry: TreeEntry,
  options: TaskSearchTreeRenderOptions,
  body: HTMLElement,
): TaskSelectionNode['comments'] {
  const { node, tree } = entry;
  let hasDescription = false;
  const lines = new Set<number>();
  for (const evidence of tree.evidence) {
    if (evidence.provenance.type !== 'field') continue;
    if (evidence.provenance.field === 'description') hasDescription = true;
    if (evidence.provenance.field === 'comment' && evidence.provenance.commentLine !== undefined)
      lines.add(evidence.provenance.commentLine);
  }
  if (hasDescription && node.description !== undefined) {
    const element = body.createDiv({ cls: 'abyss-task-desc' });
    trackField(entry, options, {
      element,
      render: renderTaskDescriptionText(
        element,
        node.description,
        fieldOptions(
          options,
          node.description,
          { type: 'description', target: taskNodeRef(node) },
          'markdown',
        ),
      ),
    });
  }
  return node.comments.filter((comment) => lines.has(comment.ref.relativeLine));
}
function renderBody(
  entry: TreeEntry,
  options: TaskSearchTreeRenderOptions,
  body: HTMLElement,
): TreeEntry[] {
  const { tree, node, host } = entry;
  const entries = [
    ...contributingComments(entry, options, body).map((comment) => ({
      line: comment.ref.relativeLine,
      comment,
    })),
    ...tree.children.map((childTree) => ({
      line: childTree.address.childLines[childTree.address.childLines.length - 1] ?? -1,
      childTree,
    })),
  ].sort((a, b) => a.line - b.line);
  const childNodes = new Map(node.subtasks.map((child) => [child.ref.relativeLine, child]));
  const children: TreeEntry[] = [];
  for (const item of entries) {
    if ('comment' in item) {
      const row = host.createDiv({ cls: 'abyss-comment-row' });
      const mount = renderTaskCommentText(
        row,
        item.comment.text,
        fieldOptions(
          options,
          item.comment.text,
          { type: 'comment', ref: item.comment.ref },
          'markdown',
        ),
      );
      trackField(entry, options, mount);
    } else {
      const child = childNodes.get(item.line);
      if (child !== undefined)
        children.push({
          tree: item.childTree,
          node: child,
          host: host.createDiv({ cls: 'abyss-subtask-content' }),
        });
    }
  }
  return children;
}
export function renderTaskSearchTree(
  host: HTMLElement,
  options: TaskSearchTreeRenderOptions,
): void {
  const context = host.createDiv({ cls: 'abyss-search-context' });
  const pending: TreeEntry[] = [
    { tree: options.search.context.tree, node: options.root, host: context },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    const body = renderHeader(entry, options);
    // Containers preserve source order while contents render iteratively without a depth limit.
    const children = renderBody(entry, options, body);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) pending.push(child);
    }
  }
}
