// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import {
  projectTaskInput,
  taskInputPreflightBody,
} from '../../src/tasks/domain/taskInputProjection';
import {
  applyTaskInputAction,
  createTaskInputState,
  editTaskInput,
  type TaskInputState,
} from '../../src/tasks/domain/taskInputState';
import type { TaskInputCandidate } from '../../src/tasks/domain/taskInputTypes';
import type { TaskPlanning } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { expectDefined } from '../helpers';
import { project, recognizer, reference } from '../support/taskInputHarness';
const context = { due: { type: 'set' as const, value: localDate('2026-10-13') } };
function dismiss(raw: string) {
  const state = createTaskInputState(raw);
  return applyTaskInputAction(
    state,
    { type: 'dismiss', role: 'due' },
    project(state, context),
    inspectTaskInput(raw),
  );
}
describe('transient input decisions', () => {
  it('preserves dismissed occurrences through UTF-16 outside edits', () => {
    const state = dismiss('Call tomorrow at 14:00');
    const after = editTaskInput(state, '👩‍💻 Call tomorrow at 14:00 please');
    expect(project(after, context).initial.due).toEqual({ type: 'clear' });
    expect(project(after, context).initial.time).toEqual({ type: 'clear' });
    expect(project(after, context).markdownBody).toBe(after.raw);
  });
  it('allows a changed phrase without restoring cleared context', () => {
    const changed = editTaskInput(dismiss('Call tomorrow'), 'Call послезавтра');
    expect(project(changed, context).initial.due).toEqual({ type: 'set', value: '2026-10-15' });
    expect(project(editTaskInput(changed, 'Call'), context).initial.due).toEqual({ type: 'clear' });
  });
  it('holds a manual day after its source calendar changes, without losing competing text', () => {
    const state = createTaskInputState('Call tomorrow at 14:00');
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(project(manual).markdownBody).toBe('Call');
    const after = editTaskInput(manual, 'Call послезавтра at 16:30');
    expect(project(after).initial.due).toEqual({ type: 'set', value: '2026-10-20' });
    expect(project(after).initial.time).toEqual({ type: 'set', value: '16:30' });
    expect(project(after).markdownBody).toBe('Call послезавтра at 16:30');
  });
  it('drops a deleted bound clock while retaining the manual date', () => {
    const state = createTaskInputState('Call tomorrow at 14:00');
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    const after = editTaskInput(manual, 'Call tomorrow');
    expect(project(after).initial.time).toBeUndefined();
    expect(project(after).markdownBody).toBe('Call');
  });
  it('manual choice after rejection grants no text consumption or hidden clock', () => {
    const state = dismiss('Call tomorrow at 14:00');
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(project(manual).markdownBody).toBe(state.raw);
    expect(project(manual).initial.time).toEqual({ type: 'clear' });
  });
  it('restores only the last dismissal and never overrides a later manual action', () => {
    const state = dismiss('Call tomorrow');
    const edited = editTaskInput(state, '👩‍💻 Call tomorrow please');
    const restored = applyTaskInputAction(
      edited,
      { type: 'restore' },
      project(edited),
      inspectTaskInput(edited.raw),
    );
    expect(project(restored, context).initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(manual.restore).toBeUndefined();
  });
  it('keeps ambiguous same-value occurrences separate until a concrete choice', () => {
    const state = createTaskInputState('Call tomorrow and tomorrow');
    const result = project(state);
    expect(result.ambiguity).toBe(true);
    expect(result.markdownBody).toBe(state.raw);
    const chosen = applyTaskInputAction(
      state,
      {
        type: 'select-date',
        role: 'due',
        value: localDate('2026-10-14'),
        candidate: expectDefined(result.candidates[0]),
      },
      result,
      inspectTaskInput(state.raw),
    );
    expect(project(chosen).markdownBody).toBe('Call and tomorrow');
  });
  it('retains explicit planning priority and the entire competing natural phrase', () => {
    const result = project(createTaskInputState('Call tomorrow at 14:00 📅 2026-10-20'));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-20' });
    expect(result.initial.time).toEqual({ type: 'set', value: '14:00' });
    expect(result.markdownBody).toBe('Call tomorrow at 14:00 📅 2026-10-20');
  });
  it('clears an explicit role until a newly authored carrier re-enters it', () => {
    const state = dismiss('Call 📅 2026-10-20');
    expect(project(state).initial.due).toEqual({ type: 'clear' });
    const after = editTaskInput(state, 'Call 📅 2026-10-21');
    expect(project(after).initial.due).toEqual({ type: 'set', value: '2026-10-21' });
    expect(project(editTaskInput(after, 'Call'), context).initial.due).toEqual({ type: 'clear' });
  });
  it('removes all canonical raw tag occurrences and permits explicit reinsertion', () => {
    const state = createTaskInputState('Call #work #WORK');
    const removed = applyTaskInputAction(
      state,
      { type: 'remove-tag', tag: '#work' },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(removed.raw).toBe(state.raw);
    expect(project(removed).markdownBody).toBe('Call');
    expect(project(removed).initial.tags?.remove).toEqual(['#work']);
    expect(editTaskInput(removed, 'Call #Work').removedTags).toEqual([]);
  });
});

describe('proven source consumption', () => {
  it('rejects stale candidate-choice callbacks', () => {
    const state = createTaskInputState('Call tomorrow');
    const result = project(state);
    const edited = editTaskInput(state, 'Call послезавтра');
    expect(
      applyTaskInputAction(
        edited,
        {
          type: 'select-date',
          role: 'due',
          value: localDate('2026-10-14'),
          candidate: expectDefined(result.candidates[0]),
        },
        result,
        inspectTaskInput(edited.raw),
      ),
    ).toBe(edited);
  });
  it('conservatively suppresses all plausible paste descendants, but new outside occurrences remain eligible', () => {
    const state = dismiss('Call tomorrow');
    const pasted = editTaskInput(state, 'Meet tomorrow then tomorrow', 'paste');
    expect(project(pasted).initial.due).toEqual({ type: 'clear' });
    const outside = editTaskInput(pasted, `${pasted.raw} послезавтра`);
    expect(project(outside).initial.due).toEqual({ type: 'set', value: '2026-10-15' });
  });
  it('invalidates restore when its calendar source changes', () => {
    expect(editTaskInput(dismiss('Call tomorrow'), 'Call послезавтра').restore).toBeUndefined();
  });
  it('dismisses neutral ambiguity until its source changes', () => {
    const state = createTaskInputState('Call tomorrow and послезавтра');
    const removed = applyTaskInputAction(
      state,
      { type: 'dismiss-ambiguity' },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(project(removed).ambiguity).toBe(false);
    expect(project(editTaskInput(removed, `👩‍💻 ${removed.raw}`)).ambiguity).toBe(false);
  });
  it('does not infer due beside explicit start or scheduled', () => {
    const result = project(createTaskInputState('Call at 14:00 ⏳ 2026-10-20'));
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.time).toEqual({ type: 'set', value: '14:00' });
    expect(result.markdownBody).toBe('Call ⏳ 2026-10-20');
  });
  it('keeps separate explicit time after natural due removal', () => {
    const state = dismiss('Call tomorrow ⏰ 14:00');
    expect(project(state).initial.due).toEqual({ type: 'clear' });
    expect(project(state).initial.time).toEqual({ type: 'set', value: '14:00' });
  });
  it('allows manual selection of a range without consuming it', () => {
    const state = createTaskInputState('Call tomorrow from 10:00 to 11:00');
    const result = project(state);
    const manual = applyTaskInputAction(
      state,
      {
        type: 'select-date',
        role: 'due',
        value: localDate('2026-10-20'),
        candidate: expectDefined(result.candidates[0]),
      },
      result,
      inspectTaskInput(state.raw),
    );
    expect(project(manual).markdownBody).toBe(state.raw);
    expect(project(manual).initial.due).toEqual({ type: 'set', value: '2026-10-20' });
  });
});

describe('authored content and source planning', () => {
  it.each([
    'tomorrow',
    '📅 2026-10-20 #work',
    '🔁 every day',
    '🔼 ➕ 2026-10-13',
    '... #work',
    '   ',
  ])('does not let metadata manufacture a title: %s', (raw) => {
    expect(project(createTaskInputState(raw)).hasAuthoredTitle).toBe(false);
  });
  it.each(['`tomorrow`', '[Call](note)', '👩‍💻'])(
    'allows meaningful authored Markdown and emoji: %s',
    (raw) => {
      expect(project(createTaskInputState(raw)).hasAuthoredTitle).toBe(true);
    },
  );
});

describe('manual and restore provenance', () => {
  it('never grants consumption to a partial interpretation through the picker', () => {
    const state = createTaskInputState('Call tomorrow morning');
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(manual.manual.due?.binding).toBeUndefined();
    expect(project(manual).markdownBody).toBe(state.raw);
  });
  it('restores only tag removal while preserving the earlier date dismissal', () => {
    const state = dismiss('Call tomorrow #work');
    const removed = applyTaskInputAction(
      state,
      { type: 'remove-tag', tag: '#work' },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(removed.restore).toBeDefined();
    const restored = applyTaskInputAction(
      removed,
      { type: 'restore' },
      project(removed),
      inspectTaskInput(removed.raw),
    );
    expect(project(restored).initial.due).toEqual({ type: 'clear' });
  });
  it('preserves due restore through a manual action on another date role', () => {
    const state = dismiss('Call tomorrow');
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'scheduled', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    expect(manual.restore).toBeDefined();
    const restored = applyTaskInputAction(
      manual,
      { type: 'restore' },
      project(manual),
      inspectTaskInput(manual.raw),
    );
    expect(project(restored).initial.scheduled).toEqual({ type: 'set', value: '2026-10-20' });
  });
});

describe('source and fallback priority', () => {
  it('blocks a natural day beside active prefix planning without losing its clock phrase', () => {
    const result = withSource(createTaskInputState('Call tomorrow at 14:00'), {
      scheduled: localDate('2026-10-20'),
    });
    expect(result.initial.due).toBeUndefined();
    expect(result.initial.scheduled).toEqual({ type: 'set', value: '2026-10-20' });
    expect(result.initial.time).toEqual({ type: 'set', value: '14:00' });
    expect(result.markdownBody).toBe('Call tomorrow at 14:00');
  });
  it('lets a new phrase supply due after a prefix fallback clear, without reviving the prefix', () => {
    const initial = createTaskInputState('Call');
    const source = { due: localDate('2026-10-20') };
    const cleared = applyTaskInputAction(
      initial,
      { type: 'dismiss', role: 'due' },
      withSource(initial, source),
      inspectTaskInput(initial.raw),
    );
    const changed = editTaskInput(cleared, 'Call tomorrow');
    expect(withSource(changed, source).initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    expect(withSource(editTaskInput(changed, 'Call'), source).initial.due).toEqual({
      type: 'clear',
    });
  });
  it('lets a new natural phrase replace a cleared explicit source without reviving it', () => {
    const removed = dismiss('Call 📅 2026-10-20');
    const changed = editTaskInput(removed, `${removed.raw} tomorrow`);
    expect(project(changed).initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    expect(project(changed).markdownBody).toBe('Call');
  });
});
function withSource(
  state: TaskInputState,
  sourcePlanning: Pick<TaskPlanning, 'due' | 'scheduled' | 'start' | 'time'>,
) {
  const inspection = inspectTaskInput(state.raw);
  return projectTaskInput({
    state,
    reference,
    inspection,
    sourcePlanning,
    candidates: recognizer.recognize({
      text: state.raw,
      reference,
      protectedRanges: inspection.protectedRanges,
    }),
  });
}

describe('compound source conservation when one component loses priority', () => {
  it('retains the entire natural phrase when a different explicit clock wins', () => {
    const raw = 'Call tomorrow at 14:00 ⏰ 16:30';
    const result = project(createTaskInputState(raw));
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
    expect(result.initial.time).toEqual({ type: 'set', value: '16:30' });
    expect(result.markdownBody).toBe(raw);
  });
  it('keeps a retained manual compound source literal when its natural clock loses priority', () => {
    const state = createTaskInputState('Call tomorrow at 14:00');
    const manual = applyTaskInputAction(
      state,
      { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
      project(state),
      inspectTaskInput(state.raw),
    );
    const edited = editTaskInput(manual, `${manual.raw} ⏰ 16:30`);
    const result = project(edited);
    expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-20' });
    expect(result.initial.time).toEqual({ type: 'set', value: '16:30' });
    expect(result.markdownBody).toBe(edited.raw);
  });
});

describe('review regressions: current manual source eligibility', () => {
  it.each(['`Call tomorrow`', 'Call tomorrow morning', 'Call not tomorrow'])(
    'preserves manual day but leaves currently ineligible source literal: %s',
    (raw) => {
      const state = createTaskInputState('Call tomorrow');
      const manual = applyTaskInputAction(
        state,
        { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
        project(state),
        inspectTaskInput(state.raw),
      );
      const edited = editTaskInput(manual, raw);
      const result = project(edited);
      expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-20' });
      expect(result.initial.time).toBeUndefined();
      expect(result.markdownBody).toBe(raw);
      expect(result.bindings).toEqual([]);
    },
  );
});

it('restores only duplicate tag metadata without touching the dismissed interior day or raw', () => {
  const raw = 'Call #work tomorrow #WORK';
  const state = dismiss(raw);
  const removed = act(state, { type: 'remove-tag', tag: '#work' });
  expect(removed.raw).toBe(raw);
  expect(project(removed, context).markdownBody).toBe('Call tomorrow');
  const restored = act(removed, { type: 'restore' });
  expect(restored.raw).toBe(raw);
  expect(project(restored, context).markdownBody).toBe(raw);
  expect(project(restored, context).initial.due).toEqual({ type: 'clear' });
});
function act(state: TaskInputState, action: Parameters<typeof applyTaskInputAction>[1]) {
  return applyTaskInputAction(state, action, project(state), inspectTaskInput(state.raw));
}
it.each(['#WORK Call #work', 'Call #work #WORK'])('activates only new tag input: %s', (raw) => {
  const removed = act(createTaskInputState('Call #work'), { type: 'remove-tag', tag: '#work' });
  const edited = editTaskInput(removed, raw);
  expect(edited.removedTags).toEqual([]);
  expect(project(edited).markdownBody).toBe(raw.startsWith('#') ? '#WORK Call' : 'Call #WORK');
  expect(edited.restore).toBeUndefined();
});
it.each(['📅 2026-10-21 Call 📅 2026-10-20', 'Call 📅 2026-10-20 📅 2026-10-21'])(
  'activates only new role input regardless of order: %s',
  (raw) => {
    const edited = editTaskInput(dismiss('Call 📅 2026-10-20'), raw);
    expect(project(edited).initial.due).toEqual({ type: 'set', value: '2026-10-21' });
    expect(project(edited).markdownBody).not.toContain('2026-10-20');
    expect(edited.restore).toBeUndefined();
    expect(project(editTaskInput(edited, 'Call'), context).initial.due).toEqual({ type: 'clear' });
  },
);
it('dismisses the current losing natural candidate with its explicit due', () => {
  const state = dismiss('Call tomorrow 📅 2026-10-20');
  expect(state.raw).toBe('Call tomorrow 📅 2026-10-20');
  expect(project(state).markdownBody).toBe('Call tomorrow');
  expect(project(state).initial.due).toEqual({ type: 'clear' });
});
it('restores a removed manual value without undoing older suppression', () => {
  const manual = act(dismiss('Call tomorrow'), {
    type: 'select-date',
    role: 'due',
    value: localDate('2026-10-22'),
  });
  const removed = act(manual, { type: 'dismiss', role: 'due' });
  const restored = act(removed, { type: 'restore' });
  expect(restored.raw).toBe(manual.raw);
  expect(project(restored).initial.due).toEqual({ type: 'set', value: '2026-10-22' });
  expect(project(restored).markdownBody).toBe(manual.raw);
});
it.each(['👩‍💻 Call #work 📅 2026-10-20 tomorrow', '👩‍💻 Call tomorrow #work 📅 2026-10-20'])(
  'unifies canonical and natural removals in original UTF-16 coordinates: %s',
  (raw) => {
    let state = dismiss(raw.replace('tomorrow', ''));
    state = act(state, { type: 'remove-tag', tag: '#work' });
    state = editTaskInput(state, raw);
    expect(project(state).markdownBody.trim()).toBe('👩‍💻 Call');
    expect(state.raw).toBe(raw);
  },
);

it('expires a manual removal receipt when its bound source changes', () => {
  const state = createTaskInputState('Call tomorrow');
  const manual = act(state, { type: 'select-date', role: 'due', value: localDate('2026-10-22') });
  const removed = act(manual, { type: 'dismiss', role: 'due' });
  expect(editTaskInput(removed, 'Call послезавтра').restore).toBeUndefined();
});
it('keeps the meaningful last Restore offer through an ineffective repeated dismissal', () => {
  const state = dismiss('Call tomorrow');
  expect(act(state, { type: 'dismiss', role: 'due' })).toBe(state);
  expect(project(act(state, { type: 'restore' })).initial.due).toEqual({
    type: 'set',
    value: '2026-10-14',
  });
});

for (const kind of ['paste', 'composition', 'history'] as const) {
  it.each([
    ['Call 📅 2026-10-20 📅 2026-10-20', 'Call 📅 2026-10-20'],
    ['📅 2026-10-20 Call 📅 2026-10-20', '📅 2026-10-20 Call'],
  ])(`keeps new identical canonical source active after ${kind}: %s`, (raw, body) => {
    const edited = editTaskInput(dismiss('Call 📅 2026-10-20'), raw, kind);
    expect(edited.raw).toBe(raw);
    expect(taskInputPreflightBody(edited, inspectTaskInput(raw))).toBe(body);
    expect(project(edited, context).markdownBody).toBe(body);
    expect(project(edited, context).initial.due).toEqual({ type: 'set', value: '2026-10-20' });
    expect(edited.restore).toBeUndefined();
    expect(project(editTaskInput(edited, 'Call', kind), context).initial.due).toEqual({
      type: 'clear',
    });
  });
}

describe('metadata decision boundary conservation', () => {
  it('merges dismissed tags with existing context removals without duplicating their identity', () => {
    const raw = 'Call #work';
    const removed = act(createTaskInputState(raw), { type: 'remove-tag', tag: '#work' });
    const result = project(removed, {
      tags: { add: ['#work', '#personal'], remove: ['#WORK', '#later'] },
    });
    expect(removed.raw).toBe(raw);
    expect(result.markdownBody).toBe('Call');
    expect(result.initial.tags).toEqual({ add: ['#personal'], remove: ['#WORK', '#later'] });
  });

  it('keeps overlapping distinct point interpretations literal and ambiguous', () => {
    const raw = 'Call next Friday';
    const candidates: TaskInputCandidate[] = [
      {
        kind: 'date-time',
        status: 'point',
        date: localDate('2026-10-16'),
        ranges: [{ from: 5, to: 16 }],
        dateRanges: [{ from: 5, to: 16 }],
        timeRanges: [],
      },
      {
        kind: 'date-time',
        status: 'point',
        date: localDate('2026-10-23'),
        ranges: [{ from: 10, to: 16 }],
        dateRanges: [{ from: 10, to: 16 }],
        timeRanges: [],
      },
    ];
    const result = projectTaskInput({
      state: createTaskInputState(raw),
      reference,
      inspection: inspectTaskInput(raw),
      sourcePlanning: {},
      candidates,
    });
    expect(result.markdownBody).toBe(raw);
    expect(result.ambiguity).toBe(true);
    expect(result.initial.due).toBeUndefined();
    expect(result.hasAuthoredTitle).toBe(true);
  });

  it('removes a reentered tag again and restores only the new occurrence', () => {
    const first = act(dismiss('Call tomorrow #work'), { type: 'remove-tag', tag: '#work' });
    const raw = 'Call tomorrow #work #WORK';
    const reentered = editTaskInput(first, raw);
    expect(project(reentered).markdownBody).toBe('Call tomorrow #WORK');
    const removedAgain = act(reentered, { type: 'remove-tag', tag: '#work' });
    expect(removedAgain.raw).toBe(raw);
    expect(project(removedAgain).markdownBody).toBe('Call tomorrow');
    expect(project(removedAgain).initial.due).toEqual({ type: 'clear' });
    const restored = act(removedAgain, { type: 'restore' });
    expect(restored.raw).toBe(raw);
    expect(project(restored).markdownBody).toBe('Call tomorrow #WORK');
    expect(project(restored).initial.due).toEqual({ type: 'clear' });
  });

  it('sets a manual date from a dismissed point without consuming its words again', () => {
    const raw = 'Call tomorrow';
    const removed = dismiss(raw);
    const projection = project(removed);
    const selected = applyTaskInputAction(
      removed,
      {
        type: 'select-date',
        role: 'due',
        value: localDate('2026-10-20'),
        candidate: expectDefined(projection.candidates[0]),
      },
      projection,
      inspectTaskInput(raw),
    );
    expect(selected.raw).toBe(raw);
    expect(project(selected).markdownBody).toBe(raw);
    expect(project(selected).initial.due).toEqual({ type: 'set', value: '2026-10-20' });
    expect(selected.restore).toBeUndefined();
  });
});
