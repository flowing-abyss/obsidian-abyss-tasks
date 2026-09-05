import { parseCommentTimestampPrefix, type AtomDateTime } from '../../domain/commentTimestamp';
import {
  recurrenceOwnedSubtree,
  stripRecurrenceTerminalBlockId,
  type RecurrenceOwnedSubtree,
} from '../../domain/recurrenceIteration';
import type { TaskInsertionPolicy } from '../../domain/types';
import { isTaskBlockBlankLine } from './taskBlockSyntax';

const TASK_RE = /^[\s>]*- \[(.)\]/u;
const PREFIX_RE = /^([\s>]*)/u;
const DESCRIPTION_RE = /^[\s>]*- > /u;

export function stripTerminalBlockId(line: string): string {
  return stripRecurrenceTerminalBlockId(line);
}

export interface TaskRootBlock {
  readonly line: number;
  readonly toLine: number;
  readonly source: string;
}

interface SourceLine {
  text: string;
  ending: '' | '\n' | '\r\n';
  readonly from: number;
  readonly to: number;
}

interface ReadSourceLineResult {
  readonly line: SourceLine;
  readonly next: number;
}

function readSourceLine(content: string, from: number): ReadSourceLineResult {
  const newline = content.indexOf('\n', from);
  const to = newline < 0 ? content.length : newline + 1;
  const hasCrLf = newline > from && content[newline - 1] === '\r';
  if (newline < 0) {
    return { line: { text: content.slice(from), ending: '', from, to }, next: to };
  }
  const textTo = newline - (hasCrLf ? 1 : 0);
  const ending = hasCrLf ? '\r\n' : '\n';
  return { line: { text: content.slice(from, textTo), ending, from, to }, next: to };
}

export interface TaskBlockTarget {
  readonly relativeLine: number;
  readonly lineCount: number;
  readonly childRanges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  readonly description?: string;
}

export type TaskBlockEdit =
  | { readonly type: 'set-description'; readonly text: string | null }
  | { readonly type: 'add-subtask'; readonly text: string }
  | {
      readonly type: 'restore-subtask';
      readonly markdown: string;
      readonly placement: {
        readonly relativeLine: number;
        readonly before?: { readonly relativeLine: number; readonly originalBlock: string };
        readonly after?: { readonly relativeLine: number; readonly originalBlock: string };
        readonly lineEnding?: '\n' | '\r\n';
      };
    }
  | {
      readonly type: 'delete-subtask';
      readonly relativeLine: number;
      readonly originalBlock: string;
    }
  | {
      readonly type: 'reorder-subtask';
      readonly source: { readonly relativeLine: number; readonly originalBlock: string };
      readonly target: { readonly relativeLine: number; readonly originalBlock: string };
      readonly placement: 'before' | 'after';
    }
  | { readonly type: 'add-comment'; readonly text: string; readonly stamp: AtomDateTime }
  | {
      readonly type: 'update-comment';
      readonly relativeLine: number;
      readonly originalMarkdown: string;
      readonly text: string;
    }
  | {
      readonly type: 'delete-comment';
      readonly relativeLine: number;
      readonly originalMarkdown: string;
    };

export type TaskBlockEditResult =
  | {
      readonly type: 'changed';
      readonly content: string;
      readonly block: TaskRootBlock;
      readonly removedSubtask?: { readonly markdown: string; readonly lineEnding?: '\n' | '\r\n' };
    }
  | { readonly type: 'unchanged'; readonly content: string; readonly block: TaskRootBlock }
  | { readonly type: 'conflict' }
  | { readonly type: 'invalid'; readonly field: 'description' | 'comment' | 'subtask' };

function sourceLines(content: string): SourceLine[] {
  const result: SourceLine[] = [];
  let from = 0;
  while (from < content.length) {
    const read = readSourceLine(content, from);
    result.push(read.line);
    from = read.next;
  }
  return result;
}

function indentation(line: string): number {
  const prefix = PREFIX_RE.exec(line)?.[1] ?? '';
  return prefix.replace(/>/gu, ' ').replace(/\t/gu, '    ').length;
}

function quoteDepth(line: string): number {
  return [...(PREFIX_RE.exec(line)?.[1] ?? '')].filter((character) => character === '>').length;
}

function firstNonEmptyEnding(lines: readonly SourceLine[]): '\n' | '\r\n' {
  const ending = lines.find((line) => line.ending !== '')?.ending;
  return ending === '\r\n' ? '\r\n' : '\n';
}

