import type { SourceRange } from '../../../markdown/inlineCode';
import {
  projectSearchText,
  searchTextSourceRanges,
  type SearchTextValue,
} from '../../../markdown/searchText';
import {
  matchSearchText,
  type PreparedSearchQuery,
  type SearchTextMatch,
  type SearchWordSegmenter,
} from '../../domain/searchMatchPolicy';
import { taskSearchMetadata } from '../../domain/taskSearchMetadata';
import type { TaskSearchAddress } from '../../domain/taskSearchTypes';
import type { SubtaskSnapshot, TaskSnapshot } from '../../domain/types';

type TaskSearchContextField =
  'title' | 'description' | 'comment' | 'tag' | 'metadata' | 'link-target';
export interface TaskSearchEvidence {
  readonly address: TaskSearchAddress;
  readonly field: TaskSearchContextField;
  readonly commentLine?: number;
  readonly text: string;
  readonly markdown?: string;
  readonly provenance:
    | {
        readonly type: 'field';
        readonly field: 'title' | 'description' | 'comment';
        readonly commentLine?: number;
        readonly visibleRange: SourceRange;
        readonly sourceRanges: readonly SourceRange[];
      }
    | { readonly type: 'semantic'; readonly key: string };
  readonly matches: ReadonlyArray<
    SearchTextMatch & { readonly sourceRanges: readonly SourceRange[] }
  >;
}
export interface TaskSearchTreeNode {
  readonly address: TaskSearchAddress;
  readonly evidence: readonly TaskSearchEvidence[];
  readonly children: readonly TaskSearchTreeNode[];
}
export interface TaskSearchContext {
  readonly tree: TaskSearchTreeNode;
}
interface ContextNode {
  readonly node: TaskSnapshot | SubtaskSnapshot;
  readonly address: TaskSearchAddress;
}
interface ContextField {
  readonly field: 'title' | 'description' | 'comment';
  readonly markdown: string;
  readonly commentLine?: number;
}
function* fields(node: ContextNode['node']): Generator<ContextField> {
  yield { field: 'title', markdown: node.markdownTitle };
  if (node.description !== undefined) yield { field: 'description', markdown: node.description };
  for (const comment of node.comments)
    yield { field: 'comment', markdown: comment.text, commentLine: comment.ref.relativeLine };
}
interface Matching {
  readonly query: PreparedSearchQuery;
  readonly segment: SearchWordSegmenter;
}
function fieldEvidence(
  current: ContextNode,
  field: ContextField,
  value: SearchTextValue,
  options: Matching & { target: boolean },
): TaskSearchEvidence | undefined {
  const { query, segment, target } = options;
  const matches = matchSearchText(value.text, query, segment).map((match) => ({
    ...match,
    sourceRanges: searchTextSourceRanges(value, { from: match.start, to: match.end }),
  }));
  if (matches.length === 0) return undefined;
  const visibleRange = { from: 0, to: value.text.length };
  return {
    address: current.address,
    field: target ? 'link-target' : field.field,
    ...(field.commentLine === undefined ? {} : { commentLine: field.commentLine }),
    text: value.text,
    markdown: field.markdown,
    provenance: {
      type: 'field',
      field: field.field,
      ...(field.commentLine === undefined ? {} : { commentLine: field.commentLine }),
      visibleRange,
      sourceRanges: searchTextSourceRanges(value, visibleRange),
    },
    matches,
  };
}
function semanticEvidence(
  current: ContextNode,
  value: { field: 'tag' | 'metadata'; key: string; text: string },
  { query, segment }: Matching,
): TaskSearchEvidence | undefined {
  const { field, key, text } = value;
  const matches = matchSearchText(text, query, segment).map((match) => ({
    ...match,
    sourceRanges: [],
  }));
  if (matches.length === 0) return undefined;
  return {
    address: current.address,
    field,
    text,
    provenance: { type: 'semantic', key },
    matches,
  };
}
function* nodeEvidence(
  current: ContextNode,
  matching: Matching,
): Generator<TaskSearchEvidence | undefined> {
  for (const field of fields(current.node)) {
    const projection = projectSearchText(
      field.markdown,
      field.field === 'title' ? 'title' : 'prose',
    );
    yield fieldEvidence(current, field, projection.visible, { ...matching, target: false });
    for (const target of projection.destinations)
      yield fieldEvidence(current, field, target, { ...matching, target: true });
  }
  for (const tag of current.node.tags)
    yield semanticEvidence(current, { field: 'tag', key: tag, text: tag }, matching);
  for (const [key, text] of taskSearchMetadata(current.node))
    yield semanticEvidence(current, { field: 'metadata', key, text }, matching);
}
interface Frame extends ContextNode {
  readonly parent?: Frame;
  readonly children: TaskSearchTreeNode[];
  readonly evidence: TaskSearchEvidence[];
}
interface PendingFrame {
  readonly frame: Frame;
  readonly finish: boolean;
}
function enqueueChildren(pending: PendingFrame[], frame: Frame): void {
  for (let i = frame.node.subtasks.length - 1; i >= 0; i--) {
    const child = frame.node.subtasks[i];
    if (child === undefined) continue;
    pending.push({
      finish: false,
      frame: {
        node: child,
        parent: frame,
        address: {
          ...frame.address,
          childLines: [...frame.address.childLines, child.ref.relativeLine],
        },
        children: [],
        evidence: [],
      },
    });
  }
}
function collectNodeEvidence(frame: Frame, matching: Matching): void {
  for (const evidence of nodeEvidence(frame, matching))
    if (evidence !== undefined) frame.evidence.push(evidence);
}
function retainFrame(frame: Frame): void {
  if (frame.parent !== undefined && (frame.evidence.length > 0 || frame.children.length > 0))
    frame.parent.children.push({
      address: frame.address,
      evidence: frame.evidence,
      children: frame.children,
    });
}
/** Detached exact roots only. Display/source evidence confers no TaskTextTarget/edit authority. */
export function taskSearchContext(
  root: TaskSnapshot,
  address: TaskSearchAddress,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
): TaskSearchContext {
  const first: Frame = {
    node: root,
    address: { ...address, childLines: [] },
    children: [],
    evidence: [],
  };
  const pending: PendingFrame[] = [{ frame: first, finish: false }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    const { frame, finish } = entry;
    if (finish) retainFrame(frame);
    else {
      collectNodeEvidence(frame, { query, segment });
      pending.push({ frame, finish: true });
      enqueueChildren(pending, frame);
    }
  }
  return { tree: { address: first.address, evidence: first.evidence, children: first.children } };
}
