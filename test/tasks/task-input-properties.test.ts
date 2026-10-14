// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import type { TaskInputProjection } from '../../src/tasks/domain/taskInputProjection';
import {
  applyTaskInputAction,
  createTaskInputState,
  editTaskInput,
  type TaskInputState,
} from '../../src/tasks/domain/taskInputState';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { project } from '../support/taskInputHarness';
const temporal = fc.constantFrom(
  { phrase: 'tomorrow', due: '2026-10-14' },
  { phrase: 'послезавтра', due: '2026-10-15' },
);
const safeWords = fc
  .array(fc.constantFrom('alpha', 'beta', '👩‍💻', '漢字'), { minLength: 1, maxLength: 8 })
  .map((words) => words.join(' '));
function chosenDue(result: TaskInputProjection): string | undefined {
  return result.initial.due?.type === 'set' ? result.initial.due.value : undefined;
}
type Operation = 'outside' | 'inside' | 'erase' | 'manual' | 'dismiss';
interface SuppressionModel {
  present: boolean;
  suppressed: boolean;
  cleared: boolean;
  manual: boolean;
}
const modelContext = { due: { type: 'set' as const, value: localDate('2026-10-13') } };
function nextPhrase(phrase: string): string {
  return phrase === 'tomorrow' ? 'послезавтра' : 'tomorrow';
}
function operate(
  state: TaskInputState,
  operation: Operation,
  phrase: string,
  present: boolean,
): TaskInputState {
  switch (operation) {
    case 'outside':
      return editTaskInput(state, `👩‍💻 ${state.raw}`);
    case 'inside':
      return editTaskInput(
        state,
        present
          ? state.raw.replace(phrase, nextPhrase(phrase))
          : `${state.raw} ${nextPhrase(phrase)}`,
      );
    case 'erase':
      return editTaskInput(state, state.raw.replace(phrase, ''));
    case 'manual':
      return applyTaskInputAction(
        state,
        { type: 'select-date', role: 'due', value: localDate('2026-10-20') },
        project(state, modelContext),
        inspectTaskInput(state.raw),
      );
    case 'dismiss':
      return applyTaskInputAction(
        state,
        { type: 'dismiss', role: 'due' },
        project(state, modelContext),
        inspectTaskInput(state.raw),
      );
  }
}
function updateModel(model: SuppressionModel, operation: Operation): void {
  if (operation === 'inside') {
    model.present = true;
    model.suppressed = false;
  }
  if (operation === 'erase') model.present = false;
  if (operation === 'manual') model.manual = true;
  if (operation === 'dismiss') {
    model.manual = false;
    model.suppressed = true;
    model.cleared = true;
  }
}
function modelDue(model: SuppressionModel, phrase: string): string | undefined {
  if (model.manual) return '2026-10-20';
  if (model.present && !model.suppressed)
    return phrase === 'tomorrow' ? '2026-10-14' : '2026-10-15';
  return model.cleared ? undefined : '2026-10-13';
}
describe('bounded temporal properties', () => {
  it('conservation: 500 accepted dates, seed 2026101301', () => {
    fc.assert(
      fc.property(temporal, safeWords, safeWords, (t, left, right) => {
        const prefix = `${left}\t  details`;
        const suffix = `notes  ${right}`;
        const state = createTaskInputState(`${prefix} ${t.phrase} ${suffix}`);
        const result = project(state);
        expect(chosenDue(result)).toBe(t.due);
        expect(result.markdownBody).toBe(`${prefix} ${suffix}`);
        expect(
          result.bindings
            .flatMap((binding) => binding.ranges)
            .map((range) => state.raw.slice(range.from, range.to)),
        ).toEqual([t.phrase]);
      }),
      { numRuns: 500, seed: 2026101301 },
    );
  });
  it('equivariance: 500 accepted dates, seed 2026101302', () => {
    fc.assert(
      fc.property(temporal, safeWords, (t, prefix) => {
        const before = createTaskInputState(`Call ${t.phrase}`);
        const accepted = project(before);
        const after = editTaskInput(before, `${prefix} ${before.raw}`);
        expect(project(after).bindings.flatMap((b) => b.ranges)).toEqual(
          accepted.bindings
            .flatMap((b) => b.ranges)
            .map((r) => ({ from: r.from + prefix.length + 1, to: r.to + prefix.length + 1 })),
        );
        const dismissed = applyTaskInputAction(
          before,
          { type: 'dismiss', role: 'due' },
          accepted,
          inspectTaskInput(before.raw),
        );
        expect(
          chosenDue(project(editTaskInput(dismissed, `${prefix} ${before.raw}`))),
        ).toBeUndefined();
        for (const body of [`Call ${t.phrase} at 14:00`, `Call at 14:00 ${t.phrase}`]) {
          const pair = project(createTaskInputState(body));
          expect(chosenDue(pair)).toBe(t.due);
          expect(pair.initial.time).toEqual({ type: 'set', value: '14:00' });
          expect(pair.markdownBody).toBe('Call');
        }
      }),
      { numRuns: 500, seed: 2026101302 },
    );
  });
  it('suppression: 250 independent model sequences, seed 2026101303', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('outside', 'inside', 'erase', 'manual', 'dismiss'), {
          minLength: 1,
          maxLength: 25,
        }),
        (operations) => {
          let state = createTaskInputState('Call tomorrow');
          let phrase = 'tomorrow';
          const model = { present: true, suppressed: false, cleared: false, manual: false };
          expect(chosenDue(project(state, modelContext))).toBe('2026-10-14');
          for (const operation of operations) {
            state = operate(state, operation, phrase, model.present);
            if (operation === 'inside') phrase = nextPhrase(phrase);
            updateModel(model, operation);
            expect(chosenDue(project(state, modelContext))).toBe(modelDue(model, phrase));
          }
        },
      ),
      { numRuns: 250, seed: 2026101303 },
    );
  });
  it('protected independence: 500 accepted outside dates, seed 2026101304', () => {
    fc.assert(
      fc.property(
        temporal,
        safeWords,
        fc.constantFrom(
          { open: '"', close: '"' },
          { open: '`', close: '`' },
          { open: '[[', close: ']]' },
        ),
        (t, words, wrapper) => {
          const protectedText = `${wrapper.open}${words} ${t.phrase} at 2pm${wrapper.close}`;
          const result = project(createTaskInputState(`Call ${protectedText} tomorrow`));
          expect(chosenDue(result)).toBe('2026-10-14');
          expect(result.initial.time).toBeUndefined();
          expect(result.markdownBody).toBe(`Call ${protectedText}`);
        },
      ),
      { numRuns: 500, seed: 2026101304 },
    );
  });
  it('temporal validity: 500 literal past and named dates, seed 2026101306', () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        fc.constantFrom(
          { raw: 'Позвонить вчера', due: '2026-10-12' },
          { raw: 'Call on October 15', due: '2026-10-15' },
          { raw: 'Call 2025-12-31', due: '2025-12-31' },
        ),
        safeWords,
        (fixture, title) => {
          const result = project(createTaskInputState(`${title} ${fixture.raw}`));
          expect(chosenDue(result)).toBe(fixture.due);
          expect(result.initial.time).toBeUndefined();
          expect(localDate(fixture.due)).toBe(fixture.due);
          if (result.initial.time?.type === 'set') localTime(result.initial.time.value);
          accepted++;
        },
      ),
      { numRuns: 500, seed: 2026101306 },
    );
    expect(accepted).toBe(500);
  });
});

