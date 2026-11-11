import type {
  ApiResultV1,
  ApplyTaskContentV1,
  ContentPlanV1,
  NoteMutationReceiptV1,
  NotePlanV1,
  NotesApiV1,
  TaskDtoV1,
  TasksApiV1,
} from '../../api';
import type { TaskSnapshot } from '../../src/tasks';
import { connect } from './native-api.ts';
import { plugin } from './native-helpers.ts';
import type { Measure } from './native-scenarios.ts';
import type { Host, NativeOptions } from './native-types.ts';
import type { Sample } from './types.ts';

function value<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(`Command profile: ${result.error.code}`);
  return result.value;
}
function required<T>(item: T | undefined, name: string): T {
  if (item === undefined) throw new Error(`Command profile missing ${name}`);
  return item;
}
interface Source {
  path: string;
  text: string;
  roots: readonly TaskSnapshot[];
  nodes: number;
}
function assertAccepted(text: string, roots: Source['roots']): void {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
  for (const root of roots) {
    const at = offsets[root.ref.line];
    if (
      at === undefined ||
      text.slice(at, at + root.source.originalBlock.length) !== root.source.originalBlock
    )
      throw new Error('Dense accepted source mismatch');
  }
}
function first(source: Source): TaskSnapshot {
  const root = source.roots[0];
  if (root?.dependencyId !== 'profile-0') throw new Error('Dense target missing');
  return root;
}
class DenseSource {
  constructor(
    readonly host: Host,
    readonly options: NativeOptions,
  ) {}
  async capture(): Promise<Source> {
    if (this.options.fixtureKind !== 'single-note') throw new Error('Dense fixture required');
    const path = `${this.options.fixtureFolder}/projects/Project-000.md`;
    const queries = plugin(this.host).queries;
    const roots = [...queries.list({ filePath: path })].sort((a, b) => a.ref.line - b.ref.line);
    const nodes = queries.listNodes().length;
    if (
      roots.length !== this.options.expectedRoots ||
      queries.list().length !== roots.length ||
      nodes !== this.options.expectedNodes
    )
      throw new Error('Dense fixture population mismatch');
    const file = this.host.vault.getFileByPath(path);
    if (file === null) throw new Error('Dense fixture missing');
    const text = await this.host.vault.read(file);
    if ((await this.host.vault.cachedRead(file)) !== text)
      throw new Error('Dense fixture cached bytes differ');
    assertAccepted(text, roots);
    return { path, text, roots, nodes };
  }
  async unchanged(before: Source): Promise<void> {
    const after = await this.capture();
    if (
      after.text !== before.text ||
      after.roots.some((root, i) => root.ref.revision !== before.roots[i]?.ref.revision)
    )
      throw new Error('Preparation changed accepted source');
  }
  async conserved(
    before: Source,
    expected: string,
    change: { root: boolean; lines: number },
  ): Promise<Sample['facts']> {
    const after = await this.capture();
    if (after.text !== expected) throw new Error('Committed bytes differ from exact candidate');
    const start = change.root ? 1 : 0;
    for (let i = start; i < before.roots.length; i++) {
      const prior = required(before.roots[i], 'prior root'),
        current = required(after.roots[i], 'current root');
      if (
        prior.source.originalBlock !== current.source.originalBlock ||
        current.ref.line !== prior.ref.line + change.lines
      )
        throw new Error('Retained sibling source or coordinates changed');
    }
    return {
      roots: after.roots.length,
      nodes: after.nodes,
      writes: 1,
      retainedRoots: after.roots.length - start,
      lineShift: change.lines,
      exactBytes: true,
    };
  }
}
export async function denseCommandScenario(
  host: Host,
  options: NativeOptions,
  measure: Measure,
  shift: boolean,
): Promise<void> {
  const source = new DenseSource(host, options);
  let captured: Source | undefined;
  await measure(
    shift ? 'command.dense-line-shift' : 'command.dense-edit',
    async () => {
      const before = required(captured, 'dense preparation'),
        root = first(before),
        target = { type: 'task' as const, ref: root.ref };
      const description = `${root.description ?? ''}\nProfile line shift`;
      const result = await plugin(host).tasks.execute(
        shift
          ? { type: 'set-description', target, text: description }
          : { type: 'append-title', target, markdown: 'edited' },
      );
      if (result.type !== 'ok' || result.outcome.type !== 'task')
        throw new Error('Dense native command failed');
      const current = result.outcome.task;
      if (
        shift
          ? current.description !== description
          : current.markdownTitle !== `${root.markdownTitle} edited`
      )
        throw new Error('Dense native command returned wrong target content');
      const block = editedBlock(root, shift);
      if (current.source.originalBlock !== block)
        throw new Error('Dense command changed unrequested root content');
      const expected = before.text.replace(root.source.originalBlock, block);
      return source.conserved(before, expected, { root: true, lines: shift ? 1 : 0 });
    },
    async () => {
      captured = await source.capture();
    },
  );
}
export async function commandStressScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  await denseCommandScenario(host, options, measure, false);
  await denseCommandScenario(host, options, measure, true);
}
interface Features {
  client: TasksApiV1;
  prepare: NonNullable<TasksApiV1['tasks']['prepare']>;
  apply: NonNullable<TasksApiV1['tasks']['apply']>;
  notes: NotesApiV1;
  signal: AbortSignal;
  retained: TaskDtoV1[];
}
interface NoteApplyFailure {
  receipt: Pick<
    NoteMutationReceiptV1,
    'effects' | 'outcome' | 'recovery' | 'noteEffects' | 'destinationEffects'
  > & {
    hasNote: boolean;
    hasSection: boolean;
    warnings: string[];
  };
  source: { conserved: boolean; facts?: Sample['facts'] };
  retained: Array<{
    index: number;
    matches: boolean;
    errorCode?: string;
    expectedLine: number;
    actualLine?: number;
    checks?: Record<'target' | 'parent' | 'title' | 'path' | 'line', boolean>;
  }>;
}
type ObserveNoteFailure = (evidence: NoteApplyFailure) => void;
interface NoteObservations {
  failure?: ObserveNoteFailure;
}
function supported(client: TasksApiV1, signal: AbortSignal): Features {
  for (const capability of [
    'tasks.tree',
    'tasks.prepare',
    'tasks.apply',
    'notes.read',
    'notes.search',
    'notes.prepare',
    'notes.apply',
  ])
    if (!client.info.capabilities.includes(capability))
      throw new Error(`Command profile capability missing: ${capability}`);
  if (
    client.info.noteLimits?.searchSourceCharacterTarget !== 262144 ||
    client.info.noteLimits.maxSingleSearchSourceCharacters !== 4194304
  )
    throw new Error('Command profile note limits differ');
  return {
    client,
    signal,
    prepare: required(client.tasks.prepare, 'prepare'),
    apply: required(client.tasks.apply, 'apply'),
    notes: required(client.notes, 'notes'),
    retained: [],
  };
}
function assertPreview(plan: ContentPlanV1, root: TaskSnapshot): void {
  if (
    plan.before?.complete !== true ||
    plan.after?.complete !== true ||
    plan.before.markdownTitle !== root.markdownTitle ||
    plan.after.markdownTitle !== `${root.markdownTitle} facade` ||
    plan.before.children.length !== 1 ||
    plan.after.children.length !== 1
  )
    throw new Error('Incomplete or incorrect content preview');
}
async function contentScenarios(
  source: DenseSource,
  features: Features,
  measure: Measure,
): Promise<void> {
  let captured: Source | undefined,
    target: TaskDtoV1 | undefined,
    prepared: ContentPlanV1 | undefined;
  await measure(
    'content.prepare',
    async () => {
      const before = required(captured, 'source'),
        selected = required(target, 'target');
      prepared = value(
        await features.prepare(
          {
            kind: 'edit',
            target: selected.target,
            expectedRevision: selected.revision,
            operation: {
              type: 'patch',
              target: selected.target,
              patch: {
                markdownTitle: { type: 'set', value: `${first(before).markdownTitle} facade` },
              },
            },
          },
          { signal: features.signal },
        ),
      );
      assertPreview(prepared, first(before));
      await source.unchanged(before);
      return {
        roots: before.roots.length,
        nodes: before.nodes,
        writes: 0,
        complete: true,
        exactBytes: true,
      };
    },
    async () => {
      captured = await source.capture();
      const retained = await retainedTargets(features, captured);
      features.retained.push(...retained);
      const resolved = value(
        await features.client.tasks.resolve(
          { source: { path: captured.path, line: first(captured).ref.line } },
          { signal: features.signal },
        ),
      );
      if (resolved.type !== 'found') throw new Error('Dense public target unavailable');
      target = resolved.task;
    },
  );
  await measure('content.apply', async () => {
    const before = required(captured, 'source'),
      plan = required(prepared, 'plan'),
      root = first(before);
    // Verification oracle only; the sealed plan, never these bytes, authorizes the write.
    const expected = before.text.replace(
      root.source.originalMarkdown,
      root.source.originalMarkdown.replace(root.markdownTitle, `${root.markdownTitle} facade`),
    );
    const result = await features.apply(applyInput(plan), { signal: features.signal });
    if (!result.ok) throw new Error(`Content apply failed: ${result.error.code}`);
    const receipt = result.receipt;
    if (
      receipt.effects !== 'committed' ||
      receipt.outcome !== 'changed' ||
      receipt.snapshots !== 'complete' ||
      receipt.warnings.length !== 0 ||
      receipt.contentContinuity.correspondence.state !== 'complete'
    )
      throw new Error('Content apply did not prove commit');
    await checkRetainedTargets(features, 0);
    return {
      ...(await source.conserved(before, expected, { root: true, lines: 0 })),
      retainedHandles: features.retained.length,
    };
  });
}
async function proseScenarios(
  source: DenseSource,
  features: Features,
  measure: Measure,
  observations: NoteObservations,
): Promise<void> {
  let captured: Source | undefined, prepared: NotePlanV1 | undefined;
  let selected: { target: string; revision: string; section: string; text: string } | undefined;
  await measure(
    'notes.prepare',
    async () => {
      const before = required(captured, 'source'),
        section = required(selected, 'prose');
      prepared = value(
        await features.notes.prepare(
          {
            kind: 'edit',
            target: section.target,
            expectedRevision: section.revision,
            operation: { type: 'append', section: section.section, text: 'Profile prose append\n' },
          },
          { signal: features.signal },
        ),
      );
      if (
        prepared.before?.text !== section.text ||
        prepared.after.text !== `${section.text}Profile prose append\n`
      )
        throw new Error('Note preview is not the complete selected section');
      await source.unchanged(before);
      return {
        roots: before.roots.length,
        nodes: before.nodes,
        writes: 0,
        exactBytes: true,
        complete: true,
      };
    },
    async () => {
      captured = await source.capture();
      selected = await selectProse(features, captured.path);
    },
  );
  await measure('notes.apply', async () => {
    const before = required(captured, 'source'),
      plan = required(prepared, 'note plan'),
      section = required(selected, 'section');
    const expected = before.text.replace(section.text, plan.after.text);
    const result = await features.notes.apply(applyInput(plan), { signal: features.signal });
    if (!result.ok) throw new Error(`Note apply failed: ${result.error.code}`);
    const receipt = result.receipt;
    if (
      receipt.effects !== 'committed' ||
      receipt.outcome !== 'changed' ||
      receipt.note === undefined ||
      receipt.warnings.length !== 0
    ) {
      const failure = new Error('Note apply did not prove commit');
      if (observations.failure !== undefined) {
        try {
          observations.failure(
            await noteApplyFailure(source, { before, expected }, features, receipt),
          );
        } catch (cause) {
          throw new AggregateError(
            [failure, cause],
            'Note apply did not prove commit; diagnostic failed',
          );
        }
      }
      throw failure;
    }
    await checkRetainedTargets(features, 1);
    return {
      ...(await source.conserved(before, expected, { root: false, lines: 1 })),
      retainedHandles: features.retained.length,
    };
  });
}
export async function commandFeatureScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
  observations: NoteObservations = {},
): Promise<void> {
  const controller = new AbortController(),
    client = connect(host);
  let off: (() => void) | undefined;
  try {
    const features = supported(client, controller.signal);
    value(await client.ready({ signal: controller.signal }));
    off = value(client.subscribe(() => {}));
    const source = new DenseSource(host, options);
    await contentScenarios(source, features, measure);
    await proseScenarios(source, features, measure, observations);
  } finally {
    controller.abort();
    try {
      off?.();
    } finally {
      client.dispose();
    }
  }
}

