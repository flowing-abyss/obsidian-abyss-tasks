import type { ProjectStatus } from '../../settings/types';
import { workNoteLifecycleBehavior } from './rollups';
import type { WorkNoteDiagnostic, WorkNoteSnapshot } from './types';

type WorkNoteRelationKind = 'blocked-by' | 'related' | 'milestone';
type InvalidWorkNoteRelationReason =
  | 'missing'
  | 'ambiguous'
  | 'multiple'
  | 'self'
  | 'cross-project'
  | 'cycle'
  | 'wrong-kind'
  | 'malformed';

interface WorkNoteRelationBase {
  readonly sourcePath: string;
  readonly targetPath?: string;
  readonly relation: WorkNoteRelationKind;
}

export type WorkNoteRelationProjection =
  | (WorkNoteRelationBase & { readonly type: 'related' })
  | (WorkNoteRelationBase & { readonly type: 'member' })
  | (WorkNoteRelationBase & { readonly type: 'blocked' })
  | (WorkNoteRelationBase & { readonly type: 'satisfied' })
  | (WorkNoteRelationBase & {
      readonly type: 'invalid';
      readonly reason: InvalidWorkNoteRelationReason;
      readonly diagnostic?: WorkNoteDiagnostic;
    });

function diagnosticRelation(field: string | undefined): WorkNoteRelationKind {
  if (field === 'milestone') return 'milestone';
  if (field === 'related') return 'related';
  return 'blocked-by';
}

function diagnosticInvalid(
  note: WorkNoteSnapshot,
  diagnostic: WorkNoteDiagnostic,
): WorkNoteRelationProjection | undefined {
  let reason: InvalidWorkNoteRelationReason | undefined;
  if (diagnostic.type === 'broken-relation') reason = 'missing';
  else if (diagnostic.type === 'ambiguous-relation') reason = 'ambiguous';
  else if (diagnostic.type === 'multiple-milestones') reason = 'multiple';
  else if (diagnostic.type === 'invalid-relation-entry') reason = 'malformed';
  if (!reason) return undefined;
  return {
    type: 'invalid',
    reason,
    sourcePath: note.path,
    relation: diagnosticRelation(diagnostic.field),
    diagnostic,
  };
}

function pathReaches(
  start: string,
  wanted: string,
  projectPath: string,
  notes: ReadonlyMap<string, WorkNoteSnapshot>,
  seen = new Set<string>(),
): boolean {
  if (start === wanted) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  const note = notes.get(start);
  if (!note || note.projectPath !== projectPath) return false;
  return note.blockedByPaths.some(
    (path) =>
      notes.get(path)?.projectPath === projectPath &&
      pathReaches(path, wanted, projectPath, notes, seen),
  );
}

function projectResolvedRelation(
  source: WorkNoteSnapshot,
  targetPath: string,
  relation: WorkNoteRelationKind,
  notes: ReadonlyMap<string, WorkNoteSnapshot>,
  statuses: readonly ProjectStatus[],
): WorkNoteRelationProjection {
  const base = { sourcePath: source.path, targetPath, relation } as const;
  if (targetPath === source.path) return { ...base, type: 'invalid', reason: 'self' };
  const target = notes.get(targetPath);
  if (!target) return { ...base, type: 'invalid', reason: 'missing' };
  if (target.projectPath !== source.projectPath) {
    return { ...base, type: 'invalid', reason: 'cross-project' };
  }
  if (relation === 'milestone') {
    return target.kind === 'milestone'
      ? { ...base, type: 'member' }
      : { ...base, type: 'invalid', reason: 'wrong-kind' };
  }
  if (relation === 'related') return { ...base, type: 'related' };
  if (pathReaches(targetPath, source.path, source.projectPath, notes)) {
    return { ...base, type: 'invalid', reason: 'cycle' };
  }
  const behavior = workNoteLifecycleBehavior(target, statuses);
  return behavior === 'completed' || behavior === 'published'
    ? { ...base, type: 'satisfied' }
    : { ...base, type: 'blocked' };
}

export function buildWorkNoteRelationProjections(
  workNotes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
  sourcePaths?: ReadonlySet<string>,
): readonly WorkNoteRelationProjection[] {
  const notes = new Map(workNotes.map((note) => [note.path, note]));
  const sources = sourcePaths ? workNotes.filter((note) => sourcePaths.has(note.path)) : workNotes;
  return buildWorkNoteRelationProjectionsFromIndex(notes, sources, statuses);
}

export function buildWorkNoteRelationProjectionsFromIndex(
  notes: ReadonlyMap<string, WorkNoteSnapshot>,
  sourceNotes: readonly WorkNoteSnapshot[],
  statuses: readonly ProjectStatus[],
): readonly WorkNoteRelationProjection[] {
  const projections: WorkNoteRelationProjection[] = [];
  for (const note of [...sourceNotes].sort((left, right) => left.path.localeCompare(right.path))) {
    for (const diagnostic of note.diagnostics) {
      const projection = diagnosticInvalid(note, diagnostic);
      if (projection) projections.push(projection);
    }
    if (!note.diagnostics.some(({ type }) => type === 'multiple-milestones')) {
      if (note.milestonePath) {
        projections.push(
          projectResolvedRelation(note, note.milestonePath, 'milestone', notes, statuses),
        );
      }
    }
    for (const targetPath of note.blockedByPaths) {
      projections.push(projectResolvedRelation(note, targetPath, 'blocked-by', notes, statuses));
    }
    for (const targetPath of note.relatedPaths) {
      projections.push(projectResolvedRelation(note, targetPath, 'related', notes, statuses));
    }
  }
  return projections;
}
