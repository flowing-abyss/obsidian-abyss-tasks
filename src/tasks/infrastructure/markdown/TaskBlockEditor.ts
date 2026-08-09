import {
  recurrenceOwnedSubtree,
  stripRecurrenceTerminalBlockId,
  type RecurrenceOwnedSubtree,
} from '../../domain/recurrenceIteration';
import type { LocalDate, TaskInsertionPolicy } from '../../domain/types';

const TASK_RE = /^[\s>]*- \[(.)\]/u;
const PREFIX_RE = /^([\s>]*)/u;
const DESCRIPTION_RE = /^[\s>]*- > /u;
const COMMENT_LIST_PREFIX_RE = /^([\s>]*- )/u;
const COMMENT_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}:/u;

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

export interface TaskBlockTarget {
  readonly relativeLine: number;
  readonly lineCount: number;
  readonly childRanges: readonly { readonly from: number; readonly to: number }[];
  readonly description?: string;
}

export type TaskBlockEdit =
  | { readonly type: 'set-description'; readonly text: string | null }
  | { readonly type: 'add-subtask'; readonly text: string }
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
  | { readonly type: 'add-comment'; readonly text: string; readonly stamp: LocalDate }
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
  | { readonly type: 'changed'; readonly content: string; readonly block: TaskRootBlock }
  | { readonly type: 'unchanged'; readonly content: string; readonly block: TaskRootBlock }
  | { readonly type: 'conflict' }
  | { readonly type: 'invalid'; readonly field: 'description' | 'comment' | 'subtask' };