function preferredEnding(lines: readonly SourceLine[], parentLine: number): '\n' | '\r\n' {
  const parentEnding = lines[parentLine]?.ending;
  if (parentEnding === '\n' || parentEnding === '\r\n') return parentEnding;
  return firstNonEmptyEnding(lines);
}

function serializeLines(
  lines: SourceLine[],
  hadFinalEnding: boolean,
  ending: '\n' | '\r\n',
): string {
  const last = lines[lines.length - 1];
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index];
    if (line?.ending === '') line.ending = ending;
  }
  if (last !== undefined) {
    if (!hadFinalEnding) last.ending = '';
    else if (last.ending === '') last.ending = ending;
  }
  return lines.map((line) => line.text + line.ending).join('');
}

function insertedLines(texts: readonly string[], ending: '\n' | '\r\n'): SourceLine[] {
  return texts.map((text) => ({ text, ending, from: 0, to: 0 }));
}

function insertAt(
  lines: SourceLine[],
  index: number,
  additions: readonly SourceLine[],
  ending: '\n' | '\r\n',
): void {
  const previous = lines[index - 1];
  if (index === lines.length && previous?.ending === '') previous.ending = ending;
  lines.splice(index, 0, ...additions);
}

function lineWithoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

interface ConfirmedChildRange {
  readonly from: number;
  readonly to: number;
}

function childBlockLines(originalBlock: string): readonly string[] {
  return originalBlock.split(/\r?\n/u).map(lineWithoutCr);
}

function confirmedChildRange(
  lines: readonly SourceLine[],
  parentLine: number,
  target: TaskBlockTarget,
  child: { readonly relativeLine: number; readonly originalBlock: string },
): ConfirmedChildRange | undefined {
  const expected = childBlockLines(child.originalBlock);
  if (child.relativeLine <= 0 || expected.length === 0) return undefined;
  const range = target.childRanges.find(
    (candidate) =>
      candidate.from === child.relativeLine &&
      candidate.to === child.relativeLine + expected.length - 1,
  );
  if (range == null) return undefined;
  const from = parentLine + range.from;
  const to = parentLine + range.to;
  if (to >= lines.length) return undefined;
  return expected.every((line, index) => lines[from + index]?.text === line)
    ? { from, to }
    : undefined;
}

function isConfirmedTarget(
  parent: SourceLine | undefined,
  parentLine: number,
  block: TaskRootBlock,
  target: TaskBlockTarget,
): parent is SourceLine {
  return (
    parent !== undefined &&
    TASK_RE.test(parent.text) &&
    target.lineCount >= 1 &&
    parentLine + target.lineCount - 1 <= block.toLine
  );
}

function commentParts(
  line: string,
): { readonly prefix: string; readonly text: string } | undefined {
  const parsed = parseCommentTimestampPrefix(line);
  return parsed != null ? { prefix: parsed.prefix, text: parsed.text } : undefined;
}

interface BlockEditContext {
  readonly lines: SourceLine[];
  readonly content: string;
  readonly block: TaskRootBlock;
  readonly target: TaskBlockTarget;
  readonly parent: SourceLine;
  readonly parentLine: number;
  readonly ending: '\n' | '\r\n';
  readonly hadFinalEnding: boolean;
}

function compatibleBlankLine(line: string, parent: string): boolean {
  return (
    isTaskBlockBlankLine(line) &&
    (quoteDepth(line) === 0 || quoteDepth(line) === quoteDepth(parent))
  );
}

function validRestoredSubtree(lines: readonly SourceLine[], parent: string): boolean {
  const first = lines[0]?.text;
  if (first === undefined || !TASK_RE.test(first)) return false;
  const depth = indentation(first);
  return (
    depth > indentation(parent) &&
    quoteDepth(first) === quoteDepth(parent) &&
    lines
      .slice(1)
      .every(
        (line) =>
          compatibleBlankLine(line.text, parent) ||
          (indentation(line.text) > depth && quoteDepth(line.text) === quoteDepth(first)),
      )
  );
}

type RestorePlacement = Extract<TaskBlockEdit, { readonly type: 'restore-subtask' }>['placement'];

