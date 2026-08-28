import type { ProjectAction } from '../../projects/types';
import {
  taskReconciliationKey,
  type TaskQueryApi,
  type TaskRef,
  type TaskResolution,
} from '../../tasks';
import type { LogicalCollectionMove } from './BoundedWindow';

type ProjectTaskCollectionNotice = 'focused-item-removed' | 'focused-item-ambiguous';

export interface ProjectTaskCollectionEffect {
  readonly focus?: TaskRef | null;
  readonly scrollTo?: TaskRef | null;
  readonly inspect?: TaskRef | null;
  readonly notice?: ProjectTaskCollectionNotice;
}

function copyRef(ref: TaskRef): TaskRef {
  return { filePath: ref.filePath, line: ref.line, revision: ref.revision };
}

function keyOf(ref: TaskRef): string {
  return taskReconciliationKey(ref);
}

function uniqueActions(actions: readonly ProjectAction[]): readonly ProjectAction[] {
  const keys = new Set<string>();
  for (const action of actions) {
    const key = keyOf(action.task.ref);
    if (keys.has(key)) throw new RangeError(`Duplicate Project Task identity: ${key}`);
    keys.add(key);
  }
  return [...actions];
}

type Resolution =
  | { readonly type: 'resolved'; readonly key: string }
  | { readonly type: 'hidden'; readonly key: string }
  | { readonly type: 'missing' }
  | { readonly type: 'ambiguous' };

/**
 * The sole logical authority for Project Tasks/List/Board/Timeline. It owns complete ProjectActions and stable
 * TaskRefs; mounted rows and the geometry window are intentionally not consulted for selection,
 * focus, inspector continuity, or bulk inputs.
 */
export class ProjectTaskCollectionSession {
  private actions: readonly ProjectAction[];
  private actionByKey = new Map<string, ProjectAction>();
  private universeByKey = new Map<string, ProjectAction>();
  private selected = new Set<string>();
  private anchorKey: string | null = null;
  private focusKey: string | null = null;
  private inspectorKey: string | null = null;
  private restoreFocus = false;
  private effect: ProjectTaskCollectionEffect | null = null;

  constructor(
    actions: readonly ProjectAction[] = [],
    private resolver: TaskQueryApi['resolve'] = (ref) => ({ type: 'not-found', ref }),
  ) {
    this.actions = uniqueActions(actions);
    this.rebuildIndex();
    this.universeByKey = new Map(this.actionByKey);
  }

  setResolver(resolver: TaskQueryApi['resolve']): void {
    this.resolver = resolver;
  }

  orderedActions(): readonly ProjectAction[] {
    return this.actions;
  }

  selectedActions(): readonly ProjectAction[] {
    return this.actions.filter((action) => this.selected.has(keyOf(action.task.ref)));
  }

  selectedCount(): number {
    return this.selected.size;
  }

  isSelected(ref: TaskRef): boolean {
    return this.selected.has(keyOf(ref));
  }

  focusedRef(): TaskRef | null {
    return this.refForKey(this.focusKey);
  }

  inspectorRef(): TaskRef | null {
    return this.refForKey(this.inspectorKey);
  }

  setInspector(ref: TaskRef | null): boolean {
    if (ref === null) {
      this.inspectorKey = null;
      this.effect = null;
      return true;
    }
    const key = keyOf(ref);
    if (!this.universeByKey.has(key)) {
      this.inspectorKey = null;
      this.effect = null;
      return false;
    }
    if (this.inspectorKey === key) return true;
    this.inspectorKey = key;
    this.focusKey = key;
    this.anchorKey = key;
    this.restoreFocus = true;
    const target = this.refForKey(key)!;
    this.effect = { focus: target, scrollTo: target };
    return true;
  }

  actionForRef(ref: TaskRef): ProjectAction | undefined {
    return this.universeByKey.get(keyOf(ref));
  }

  selectOnly(ref: TaskRef): boolean {
    const key = keyOf(ref);
    if (!this.actionByKey.has(key)) return false;
    this.selected = new Set([key]);
    this.anchorKey = key;
    this.setFocus(key, false);
    return true;
  }

  toggle(ref: TaskRef): boolean {
    const key = keyOf(ref);
    if (!this.actionByKey.has(key)) return false;
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
    this.anchorKey = key;
    this.setFocus(key, false);
    return true;
  }

  /** Retains semantic focus without changing selection or inspector ownership. */
  focusOnly(ref: TaskRef): boolean {
    const key = keyOf(ref);
    if (!this.actionByKey.has(key)) return false;
    this.focusKey = key;
    this.restoreFocus = true;
    this.effect = null;
    return true;
  }

  extendTo(ref: TaskRef): boolean {
    const key = keyOf(ref);
    const focusIndex = this.indexOf(key);
    if (focusIndex < 0) return false;
    const anchor = this.anchorKey ?? this.focusKey ?? key;
    const anchorIndex = this.indexOf(anchor);
    const from = Math.min(anchorIndex < 0 ? focusIndex : anchorIndex, focusIndex);
    const to = Math.max(anchorIndex < 0 ? focusIndex : anchorIndex, focusIndex);
    this.selected = new Set(
      this.actions.slice(from, to + 1).map((action) => keyOf(action.task.ref)),
    );
    this.anchorKey = anchorIndex < 0 ? key : anchor;
    this.setFocus(key, false);
    return true;
  }

