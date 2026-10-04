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
export interface TaskSearchExcerpt {
  readonly address: TaskSearchAddress;
  readonly field: TaskSearchContextField;
  readonly commentLine?: number;
  readonly label: string;
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
  readonly breadcrumb: readonly string[];
}
export interface TaskSearchContext {
  readonly excerpts: readonly TaskSearchExcerpt[];
}
interface ContextNode {
  readonly node: TaskSnapshot | SubtaskSnapshot;
  readonly address: TaskSearchAddress;
  readonly breadcrumb: readonly string[];
}
interface ContextField {
  readonly field: 'title' | 'description' | 'comment';
  readonly markdown: string;
  readonly commentLine?: number;
}
function* nodes(current: ContextNode): Generator<ContextNode> {
  yield current;
  for (const child of current.node.subtasks)
    yield* nodes({
      node: child,
      address: {
        ...current.address,
        childLines: [...current.address.childLines, child.ref.relativeLine],
      },
      breadcrumb: [...current.breadcrumb, child.title],
    });
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
): TaskSearchExcerpt | undefined {
  const { query, segment, target } = options;
  const matches = matchSearchText(value.text, query, segment).map((match) => ({
    ...match,
    sourceRanges: searchTextSourceRanges(value, { from: match.start, to: match.end }),
  }));
  if (matches.length === 0) return undefined;
  const visibleRange = { from: 0, to: value.text.length };
  return {
    address: current.address,
    breadcrumb: current.breadcrumb,
    field: target ? 'link-target' : field.field,
    ...(field.commentLine === undefined ? {} : { commentLine: field.commentLine }),
    label: target ? `${field.field} link target` : field.field,
    text: value.text,
    ...(target ? {} : { markdown: field.markdown }),
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
): TaskSearchExcerpt | undefined {
  const { field, key, text } = value;
  const matches = matchSearchText(text, query, segment).map((match) => ({
    ...match,
    sourceRanges: [],
  }));
  if (matches.length === 0) return undefined;
  return {
    address: current.address,
    breadcrumb: current.breadcrumb,
    field,
    label: `${field}: ${key}`,
    text,
    provenance: { type: 'semantic', key },
    matches,
  };
}
function coverage(excerpts: readonly TaskSearchExcerpt[]): number {
  return new Set(excerpts.flatMap((excerpt) => excerpt.matches.map((match) => match.queryToken)))
    .size;
}
/** Only the selected three fields and one candidate are retained, never a root/corpus context cache. */
function collect(selected: TaskSearchExcerpt[], candidate: TaskSearchExcerpt | undefined): void {
  if (candidate === undefined) return;
  if (selected.length < 3) {
    selected.push(candidate);
    return;
  }
  let best = coverage(selected),
    remove = -1;
  // Equal coverage keeps the earliest canonical fields. Among improvements remove the latest.
  for (let index = selected.length - 1; index >= 0; index--) {
    const score = coverage([...selected.filter((_, at) => at !== index), candidate]);
    if (score > best) {
      best = score;
      remove = index;
    }
  }
  if (remove >= 0) {
    selected.splice(remove, 1);
    selected.push(candidate);
  }
}
function* nodeEvidence(
  current: ContextNode,
  matching: Matching,
): Generator<TaskSearchExcerpt | undefined> {
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
/** Detached exact roots only. Display/source evidence confers no TaskTextTarget/edit authority. */
export function taskSearchContext(
  root: TaskSnapshot,
  address: TaskSearchAddress,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
): TaskSearchContext {
  const excerpts: TaskSearchExcerpt[] = [];
  for (const current of nodes({
    node: root,
    address: { ...address, childLines: [] },
    breadcrumb: [root.title],
  })) {
    for (const evidence of nodeEvidence(current, { query, segment })) collect(excerpts, evidence);
  }
  return { excerpts };
}