function sourceLines(content: string): SourceLine[] {
  const result: SourceLine[] = [];
  let from = 0;
  while (from < content.length) {
    const newline = content.indexOf('\n', from);
    const to = newline < 0 ? content.length : newline + 1;
    const hasCrLf = newline > from && content[newline - 1] === '\r';
    let textTo = content.length;
    let ending: SourceLine['ending'] = '';
    if (newline >= 0) {
      textTo = newline - (hasCrLf ? 1 : 0);
      ending = hasCrLf ? '\r\n' : '\n';
    }
    result.push({ text: content.slice(from, textTo), ending, from, to });
    from = to;
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

function preferredEnding(lines: readonly SourceLine[], parentLine: number): '\n' | '\r\n' {
  const parentEnding = lines[parentLine]?.ending;
  if (parentEnding) return parentEnding;
  return lines.find((line) => line.ending !== '')?.ending || '\n';
}

function serializeLines(
  lines: SourceLine[],
  hadFinalEnding: boolean,
  ending: '\n' | '\r\n',
): string {
  const last = lines[lines.length - 1];
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index];
    if (line && line.ending === '') line.ending = ending;
  }
  if (last) last.ending = hadFinalEnding ? last.ending || ending : '';
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
  if (!range) return undefined;
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
  const listPrefix = COMMENT_LIST_PREFIX_RE.exec(line)?.[1];
  if (listPrefix === undefined) return undefined;
  let textFrom = listPrefix.length;
  if (COMMENT_DATE_PREFIX_RE.test(line.slice(textFrom))) {
    textFrom += 11;
    while (line[textFrom] === ' ' || line[textFrom] === '\t') textFrom++;
  }
  return { prefix: line.slice(0, textFrom), text: line.slice(textFrom) };
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
      const rootLine = lines[index];
      if (!rootLine || !TASK_RE.test(rootLine.text)) {
        index++;
        continue;
      }
      const rootIndent = indentation(rootLine.text);
      const rootQuote = quoteDepth(rootLine.text);
      let toLine = index;
      let cursor = index + 1;
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (!line) break;
        if (/^[\s>]*$/u.test(line.text)) {
          cursor++;
          continue;
        }
        if (quoteDepth(line.text) !== rootQuote || indentation(line.text) <= rootIndent) break;
        toLine = cursor;
        cursor++;
      }
      const from = rootLine.from;
      const last = lines[toLine];
      const to = last ? last.to - last.ending.length : from;
      roots.push({
        line: index,
        toLine,
        source: content.slice(from, to),
      });
      index = Math.max(index + 1, cursor);
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
    if (
      capturedLines.length === 0 ||
      capturedBlocks.length !== 1 ||
      capturedBlocks[0]?.line !== 0 ||
      capturedBlocks[0].toLine !== capturedLines.length - 1 ||
      capturedBlocks[0].source !== blockSource
    ) {
      return undefined;
    }
    const lines = sourceLines(content);
    const ending = lines.find((line) => line.ending !== '')?.ending || '\n';
    const hadFinalEnding = content.endsWith('\n');
    let at = lines.length;

    if (insertion.type === 'section' && insertion.heading.trim().length > 0) {
      const heading = insertion.heading.trim();
      const found = lines.findIndex((line) => line.text.trim() === heading);
      if (found >= 0) {
        at = found + 1;
      } else {
        if (lines.length > 0 && lines[lines.length - 1]?.text.trim().length !== 0) {
          insertAt(lines, lines.length, insertedLines([''], ending), ending);
        }
        insertAt(lines, lines.length, insertedLines([insertion.heading], ending), ending);
        at = lines.length;
      }
    }

    insertAt(
      lines,
      at,
      capturedLines.map((line) => ({ ...line })),
      ending,
    );
    const next = serializeLines(lines, hadFinalEnding, ending);
    const block = this.rootBlocks(next).find((candidate) => candidate.line === at);
    return block ? { content: next, block } : undefined;
  }

  deleteRoot(content: string, block: TaskRootBlock): string | undefined {
    const lines = sourceLines(content);
    const first = lines[block.line];
    const last = lines[block.toLine];
    if (!first || !last) return undefined;
    let from = first.from;
    if (last.ending === '' && from > 0) {
      const previous = lines[block.line - 1];
      if (previous) from -= previous.ending.length;
    }
    return content.slice(0, from) + content.slice(last.to);
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
    if (!current || absoluteLine > block.toLine) return { content, block };
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
    lines: SourceLine[],
    content: string,
    block: TaskRootBlock,
    target: TaskBlockTarget,
    parent: SourceLine,
    parentLine: number,
    ending: '\n' | '\r\n',
    edit: Extract<TaskBlockEdit, { readonly type: 'set-description' }>,
  ): TaskBlockEditResult | undefined {
    if (edit.text?.includes('\r')) return { type: 'invalid', field: 'description' };
    const requested = edit.text ?? undefined;
    if (requested === target.description) return { type: 'unchanged', content, block };
    const directDescriptions = this.descriptionLines(content, block, target);
    const insertionLine =
      directDescriptions.length > 0 ? block.line + directDescriptions[0]! : parentLine + 1;
    for (const relativeLine of [...directDescriptions].sort((left, right) => right - left)) {
      lines.splice(block.line + relativeLine, 1);
    }
    if (requested !== undefined) {
      const prefix = `${PREFIX_RE.exec(parent.text)?.[1] ?? ''}  `;
      const replacements = requested.split('\n').map((line) => `${prefix}- > ${line}`);
      insertAt(lines, insertionLine, insertedLines(replacements, ending), ending);
    }
    return undefined;
  }

  private editSubtaskStructure(
    lines: SourceLine[],
    content: string,
    block: TaskRootBlock,
    target: TaskBlockTarget,
    parent: SourceLine,
    parentLine: number,
    ending: '\n' | '\r\n',
    edit: Extract<
      TaskBlockEdit,
      { readonly type: 'add-subtask' | 'delete-subtask' | 'reorder-subtask' }
    >,
  ): TaskBlockEditResult | undefined {
    if (edit.type === 'add-subtask') {
      if (edit.text.trim().length === 0 || /[\r\n]/u.test(edit.text)) {
        return { type: 'invalid', field: 'subtask' };
      }
      const prefix = `${PREFIX_RE.exec(parent.text)?.[1] ?? ''}  `;
      insertAt(
        lines,
        parentLine + target.lineCount,
        insertedLines([`${prefix}- [ ] ${edit.text}`], ending),
        ending,
      );
      return undefined;
    }

    if (edit.type === 'delete-subtask') {
      const range = confirmedChildRange(lines, parentLine, target, edit);
      if (!range) return { type: 'conflict' };
      lines.splice(range.from, range.to - range.from + 1);
      return undefined;
    }

    const source = confirmedChildRange(lines, parentLine, target, edit.source);
    const destination = confirmedChildRange(lines, parentLine, target, edit.target);
    if (!source || !destination) return { type: 'conflict' };
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

    const ending = preferredEnding(lines, parentLine);
    const hadFinalEnding = content.endsWith('\n');

    if (edit.type === 'set-description') {
      const earlyResult = this.editDescription(
        lines,
        content,
        block,
        target,
        parent,
        parentLine,
        ending,
        edit,
      );
      if (earlyResult) return earlyResult;
    } else if (
      edit.type === 'add-subtask' ||
      edit.type === 'delete-subtask' ||
      edit.type === 'reorder-subtask'
    ) {
      const earlyResult = this.editSubtaskStructure(
        lines,
        content,
        block,
        target,
        parent,
        parentLine,
        ending,
        edit,
      );
      if (earlyResult) return earlyResult;
    } else if (edit.type === 'add-comment') {
      if (edit.text.length === 0 || /[\r\n]/u.test(edit.text)) {
        return { type: 'invalid', field: 'comment' };
      }
      const prefix = `${PREFIX_RE.exec(parent.text)?.[1] ?? ''}  `;
      const insertionLine = parentLine + target.lineCount;
      insertAt(
        lines,
        insertionLine,
        insertedLines([`${prefix}- ${edit.stamp}: ${edit.text}`], ending),
        ending,
      );
    } else {
      const commentLine = parentLine + edit.relativeLine;
      const current = lines[commentLine];
      if (
        edit.relativeLine <= 0 ||
        edit.relativeLine >= target.lineCount ||
        !current ||
        current.text !== lineWithoutCr(edit.originalMarkdown)
      ) {
        return { type: 'conflict' };
      }
      const comment = commentParts(current.text);
      if (!comment) return { type: 'conflict' };
      if (edit.type === 'update-comment') {
        if (edit.text.length === 0 || /[\r\n]/u.test(edit.text)) {
          return { type: 'invalid', field: 'comment' };
        }
        if (comment.text.trim() === edit.text) {
          return { type: 'unchanged', content, block };
        }
        current.text = `${comment.prefix}${edit.text}`;
      } else {
        lines.splice(commentLine, 1);
      }
    }

    const next = serializeLines(lines, hadFinalEnding, ending);
    if (next === content) return { type: 'unchanged', content, block };
    const updated = this.rootBlocks(next).find((candidate) => candidate.line === block.line);
    return updated ? { type: 'changed', content: next, block: updated } : { type: 'conflict' };
  }
}