function restoredSubtaskLine(
  context: BlockEditContext,
  placement: RestorePlacement,
): number | undefined {
  const { relativeLine } = placement;
  if (!Number.isSafeInteger(relativeLine) || relativeLine <= 0) return undefined;
  const anchors = restorationAnchors(context, placement);
  if (anchors === undefined) return undefined;
  const { before: beforeRange, after: afterRange } = anchors;
  const insertion = anchoredRestorationLine(context, placement, anchors);
  if (!safeRestorationGap(context, insertion)) return undefined;
  if (
    (beforeRange !== undefined && insertion > beforeRange.from) ||
    (afterRange !== undefined && insertion <= afterRange.to)
  )
    return undefined;
  if (
    context.target.childRanges.some(
      (range) => relativeLine > range.from && relativeLine <= range.to,
    )
  )
    return undefined;
  return insertion;
}

function safeRestorationGap(context: BlockEditContext, insertion: number): boolean {
  if (insertion > context.lines.length) return false;
  for (let line = context.parentLine + context.target.lineCount; line < insertion; line++) {
    const source = context.lines[line];
    if (source === undefined || !compatibleBlankLine(source.text, context.parent.text))
      return false;
  }
  return true;
}

interface RestorationAnchors {
  readonly before: ConfirmedChildRange | undefined;
  readonly after: ConfirmedChildRange | undefined;
}

function restorationAnchors(
  context: BlockEditContext,
  placement: RestorePlacement,
): RestorationAnchors | undefined {
  const ranges = [placement.before, placement.after].map((anchor) =>
    anchor === undefined
      ? undefined
      : confirmedChildRange(context.lines, context.parentLine, context.target, anchor),
  );
  if (
    (placement.before !== undefined && ranges[0] === undefined) ||
    (placement.after !== undefined && ranges[1] === undefined)
  )
    return undefined;
  return { before: ranges[0], after: ranges[1] };
}

function anchoredRestorationLine(
  context: BlockEditContext,
  placement: RestorePlacement,
  anchors: RestorationAnchors,
): number {
  if (placement.before !== undefined && anchors.before !== undefined)
    return anchors.before.from + placement.relativeLine - placement.before.relativeLine;
  if (placement.after !== undefined && anchors.after !== undefined)
    return anchors.after.from + placement.relativeLine - placement.after.relativeLine;
  return context.parentLine + placement.relativeLine;
}

function restoreSeparator(
  context: BlockEditContext,
  placement: RestorePlacement,
): '\n' | '\r\n' | undefined {
  if (
    placement.before === undefined &&
    placement.after === undefined &&
    placement.lineEnding !== undefined
  )
    return placement.lineEnding;
  const endings = new Set(
    context.lines.map((line) => line.ending).filter((ending) => ending !== ''),
  );
  return endings.size === 1 ? [...endings][0] : undefined;
}

function rootBlockAt(
  lines: readonly SourceLine[],
  content: string,
  index: number,
): { readonly block: TaskRootBlock; readonly next: number } | undefined {
  const rootLine = lines[index];
  if (rootLine == null || !TASK_RE.test(rootLine.text)) return undefined;
  const rootIndent = indentation(rootLine.text);
  const rootQuote = quoteDepth(rootLine.text);
  let toLine = index;
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line == null) break;
    if (isTaskBlockBlankLine(line.text)) {
      cursor++;
      continue;
    }
    if (quoteDepth(line.text) !== rootQuote || indentation(line.text) <= rootIndent) break;
    toLine = cursor;
    cursor++;
  }
  const last = lines[toLine];
  const to = last != null ? last.to - last.ending.length : rootLine.from;
  return {
    block: { line: index, toLine, source: content.slice(rootLine.from, to) },
    next: Math.max(index + 1, cursor),
  };
}

function validCapturedBlock(
  source: string,
  lines: readonly SourceLine[],
  blocks: readonly TaskRootBlock[],
): boolean {
  const block = blocks[0];
  return (
    lines.length > 0 &&
    blocks.length === 1 &&
    block?.line === 0 &&
    block.toLine === lines.length - 1 &&
    block.source === source
  );
}

function rootInsertionIndex(
  lines: SourceLine[],
  insertion: TaskInsertionPolicy,
  ending: '\n' | '\r\n',
): number {
  if (insertion.type !== 'section' || insertion.heading.trim().length === 0) return lines.length;
  const heading = insertion.heading.trim();
  const found = lines.findIndex((line) => line.text.trim() === heading);
  if (found >= 0) return found + 1;
  if (lines.length > 0 && lines[lines.length - 1]?.text.trim().length !== 0) {
    insertAt(lines, lines.length, insertedLines([''], ending), ending);
  }
  insertAt(lines, lines.length, insertedLines([insertion.heading], ending), ending);
  return lines.length;
}

