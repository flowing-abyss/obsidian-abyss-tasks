import { buildLinkRaw, parseLinks } from '../../markdown/links';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import { projectTableLinkTargetParts } from '../../projects/projectTableLinkTarget';

export const PROJECT_TABLE_CLIPBOARD_TYPE = 'application/x-abyss-project-table';

type ProjectClipboardFieldType = ProjectFieldCatalogItem['type'] | 'external';

export interface ProjectClipboardCell {
  readonly value: unknown;
  readonly sourcePath: string;
  readonly fieldType: ProjectClipboardFieldType;
}

interface ProjectTableClipboardPayload {
  readonly version: 1;
  readonly rows: ProjectClipboardCell[][];
}

interface ProjectPasteSelectionBounds {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

interface ProjectPastePosition {
  readonly row: number;
  readonly column: number;
}

export interface ProjectPasteMapping extends ProjectPastePosition {
  readonly source: ProjectClipboardCell;
}

export interface ProjectPasteRectangleOptions {
  readonly selection: ProjectPasteSelectionBounds;
  readonly focus: ProjectPastePosition;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface ProjectLinkRebaser {
  readonly resolve: (target: string, sourcePath: string) => string | undefined;
  readonly linktext: (resolvedPath: string, destinationPath: string) => string;
}

function copyValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyValue) : value;
}

function isClipboardValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every(isClipboardValue))
  );
}

function isClipboardFieldType(value: unknown): value is ProjectFieldCatalogItem['type'] {
  return [
    null,
    'text',
    'list',
    'number',
    'checkbox',
    'date',
    'datetime',
    'tags',
    'status',
    'progress',
    'name',
  ].includes(value as never);
}

function isClipboardCell(value: unknown): value is ProjectClipboardCell {
  if (typeof value !== 'object' || value === null) return false;
  const cell = value as Partial<ProjectClipboardCell>;
  return (
    typeof cell.sourcePath === 'string' &&
    isClipboardFieldType(cell.fieldType) &&
    isClipboardValue(cell.value)
  );
}

export function encodeProjectTableClipboard(
  rows: ReadonlyArray<readonly ProjectClipboardCell[]>,
): string {
  const payload: ProjectTableClipboardPayload = {
    version: 1,
    rows: rows.map((row) =>
      row.map((cell) => ({
        value: copyValue(cell.value),
        sourcePath: cell.sourcePath,
        fieldType: cell.fieldType,
      })),
    ),
  };
  return JSON.stringify(payload);
}

export function decodeProjectTableClipboard(input: string): ProjectClipboardCell[][] | undefined {
  if (input.length === 0) return undefined;
  try {
    const parsed = JSON.parse(input) as Partial<ProjectTableClipboardPayload>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.rows) ||
      parsed.rows.length === 0 ||
      !parsed.rows.every(
        (row) => Array.isArray(row) && row.length > 0 && row.every(isClipboardCell),
      )
    ) {
      return undefined;
    }
    return parsed.rows.map((row) =>
      row.map((cell) => ({
        value: copyValue(cell.value),
        sourcePath: cell.sourcePath,
        fieldType: cell.fieldType,
      })),
    );
  } catch {
    return undefined;
  }
}

