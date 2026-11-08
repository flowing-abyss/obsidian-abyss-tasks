import type { TaskSourceCopy } from '../../application/TaskSourceCopyApi';
import { taskNodeSourceLine, taskTreeNodes } from '../../domain/taskSearchProjection';
import { sameTaskNodeRef, type TaskSnapshot } from '../../domain/types';
import type {
  TaskBlockEditor,
  TaskBlockTarget,
  TaskNodeLineMapping,
  TaskRootBlock,
} from './TaskBlockEditor';
import {
  hasSourceAnchors,
  prepareSubtreeCopy,
  type HierarchyEndpoint,
  type HierarchyTransferInput,
} from './taskHierarchyTransfer';

export interface SourceGraftInput {
  readonly source: { readonly root: TaskSnapshot; readonly content: string };
  readonly destination: {
    readonly root: TaskSnapshot;
    readonly content: string;
    readonly creating: boolean;
  };
  readonly selection: TaskSourceCopy;
  readonly editor: TaskBlockEditor;
  readonly rewrite: HierarchyTransferInput['rewrite'];
}
export interface SourceGraft {
  readonly content: string;
  readonly from: number;
  readonly count: number;
  readonly sourceFrom: number;
  readonly lineMap: readonly TaskNodeLineMapping[];
}
function endpoint(
  editor: TaskBlockEditor,
  basis: SourceGraftInput['source'],
  target: TaskSourceCopy['parent'],
): HierarchyEndpoint | undefined {
  const node = [...taskTreeNodes(basis.root)].find((n) => sameTaskNodeRef(n.target, target));
  const block = editor
    .rootBlocks(basis.content)
    .find((b) => b.line === basis.root.ref.line && b.source === basis.root.source.originalBlock);
  if (node === undefined || block === undefined) return undefined;
  const relativeLine = taskNodeSourceLine(target) - basis.root.ref.line;
  const owned = editor.ownedTaskSubtree(block.source, relativeLine);
  if (owned === undefined) return undefined;
  const selected: TaskBlockTarget = {
    relativeLine,
    lineCount: owned.toLine - owned.fromLine + 1,
    childRanges: node.node.subtasks.map((child) => ({
      from: child.ref.relativeLine,
      to: child.ref.relativeLine + child.ref.originalBlock.split(/\r?\n/u).length - 1,
    })),
  };
  return { filePath: basis.root.ref.filePath, block, target: selected };
}
function sameRoot(input: SourceGraftInput): boolean {
  return (
    !input.destination.creating &&
    input.source.root.ref.filePath === input.destination.root.ref.filePath &&
    input.source.root.ref.line === input.destination.root.ref.line
  );
}
function overlapping(
  input: SourceGraftInput,
  source: HierarchyEndpoint,
  parent: HierarchyEndpoint,
): boolean {
  if (!sameRoot(input)) return false;
  if (input.source.root.source.originalBlock !== input.destination.root.source.originalBlock)
    return true;
  return (
    parent.target.relativeLine >= source.target.relativeLine &&
    parent.target.relativeLine < source.target.relativeLine + source.target.lineCount
  );
}
function graftComment(
  input: SourceGraftInput,
  source: HierarchyEndpoint,
  parent: HierarchyEndpoint,
): SourceGraft | undefined {
  if (input.selection.type !== 'comment') return undefined;
  const captured = input.editor.captureComment(
    input.source.content,
    source.block,
    source.target,
    input.selection.source,
  );
  if (captured === undefined || hasSourceAnchors(captured.originalMarkdown)) return undefined;
  const result = input.editor.copyComment(input.destination.content, parent.block, parent.target, {
    source: captured,
    rewrite: (text) => input.rewrite(text, source.filePath, parent.filePath, new Set()),
  });
  if (result?.edit.type !== 'changed' || result.edit.lineMap === undefined) return undefined;
  return {
    content: result.edit.content,
    from: result.from,
    count: result.count,
    sourceFrom: source.target.relativeLine + input.selection.source.relativeLine,
    lineMap: result.edit.lineMap,
  };
}
export function graftPreparedSource(input: SourceGraftInput): SourceGraft | undefined {
  const target =
    input.selection.type === 'comment' ? input.selection.source.parent : input.selection.source;
  const source = endpoint(input.editor, input.source, target),
    parent = endpoint(input.editor, input.destination, input.selection.parent);
  if (source === undefined || parent === undefined) return undefined;
  if (input.selection.type === 'comment') return graftComment(input, source, parent);
  if (overlapping(input, source, parent)) return undefined;
  const copied = prepareSubtreeCopy({
    sourceContent: input.source.content,
    destinationContent: input.destination.content,
    source,
    parent,
    editor: input.editor,
    rewrite: input.rewrite,
  });
  return copied === undefined ? undefined : { ...copied, sourceFrom: source.target.relativeLine };
}
export function graftedRootBlock(
  editor: TaskBlockEditor,
  content: string,
  root: TaskSnapshot,
): TaskRootBlock | undefined {
  return editor.rootBlocks(content).find((b) => b.line === root.ref.line);
}