export class TaskBlockEditor {
  ownedTaskSubtree(
    rootBlock: string,
    ownerRelativeLine: number,
  ): RecurrenceOwnedSubtree | undefined {
    return recurrenceOwnedSubtree(rootBlock, ownerRelativeLine);
  }

  rootBlocks(content: string): readonly TaskRootBlock[] {
    const lines = sourceLines(content);
    const roots: TaskRootBlock[] = [];
    let index = 0;
    while (index < lines.length) {
      const found = rootBlockAt(lines, content, index);
      if (found === undefined) {
        index++;
        continue;
      }
      roots.push(found.block);
      index = found.next;
    }
    return roots;
  }

  insertRoot(
    content: string,
    taskLine: string,
    insertion: TaskInsertionPolicy,
  ): { readonly content: string; readonly block: TaskRootBlock } | undefined {
    if (/[\r\n]/u.test(taskLine)) return undefined;
    return this.insertRootBlock(content, taskLine, insertion);
  }

  insertRootBlock(
    content: string,
    blockSource: string,
    insertion: TaskInsertionPolicy,
  ): { readonly content: string; readonly block: TaskRootBlock } | undefined {
    const capturedLines = sourceLines(blockSource);
    const capturedBlocks = this.rootBlocks(blockSource);
    if (!validCapturedBlock(blockSource, capturedLines, capturedBlocks)) return undefined;
    const lines = sourceLines(content);
    const ending = firstNonEmptyEnding(lines);
    const hadFinalEnding = content.endsWith('\n');
    const at = rootInsertionIndex(lines, insertion, ending);
    insertAt(
      lines,
      at,
      capturedLines.map((line) => ({ ...line })),
      ending,
    );
    const next = serializeLines(lines, hadFinalEnding, ending);
    const block = this.rootBlocks(next).find((candidate) => candidate.line === at);
    return block != null ? { content: next, block } : undefined;
  }

  deleteRoot(content: string, block: TaskRootBlock): string | undefined {
    const lines = sourceLines(content);
    const first = lines[block.line];
    const last = lines[block.toLine];
    if (first == null || last == null) return undefined;
    let from = first.from;
    if (last.ending === '' && from > 0) {
      const previous = lines[block.line - 1];
      if (previous != null) from -= previous.ending.length;
    }
    return content.slice(0, from) + content.slice(last.to);
  }

  replaceOwnedTaskSubtree(
    content: string,
    block: TaskRootBlock,
    ownerRelativeLine: number,
    replacements: readonly string[],
  ): string | undefined {
    const ownership = this.ownedTaskSubtree(block.source, ownerRelativeLine);
    if (ownership == null || replacements.some((replacement) => replacement.length === 0)) {
      return undefined;
    }
    const lines = sourceLines(content);
    const first = lines[block.line + ownership.fromLine];
    const last = lines[block.line + ownership.toLine];
    if (first == null || last == null || block.line + ownership.toLine > block.toLine)
      return undefined;

    if (replacements.length === 0) {
      return content.slice(0, first.from) + content.slice(last.to);
    }
    const ending = preferredEnding(lines, block.line + ownership.fromLine);
    const replacement = replacements.join(ending) + last.ending;
    return content.slice(0, first.from) + replacement + content.slice(last.to);
  }

  replaceLine(
    content: string,
    block: TaskRootBlock,
    relativeLine: number,
    replacement: string,
  ): { readonly content: string; readonly block: TaskRootBlock } {
    const lines = sourceLines(content);
    const absoluteLine = block.line + relativeLine;
    const current = lines[absoluteLine];
    if (current == null || absoluteLine > block.toLine) return { content, block };
    const next =
      content.slice(0, current.from) + replacement + current.ending + content.slice(current.to);
    const updated =
      this.rootBlocks(next).find((candidate) => candidate.line === block.line) ?? block;
    return { content: next, block: updated };
  }

  descriptionLines(
    content: string,
    block: TaskRootBlock,
    target: TaskBlockTarget,
  ): readonly number[] {
    const lines = sourceLines(content);
    const result: number[] = [];
    for (let relative = 1; relative < target.lineCount; relative++) {
      if (target.childRanges.some((range) => relative >= range.from && relative <= range.to)) {
        continue;
      }
      const rootRelative = target.relativeLine + relative;
      if (DESCRIPTION_RE.test(lines[block.line + rootRelative]?.text ?? '')) {
        result.push(rootRelative);
      }
    }
    return result;
  }

