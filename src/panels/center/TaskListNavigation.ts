import type { AppState, ListSelection } from '../../app/AppState';
import {
  sameTaskNodeRef,
  TaskSearchError,
  type TaskNodeRef,
  type TaskReadProjectionApi,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSnapshot,
} from '../../tasks';
import { taskSelectionRefPath, type TaskSelectionNode } from '../../ui/taskSelection';
import type { PanelNavigationActions } from '../../views/panelNavigation';

export interface TaskListNavigationRequest {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}
export interface ResolvedTaskListTarget {
  readonly address: TaskSearchAddress;
  readonly root: TaskSnapshot;
  readonly path: TaskSelectionNode[];
}
async function findTaskListAddress(
  reads: TaskReadProjectionApi,
  target: TaskNodeRef,
  generation: number,
  request: TaskListNavigationRequest,
): Promise<TaskSearchAddress | undefined> {
  const current = (): boolean => !request.signal.aborted && request.isCurrent();
  let rootRef = target;
  const childLines: number[] = [];
  while (rootRef.type === 'subtask') {
    childLines.unshift(rootRef.ref.relativeLine);
    rootRef = rootRef.ref.parent;
  }
  let address: TaskSearchAddress | undefined;
  for await (const batch of reads.organization(
    { expectedGeneration: generation, filePath: rootRef.ref.filePath },
    request.signal,
  )) {
    if (!current()) return undefined;
    if (batch.generation !== generation) throw new TaskSearchError('stale', 'Task changed');
    const record = batch.items.find(
      (item) =>
        item.source.filePath === rootRef.ref.filePath && item.source.line === rootRef.ref.line,
    );
    if (record !== undefined) {
      address = { ...record.address, childLines };
      break;
    }
  }
  return address;
}

export async function resolveTaskListRef(options: {
  readonly reads: TaskReadProjectionApi;
  readonly search: TaskSearchApi;
  readonly target: TaskNodeRef;
  readonly generation: number;
  readonly request: TaskListNavigationRequest;
}): Promise<ResolvedTaskListTarget | undefined> {
  const { reads, search, target, generation, request } = options;
  const current = (): boolean => !request.signal.aborted && request.isCurrent();
  if (!current()) return undefined;
  const address = await findTaskListAddress(reads, target, generation, request);
  if (!current()) return undefined;
  if (address === undefined) throw new TaskSearchError('stale', 'Task changed');
  const hydrated = (await search.resolveHits([{ address, score: 0 }], request.signal))[0];
  if (!current()) return undefined;
  if (hydrated === undefined || !sameTaskNodeRef(hydrated.task.target, target))
    throw new TaskSearchError('stale', 'Task changed');
  const path = taskSelectionRefPath(hydrated.task.root, target);
  if (path === undefined) throw new TaskSearchError('stale', 'Task changed');
  return { address, root: hydrated.task.root, path };
}
export async function navigateTaskListTarget(
  source:
    | { readonly type: 'address'; readonly address: TaskSearchAddress }
    | { readonly type: 'resolved'; readonly target: ResolvedTaskListTarget },
  options: {
    readonly search: TaskSearchApi;
    readonly state: AppState;
    readonly navigation: PanelNavigationActions;
    readonly request: TaskListNavigationRequest;
    readonly destination: (root: TaskSnapshot) => ListSelection;
    readonly installReveal: (address: TaskSearchAddress, selection: ListSelection) => void;
    readonly onCommitted: () => void;
  },
): Promise<void> {
  const { request, search, navigation, state } = options;
  const current = (): boolean => !request.signal.aborted && request.isCurrent();
  if (!current()) return;
  let target: ResolvedTaskListTarget;
  if (source.type === 'resolved') target = source.target;
  else {
    const hydrated = (
      await search.resolveHits([{ address: source.address, score: 0 }], request.signal)
    )[0];
    if (!current()) return;
    if (hydrated === undefined) throw new TaskSearchError('stale', 'Task changed');
    const path = taskSelectionRefPath(hydrated.task.root, hydrated.task.target);
    if (path === undefined) throw new TaskSearchError('stale', 'Task changed');
    target = { address: source.address, root: hydrated.task.root, path };
  }
  if (!current()) return;
  const selection = options.destination(target.root);
  navigation.openList(selection, {
    canCommit: current,
    commit: () => {
      options.installReveal(target.address, selection);
      state.set('taskStack', target.path);
      options.onCommitted();
    },
  });
}