  activate(ref: TaskRef): boolean {
    const key = keyOf(ref);
    if (!this.actionByKey.has(key)) return false;
    this.selected.clear();
    this.anchorKey = key;
    this.focusKey = key;
    this.inspectorKey = key;
    this.restoreFocus = true;
    const target = this.refForKey(key)!;
    this.effect = { focus: target, scrollTo: target, inspect: target };
    return true;
  }

  clearSelection(): void {
    this.selected.clear();
    this.anchorKey = this.focusKey;
  }

  moveFocus(move: LogicalCollectionMove): TaskRef | null {
    if (this.actions.length === 0) {
      this.clearEmptyState();
      return null;
    }
    const currentIndex = this.focusKey === null ? -1 : this.indexOf(this.focusKey);
    let targetIndex: number;
    if (move.type === 'home') targetIndex = 0;
    else if (move.type === 'end') targetIndex = this.actions.length - 1;
    else if (move.type === 'page') {
      const base = currentIndex < 0 ? 0 : currentIndex;
      targetIndex = base + Math.trunc(move.pages) * Math.max(1, Math.trunc(move.pageSize));
    } else {
      let base = currentIndex;
      if (currentIndex < 0) base = move.delta < 0 ? this.actions.length : -1;
      targetIndex = base + Math.trunc(move.delta);
    }
    targetIndex = Math.max(0, Math.min(this.actions.length - 1, targetIndex));
    const targetKey = keyOf(this.actions[targetIndex]!.task.ref);
    if (move.extendSelection) {
      const anchor = this.anchorKey ?? this.focusKey ?? targetKey;
      const anchorIndex = Math.max(0, this.indexOf(anchor));
      const from = Math.min(anchorIndex, targetIndex);
      const to = Math.max(anchorIndex, targetIndex);
      this.selected = new Set(
        this.actions.slice(from, to + 1).map((action) => keyOf(action.task.ref)),
      );
      this.anchorKey = anchor;
    } else {
      this.selected.clear();
      this.anchorKey = targetKey;
    }
    this.focusKey = targetKey;
    this.inspectorKey = targetKey;
    this.restoreFocus = true;
    const target = this.refForKey(targetKey)!;
    this.effect = { focus: target, scrollTo: target, inspect: target };
    return target;
  }

  reconcile(actions: readonly ProjectAction[], universe: readonly ProjectAction[] = actions): void {
    const previousActions = this.actions;
    const previousUniverseByKey = this.universeByKey;
    const previousIndex = new Map(
      previousActions.map((action, index) => [keyOf(action.task.ref), index] as const),
    );
    const previousByKey = this.actionByKey;
    const nextActions = uniqueActions(actions);
    const nextByKey = new Map(
      nextActions.map((action) => [keyOf(action.task.ref), action] as const),
    );
    const nextUniverse = uniqueActions(universe);
    const nextUniverseByKey = new Map(
      nextUniverse.map((action) => [keyOf(action.task.ref), action] as const),
    );
    const resolutionCache = new Map<string, Resolution>();
    const resolve = (key: string): Resolution => {
      const cached = resolutionCache.get(key);
      if (cached) return cached;
      if (nextByKey.has(key)) {
        const exact = { type: 'resolved' as const, key };
        resolutionCache.set(key, exact);
        return exact;
      }
      if (nextUniverseByKey.has(key)) {
        const hidden = { type: 'hidden' as const, key };
        resolutionCache.set(key, hidden);
        return hidden;
      }
      const oldAction = previousByKey.get(key) ?? previousUniverseByKey.get(key);
      if (!oldAction) return { type: 'missing' };
      const result = this.resolver(oldAction.task.ref);
      const resolved = this.resolveIntoNext(result, nextByKey, nextUniverseByKey);
      resolutionCache.set(key, resolved);
      return resolved;
    };

    const remap = (keys: Iterable<string>): Set<string> => {
      const result = new Set<string>();
      for (const key of keys) {
        const resolution = resolve(key);
        if (resolution.type === 'resolved' || resolution.type === 'hidden') {
          result.add(resolution.key);
        }
      }
      return result;
    };

    const oldFocusKey = this.focusKey;
    const oldInspectorKey = this.inspectorKey;
    const focusResolution = oldFocusKey === null ? null : resolve(oldFocusKey);
    const inspectorResolution = oldInspectorKey === null ? null : resolve(oldInspectorKey);

    this.actions = nextActions;
    this.actionByKey = nextByKey;
    this.universeByKey = nextUniverseByKey;
    this.selected = remap(this.selected);
    const remappedAnchor = this.anchorKey === null ? null : resolve(this.anchorKey);
    this.anchorKey =
      remappedAnchor?.type === 'resolved' || remappedAnchor?.type === 'hidden'
        ? remappedAnchor.key
        : null;

    if (focusResolution?.type === 'ambiguous') {
      this.selected.clear();
      this.focusKey = null;
      this.inspectorKey = null;
      this.anchorKey = null;
      this.restoreFocus = false;
      this.effect = {
        focus: null,
        scrollTo: null,
        inspect: null,
        notice: 'focused-item-ambiguous',
      };
      return;
    }

    if (focusResolution?.type === 'hidden') {
      this.focusKey = focusResolution.key;
      this.inspectorKey =
        inspectorResolution?.type === 'resolved' || inspectorResolution?.type === 'hidden'
          ? inspectorResolution.key
          : null;
      this.restoreFocus = false;
      this.effect = null;
      return;
    }

    if (focusResolution?.type === 'resolved') {
      this.focusKey = focusResolution.key;
      this.inspectorKey =
        inspectorResolution?.type === 'resolved' || inspectorResolution?.type === 'hidden'
          ? inspectorResolution.key
          : null;
      const focusChanged = focusResolution.key !== oldFocusKey;
      const inspectorChanged = this.inspectorKey !== oldInspectorKey;
      if (focusChanged || inspectorChanged) {
        const focused = this.refForKey(this.focusKey)!;
        this.effect = {
          focus: focused,
          scrollTo: focused,
          inspect: this.refForKey(this.inspectorKey),
        };
      }
      return;
    }

    if (oldFocusKey !== null) {
      const oldIndex = previousIndex.get(oldFocusKey) ?? 0;
      const next = nextActions[Math.min(oldIndex, Math.max(0, nextActions.length - 1))];
      this.focusKey = next ? keyOf(next.task.ref) : null;
      this.inspectorKey = null;
      this.anchorKey = this.focusKey;
      this.restoreFocus = this.focusKey !== null;
      this.effect = {
        focus: this.refForKey(this.focusKey),
        scrollTo: this.refForKey(this.focusKey),
        inspect: null,
        notice: 'focused-item-removed',
      };
      return;
    }

    this.focusKey = null;
    this.inspectorKey =
      inspectorResolution?.type === 'resolved' || inspectorResolution?.type === 'hidden'
        ? inspectorResolution.key
        : null;
    if (nextActions.length === 0 && nextUniverse.length === 0) this.clearEmptyState();
  }

