import type { App } from 'obsidian';
import { sameNoteFileStamp } from '../../../markdown/noteFileStamp';
import { readVaultText } from '../../../markdown/readVaultText';
import type {
  NoteRange,
  NoteReplacement,
  NoteTaskProtection,
  NoteTaskStage,
} from '../../../notes/noteApi';
import type { AcceptedNoteSource, TaskReadObservation } from '../../../notes/NoteSourceApi';
import { recurrenceOwnedSubtree } from '../../domain/recurrenceIteration';
import type { TaskOccurrenceWitness } from '../../domain/taskOccurrence';
import type { ProvenRootRevisionOverride } from '../../domain/taskReconciliation';
import { TaskBlockEditor } from '../markdown/TaskBlockEditor';
import type { TaskIndex } from '../TaskIndex';
import type { OwnedSourceMutation, TaskRefAuthority } from '../TaskRefAuthority';

function lineStarts(content: string): number[] {
  const result = [0];
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) result.push(i + 1);
  return result;
}
function displaced(offset: number, edits: readonly NoteReplacement[]): number {
  return edits.reduce(
    (value, { range, replacement }) =>
      value + (range.to <= offset ? replacement.length - (range.to - range.from) : 0),
    offset,
  );
}
/** Projects canonical block ownership; it never parses task syntax independently. */
export class CanonicalNoteTaskProtection implements NoteTaskProtection {
  private readonly editor = new TaskBlockEditor();
  constructor(
    private readonly app: App,
    private readonly index: TaskIndex,
    private readonly authority: TaskRefAuthority,
  ) {}
  ranges(content: string): readonly NoteRange[] {
    const lines = lineStarts(content);
    return this.editor.rootBlocks(content).map((block) => {
      const from = lines[block.line];
      if (from === undefined) throw new Error('Invalid canonical block range');
      return { from, to: from + block.source.length, kind: 'task', editable: false };
    });
  }
  preserves(before: string, after: string, range: NoteRange, replacement: string): boolean {
    return this.preservesAll(before, after, [{ range, replacement }]);
  }
  preservesAll(before: string, after: string, edits: readonly NoteReplacement[]): boolean {
    const original = this.ranges(before),
      candidate = this.ranges(after);
    if (original.length !== candidate.length) return false;
    return original.every((block) => {
      if (edits.some(({ range }) => block.from < range.to && block.to > range.from)) return false;
      const from = displaced(block.from, edits);
      const found = candidate.find(
        (next) => next.from === from && next.to === from + block.to - block.from,
      );
      return (
        found !== undefined &&
        before.slice(block.from, block.to) === after.slice(found.from, found.to)
      );
    });
  }
  stage(
    source: AcceptedNoteSource,
    candidate: string,
    range: NoteRange,
    replacement: string,
  ): NoteTaskStage | undefined {
    return this.stageAll(source, candidate, [{ range, replacement }]);
  }
  stageAll(
    source: AcceptedNoteSource,
    candidate: string,
    edits: readonly NoteReplacement[],
  ): NoteTaskStage | undefined {
    if (!this.preservesAll(source.content, candidate, edits)) return undefined;
    const predecessors = this.index.currentRoots(source.path);
    const beforeBlocks = this.editor.rootBlocks(source.content);
    if (
      predecessors.length !== beforeBlocks.length ||
      !predecessors.every((root) =>
        beforeBlocks.some((block) => block.line === root.line && block.source === root.source),
      )
    )
      return undefined;
    if (predecessors.length === 0) return this.emptyStage(source, candidate);
    const population = this.continuations(source, candidate, edits);
    if (population === undefined) return undefined;
    const { transitions, occurrences } = population;
    const owner = this.authority.reserveStructuralMutation(
      [
        {
          filePath: source.path,
          before: source.content,
          after: candidate,
          predecessors,
          roots: transitions,
          transitions,
          occurrences,
          operation: {},
        },
      ],
      (path) => this.index.currentRoots(path),
    );
    return owner === undefined ? undefined : this.ownedStage(source, candidate, owner);
  }
  private continuations(
    source: AcceptedNoteSource,
    candidate: string,
    edits: readonly NoteReplacement[],
  ):
    | { transitions: ProvenRootRevisionOverride[]; occurrences: TaskOccurrenceWitness[] }
    | undefined {
    const predecessors = this.index.currentRoots(source.path);
    const oldLines = lineStarts(source.content),
      newLines = lineStarts(candidate);
    const transitions: ProvenRootRevisionOverride[] = [];
    const occurrences: TaskOccurrenceWitness[] = [];
    for (const prior of predecessors) {
      const offset = oldLines[prior.line];
      if (offset === undefined) return undefined;
      const nextOffset = displaced(offset, edits);
      const line = newLines.indexOf(nextOffset);
      if (line < 0) return undefined;
      const next = { ...prior, line, previousRevision: prior.revision };
      transitions.push(next);
      const continued = this.occurrences(source.path, next, prior.line);
      if (continued === undefined) return undefined;
      occurrences.push(...continued);
    }
    return { transitions, occurrences };
  }
  private occurrences(
    path: string,
    next: ProvenRootRevisionOverride,
    beforeLine: number,
  ): TaskOccurrenceWitness[] | undefined {
    const subtree = recurrenceOwnedSubtree(next.source, 0);
    if (subtree === undefined) return undefined;
    if (next.line === beforeLine) return [];
    return subtree.taskLines.map((nodeOffset) => ({
      kind: 'continued',
      before: {
        filePath: path,
        rootRevision: next.previousRevision,
        rootLine: beforeLine,
        nodeOffset,
      },
      after: { filePath: path, rootRevision: next.revision, rootLine: next.line, nodeOffset },
    }));
  }
  private emptyStage(source: AcceptedNoteSource, candidate: string): NoteTaskStage {
    return {
      forward: (live) => (live === source.content ? candidate : undefined),
      install: (file) => this.index.projectSources().reconcile(source.path, file, candidate),
      reject: async () => {},
      release: () => {},
    };
  }
  private stageMeaningCurrent(meaning: TaskReadObservation): boolean {
    const current = this.index.integrationReads().capture();
    return (
      current.lifecycle === 'ready' &&
      current.scopeRevision === meaning.scopeRevision &&
      current.semanticsRevision === meaning.semanticsRevision
    );
  }