async function noteApplyFailure(
  source: DenseSource,
  candidate: { before: Source; expected: string },
  features: Features,
  receipt: NoteMutationReceiptV1,
): Promise<NoteApplyFailure> {
  let conservation: NoteApplyFailure['source'];
  try {
    conservation = {
      conserved: true,
      facts: await source.conserved(candidate.before, candidate.expected, {
        root: false,
        lines: 1,
      }),
    };
  } catch {
    conservation = { conserved: false };
  }
  const retained: NoteApplyFailure['retained'] = [];
  for (const [index, prior] of features.retained.entries()) {
    const expectedLine = prior.source.line + 1;
    try {
      const result = await features.client.tasks.get(prior.target, { signal: features.signal });
      if (!result.ok) {
        retained.push({ index, expectedLine, matches: false, errorCode: result.error.code });
        continue;
      }
      const after = result.value;
      retained.push({
        index,
        expectedLine,
        actualLine: after.source.line,
        matches: retainedMatches(prior, after, 1),
        checks: {
          target: after.target === prior.target,
          parent: after.parentTarget === prior.parentTarget,
          title: after.title === prior.title,
          path: after.source.path === prior.source.path,
          line: after.source.line === expectedLine,
        },
      });
    } catch {
      retained.push({ index, expectedLine, matches: false, errorCode: 'DIAGNOSTIC_READ_REJECTED' });
    }
  }
  return {
    receipt: {
      effects: receipt.effects,
      outcome: receipt.outcome,
      recovery: receipt.recovery,
      noteEffects: receipt.noteEffects,
      destinationEffects: receipt.destinationEffects,
      hasNote: receipt.note !== undefined,
      hasSection: receipt.section !== undefined,
      warnings: receipt.warnings.map((warning) => warning.code),
    },
    source: conservation,
    retained,
  };
}

