import { describe, expect, it } from 'vitest';
import { ProjectTaskCollectionSession } from '../src/panels/projects/ProjectTaskCollectionSession';
import type { ProjectAction } from '../src/projects/types';
import type { TaskQueryApi, TaskSnapshot } from '../src/tasks';
import { task } from './helpers';

function action(
  filePath: string,
  line: number,
  revision: string,
  title = `Task ${line}`,
): ProjectAction {
  return {
    task: task({
      title,
      ref: { filePath, line, revision },
      source: { filePath, line, originalBlock: `- [ ] ${title}` },
    }),
    projectPath: 'Projects/A.md',
    owner:
      filePath === 'Projects/A.md'
        ? { type: 'project', path: filePath }
        : { type: 'work-note', path: filePath },
    dependency:
      line === 2
        ? { type: 'blocked', prerequisites: [{ filePath, line: 0, revision: 'r0' }] }
        : { type: 'allowed' },
  };
}

function exactResolver(tasks: readonly TaskSnapshot[]): TaskQueryApi['resolve'] {
  return (ref) => {
    const current = tasks.find(
      (candidate) =>
        candidate.ref.filePath === ref.filePath &&
        candidate.ref.line === ref.line &&
        candidate.ref.revision === ref.revision,
    );
    return current
      ? { type: 'exact', task: current, basis: { observed: current } }
      : { type: 'not-found', ref };
  };
}

