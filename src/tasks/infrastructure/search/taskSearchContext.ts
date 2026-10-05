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
  readonly children: TaskSearchTreeNode[];
  readonly evidence: TaskSearchEvidence[];
  nextChild: number;
}
function frame(current: ContextNode, matching: Matching): Frame {
  const evidence: TaskSearchEvidence[] = [];
  for (const record of nodeEvidence(current, matching))
    if (record !== undefined) evidence.push(record);
  return { ...current, evidence, children: [], nextChild: 0 };
}
/** Detached exact roots only. Display/source evidence confers no TaskTextTarget/edit authority. */
export function taskSearchContext(
  root: TaskSnapshot,
  address: TaskSearchAddress,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
): TaskSearchContext {
  const matching = { query, segment };
  const first = frame({ node: root, address: { ...address, childLines: [] } }, matching);
  const pending = [first];
  while (pending.length > 0) {
    const current = pending[pending.length - 1];
    if (current === undefined) break;
    const child = current.node.subtasks[current.nextChild++];
    if (child !== undefined) {
      pending.push(
        frame(
          {
            node: child,
            address: {
              ...current.address,
              childLines: [...current.address.childLines, child.ref.relativeLine],
            },
          },
          matching,
        ),
      );
    } else {
      pending.pop();
      const parent = pending[pending.length - 1];
      if (parent !== undefined && (current.evidence.length > 0 || current.children.length > 0))
        parent.children.push({
          address: current.address,
          evidence: current.evidence,
          children: current.children,
        });
    }
  }
  return { tree: { address: first.address, evidence: first.evidence, children: first.children } };
}
