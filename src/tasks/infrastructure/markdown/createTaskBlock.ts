import type { TaskDraft } from '../../application/TaskRepository';
import type { LocalDate, TaskRef } from '../../domain/types';
import type { TaskIssue } from '../../domain/validation';
import { applyTaskCommand } from './applyTaskCommand';
import { createdDateIssues, stampCreatedDate } from './createTaskLine';
import { TaskBlockEditor } from './TaskBlockEditor';
import { type TaskMarkdownCodec } from './TaskMarkdownCodec';

const DRAFT_REF: TaskRef = { filePath: '', line: 0, revision: '' };
const editor = new TaskBlockEditor();

function invalid(issues: readonly TaskIssue[]): {
  readonly type: 'invalid';
  readonly issues: readonly TaskIssue[];
} {
  return { type: 'invalid' as const, issues };
}

type CreateTaskBlockResult =
  | { readonly type: 'created'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

type DraftContentResult =
  | { readonly type: 'content'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

function draftContent(markdownBody: string): DraftContentResult {
  if (markdownBody.replace(/\r\n/gu, '').includes('\r')) {
    return invalid([{ code: 'invalid-title', field: 'title' }]);
  }
  const [owner, ...nested] = markdownBody.replace(/\r\n/gu, '\n').split('\n');
  if (owner === undefined || owner.trim().length === 0) {
    return invalid([{ code: 'invalid-title', field: 'title' }]);
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
): CreateTaskBlockResult | undefined {
  for (const sourceLine of sourceLines) {
    const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
    if (parsed == null) continue;
    if (parsed.markdownTitle.trim().length === 0) {
      return invalid([{ code: 'invalid-title', field: 'title' }]);
    }
    const issues = [...codec.validateLine(sourceLine), ...createdDateIssues(parsed)];
    if (issues.length > 0) return invalid(issues);
  }
  return undefined;
}

function applyInitialPatch(
  codec: TaskMarkdownCodec,
  sourceLines: string[],
  initial: TaskDraft['initial'],
): CreateTaskBlockResult | undefined {
  if (initial === undefined || Object.keys(initial).length === 0) return undefined;
  const ownerLine = sourceLines[0];
  if (ownerLine === undefined) return invalid([{ code: 'invalid-task-syntax' }]);
  const result = applyTaskCommand(codec, ownerLine, {
    type: 'patch',
    target: { type: 'task', ref: DRAFT_REF },
    patch: initial,
  });
  if (result.type === 'invalid') return result;
  sourceLines[0] = result.content;
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
  if (!validRootBlock(content.content)) return invalid([{ code: 'invalid-task-syntax' }]);
  const sourceLines = content.content.split('\n');
  const validation = validateSourceLines(codec, sourceLines);
  if (validation !== undefined) return validation;
  const patch = applyInitialPatch(codec, sourceLines, draft.initial);
  if (patch !== undefined) return patch;
  const updated = sourceLines.join('\n');
  return {
    type: 'created',
    content: draft.addCreatedDate ? stampSourceLines(codec, sourceLines, draft.today) : updated,
  };
}