function applyInput(plan: { target: string; revision: string }): ApplyTaskContentV1 {
  return {
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    requestId: crypto.randomUUID(),
    expiresAt: Date.now() + 300000,
  };
}
async function selectProse(
  features: Features,
  path: string,
): Promise<{ target: string; revision: string; section: string; text: string }> {
  const note = value(
    await features.notes.read({ selector: { path } }, { signal: features.signal }),
  );
  const section = required(
    note.segments.find(
      (part) =>
        part.section.kind === 'prose' &&
        part.section.canAppend &&
        part.text.includes('Profile editable prose.') &&
        !part.continuesPrevious &&
        !part.continuesNext,
    ),
    'editable prose section',
  );
  return {
    target: note.note.target,
    revision: note.note.revision,
    section: section.section.target,
    text: section.text,
  };
}

async function retainedTargets(features: Features, source: Source): Promise<TaskDtoV1[]> {
  const roots = source.roots.filter((root) => root.title === 'Duplicate profile root');
  if (roots.length !== 2) throw new Error('Duplicate root controls missing');
  const targets: TaskDtoV1[] = [];
  for (const root of roots) {
    const child = required(root.subtasks[0], 'duplicate child');
    for (const line of [root.ref.line, root.ref.line + child.ref.relativeLine]) {
      const result = value(
        await features.client.tasks.resolve(
          { source: { path: source.path, line } },
          { signal: features.signal },
        ),
      );
      if (result.type !== 'found') throw new Error('Duplicate occurrence unavailable');
      targets.push(result.task);
    }
  }
  return targets;
}
async function checkRetainedTargets(features: Features, shift: number): Promise<void> {
  for (const before of features.retained) {
    const after = value(
      await features.client.tasks.get(before.target, { signal: features.signal }),
    );
    if (!retainedMatches(before, after, shift))
      throw new Error('Duplicate root or child lost identity through displacement');
  }
}
function retainedMatches(before: TaskDtoV1, after: TaskDtoV1, shift: number): boolean {
  return (
    after.target === before.target &&
    after.parentTarget === before.parentTarget &&
    after.title === before.title &&
    after.source.path === before.source.path &&
    after.source.line === before.source.line + shift
  );
}

function editedBlock(root: TaskSnapshot, shift: boolean): string {
  if (!shift)
    return root.source.originalBlock.replace(root.markdownTitle, `${root.markdownTitle} edited`);
  const description = root.description ?? '';
  return root.source.originalBlock.replace(
    `  - > ${description}\n`,
    `  - > ${description}\n  - > Profile line shift\n`,
  );
}