  private ownedStage(
    source: AcceptedNoteSource,
    candidate: string,
    owner: OwnedSourceMutation,
  ): NoteTaskStage {
    const native = this.app.vault.getFileByPath(source.path);
    const meaning = this.index.integrationReads().capture();
    return {
      forward: (live) => owner.forward(source.path, live),
      install: async (file) => {
        if (!this.stageMeaningCurrent(meaning)) return false;
        return await this.index.reconcileCommittedSource(source.path, file, candidate, () => {
          if (!this.stageMeaningCurrent(meaning))
            throw new Error('Preserved task meaning changed.');
          const contents = new Map([[source.path, candidate]]);
          this.index.installCommittedBatch(contents, () => {
            if (!owner.complete(contents)) throw new Error('Lost preserved-task authority');
          });
        });
      },
      reject: async (file) => {
        const invalidate = this.index.captureRejectedSourceInvalidation(
          source.path,
          file,
          candidate,
        );
        try {
          if (
            native === null ||
            native !== file ||
            this.app.vault.getAbstractFileByPath(source.path) !== native
          )
            throw new Error('Preserved task source was replaced.');
          const stamp = { ...native.stat };
          const live = await readVaultText(this.app.vault, native);
          if (
            this.app.vault.getAbstractFileByPath(source.path) !== native ||
            !sameNoteFileStamp(stamp, native.stat)
          )
            throw new Error('Preserved task source changed during readback.');
          const accepted = await this.index.reconcileCommittedSource(
            source.path,
            native,
            live,
            () => {
              owner.rejectSource(source.path, live);
              this.index.installCommittedContent(source.path, live);
            },
          );
          if (!accepted) {
            owner.rejectSource(source.path);
            invalidate();
          }
        } catch {
          owner.rejectSource(source.path);
          invalidate();
        }
      },
      release: () => {
        owner.release();
      },
    };
  }
}
