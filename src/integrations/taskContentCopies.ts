import type { ApiResultV1, ContentSourceCopyV1 } from '../../api';
import {
  sameTaskNodeRef,
  taskNodeRootRef,
  taskTreeNodes,
  type CommentRef,
  type TaskNodeRef,
  type TaskSourceCopyEvidence,
} from '../tasks';
import type { TaskApiContext } from './TaskApiProvider';
import { contentFailure, readNodeFor, type TreeProjection } from './taskTreeApi';

export interface ContentCopyOrigin {
  readonly source: string;
  readonly root: ContentSourceCopyV1['sourceRoot'];
  readonly tasks: readonly string[];
  readonly comments: readonly string[];
}
export function copyOrigin(
  context: TaskApiContext,
  evidence: TaskSourceCopyEvidence,
  source: string,
  entry: TreeProjection['entry'],
): ApiResultV1<ContentCopyOrigin> {
  const root = evidence.sourceRoot;
  const origins = [...taskTreeNodes(root)];
  const handles = new Map<string, string>();
  for (const node of origins) {
    const identity = context.identities.project(
      readNodeFor(context, node),
      context.reads.capture().semanticsRevision,
    );
    if (!identity.ok) return identity;
    handles.set(JSON.stringify(node.target), identity.value.target);
  }
  const rootHandle = handles.get(JSON.stringify({ type: 'task', ref: root.ref }));
  if (rootHandle === undefined) return contentFailure();
  const rootIdentity = context.identities.lookup(rootHandle);
  if (!rootIdentity.ok) return rootIdentity;
  const tasks = evidence.tasks.map((p) => handles.get(JSON.stringify(p.source)));
  if (tasks.some((t) => t === undefined)) return contentFailure();
  const comments = evidence.comments.map((p) =>
    entry('comment', handles.get(JSON.stringify(p.source.parent)) ?? '', p.source),
  );
  return {
    ok: true,
    value: {
      source,
      root: { target: rootHandle, revision: rootIdentity.value.revision },
      tasks: tasks as string[],
      comments,
    },
  };
}
export function projectSourceCopy(
  evidence: TaskSourceCopyEvidence,
  origin: ContentCopyOrigin,
  task: (ref: TaskNodeRef) => string | undefined,
  comment: (ref: CommentRef) => string | undefined,
): ContentSourceCopyV1 {
  const tasks = evidence.tasks.flatMap((pair, i) => {
    const destinationTarget = task(pair.destination),
      sourceTarget = origin.tasks[i];
    return destinationTarget === undefined || sourceTarget === undefined
      ? []
      : [{ sourceTarget, destinationTarget }];
  });
  const comments = evidence.comments.flatMap((pair, i) => {
    const destinationTarget = comment(pair.destination),
      destinationParent = task(pair.destination.parent),
      sourceTarget = origin.comments[i];
    return destinationTarget === undefined ||
      destinationParent === undefined ||
      sourceTarget === undefined
      ? []
      : [{ sourceTarget, destinationTarget, destinationParent }];
  });
  const complete =
    tasks.length === evidence.tasks.length && comments.length === evidence.comments.length;
  return {
    type: evidence.type,
    source: origin.source,
    sourceRoot: origin.root,
    state: complete ? evidence.state : 'unavailable',
    tasks,
    comments,
  };
}
export function acceptedSourceComment(
  context: TaskApiContext,
  value: object | undefined,
): CommentRef | undefined {
  if (value === undefined) return undefined;
  const ref = value as CommentRef;
  const root = taskNodeRootRef(ref.parent);
  const found = context.reads.node({
    filePath: root.filePath,
    rootRevision: root.revision,
    rootLine: root.line,
    nodeOffset: 0,
  });
  if (
    found.type !== 'ok' ||
    !context.reads.canDisclose({
      filePath: root.filePath,
      rootRevision: root.revision,
      rootLine: root.line,
      nodeOffset: 0,
    })
  )
    return undefined;
  for (const owner of taskTreeNodes(found.value.value.root)) {
    if (!sameTaskNodeRef(owner.target, ref.parent)) continue;
    const comment = owner.node.comments.find((c) => JSON.stringify(c.ref) === JSON.stringify(ref));
    if (comment !== undefined) return comment.ref;
  }
  return undefined;
}
