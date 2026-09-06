import { describe, expect, it, vi } from 'vitest';
import { AppState, type AppStateData } from '../src/app/AppState';
import type { TaskNodeSnapshot } from '../src/tasks';
import { expectDefined, subtask, task, taskComment } from './helpers';

function inspectorLocation(title: string, children: readonly string[] = []): TaskNodeSnapshot {
  const root = task({
    title,
    tags: ['#original'],
    comments: [taskComment({ date: '2026-09-05' })],
  });
  const path = children.map((child) => subtask({ title: child }));
  let parent: TaskNodeSnapshot['node'] = root;
  let target: TaskNodeSnapshot['target'] = { type: 'task', ref: root.ref };
  for (const child of path) {
    Object.assign(child, { ref: { ...child.ref, parent: target } });
    Object.assign(parent, { subtasks: [child] });
    parent = child;
    target = { type: 'subtask', ref: child.ref };
  }
  return { root, path, node: parent, target };
}

describe('AppState dependency history', () => {
  it('restores whole structural frames across two dependency hops', () => {
    const state = new AppState();
    const a = inspectorLocation('A', ['A.1', 'A.1.a']);
    const b = inspectorLocation('B', ['B.2']);
    const c = inspectorLocation('C');
    const original = [a.root, ...a.path];
    state.set('taskStack', original);

    state.openInspectorDependency(b);
    expect(state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
    state.openInspectorDependency(c);
    expect(state.get('taskStack').map((node) => node.title)).toEqual(['C']);
    expect(state.get('inspectorBackStack')).toHaveLength(2);
    expect(state.backInspectorDependency()).toBe(true);
    expect(state.get('taskStack')).toEqual([b.root, ...b.path]);
    expect(state.backInspectorDependency()).toBe(true);
    expect(state.get('taskStack')).toEqual(original);
    expect(state.backInspectorDependency()).toBe(false);
  });

  it('detaches and deeply freezes saved frames and dependency destinations', () => {
    const state = new AppState();
    const a = inspectorLocation('A', ['A.1']);
    const b = inspectorLocation('B', ['B.2']);
    const original = [a.root, ...a.path];
    state.set('taskStack', original);
    state.openInspectorDependency(b);
    const frames = state.get('inspectorBackStack');
    const saved = expectDefined(frames[0]);
    const savedRoot = expectDefined(saved.taskStack[0]);
    const timestamp = expectDefined(savedRoot.comments[0]?.timestamp);
    expect(Reflect.set(savedRoot, 'title', 'tampered')).toBe(false);
    expect(Reflect.set(savedRoot.ref, 'revision', 'tampered')).toBe(false);
    expect(Reflect.set(savedRoot.tags, '0', '#tampered')).toBe(false);
    expect(Reflect.set(timestamp, 'raw', 'tampered')).toBe(false);
    expect(Reflect.set(saved.taskStack, '0', b.root)).toBe(false);
    expect(Reflect.set(saved, 'taskStack', [])).toBe(false);
    expect(Reflect.set(frames, '0', { taskStack: [] })).toBe(false);
    expect(Reflect.set(state.get('taskStack'), '0', a.root)).toBe(false);
    expect(Reflect.set(expectDefined(state.get('taskStack')[1]), 'title', 'tampered')).toBe(false);

    Object.assign(a.root, { title: 'changed source' });
    Object.assign(expectDefined(a.path[0]), { title: 'changed child' });
    Object.assign(expectDefined(a.root.comments[0]?.timestamp), { raw: 'changed timestamp' });
    Object.assign(b.root, { title: 'changed destination' });
    original.length = 0;
    expect(state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
    state.backInspectorDependency();
    expect(state.get('taskStack').map((node) => node.title)).toEqual(['A', 'A.1']);
    expect(state.get('taskStack')[0]?.comments[0]?.timestamp?.raw).toBe('2026-09-05');
  });

  it.each(['another', 'same', 'close'] as const)(
    'resets history on an ordinary %s selection',
    (kind) => {
      const state = new AppState();
      state.set('taskStack', [inspectorLocation('A').root]);
      state.openInspectorDependency(inspectorLocation('B'));
      let next = state.get('taskStack');
      if (kind === 'close') next = [];
      if (kind === 'another') next = [task({ title: 'D' })];
      state.set('taskStack', next);
      expect(state.get('inspectorBackStack')).toEqual([]);
      expect(state.backInspectorDependency()).toBe(false);
      expect(state.get('taskStack')).toBe(next);
    },
  );

  it('preserves history for structural navigation and proven selection refresh', () => {
    const state = new AppState();
    state.set('taskStack', [inspectorLocation('A').root]);
    const b = inspectorLocation('B', ['B.2']);
    state.openInspectorDependency(b);
    const saved = state.get('inspectorBackStack');
    state.updateInspectorSelection([b.root]);
    state.updateInspectorSelection([b.root, ...b.path]);
    expect(state.get('inspectorBackStack')).toBe(saved);
    expect(state.backInspectorDependency()).toBe(true);
    expect(state.get('taskStack').map((node) => node.title)).toEqual(['A']);
  });

  it('publishes history and destination together once per navigation even inside a batch', () => {
    const state = new AppState();
    state.set('taskStack', [inspectorLocation('A').root]);
    const observations: unknown[] = [];
    state.on('taskStack', () =>
      observations.push({
        title: state.get('taskStack')[0]?.title,
        frames: state.get('inspectorBackStack').map((frame) => frame.taskStack[0]?.title),
      }),
    );
    const commits = vi.fn();
    state.onCommit(commits);
    state.batch(() => {
      state.openInspectorDependency(inspectorLocation('B'));
    });
    state.backInspectorDependency();
    expect(observations).toEqual([
      { title: 'B', frames: ['A'] },
      { title: 'A', frames: [] },
    ]);
    expect(commits).toHaveBeenCalledTimes(2);
    for (const [changed] of commits.mock.calls) {
      expect(changed).toEqual(new Set(['taskStack', 'inspectorBackStack']));
    }
  });

  it('rejects reentrant dependency navigation without partially changing either stack', () => {
    const state = new AppState();
    state.set('taskStack', [inspectorLocation('A').root]);
    state.on('mode', () => {
      state.openInspectorDependency(inspectorLocation('B'));
    });
    expect(() => {
      state.set('mode', 'calendar');
    }).toThrow('during notification delivery');
    expect(state.get('taskStack')[0]?.title).toBe('A');
    expect(state.get('inspectorBackStack')).toEqual([]);
  });

  it('atomically restores a validated live frame and detaches its supplied snapshots', () => {
    const state = new AppState();
    const original = inspectorLocation('A', ['A.1']);
    state.set('taskStack', [original.root, ...original.path]);
    state.openInspectorDependency(inspectorLocation('B'));
    const current = inspectorLocation('Live A', ['Live A.1']);
    const commits = vi.fn(() => ({
      stack: state.get('taskStack').map((node) => node.title),
      history: state.get('inspectorBackStack').length,
    }));
    state.onCommit(commits);
    expect(state.backInspectorDependency([current.root, ...current.path])).toBe(true);
    expect(commits).toHaveReturnedWith({ stack: ['Live A', 'Live A.1'], history: 0 });
    expect(commits).toHaveBeenCalledOnce();
    Object.assign(current.root, { title: 'mutated caller' });
    expect(state.get('taskStack')[0]?.title).toBe('Live A');
    expect(Object.isFrozen(state.get('taskStack')[0]?.ref)).toBe(true);
  });

  it('keeps the current selection and history when a supplied live frame is invalid', () => {
    const state = new AppState();
    state.set('taskStack', [inspectorLocation('A').root]);
    const b = inspectorLocation('B', ['B.2']);
    state.openInspectorDependency(b);
    const current = state.get('taskStack');
    const history = state.get('inspectorBackStack');
    expect(state.backInspectorDependency([...b.path])).toBe(false);
    expect(state.get('taskStack')).toBe(current);
    expect(state.get('inspectorBackStack')).toBe(history);
  });

  it('maintains live history immutably without changing the current frame or emitting no-ops', () => {
    const state = new AppState();
    const a = inspectorLocation('A', ['A.1']);
    state.set('taskStack', [a.root, ...a.path]);
    state.openInspectorDependency(inspectorLocation('B'));
    const history = state.get('inspectorBackStack');
    const current = state.get('taskStack');
    const commits = vi.fn();
    state.onCommit(commits);
    state.updateInspectorHistoryFrames(history);
    state.updateInspectorHistoryFrames([{ taskStack: [a.root, ...a.path] }]);
    expect(commits).not.toHaveBeenCalled();
    const live = inspectorLocation('Live A', ['Live A.1']);
    state.updateInspectorHistoryFrames([{ taskStack: [live.root, ...live.path] }]);
    expect(commits).toHaveBeenCalledOnce();
    expect(commits).toHaveBeenCalledWith(new Set(['inspectorBackStack']));
    expect(state.get('taskStack')).toBe(current);
    expect(history[0]?.taskStack[0]?.title).toBe('A');
    Object.assign(live.root, { title: 'caller mutation' });
    expect(state.get('inspectorBackStack')[0]?.taskStack[0]?.title).toBe('Live A');
    expect(Object.isFrozen(state.get('inspectorBackStack')[0]?.taskStack[0]?.ref)).toBe(true);
    state.on('mode', () => {
      state.updateInspectorHistoryFrames(history);
    });
    expect(() => {
      state.set('mode', 'calendar');
    }).toThrow('during notification delivery');
    expect(state.get('inspectorBackStack')[0]?.taskStack[0]?.title).toBe('Live A');
  });

  it('opens from an empty selection and treats the already selected target as a no-op', () => {
    const state = new AppState();
    const b = inspectorLocation('B', ['B.2']);
    state.openInspectorDependency(b);
    expect(state.get('inspectorBackStack')).toEqual([]);
    const selected = state.get('taskStack');
    state.openInspectorDependency(b);
    expect(state.get('taskStack')).toBe(selected);
    expect(state.get('inspectorBackStack')).toEqual([]);
  });

  it('rejects invalid destination paths and discards invalid externally supplied frames', () => {
    const state = new AppState();
    const a = inspectorLocation('A');
    const b = inspectorLocation('B', ['B.2']);
    state.set('taskStack', [a.root]);
    state.openInspectorDependency({ ...b, root: a.root });
    expect(state.get('taskStack')).toEqual([a.root]);
    const frames = [{ taskStack: [] }, { taskStack: [...b.path] }, { taskStack: [a.root] }];
    state.set('inspectorBackStack', frames);
    frames.length = 0;
    expect(state.get('inspectorBackStack')).toEqual([{ taskStack: [a.root] }]);
    expect(Object.isFrozen(state.get('inspectorBackStack')[0]?.taskStack[0]?.ref)).toBe(true);
  });
});

describe('AppState', () => {
  it('returns initial values', () => {
    const s = new AppState();
    expect(s.get('mode')).toBe('tasks');
    expect(s.get('selectedList')).toBe('today');
    expect(s.get('taskStack')).toEqual([]);
    expect(s.get('centerFilter')).toBe('');
    expect(s.get('searchQuery')).toBe('');
    expect(s.get('projectsPanel')).toEqual({ view: 'list' });
  });

  it('notifies on projectsPanel change with a fresh object', () => {
    const s = new AppState();
    const cb = vi.fn();
    s.on('projectsPanel', cb);
    s.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    expect(cb).toHaveBeenCalledOnce();
    expect(s.get('projectsPanel')).toEqual({ view: 'dashboard', path: 'Projects/A.md' });
  });

  it('accepts a project selection', () => {
    const s = new AppState();
    s.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    expect(s.get('selectedList')).toEqual({ type: 'project', path: 'Projects/A.md' });
  });

  it('set updates value', () => {
    const s = new AppState();
    s.set('mode', 'calendar');
    expect(s.get('mode')).toBe('calendar');
  });

  it('on fires listener when value changes', () => {
    const s = new AppState();
    const cb = vi.fn();
    s.on('mode', cb);
    s.set('mode', 'search');
    expect(cb).toHaveBeenCalledWith('search', 'tasks');
  });

  it('on does not fire when value is unchanged', () => {
    const s = new AppState();
    const cb = vi.fn();
    s.on('mode', cb);
    s.set('mode', 'tasks'); // same as initial
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe stops listener', () => {
    const s = new AppState();
    const cb = vi.fn();
    const off = s.on('mode', cb);
    off();
    s.set('mode', 'calendar');
    expect(cb).not.toHaveBeenCalled();
  });

  it('multiple listeners on same key all fire', () => {
    const s = new AppState();
    const a = vi.fn();
    const b = vi.fn();
    s.on('centerFilter', a);
    s.on('centerFilter', b);
    s.set('centerFilter', 'hello');
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('listeners on different keys do not cross-fire', () => {
    const s = new AppState();
    const cb = vi.fn();
    s.on('searchQuery', cb);
    s.set('centerFilter', 'hello');
    expect(cb).not.toHaveBeenCalled();
  });

  // --- Edge cases (Phase 1 coverage) ---

  it('fires when taskStack is set to a new array equal in content (reference inequality)', () => {
    const s = new AppState();
    const cb = vi.fn();
    s.on('taskStack', cb);
    s.set('taskStack', []);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- repeated assignment is the behavior under test
    s.set('taskStack', []); // new ref, empty
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not fire when taskStack is set to the same reference', () => {
    const s = new AppState();
    const cb = vi.fn();
    const arr: never[] = [];
    s.on('taskStack', cb);
    s.set('taskStack', arr);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- identical-reference assignment is the behavior under test
    s.set('taskStack', arr); // same ref
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('round-trips a selectedList object variant { type: tag, tag }', () => {
    const s = new AppState();
    const sel = { type: 'tag', tag: 'work' } as const;
    s.set('selectedList', sel);
    expect(s.get('selectedList')).toEqual(sel);
  });

  it('round-trips a selectedList object variant { type: group, groupId }', () => {
    const s = new AppState();
    const sel = { type: 'group', groupId: 'g1' } as const;
    s.set('selectedList', sel);
    expect(s.get('selectedList')).toEqual(sel);
  });

  it('finishes standalone siblings and one commit before rethrowing a listener error', () => {
    const s = new AppState();
    const trace: string[] = [];
    const commits: Array<ReadonlySet<keyof AppStateData>> = [];
    s.on('mode', () => {
      trace.push('throwing');
      throw new Error('boom');
    });
    s.on('mode', () => trace.push('sibling'));
    s.onCommit((changed) => {
      trace.push('commit');
      commits.push(changed);
    });

    expect(() => {
      s.set('mode', 'calendar');
    }).toThrow('boom');
    expect(trace).toEqual(['throwing', 'sibling', 'commit']);
    expect(s.get('mode')).toBe('calendar');
    expect(commits).toEqual([new Set(['mode'])]);
    expect(Object.isFrozen(commits[0])).toBe(true);
  });

  it('snapshots listener membership during standalone key delivery', () => {
    const s = new AppState();
    const trace: string[] = [];
    const added = (): void => {
      trace.push('added');
    };
    let removeSibling = (): void => {};
    s.on('mode', () => {
      trace.push('first');
      removeSibling();
      s.on('mode', added);
    });
    removeSibling = s.on('mode', () => trace.push('removed'));

    s.set('mode', 'calendar');
    expect(trace).toEqual(['first', 'removed']);

    trace.length = 0;
    s.set('mode', 'search');
    expect(trace).toEqual(['first', 'added']);
  });

  it('rejects a standalone listener write before mutation and still commits once', () => {
    const s = new AppState();
    const sibling = vi.fn();
    const commits: Array<ReadonlySet<keyof AppStateData>> = [];
    s.on('mode', () => {
      s.set('centerFilter', 'listener-write');
    });
    s.on('mode', sibling);
    s.onCommit((changed) => commits.push(changed));

    expect(() => {
      s.set('mode', 'calendar');
    }).toThrow('Cannot set AppState.centerFilter during notification delivery');

    expect(s.get('mode')).toBe('calendar');
    expect(s.get('centerFilter')).toBe('');
    expect(sibling).toHaveBeenCalledOnce();
    expect(commits).toEqual([new Set(['mode'])]);
  });

  it('unsubscribe is idempotent (safe to call twice)', () => {
    const s = new AppState();
    const cb = vi.fn();
    const off = s.on('mode', cb);
    off();
    off();
    s.set('mode', 'search');
    expect(cb).not.toHaveBeenCalled();
  });

  it('re-adding a listener after unsubscribe works', () => {
    const s = new AppState();
    const cb = vi.fn();
    const off = s.on('mode', cb);
    off();
    s.on('mode', cb);
    s.set('mode', 'calendar');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('draggingTaskNode initialises as null', () => {
    const s = new AppState();
    expect(s.get('draggingTaskNode')).toBeNull();
  });

  it('detaches a canonical drag payload and clears it without affecting selection or history', () => {
    const s = new AppState();
    const location = inspectorLocation('A', ['A.1']);
    s.set('taskStack', [location.root]);
    s.openInspectorDependency(inspectorLocation('B'));
    const selection = s.get('taskStack');
    const history = s.get('inspectorBackStack');
    s.set('draggingTaskNode', { source: 'inspector-subtask', task: location });
    const payload = expectDefined(s.get('draggingTaskNode'));
    Object.assign(location.root, { title: 'Changed' });
    expect(payload.task.root.title).toBe('A');
    expect(payload.task.node).toBe(payload.task.path[0]);
    expect(Reflect.set(payload.task.target.ref, 'relativeLine', 999)).toBe(false);
    expect(Reflect.set(payload, 'source', 'center-card')).toBe(false);
    s.set('draggingTaskNode', null);
    expect(s.get('draggingTaskNode')).toBeNull();
    expect(s.get('taskStack')).toBe(selection);
    expect(s.get('inspectorBackStack')).toBe(history);
  });

  it('detaches and deeply freezes relation evidence with the canonical dragged node', () => {
    const s = new AppState();
    const task = inspectorLocation('A', ['A.1']);
    const dependent = inspectorLocation('B').target;
    const relation = {
      blocker: task.target,
      dependent,
      dependencyId: 'first',
      direction: 'blocked-by' as const,
    };
    s.set('draggingTaskNode', { source: 'inspector-relation', task, relation });
    const payload = expectDefined(s.get('draggingTaskNode'));
    if (payload.source !== 'inspector-relation') throw new Error('Missing relation');
    Object.assign(relation, { dependencyId: 'changed' });
    Object.assign(dependent.ref, { line: 100 });
    expect(payload.relation.dependencyId).toBe('first');
    expect(payload.relation.dependent.ref).not.toEqual(dependent.ref);
    expect(Reflect.set(payload.relation.blocker.ref, 'relativeLine', 100)).toBe(false);
    expect(payload.task.node).toBe(payload.task.path[0]);
  });

  it('draggingTag initialises as null', () => {
    const s = new AppState();
    expect(s.get('draggingTag')).toBeNull();
  });

  it('draggingTag can be set to a tag string and back to null', () => {
    const s = new AppState();
    s.set('draggingTag', '#task/next');
    expect(s.get('draggingTag')).toBe('#task/next');
    s.set('draggingTag', null);
    expect(s.get('draggingTag')).toBeNull();
  });

  it('centerListViewState defaults to today defaults', () => {
    const s = new AppState();
    const state = s.get('centerListViewState');
    expect(state.groupBy).toBe('date');
    expect(state.sortBy).toEqual({ field: 'date', dir: 'asc' });
    expect(state.statusGroups).toEqual(['todo', 'in-progress']);
    expect(state.filters).toEqual([]);
  });

  describe('batching', () => {
    it('updates reads synchronously while deferring key notifications until commit', () => {
      const s = new AppState();
      const trace: string[] = [];
      s.on('mode', (next, prev) => trace.push(`mode:${prev}->${next}`));

      s.batch(() => {
        s.set('mode', 'calendar');
        expect(s.get('mode')).toBe('calendar');
        expect(trace).toEqual([]);
      });

      expect(trace).toEqual(['mode:tasks->calendar']);
    });

    it('commits only after the outermost nested batch finishes', () => {
      const s = new AppState();
      const trace: string[] = [];
      s.on('mode', () => trace.push('mode'));
      s.onCommit(() => trace.push('commit'));

      s.batch(() => {
        s.set('mode', 'calendar');
        s.batch(() => {
          s.set('mode', 'search');
        });
        expect(trace).toEqual([]);
      });

      expect(trace).toEqual(['mode', 'commit']);
    });

    it('notifies each key with its first previous and final next value', () => {
      const s = new AppState();
      const cb = vi.fn();
      s.on('mode', cb);

      s.batch(() => {
        for (const mode of ['calendar', 'search', 'projects'] as const) s.set('mode', mode);
      });

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('projects', 'tasks');
    });

    it('notifies keys in deterministic first-write order', () => {
      const s = new AppState();
      const trace: string[] = [];
      s.on('centerFilter', () => trace.push('centerFilter'));
      s.on('mode', () => trace.push('mode'));
      s.on('searchQuery', () => trace.push('searchQuery'));

      s.batch(() => {
        const changes = [
          (): void => {
            s.set('centerFilter', 'first');
          },
          (): void => {
            s.set('mode', 'calendar');
          },
          (): void => {
            s.set('centerFilter', 'final');
          },
          (): void => {
            s.set('searchQuery', 'last');
          },
        ];
        for (const apply of changes) apply();
      });

      expect(trace).toEqual(['centerFilter', 'mode', 'searchQuery']);
    });

    it('notifies a changed key only once per outer batch', () => {
      const s = new AppState();
      const cb = vi.fn();
      s.on('centerFilter', cb);

      s.batch(() => {
        for (const value of ['a', 'b']) s.set('centerFilter', value);
        s.batch(() => {
          s.set('centerFilter', 'c');
        });
      });

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('c', '');
    });

    it('fires one commit callback with all changed keys per outer batch', () => {
      const s = new AppState();
      const commits: Array<ReadonlySet<string>> = [];
      s.onCommit((changed) => commits.push(new Set(changed)));

      s.batch(() => {
        s.set('mode', 'calendar');
        s.batch(() => {
          s.set('centerFilter', 'focus');
        });
        s.set('mode', 'search');
      });

      expect(commits).toEqual([new Set(['mode', 'centerFilter'])]);
    });

    it('fires one commit callback with no changed keys for an empty outer batch', () => {
      const s = new AppState();
      const cb = vi.fn();
      s.onCommit(cb);

      s.batch(() => {
        s.batch(() => {});
      });

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(new Set());
    });

    it('omits a net-zero key while still committing the outer batch', () => {
      const s = new AppState();
      const keyListener = vi.fn();
      const commits: Array<ReadonlySet<keyof AppStateData>> = [];
      s.on('mode', keyListener);
      s.onCommit((changed) => commits.push(changed));

      s.batch(() => {
        for (const mode of ['calendar', 'tasks'] as const) s.set('mode', mode);
      });

      expect(keyListener).not.toHaveBeenCalled();
      expect(commits).toEqual([new Set()]);
    });

    it('fires one commit callback for a changed standalone set', () => {
      const s = new AppState();
      const cb = vi.fn();
      s.onCommit(cb);

      s.set('mode', 'calendar');

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(new Set(['mode']));
    });

    it('preserves unchanged standalone set behavior without a commit', () => {
      const s = new AppState();
      const keyListener = vi.fn();
      const commitListener = vi.fn();
      s.on('mode', keyListener);
      s.onCommit(commitListener);

      s.set('mode', 'tasks');

      expect(keyListener).not.toHaveBeenCalled();
      expect(commitListener).not.toHaveBeenCalled();
    });

    it('rejects a listener write to another pending key before mutation and commits once', () => {
      const s = new AppState();
      const trace: string[] = [];
      const mutator = vi.fn(() => {
        trace.push('mutator');
        s.set('centerFilter', 'listener-final');
      });
      const sibling = vi.fn((next: string) => {
        trace.push(`sibling:${next}:${s.get('mode')}`);
      });
      const filter = vi.fn((next: string, prev: string) => {
        trace.push(`filter:${prev}->${next}:${s.get('centerFilter')}`);
      });
      const commits: Array<ReadonlySet<keyof AppStateData>> = [];
      s.on('mode', mutator);
      s.on('mode', sibling);
      s.on('centerFilter', filter);
      s.onCommit((changed) => {
        trace.push('commit');
        commits.push(changed);
      });

      let thrown: unknown;
      try {
        s.batch(() => {
          s.set('mode', 'calendar');
          s.set('centerFilter', 'queued');
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        name: 'AppStateReentrantMutationError',
        message: 'Cannot set AppState.centerFilter during notification delivery',
      });
      expect(mutator).toHaveBeenCalledOnce();
      expect(sibling).toHaveBeenCalledOnce();
      expect(filter).toHaveBeenCalledOnce();
      expect(filter).toHaveBeenCalledWith('queued', '');
      expect(s.get('centerFilter')).toBe('queued');
      expect(trace).toEqual([
        'mutator',
        'sibling:calendar:calendar',
        'filter:->queued:queued',
        'commit',
      ]);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toEqual(new Set(['mode', 'centerFilter']));
      expect(Object.isFrozen(commits[0])).toBe(true);
    });

    it('rejects a listener rewrite of the current key without a second notification', () => {
      const s = new AppState();
      const mutator = vi.fn(() => {
        s.set('mode', 'search');
      });
      const siblingObservations: Array<[string, string, string]> = [];
      const sibling = vi.fn((next: string, prev: string) => {
        siblingObservations.push([next, prev, s.get('mode')]);
      });
      const commits: Array<ReadonlySet<keyof AppStateData>> = [];
      s.on('mode', mutator);
      s.on('mode', sibling);
      s.onCommit((changed) => commits.push(changed));

      let thrown: unknown;
      try {
        s.batch(() => {
          s.set('mode', 'calendar');
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ name: 'AppStateReentrantMutationError' });
      expect(mutator).toHaveBeenCalledOnce();
      expect(sibling).toHaveBeenCalledOnce();
      expect(siblingObservations).toEqual([['calendar', 'tasks', 'calendar']]);
      expect(s.get('mode')).toBe('calendar');
      expect(commits).toEqual([new Set(['mode'])]);
    });

    it('continues later key notifications and the outer commit before rethrowing', () => {
      const s = new AppState();
      const trace: string[] = [];
      s.on('mode', () => {
        trace.push('mode:throw');
        throw new Error('mode failed');
      });
      s.on('mode', () => trace.push('mode:sibling'));
      s.on('centerFilter', () => trace.push('centerFilter'));
      s.onCommit(() => trace.push('commit'));

      expect(() => {
        s.batch(() => {
          s.set('mode', 'calendar');
          s.set('centerFilter', 'final');
        });
      }).toThrow('mode failed');

      expect(trace).toEqual(['mode:throw', 'mode:sibling', 'centerFilter', 'commit']);
      expect(s.get('centerFilter')).toBe('final');
    });

    it('snapshots batched key listeners for add and remove mutations during delivery', () => {
      const s = new AppState();
      const trace: string[] = [];
      const added = (): void => {
        trace.push('added');
      };
      let removeSibling = (): void => {};
      s.on('mode', () => {
        trace.push('first');
        removeSibling();
        s.on('mode', added);
      });
      removeSibling = s.on('mode', () => trace.push('removed'));

      s.batch(() => {
        s.set('mode', 'calendar');
      });
      expect(trace).toEqual(['first', 'removed']);

      trace.length = 0;
      s.batch(() => {
        s.set('mode', 'search');
      });
      expect(trace).toEqual(['first', 'added']);
    });

    it('snapshots batched commit listeners for add and remove mutations during delivery', () => {
      const s = new AppState();
      const trace: string[] = [];
      const added = (): void => {
        trace.push('added');
      };
      let removeSibling = (): void => {};
      s.onCommit(() => {
        trace.push('first');
        removeSibling();
        s.onCommit(added);
      });
      removeSibling = s.onCommit(() => trace.push('removed'));

      s.batch(() => {
        s.set('mode', 'calendar');
      });
      expect(trace).toEqual(['first', 'removed']);

      trace.length = 0;
      s.batch(() => {
        s.set('mode', 'search');
      });
      expect(trace).toEqual(['first', 'added']);
    });

    it('rejects commit-listener mutation and finishes one immutable commit snapshot', () => {
      const s = new AppState();
      const trace: string[] = [];
      const commits: Array<ReadonlySet<keyof AppStateData>> = [];
      s.onCommit((changed) => {
        trace.push('mutator');
        commits.push(changed);
        s.set('centerFilter', 'blocked');
      });
      s.onCommit(() => trace.push('sibling'));

      let thrown: unknown;
      try {
        s.batch(() => {
          s.set('mode', 'calendar');
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        name: 'AppStateReentrantMutationError',
        message: 'Cannot set AppState.centerFilter during notification delivery',
      });
      expect(trace).toEqual(['mutator', 'sibling']);
      expect(s.get('centerFilter')).toBe('');
      expect(commits).toHaveLength(1);
      expect(commits[0]).toEqual(new Set(['mode']));
      expect(Object.isFrozen(commits[0])).toBe(true);
    });

    it('gives commit listeners an immutable snapshot that stays stable across later commits', () => {
      const s = new AppState();
      const snapshots: Array<ReadonlySet<string>> = [];
      let mutationError: unknown;
      s.onCommit((changed) => {
        snapshots.push(changed);
        if (snapshots.length !== 1) return;
        try {
          (changed as Set<keyof AppStateData>).add('searchQuery');
        } catch (error) {
          mutationError = error;
        }
      });

      s.set('mode', 'calendar');
      s.set('centerFilter', 'next');

      expect(mutationError).toBeInstanceOf(TypeError);
      expect(Object.isFrozen(snapshots[0])).toBe(true);
      expect([...expectDefined(snapshots[0])]).toEqual(['mode']);
      expect([...expectDefined(snapshots[1])]).toEqual(['centerFilter']);
    });
  });
});