describe('restore after outside edits', () => {
  it('retains last dismissal across 250 UTF-16 prefix/suffix variants, seed 2026101308', () => {
    let accepted = 0;
    fc.assert(
      fc.property(safeWords, safeWords, (prefix, suffix) => {
        const state = createTaskInputState('Call tomorrow');
        const removed = applyTaskInputAction(
          state,
          { type: 'dismiss', role: 'due' },
          project(state, modelContext),
          inspectTaskInput(state.raw),
        );
        const edited = editTaskInput(removed, `${prefix} ${removed.raw} ${suffix}`);
        expect(chosenDue(project(edited, modelContext))).toBeUndefined();
        const restored = applyTaskInputAction(
          edited,
          { type: 'restore' },
          project(edited, modelContext),
          inspectTaskInput(edited.raw),
        );
        expect(chosenDue(project(restored, modelContext))).toBe('2026-10-14');
        accepted++;
      }),
      { numRuns: 250, seed: 2026101308 },
    );
    expect(accepted).toBe(250);
  });
});

describe('bounded separator preservation', () => {
  it('retains signed tokens, casing and internal delimiters, seed 2026101402', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '-5 degrees',
          '+5.5 units',
          '−5 градусов',
          '--flag',
          'iOS update',
          'eBay listing',
          'e-mail details',
          'call — details',
          'call: details',
        ),
        fc.constantFrom(' ', '\t', '  '),
        (title, gap) => {
          const result = project(createTaskInputState(`Tomorrow${gap}— ${title}`));
          expect(result.markdownBody).toBe(title);
          expect(result.initial.due).toEqual({ type: 'set', value: '2026-10-14' });
        },
      ),
      { numRuns: 48, seed: 2026101402 },
    );
  });
});
