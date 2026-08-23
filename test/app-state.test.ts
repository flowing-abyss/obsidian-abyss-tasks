import { describe, expect, it, vi } from 'vitest';
import { AppState, type AppStateData } from '../src/app/AppState';
import { task } from './helpers';

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
    // eslint-disable-next-line sonarjs/no-element-overwrite
    s.set('taskStack', []); // new ref, empty
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not fire when taskStack is set to the same reference', () => {
    const s = new AppState();
    const cb = vi.fn();
    const arr: never[] = [];
    s.on('taskStack', cb);
    s.set('taskStack', arr);
    // eslint-disable-next-line sonarjs/no-element-overwrite
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

  it('propagates a standalone listener error immediately and skips siblings and commit', () => {
    const s = new AppState();
    const trace: string[] = [];
    s.on('mode', () => {
      trace.push('throwing');
      throw new Error('boom');
    });
    s.on('mode', () => trace.push('sibling'));
    s.onCommit(() => trace.push('commit'));

    expect(() => s.set('mode', 'calendar')).toThrow('boom');
    expect(trace).toEqual(['throwing']);
    expect(s.get('mode')).toBe('calendar');
  });

  it('uses live listener membership during standalone key delivery', () => {
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
    expect(trace).toEqual(['first', 'added']);

    trace.length = 0;
    s.set('mode', 'search');
    expect(trace).toEqual(['first', 'added']);
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

  it('draggingTask initialises as null', () => {
    const s = new AppState();
    expect(s.get('draggingTask')).toBeNull();
  });

  it('draggingTask can be set to a task and back to null', () => {
    const s = new AppState();
    const t = task({ source: { filePath: 'a.md' } });
    s.set('draggingTask', t);
    expect(s.get('draggingTask')).toBe(t);
    s.set('draggingTask', null);
    expect(s.get('draggingTask')).toBeNull();
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
        s.set('mode', 'calendar');
        s.set('mode', 'search');
        s.set('mode', 'projects');
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
        s.set('centerFilter', 'first');
        s.set('mode', 'calendar');
        s.set('centerFilter', 'final');
        s.set('searchQuery', 'last');
      });

      expect(trace).toEqual(['centerFilter', 'mode', 'searchQuery']);
    });

    it('notifies a changed key only once per outer batch', () => {
      const s = new AppState();
      const cb = vi.fn();
      s.on('centerFilter', cb);

      s.batch(() => {
        s.set('centerFilter', 'a');
        s.set('centerFilter', 'b');
        s.batch(() => s.set('centerFilter', 'c'));
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
        s.batch(() => s.set('centerFilter', 'focus'));
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
        s.set('mode', 'calendar');
        s.set('mode', 'tasks');
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
      const commits: ReadonlySet<keyof AppStateData>[] = [];
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
      const mutator = vi.fn(() => s.set('mode', 'search'));
      const siblingObservations: Array<[string, string, string]> = [];
      const sibling = vi.fn((next: string, prev: string) => {
        siblingObservations.push([next, prev, s.get('mode')]);
      });
      const commits: ReadonlySet<keyof AppStateData>[] = [];
      s.on('mode', mutator);
      s.on('mode', sibling);
      s.onCommit((changed) => commits.push(changed));

      let thrown: unknown;
      try {
        s.batch(() => s.set('mode', 'calendar'));
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

      expect(() =>
        s.batch(() => {
          s.set('mode', 'calendar');
          s.set('centerFilter', 'final');
        }),
      ).toThrow('mode failed');

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

      s.batch(() => s.set('mode', 'calendar'));
      expect(trace).toEqual(['first', 'removed']);

      trace.length = 0;
      s.batch(() => s.set('mode', 'search'));
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

      s.batch(() => s.set('mode', 'calendar'));
      expect(trace).toEqual(['first', 'removed']);

      trace.length = 0;
      s.batch(() => s.set('mode', 'search'));
      expect(trace).toEqual(['first', 'added']);
    });

    it('rejects commit-listener mutation and finishes one immutable commit snapshot', () => {
      const s = new AppState();
      const trace: string[] = [];
      const commits: ReadonlySet<keyof AppStateData>[] = [];
      s.onCommit((changed) => {
        trace.push('mutator');
        commits.push(changed);
        s.set('centerFilter', 'blocked');
      });
      s.onCommit(() => trace.push('sibling'));

      let thrown: unknown;
      try {
        s.batch(() => s.set('mode', 'calendar'));
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
      const snapshots: ReadonlySet<string>[] = [];
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
      expect([...snapshots[0]!]).toEqual(['mode']);
      expect([...snapshots[1]!]).toEqual(['centerFilter']);
    });
  });
});
