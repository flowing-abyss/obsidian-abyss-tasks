import type { TaskDraft } from '../../application/TaskRepository';
import type { LocalDate, TaskRef } from '../../domain/types';
import type { TaskIssue } from '../../domain/validation';
import { invalidTaskResult, invalidTaskSyntax } from '../../domain/validation';
import { applyTaskCommand } from './applyTaskCommand';
import {
  creationLineIssues,
  creationMetadataIssues,
  normalizeCreatedTaskLine,
  stampCreatedDate,
} from './createTaskLine';
import { TaskBlockEditor } from './TaskBlockEditor';
import { type TaskMarkdownCodec } from './TaskMarkdownCodec';

const DRAFT_REF: TaskRef = { filePath: '', line: 0, revision: '' };
const editor = new TaskBlockEditor();

type CreateTaskBlockResult =
  | { readonly type: 'created'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };
type CreateMetadataFailure = Extract<CreateTaskBlockResult, { readonly type: 'invalid' }>;
type ReadTaskCreateContextResult =
  { readonly type: 'context'; readonly content: string } | CreateMetadataFailure;

type DraftContentResult =
  | { readonly type: 'content'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

function draftContent(markdownBody: string): DraftContentResult {
  if (markdownBody.replace(/\r\n/gu, '').includes('\r')) {
    return invalidTaskResult([{ code: 'invalid-title', field: 'title' }]);
  }
  const [owner, ...nested] = markdownBody.replace(/\r\n/gu, '\n').split('\n');
  if (owner === undefined || owner.trim().length === 0) {
    return invalidTaskResult([{ code: 'invalid-title', field: 'title' }]);
  }
  return { type: 'content', content: [`- [ ] ${owner}`, ...nested].join('\n') };
}

function validRootBlock(content: string): boolean {
  const blocks = editor.rootBlocks(content);
  const block = blocks[0];
  return (
    blocks.length === 1 &&
    block?.line === 0 &&
    block.toLine === content.split('\n').length - 1 &&
    block.source === content
  );
}

function validateSourceLines(
  codec: TaskMarkdownCodec,
  sourceLines: readonly string[],
): CreateMetadataFailure | undefined {
  for (const sourceLine of sourceLines) {
    const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
    if (parsed == null) continue;
    const issues = creationLineIssues(codec, parsed);
    if (issues.length > 0) return invalidTaskResult(issues);
  }
  return undefined;
}

function applyInitialPatch(
  codec: TaskMarkdownCodec,
  sourceLines: string[],
  initial: TaskDraft['initial'],
): CreateMetadataFailure | undefined {
  if (initial === undefined || Object.keys(initial).length === 0) return undefined;
  const ownerLine = sourceLines[0];
  if (ownerLine === undefined) return invalidTaskSyntax();
  const result = applyTaskCommand(codec, ownerLine, {
    type: 'patch',
    target: { type: 'task', ref: DRAFT_REF },
    patch: initial,
  });
  if (result.type === 'invalid') return result;
  sourceLines[0] = result.content;
  return undefined;
}

function applyInitialStatus(
  codec: TaskMarkdownCodec,
  sourceLines: string[],
  draft: TaskDraft,
): CreateMetadataFailure | undefined {
  const status = draft.initial?.status;
  if (status === undefined) return undefined;
  if (!codec.matchesStatusRule(status))
    return invalidTaskResult([{ code: 'invalid-status', field: 'status' }]);
  const owner = sourceLines[0];
  if (owner === undefined) return invalidTaskSyntax();
  const result = applyTaskCommand(codec, owner, {
    type: 'set-status',
    target: { type: 'task', ref: DRAFT_REF },
    symbol: status.symbol,
    ...(draft.today === undefined ? {} : { stamp: draft.today }),
    ...(draft.addCompletionDate === undefined
      ? {}
      : { addCompletionDate: draft.addCompletionDate }),
  });
  if (result.type === 'invalid') return result;
  sourceLines[0] = result.content;
  return undefined;
}

/** A read-only context root shares creation metadata stages without authorizing a task title. */
export function readTaskCreateContext(
  codec: TaskMarkdownCodec,
  draft: TaskDraft,
): ReadTaskCreateContextResult {
  if (/[\r\n]/u.test(draft.markdownBody)) return invalidTaskSyntax();
  const sourceLines = [`- [ ] ${draft.markdownBody}`];
  const parsed = codec.parseLine(sourceLines[0] ?? '', { filePath: '', line: 0 });
  if (parsed === null) return invalidTaskSyntax();
  const issues = creationMetadataIssues(codec, parsed);
  if (issues.length > 0) return invalidTaskResult(issues);
  const patch = applyInitialPatch(codec, sourceLines, draft.initial);
  if (patch !== undefined) return patch;
  const status = applyInitialStatus(codec, sourceLines, draft);
  if (status !== undefined) return status;
  const normalized = normalizeSourceLines(codec, sourceLines);
  return normalized ?? { type: 'context', content: sourceLines.join('\n') };
}

/** Newly authored raw timing follows the same final-candidate rule as field edits. */
function normalizeSourceLines(
  codec: TaskMarkdownCodec,
  sourceLines: string[],
): CreateMetadataFailure | undefined {
  for (const [index, sourceLine] of sourceLines.entries()) {
    const result = normalizeCreatedTaskLine(codec, sourceLine);
    if (result.type === 'invalid') return result;
    sourceLines[index] = result.content;
  }
  return undefined;
}

function stampSourceLines(
  codec: TaskMarkdownCodec,
  sourceLines: readonly string[],
  today: LocalDate,
): string {
  return sourceLines
    .map((sourceLine) => {
      const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
      return parsed != null ? stampCreatedDate(parsed, today) : sourceLine;
    })
    .join('\n');
}

/** Builds, validates, and stamps exactly one root task block without inserting it into a note. */
export function createTaskBlock(
  codec: TaskMarkdownCodec,
  draft: TaskDraft & { readonly today: LocalDate; readonly addCreatedDate: boolean },
): CreateTaskBlockResult {
  const content = draftContent(draft.markdownBody);
  if (content.type === 'invalid') return content;
  if (!validRootBlock(content.content)) return invalidTaskSyntax();
  const sourceLines = content.content.split('\n');
  const validation = validateSourceLines(codec, sourceLines);
  if (validation !== undefined) return validation;
  const patch = applyInitialPatch(codec, sourceLines, draft.initial);
  if (patch !== undefined) return patch;
  const status = applyInitialStatus(codec, sourceLines, draft);
  if (status !== undefined) return status;
  const normalized = normalizeSourceLines(codec, sourceLines);
  if (normalized !== undefined) return normalized;
  const updated = sourceLines.join('\n');
  return {
    type: 'created',
    content: draft.addCreatedDate ? stampSourceLines(codec, sourceLines, draft.today) : updated,
  };
}
