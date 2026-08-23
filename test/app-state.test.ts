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

  it('rethrows a listener error only after sibling and commit delivery complete', () => {
    const s = new AppState();
    const trace: string[] = [];
    s.on('mode', () => {
      trace.push('throwing');
      throw new Error('boom');
    });
    s.on('mode', () => trace.push('sibling'));
    s.onCommit(() => trace.push('commit'));

    expect(() => s.set('mode', 'calendar')).toThrow('boom');
    expect(trace).toEqual(['throwing', 'sibling', 'commit']);
    expect(s.get('mode')).toBe('calendar');
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

    it('folds a listener update to a pending key into one final notification and commit', () => {
      const s = new AppState();
      const filter = vi.fn((next: string) => {
        expect(next).toBe(s.get('centerFilter'));
      });
      const commits = vi.fn();
      s.on('mode', () => s.set('centerFilter', 'listener-final'));
      s.on('centerFilter', filter);
      s.onCommit(commits);

      s.batch(() => {
        s.set('mode', 'calendar');
        s.set('centerFilter', 'queued');
      });

      expect(filter).toHaveBeenCalledOnce();
      expect(filter).toHaveBeenCalledWith('listener-final', '');
      expect(commits).toHaveBeenCalledOnce();
      expect(commits).toHaveBeenCalledWith(new Set(['mode', 'centerFilter']));
    });

    it('delivers a reentrant write to the current key in a final wave before one commit', () => {
      const s = new AppState();
      const notifications: Array<[string, string]> = [];
      const commits = vi.fn();
      s.on('mode', (next, prev) => {
        notifications.push([next, prev]);
        if (next === 'calendar') s.set('mode', 'search');
      });
      s.onCommit(commits);

      s.batch(() => s.set('mode', 'calendar'));

      expect(notifications).toEqual([
        ['calendar', 'tasks'],
        ['search', 'calendar'],
      ]);
      expect(s.get('mode')).toBe('search');
      expect(commits).toHaveBeenCalledOnce();
      expect(commits).toHaveBeenCalledWith(new Set(['mode']));
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

    it('snapshots key listeners for add and remove mutations during delivery', () => {
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

    it('snapshots commit listeners for add and remove mutations during delivery', () => {
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

      s.set('mode', 'calendar');
      expect(trace).toEqual(['first', 'removed']);

      trace.length = 0;
      s.set('mode', 'search');
      expect(trace).toEqual(['first', 'added']);
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
