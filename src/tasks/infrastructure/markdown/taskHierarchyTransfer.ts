import { consumeMarkdownFenceLine, type MarkdownFence } from '../../../markdown/fences';
import type { TaskBlockEditor, TaskBlockTarget, TaskRootBlock } from './TaskBlockEditor';

export interface HierarchyEndpoint {
  readonly filePath: string;
  readonly block: TaskRootBlock;
  readonly target: TaskBlockTarget;
}
export interface HierarchyTransferInput {
  readonly contents: ReadonlyMap<string, string>;
  readonly source: HierarchyEndpoint;
  readonly parent?: HierarchyEndpoint;
  readonly editor: TaskBlockEditor;
  readonly rewrite: (
    source: string,
    from: string,
    to: string,
    anchors: ReadonlySet<string>,
  ) => string | undefined;
}
export interface PreparedHierarchyTransfer {
  readonly type: 'prepared';
  readonly contents: ReadonlyMap<string, string>;
  readonly moved: { readonly filePath: string; readonly line: number };
  readonly changed: boolean;
  readonly survivingRoots: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly beforeLine: number; readonly line: number }>
  >;
}
export type HierarchyTransferResult = PreparedHierarchyTransfer | { readonly type: 'invalid' };
interface Line {
  text: string;
  ending: string;
  originalLine?: number;
}
interface TransferContext {
  readonly input: HierarchyTransferInput;
  readonly before: string;
  readonly destination: string;
  readonly destinationPath: string;
  readonly sourceLines: Line[];
  readonly from: number;
  readonly to: number;
  readonly sameFile: boolean;
  readonly parentLine: number | undefined;
}
class InvalidHierarchy extends Error {}
function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new InvalidHierarchy();
  return value;
}
function lines(content: string): Line[] {
  const result: Line[] = [];
  let from = 0;
  while (from < content.length) {
    const newline = content.indexOf('\n', from);
    if (newline < 0) {
      result.push({ text: content.slice(from), ending: '', originalLine: result.length });
      break;
    }
    const crlf = content[newline - 1] === '\r';
    result.push({
      text: content.slice(from, newline - (crlf ? 1 : 0)),
      ending: crlf ? '\r\n' : '\n',
      originalLine: result.length,
    });
    from = newline + 1;
  }
  return result;
}
function prefix(text: string): string {
  return /^[ \t>]*/u.exec(text)?.[0] ?? '';
}
function depth(text: string): number {
  return prefix(text).replace(/\t/gu, '    ').length;
}
function serialize(value: Line[], original: string): string {
  const fallback = original.includes('\r\n') ? '\r\n' : '\n';
  return value
    .map((line, index) => {
      const ending = line.ending === '' ? fallback : line.ending;
      return line.text + (index === value.length - 1 && !original.endsWith('\n') ? '' : ending);
    })
    .join('');
}
function exactEndpoint(input: HierarchyTransferInput, endpoint: HierarchyEndpoint): boolean {
  const content = input.contents.get(endpoint.filePath);
  return (
    content !== undefined &&
    input.editor
      .rootBlocks(content)
      .some(
        (block) =>
          block.line === endpoint.block.line &&
          block.toLine === endpoint.block.toLine &&
          block.source === endpoint.block.source,
      )
  );
}
function directParent(context: TransferContext): boolean {
  const { input, sourceLines, from, parentLine } = context;
  const owner = input.editor.ownedTaskSubtree(input.source.block.source, 0);
  const candidates = owner?.taskLines.map((line) => line + input.source.block.line) ?? [];
  const prior = candidates.filter(
    (line) =>
      line < from && depth(sourceLines[line]?.text ?? '') < depth(sourceLines[from]?.text ?? ''),
  );
  return parentLine !== undefined && prior[prior.length - 1] === parentLine;
}
function anchorsIn(text: string): string[] {
  let fence: MarkdownFence | undefined;
  const result: string[] = [];
  for (const line of text.split('\n')) {
    const consumed = consumeMarkdownFenceLine(fence, line);
    fence = consumed.fence;
    if (!consumed.isContent) continue;
    const anchor = /(?:^|\s)\^([A-Za-z0-9-]+)(?=\r?$)/u.exec(line)?.[1];
    if (anchor !== undefined) result.push(anchor);
  }
  return result;
}
function contextFor(input: HierarchyTransferInput): TransferContext {
  const { source, parent, editor } = input;
  if (!exactEndpoint(input, source) || (parent !== undefined && !exactEndpoint(input, parent)))
    throw new InvalidHierarchy();
  const destinationPath = parent?.filePath ?? source.filePath;
  const owned = requireValue(
    editor.ownedTaskSubtree(source.block.source, source.target.relativeLine),
  );
  if (owned.toLine - owned.fromLine + 1 !== source.target.lineCount) throw new InvalidHierarchy();
  const before = requireValue(input.contents.get(source.filePath));
  return {
    input,
    before,
    destinationPath,
    destination: requireValue(input.contents.get(destinationPath)),
    sourceLines: lines(before),
    from: source.block.line + owned.fromLine,
    to: source.block.line + owned.toLine,
    sameFile: source.filePath === destinationPath,
    parentLine: parent === undefined ? undefined : parent.block.line + parent.target.relativeLine,
  };
}
function validateRelation(context: TransferContext): void {
  const { parentLine, sameFile, from, to, input } = context;
  if (parentLine !== undefined && sameFile && parentLine >= from && parentLine <= to)
    throw new InvalidHierarchy();
  if (input.parent === undefined && input.source.target.relativeLine === 0)
    throw new InvalidHierarchy();
}
function insertionFor(context: TransferContext): {
  readonly line: number;
  readonly prefix: string;
} {
  const { input, destination, sourceLines } = context;
  return input.parent === undefined
    ? {
        line: input.source.block.toLine + 1,
        prefix: prefix(sourceLines[input.source.block.line]?.text ?? ''),
      }
    : requireValue(
        input.editor.hierarchyInsertion(destination, input.parent.block, input.parent.target),
      );
}
function transferSource(context: TransferContext, insertionPrefix: string): Line[] {
  const { sourceLines, from, to, sameFile, destination, input, destinationPath } = context;
  const captured = sourceLines.slice(from, to + 1);
  const originalPrefix = prefix(captured[0]?.text ?? '');
  const anchors = anchorsIn(captured.map((line) => line.text).join('\n'));
  const remaining = sameFile
    ? sourceLines.filter((_, at) => at < from || at > to)
    : lines(destination);
  if (
    new Set(anchors).size !== anchors.length ||
    anchorsIn(remaining.map((line) => line.text).join('\n')).some((anchor) =>
      anchors.includes(anchor),
    )
  )
    throw new InvalidHierarchy();
  const adjusted = captured
    .map((line) => {
      if (line.text.trim().length === 0) return line.text + line.ending;
      if (!line.text.startsWith(originalPrefix)) throw new InvalidHierarchy();
      return insertionPrefix + line.text.slice(originalPrefix.length) + line.ending;
    })
    .join('');
  const rewritten = requireValue(
    sameFile
      ? adjusted
      : input.rewrite(adjusted, input.source.filePath, destinationPath, new Set(anchors)),
  );
  const moved = lines(rewritten).map(({ text, ending }) => ({ text, ending }));
  if (moved.length !== captured.length) throw new InvalidHierarchy();
  return moved;
}
function survivingRoots(
  context: TransferContext,
  contents: ReadonlyMap<string, string>,
  targetLines: Line[],
): PreparedHierarchyTransfer['survivingRoots'] {
  return new Map(
    [...contents].map(([path, content]) => {
      const updated = path === context.destinationPath ? targetLines : context.sourceLines;
      return [
        path,
        context.input.editor.rootBlocks(content).flatMap((block) => {
          const beforeLine = updated[block.line]?.originalLine;
          return beforeLine === undefined ? [] : [{ beforeLine, line: block.line }];
        }),
      ];
    }),
  );
}
function applyTransfer(context: TransferContext): PreparedHierarchyTransfer {
  const { input, sourceLines, from, to, sameFile, destination, destinationPath, before } = context;
  const insertion = insertionFor(context);
  const moved = transferSource(context, insertion.prefix);
  sourceLines.splice(from, to - from + 1);
  const targetLines = sameFile ? sourceLines : lines(destination);
  const at = insertion.line - (sameFile && insertion.line > to ? to - from + 1 : 0);
  targetLines.splice(at, 0, ...moved);
  const contents = new Map(input.contents);
  contents.set(input.source.filePath, serialize(sourceLines, before));
  contents.set(destinationPath, serialize(targetLines, destination));
  const root = requireValue(
    input.editor
      .rootBlocks(requireValue(contents.get(destinationPath)))
      .find((block) => block.line <= at && block.toLine >= at),
  );
  const owned = requireValue(input.editor.ownedTaskSubtree(root.source, at - root.line));
  if (owned.toLine - owned.fromLine + 1 !== moved.length) throw new InvalidHierarchy();
  return {
    type: 'prepared',
    contents,
    moved: { filePath: destinationPath, line: at },
    changed: true,
    survivingRoots: survivingRoots(context, contents, targetLines),
  };
}
export function prepareHierarchyTransfer(input: HierarchyTransferInput): HierarchyTransferResult {
  try {
    const context = contextFor(input);
    validateRelation(context);
    if (
      context.sameFile &&
      input.source.block.line === input.parent?.block.line &&
      directParent(context)
    )
      return {
        type: 'prepared',
        contents: input.contents,
        moved: { filePath: input.source.filePath, line: context.from },
        changed: false,
        survivingRoots: new Map(),
      };
    return applyTransfer(context);
  } catch (error) {
    if (error instanceof InvalidHierarchy) return { type: 'invalid' };
    throw error;
  }
}