  private editDescription(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'set-description' }>,
  ): TaskBlockEditResult | undefined {
    const { content, block, target } = context;
    if (edit.text?.includes('\r') ?? false) return { type: 'invalid', field: 'description' };
    const requested = edit.text ?? undefined;
    if (requested === target.description) return { type: 'unchanged', content, block };
    const directDescriptions = this.descriptionLines(content, block, target);
    this.replaceDescriptionLines(context, directDescriptions, requested);
    return undefined;
  }

  private replaceDescriptionLines(
    context: BlockEditContext,
    directDescriptions: readonly number[],
    requested: string | undefined,
  ): void {
    const { lines, block, parent, parentLine, ending } = context;
    const firstDescription = directDescriptions[0];
    const insertionLine =
      firstDescription === undefined ? parentLine + 1 : block.line + firstDescription;
    for (const relativeLine of [...directDescriptions].sort((left, right) => right - left)) {
      lines.splice(block.line + relativeLine, 1);
    }
    if (requested !== undefined) {
      const prefix = `${PREFIX_RE.exec(parent.text)?.[1] ?? ''}  `;
      const replacements = requested.split('\n').map((line) => `${prefix}- > ${line}`);
      insertAt(lines, insertionLine, insertedLines(replacements, ending), ending);
    }
  }

  private editSubtaskStructure(
    context: BlockEditContext,
    edit: Extract<
      TaskBlockEdit,
      { readonly type: 'add-subtask' | 'delete-subtask' | 'restore-subtask' | 'reorder-subtask' }
    >,
  ): TaskBlockEditResult | undefined {
    if (edit.type === 'add-subtask') return this.addSubtask(context, edit);
    if (edit.type === 'delete-subtask') return this.deleteSubtask(context, edit);
    if (edit.type === 'restore-subtask') return this.restoreSubtask(context, edit);
    return this.reorderSubtask(context, edit);
  }

  private addSubtask(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'add-subtask' }>,
  ): TaskBlockEditResult | undefined {
    if (edit.text.trim().length === 0 || /[\r\n]/u.test(edit.text)) {
      return { type: 'invalid', field: 'subtask' };
    }
    const prefix = `${PREFIX_RE.exec(context.parent.text)?.[1] ?? ''}  `;
    insertAt(
      context.lines,
      context.parentLine + context.target.lineCount,
      insertedLines([`${prefix}- [ ] ${edit.text}`], context.ending),
      context.ending,
    );
    return undefined;
  }

  private deleteSubtask(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'delete-subtask' }>,
  ): TaskBlockEditResult | undefined {
    const range = confirmedChildRange(context.lines, context.parentLine, context.target, edit);
    if (range == null) return { type: 'conflict' };
    const first = context.lines[range.from];
    const last = context.lines[range.to];
    if (first === undefined || last === undefined) return { type: 'conflict' };
    const previousEnding = context.lines[range.from - 1]?.ending;
    const lineEnding = last.ending === '' ? previousEnding : undefined;
    const markdown = context.content.slice(first.from, last.to);
    context.lines.splice(range.from, range.to - range.from + 1);
    const result = this.editedResult(context);
    return result.type === 'changed'
      ? {
          ...result,
          removedSubtask: {
            markdown,
            ...(lineEnding === '\n' || lineEnding === '\r\n' ? { lineEnding } : {}),
          },
        }
      : result;
  }

  private restoreSubtask(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'restore-subtask' }>,
  ): TaskBlockEditResult | undefined {
    const additions = sourceLines(edit.markdown);
    if (!validRestoredSubtree(additions, context.parent.text)) {
      return { type: 'invalid', field: 'subtask' };
    }
    // Deleting a no-final-newline subtree can leave an empty EOF line omitted by sourceLines.
    if (
      context.hadFinalEnding &&
      !edit.markdown.endsWith('\n') &&
      context.parentLine + edit.placement.relativeLine === context.lines.length + 1
    ) {
      context.lines.push({
        text: '',
        ending: '',
        from: context.content.length,
        to: context.content.length,
      });
    }
    const insertion = restoredSubtaskLine(context, edit.placement);
    if (insertion === undefined) return { type: 'conflict' };
    const hadFinalEnding =
      insertion === context.lines.length ? edit.markdown.endsWith('\n') : context.hadFinalEnding;
    const previous = context.lines[insertion - 1];
    if (previous?.ending === '') {
      const ending = restoreSeparator(context, edit.placement);
      if (ending === undefined) return { type: 'conflict' };
      previous.ending = ending;
    }
    context.lines.splice(insertion, 0, ...additions);
    return this.editedResult({ ...context, hadFinalEnding });
  }

  private reorderSubtask(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'reorder-subtask' }>,
  ): TaskBlockEditResult | undefined {
    const { lines, parentLine, target, content, block } = context;
    const source = confirmedChildRange(lines, parentLine, target, edit.source);
    const destination = confirmedChildRange(lines, parentLine, target, edit.target);
    if (source == null || destination == null) return { type: 'conflict' };
    if (source.from === destination.from && source.to === destination.to) {
      return { type: 'unchanged', content, block };
    }
    const moved = lines.splice(source.from, source.to - source.from + 1);
    const removed = moved.length;
    const targetFrom = destination.from - (source.from < destination.from ? removed : 0);
    const targetTo = destination.to - (source.from < destination.from ? removed : 0);
    const insertion = edit.placement === 'before' ? targetFrom : targetTo + 1;
    lines.splice(insertion, 0, ...moved);
    return undefined;
  }

  private addComment(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'add-comment' }>,
  ): TaskBlockEditResult | undefined {
    if (edit.text.length === 0 || /[\r\n]/u.test(edit.text)) {
      return { type: 'invalid', field: 'comment' };
    }
    const prefix = `${PREFIX_RE.exec(context.parent.text)?.[1] ?? ''}  `;
    const addition = `${prefix}- ${edit.stamp}: ${edit.text}`;
    insertAt(
      context.lines,
      context.parentLine + context.target.lineCount,
      insertedLines([addition], context.ending),
      context.ending,
    );
    return undefined;
  }

  private editExistingComment(
    context: BlockEditContext,
    edit: Extract<TaskBlockEdit, { readonly type: 'update-comment' | 'delete-comment' }>,
  ): TaskBlockEditResult | undefined {
    const commentLine = context.parentLine + edit.relativeLine;
    const current = context.lines[commentLine];
    if (
      edit.relativeLine <= 0 ||
      edit.relativeLine >= context.target.lineCount ||
      current?.text !== lineWithoutCr(edit.originalMarkdown)
    ) {
      return { type: 'conflict' };
    }
    const comment = commentParts(current.text);
    if (comment == null) return { type: 'conflict' };
    if (edit.type === 'delete-comment') {
      context.lines.splice(commentLine, 1);
      return undefined;
    }
    if (edit.text.length === 0 || /[\r\n]/u.test(edit.text)) {
      return { type: 'invalid', field: 'comment' };
    }
    if (comment.text.trim() === edit.text) {
      return { type: 'unchanged', content: context.content, block: context.block };
    }
    current.text = `${comment.prefix}${edit.text}`;
    return undefined;
  }

  private applyEdit(
    context: BlockEditContext,
    edit: TaskBlockEdit,
  ): TaskBlockEditResult | undefined {
    switch (edit.type) {
      case 'set-description':
        return this.editDescription(context, edit);
      case 'add-subtask':
      case 'delete-subtask':
      case 'restore-subtask':
      case 'reorder-subtask':
        return this.editSubtaskStructure(context, edit);
      case 'add-comment':
        return this.addComment(context, edit);
      case 'update-comment':
      case 'delete-comment':
        return this.editExistingComment(context, edit);
    }
  }

  private editedResult(context: BlockEditContext): TaskBlockEditResult {
    const next = serializeLines(context.lines, context.hadFinalEnding, context.ending);
    if (next === context.content) {
      return { type: 'unchanged', content: context.content, block: context.block };
    }
    const updated = this.rootBlocks(next).find(
      (candidate) => candidate.line === context.block.line,
    );
    return updated != null
      ? { type: 'changed', content: next, block: updated }
      : { type: 'conflict' };
  }

  edit(
    content: string,
    block: TaskRootBlock,
    target: TaskBlockTarget,
    edit: TaskBlockEdit,
  ): TaskBlockEditResult {
    const lines = sourceLines(content);
    const parentLine = block.line + target.relativeLine;
    const parent = lines[parentLine];
    if (!isConfirmedTarget(parent, parentLine, block, target)) {
      return { type: 'conflict' };
    }

    const context: BlockEditContext = {
      lines,
      content,
      block,
      target,
      parent,
      parentLine,
      ending: preferredEnding(lines, parentLine),
      hadFinalEnding: content.endsWith('\n'),
    };
    const earlyResult = this.applyEdit(context, edit);
    return earlyResult ?? this.editedResult(context);
  }
}