describe('ProjectTaskCollectionSession', () => {
  it('owns complete ProjectActions for off-window range and bulk inputs', () => {
    const actions = Array.from({ length: 100 }, (_, index) =>
      action(index < 20 ? 'Projects/A.md' : 'Work Notes/A.md', index, `r${index}`),
    );
    const session = new ProjectTaskCollectionSession(
      actions,
      exactResolver(actions.map(({ task: candidate }) => candidate)),
    );

    session.selectOnly(actions[12]!.task.ref);
    session.extendTo(actions[72]!.task.ref);

    expect(session.selectedActions()).toEqual(actions.slice(12, 73));
    expect(session.selectedActions()[2]!.owner).toBe(actions[14]!.owner);
    expect(session.selectedActions()[0]!.dependency).toBe(actions[12]!.dependency);
  });

  it('moves Home End Page and Arrow over the complete action order with typed one-shot effects', () => {
    const actions = Array.from({ length: 100 }, (_, index) =>
      action('Work Notes/A.md', index, `r${index}`),
    );
    const session = new ProjectTaskCollectionSession(
      actions,
      exactResolver(actions.map(({ task: candidate }) => candidate)),
    );
    session.activate(actions[10]!.task.ref);
    session.consumeEffect();

    session.moveFocus({ type: 'page', pages: 2, pageSize: 20, extendSelection: true });
    expect(session.focusedRef()).toEqual(actions[50]!.task.ref);
    expect(session.selectedActions()).toEqual(actions.slice(10, 51));
    expect(session.consumeEffect()).toEqual({
      focus: actions[50]!.task.ref,
      scrollTo: actions[50]!.task.ref,
      inspect: actions[50]!.task.ref,
    });
    expect(session.consumeEffect()).toBeNull();

    session.moveFocus({ type: 'end', extendSelection: false });
    expect(session.focusedRef()).toEqual(actions[99]!.task.ref);
    session.moveFocus({ type: 'home', extendSelection: false });
    expect(session.focusedRef()).toEqual(actions[0]!.task.ref);
    session.moveFocus({ type: 'step', delta: 1, extendSelection: false });
    expect(session.focusedRef()).toEqual(actions[1]!.task.ref);
  });

  it('rebases focus and inspector only through the Task query resolver', () => {
    const before = [action('Work Notes/A.md', 4, 'old'), action('Work Notes/A.md', 5, 'keep')];
    const rebased = action('Work Notes/A.md', 6, 'new');
    const after = [rebased, before[1]!];
    const session = new ProjectTaskCollectionSession(before, (ref) =>
      ref.revision === 'old'
        ? {
            type: 'rebased',
            previous: before[0]!.task,
            current: rebased.task,
            evidence: 'byte-identical-relocation',
            basis: { observed: before[0]!.task },
          }
        : exactResolver(after.map(({ task: candidate }) => candidate))(ref),
    );
    session.activate(before[0]!.task.ref);
    session.consumeEffect();

    session.reconcile(after);

    expect(session.focusedRef()).toEqual(rebased.task.ref);
    expect(session.inspectorRef()).toEqual(rebased.task.ref);
    expect(session.consumeEffect()).toEqual({
      focus: rebased.task.ref,
      scrollTo: rebased.task.ref,
      inspect: rebased.task.ref,
    });
  });

  it('retargets deletion once per update, clears an empty target, and announces a later deletion again', () => {
    const actions = [
      action('Work Notes/A.md', 0, 'r0'),
      action('Work Notes/A.md', 1, 'r1'),
      action('Work Notes/A.md', 2, 'r2'),
    ];
    let current = actions.map(({ task: candidate }) => candidate);
    const session = new ProjectTaskCollectionSession(actions, (ref) => exactResolver(current)(ref));
    session.activate(actions[1]!.task.ref);
    session.consumeEffect();

    current = [actions[0]!.task, actions[2]!.task];
    session.reconcile([actions[0]!, actions[2]!]);
    expect(session.focusedRef()).toEqual(actions[2]!.task.ref);
    expect(session.inspectorRef()).toBeNull();
    expect(session.consumeEffect()).toEqual({
      focus: actions[2]!.task.ref,
      scrollTo: actions[2]!.task.ref,
      inspect: null,
      notice: 'focused-item-removed',
    });
    expect(session.consumeEffect()).toBeNull();

    current = [actions[0]!.task, actions[1]!.task, actions[2]!.task];
    session.reconcile(actions);
    session.activate(actions[1]!.task.ref);
    session.consumeEffect();
    current = [actions[0]!.task, actions[2]!.task];
    session.reconcile([actions[0]!, actions[2]!]);
    expect(session.consumeEffect()?.notice).toBe('focused-item-removed');

    current = [];
    session.reconcile([]);
    expect(session.focusedRef()).toBeNull();
    expect(session.shouldRestoreFocus()).toBe(false);
    expect(session.consumeEffect()).toEqual({
      focus: null,
      scrollTo: null,
      inspect: null,
      notice: 'focused-item-removed',
    });
  });

  it('clears a truly ambiguous TaskRef without conflating duplicate titles', () => {
    const duplicateTitleA = action('Work Notes/A.md', 1, 'a', 'Repeated title');
    const duplicateTitleB = action('Work Notes/B.md', 1, 'b', 'Repeated title');
    const ambiguousCandidates = [
      {
        root: duplicateTitleA.task,
        target: { type: 'task' as const, ref: duplicateTitleA.task.ref },
      },
      {
        root: duplicateTitleB.task,
        target: { type: 'task' as const, ref: duplicateTitleB.task.ref },
      },
    ];
    const session = new ProjectTaskCollectionSession([duplicateTitleA, duplicateTitleB], () => ({
      type: 'ambiguous',
      candidates: ambiguousCandidates,
    }));
    session.activate(duplicateTitleA.task.ref);
    session.consumeEffect();

    session.reconcile([duplicateTitleB]);

    expect(session.focusedRef()).toBeNull();
    expect(session.inspectorRef()).toBeNull();
    expect(session.selectedActions()).toEqual([]);
    expect(session.consumeEffect()).toEqual({
      focus: null,
      scrollTo: null,
      inspect: null,
      notice: 'focused-item-ambiguous',
    });
  });

  it('emits a mount restore only while focus ownership remains and adopts one inspector gateway', () => {
    const actions = [action('Projects/A.md', 0, 'r0'), action('Work Notes/A.md', 1, 'r1')];
    const session = new ProjectTaskCollectionSession(
      actions,
      exactResolver(actions.map(({ task: candidate }) => candidate)),
    );
    session.activate(actions[1]!.task.ref);
    session.consumeEffect();

    expect(session.restoreEffect()).toEqual({
      focus: actions[1]!.task.ref,
      scrollTo: actions[1]!.task.ref,
      inspect: actions[1]!.task.ref,
    });
    session.setInspector(actions[0]!.task.ref);
    expect(session.inspectorRef()).toEqual(actions[0]!.task.ref);
    expect(session.consumeEffect()).toEqual({
      focus: actions[0]!.task.ref,
      scrollTo: actions[0]!.task.ref,
    });
    session.setInspector(null);
    expect(session.inspectorRef()).toBeNull();
    expect(session.consumeEffect()).toBeNull();

    session.intentionalBlur();
    expect(session.restoreEffect()).toBeNull();
  });
});