  consumeEffect(): ProjectTaskCollectionEffect | null {
    const effect = this.effect;
    this.effect = null;
    return effect;
  }

  restoreEffect(): ProjectTaskCollectionEffect | null {
    const focus =
      this.restoreFocus && this.focusKey !== null && this.actionByKey.has(this.focusKey)
        ? this.refForKey(this.focusKey)
        : null;
    const inspect =
      this.inspectorKey !== null && this.actionByKey.has(this.inspectorKey)
        ? this.refForKey(this.inspectorKey)
        : null;
    if (!focus && !inspect) return null;
    return {
      ...(focus ? { focus, scrollTo: focus } : {}),
      ...(inspect ? { inspect } : {}),
    };
  }

  intentionalBlur(): void {
    this.restoreFocus = false;
    this.effect = null;
  }

  shouldRestoreFocus(): boolean {
    return this.restoreFocus;
  }

  reset(): void {
    this.actions = [];
    this.actionByKey.clear();
    this.universeByKey.clear();
    this.selected.clear();
    this.anchorKey = null;
    this.focusKey = null;
    this.inspectorKey = null;
    this.restoreFocus = false;
    this.effect = null;
  }

  private resolveIntoNext(
    result: TaskResolution,
    nextByKey: ReadonlyMap<string, ProjectAction>,
    nextUniverseByKey: ReadonlyMap<string, ProjectAction>,
  ): Resolution {
    if (result.type === 'ambiguous' || result.type === 'uncertain' || result.type === 'visual') {
      return { type: 'ambiguous' };
    }
    if (result.type === 'not-found') return { type: 'missing' };
    const candidate = result.type === 'rebased' ? result.current : result.task;
    const key = keyOf(candidate.ref);
    if (nextByKey.has(key)) return { type: 'resolved', key };
    return nextUniverseByKey.has(key) ? { type: 'hidden', key } : { type: 'missing' };
  }

  private setFocus(key: string, inspect: boolean): void {
    this.focusKey = key;
    if (inspect) this.inspectorKey = key;
    this.restoreFocus = true;
    const target = this.refForKey(key)!;
    this.effect = {
      focus: target,
      scrollTo: target,
      ...(inspect && { inspect: target }),
    };
  }

  private refForKey(key: string | null): TaskRef | null {
    if (key === null) return null;
    const ref = (this.actionByKey.get(key) ?? this.universeByKey.get(key))?.task.ref;
    return ref ? copyRef(ref) : null;
  }

  private indexOf(key: string): number {
    return this.actions.findIndex((action) => keyOf(action.task.ref) === key);
  }

  private rebuildIndex(): void {
    this.actionByKey = new Map(
      this.actions.map((action) => [keyOf(action.task.ref), action] as const),
    );
  }

  private clearEmptyState(): void {
    this.selected.clear();
    this.anchorKey = null;
    this.focusKey = null;
    this.inspectorKey = null;
    this.restoreFocus = false;
  }
}