function quoteTsvCell(value: string): string {
  return /[\t\n\r"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function formatProjectTableTsv(rows: ReadonlyArray<readonly string[]>): string {
  return rows.map((row) => row.map(quoteTsvCell).join('\t')).join('\n');
}

interface TsvParseState {
  readonly rows: string[][];
  row: string[];
  cell: string;
  quoted: boolean;
}

function finishTsvCell(state: TsvParseState): void {
  state.row.push(state.cell);
  state.cell = '';
}

function finishTsvRow(state: TsvParseState): void {
  finishTsvCell(state);
  state.rows.push(state.row);
  state.row = [];
}

function consumeTsvCharacter(input: string, index: number, state: TsvParseState): number {
  const character = input[index];
  if (character === '"') {
    return consumeTsvQuote(input, index, state);
  }
  if (character === '\t' && !state.quoted) {
    finishTsvCell(state);
    return index;
  }
  if ((character === '\n' || character === '\r') && !state.quoted) {
    finishTsvRow(state);
    return character === '\r' && input[index + 1] === '\n' ? index + 1 : index;
  }
  state.cell += character;
  return index;
}

function consumeTsvQuote(input: string, index: number, state: TsvParseState): number {
  if (state.quoted && input[index + 1] === '"') {
    state.cell += '"';
    return index + 1;
  }
  state.quoted = !state.quoted;
  return index;
}

export function parseProjectTableTsv(input: string): string[][] {
  const state: TsvParseState = { rows: [], row: [], cell: '', quoted: false };
  let index = 0;
  while (index < input.length) {
    index = consumeTsvCharacter(input, index, state) + 1;
  }
  if (state.quoted) throw new Error('Unterminated quoted clipboard cell');
  finishTsvRow(state);
  if (input.endsWith('\n') || input.endsWith('\r')) state.rows.pop();
  return state.rows.length === 0 ? [['']] : state.rows;
}

export function clipboardPayloadFromText(value: string): ProjectClipboardCell {
  return { value, sourcePath: '', fieldType: 'external' };
}

export function resolveProjectPasteRectangle(
  source: ReadonlyArray<readonly ProjectClipboardCell[]>,
  options: ProjectPasteRectangleOptions,
): ProjectPasteMapping[] {
  const { selection, focus, rowCount, columnCount } = options;
  const sourceColumns = source[0]?.length ?? 0;
  validateSourceRectangle(source, sourceColumns);
  const { top, left, height, width, broadcast } = pasteDimensions(
    source.length,
    sourceColumns,
    selection,
    focus,
  );
  ensurePasteFits({ top, left, height, width }, rowCount, columnCount);
  return buildPasteMappings(source, { top, left, height, width, broadcast });
}

interface PasteDimensions {
  readonly top: number;
  readonly left: number;
  readonly height: number;
  readonly width: number;
  readonly broadcast: boolean;
}

function pasteDimensions(
  sourceRows: number,
  sourceColumns: number,
  selection: ProjectPasteSelectionBounds,
  focus: ProjectPastePosition,
): PasteDimensions {
  const selectedRows = selection.bottom - selection.top + 1;
  const selectedColumns = selection.right - selection.left + 1;
  const broadcast = sourceRows === 1 && sourceColumns === 1;
  const matchesSelection = sourceRows === selectedRows && sourceColumns === selectedColumns;
  const top = broadcast || matchesSelection ? selection.top : focus.row;
  const left = broadcast || matchesSelection ? selection.left : focus.column;
  const height = broadcast ? selectedRows : sourceRows;
  const width = broadcast ? selectedColumns : sourceColumns;
  return { top, left, height, width, broadcast };
}

function ensurePasteFits(
  dimensions: Omit<PasteDimensions, 'broadcast'>,
  rowCount: number,
  columnCount: number,
): void {
  const { top, left, height, width } = dimensions;
  if (top < 0 || left < 0 || top + height > rowCount || left + width > columnCount) {
    throw new Error('Clipboard range does not fit in the visible table');
  }
}

function buildPasteMappings(
  source: ReadonlyArray<readonly ProjectClipboardCell[]>,
  dimensions: PasteDimensions,
): ProjectPasteMapping[] {
  const { top, height, broadcast } = dimensions;
  const mappings: ProjectPasteMapping[] = [];
  for (let row = 0; row < height; row += 1) {
    const sourceRow = broadcast ? source[0] : source[row];
    mappings.push(...buildPasteRow(sourceRow, top + row, dimensions));
  }
  return mappings;
}

function buildPasteRow(
  sourceRow: readonly ProjectClipboardCell[] | undefined,
  row: number,
  dimensions: PasteDimensions,
): ProjectPasteMapping[] {
  const { left, width, broadcast } = dimensions;
  const mappings: ProjectPasteMapping[] = [];
  for (let column = 0; column < width; column += 1) {
    const sourceCell = sourceRow?.[broadcast ? 0 : column];
    if (sourceCell === undefined) throw new Error('Clipboard data is not a rectangle');
    mappings.push({ row, column: left + column, source: sourceCell });
  }
  return mappings;
}

function validateSourceRectangle(
  source: ReadonlyArray<readonly ProjectClipboardCell[]>,
  columns: number,
): void {
  if (source.length === 0 || columns === 0) throw new Error('Clipboard data is not a rectangle');
  if (!source.every((row) => row.length === columns)) {
    throw new Error('Clipboard data is not a rectangle');
  }
}

function fieldLabel(type: ProjectFieldCatalogItem['type']): string {
  if (type === null) return 'This field';
  return type.charAt(0).toLocaleUpperCase() + type.slice(1);
}

function scalar(value: unknown, targetType: ProjectFieldCatalogItem['type']): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value) || typeof value === 'object') {
    throw new Error(
      `${fieldLabel(targetType)} data cannot be pasted into ${fieldLabel(targetType)}`,
    );
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  throw new Error(`Invalid ${fieldLabel(targetType)} value`);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

export function coerceProjectClipboardValue(
  source: ProjectClipboardCell,
  targetType: ProjectFieldCatalogItem['type'],
  statusNames: readonly string[],
): unknown {
  if (targetType === 'name' || targetType === 'progress') {
    throw new Error(`${fieldLabel(targetType)} is read-only`);
  }
  if (targetType === null) throw new Error('This field is read-only');
  if (targetType === 'list' || targetType === 'tags') return coerceListValue(source, targetType);
  return coerceScalarTarget(source, targetType, statusNames);
}

function coerceScalarTarget(
  source: ProjectClipboardCell,
  targetType: Exclude<
    ProjectFieldCatalogItem['type'],
    null | 'name' | 'progress' | 'list' | 'tags'
  >,
  statusNames: readonly string[],
): unknown {
  rejectCollectionValue(source, targetType);
  if (targetType === 'checkbox') return coerceCheckboxValue(source.value);
  if (targetType === 'number') return coerceNumberValue(source.value);
  const value = scalar(source.value, targetType);
  if (value === undefined) return undefined;
  if (targetType === 'status') return coerceStatusValue(value, statusNames);
  if (targetType === 'date' && !validDate(value)) throw new Error(`Invalid date: ${value}`);
  if (targetType === 'datetime' && !validDateTime(value)) {
    throw new Error(`Invalid date and time: ${value}`);
  }
  return value;
}

function incompatibleValue(
  source: ProjectClipboardCell,
  targetType: ProjectFieldCatalogItem['type'],
): Error {
  const sourceType = source.fieldType === 'external' ? 'text' : source.fieldType;
  return new Error(
    `${fieldLabel(sourceType)} data cannot be pasted into ${fieldLabel(targetType)}`,
  );
}

function coerceListValue(
  source: ProjectClipboardCell,
  targetType: ProjectFieldCatalogItem['type'],
): unknown[] {
  if (source.value === undefined || source.value === null || source.value === '') return [];
  if (Array.isArray(source.value)) return source.value.map(copyValue);
  if (typeof source.value === 'object') throw incompatibleValue(source, targetType);
  return [source.value];
}

function rejectCollectionValue(
  source: ProjectClipboardCell,
  targetType: ProjectFieldCatalogItem['type'],
): void {
  if (Array.isArray(source.value) || (typeof source.value === 'object' && source.value !== null)) {
    throw incompatibleValue(source, targetType);
  }
}

function scalarText(value: string | number | boolean): string {
  return typeof value === 'string' ? value : `${value}`;
}

function coerceCheckboxValue(value: unknown): boolean | undefined {
  if (isEmptyClipboardValue(value)) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('Invalid checkbox value');
  const text = scalarText(value).trim().toLocaleLowerCase();
  if (['true', 'yes'].includes(text)) return true;
  if (['false', 'no'].includes(text)) return false;
  throw new Error(`Invalid checkbox value: ${scalarText(value)}`);
}

function isEmptyClipboardValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function coerceNumberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid number');
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid number: ${scalarText(value)}`);
  return number;
}

function coerceStatusValue(value: string, statusNames: readonly string[]): string {
  if (!statusNames.includes(value)) throw new Error(`Unknown project status: ${value}`);
  return value;
}

function validDateTime(value: string): boolean {
  const separator = value.indexOf('T');
  if (separator < 0 || !validDate(value.slice(0, separator))) return false;
  return /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(
    value.slice(separator + 1),
  );
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalValue(value, right[index]))
    );
  }
  return Object.is(left, right);
}

export function deduplicateProjectCellAssignments<
  T extends { readonly key: string; readonly value: unknown },
>(assignments: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const assignment of assignments) {
    const existing = unique.get(assignment.key);
    if (existing !== undefined && !equalValue(existing.value, assignment.value)) {
      throw new Error('Conflicting values target the same project cell');
    }
    if (existing === undefined) unique.set(assignment.key, assignment);
  }
  return [...unique.values()];
}

function rebaseString(
  value: string,
  sourcePath: string,
  destinationPath: string,
  rebaser: ProjectLinkRebaser,
): string {
  const links = parseLinks(value);
  let result = value;
  for (const link of [...links].reverse()) {
    const { resolverTarget, subpath, externalTarget } = projectTableLinkTargetParts(link);
    if (externalTarget !== undefined) continue;
    const resolved = rebaser.resolve(resolverTarget, sourcePath);
    if (resolved === undefined) continue;
    const linktext = rebaser.linktext(resolved, destinationPath);
    const target = `${link.type === 'md' ? encodeURI(linktext) : linktext}${subpath}`;
    const raw = buildLinkRaw(link.type, target, link.display);
    result = `${result.slice(0, link.index)}${raw}${result.slice(link.index + link.raw.length)}`;
  }
  return result;
}

export function rebaseProjectClipboardLinks(
  value: unknown,
  sourcePath: string,
  destinationPath: string,
  rebaser: ProjectLinkRebaser,
): unknown {
  if (sourcePath.length === 0 || sourcePath === destinationPath) return copyValue(value);
  if (typeof value === 'string') return rebaseString(value, sourcePath, destinationPath, rebaser);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rebaseProjectClipboardLinks(entry, sourcePath, destinationPath, rebaser),
    );
  }
  return value;
}
