import { Component, Menu, Notice, setIcon, TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { exactLinkToken, parseLinks } from '../../markdown/links';
import { moment } from '../../obsidianMoment';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import { isProjectCreationError, type ProjectCreateRequest } from '../../projects/projectCreation';
import {
  isProjectEditValidationError,
  ProjectEditValidationError,
} from '../../projects/projectEditError';
import type { ProjectEditHistory } from '../../projects/projectEditHistory';
import {
  projectCellSourceValue,
  projectFieldWithOwnedClear,
  type AppliedProjectCellChange,
  type OwnedInferredPropertyClear,
  type ProjectCellChange,
  type ProjectEditResult,
} from '../../projects/projectEdits';
import {
  buildProjectFieldCatalog,
  findFrontmatterProperty,
  findProjectFieldById,
  isAvailableProjectField,
  isReservedProjectProperty,
  projectFieldValue,
  type ProjectColumn,
  type ProjectDateDisplay,
  type ProjectField,
  type ProjectFieldCatalogItem,
  type ProjectPropertyType,
  type ProjectTableProgressDisplay,
  type ProjectTableSettings,
} from '../../projects/projectFields';
import { buildProjectKanbanModel } from '../../projects/projectKanbanModel';
import {
  buildDefaultProjectKanbanSettings,
  type ProjectKanbanSettings,
  type ProjectOverviewMode,
} from '../../projects/projectKanbanSettings';
import type { ProjectValuePresentation } from '../../projects/projectPropertyDefinitions';
import {
  projectPropertyTypeChoices,
  resolveConfiguredProjectField,
  setProjectPropertyDefinitionType,
  type ProjectPropertyDefinition,
} from '../../projects/projectPropertyDefinitions';
import { sameProjectPropertyName } from '../../projects/projectPropertyNames';
import {
  compatibleProjectPropertyPresets,
  compileProjectPropertyPresets,
  type CompiledProjectPropertyPresets,
} from '../../projects/projectPropertyPresets';
import type { ProjectSourceObservation } from '../../projects/ProjectStore';
import {
  buildProjectTableModel,
  projectProgressDisplayValue,
  projectTableGroupLinkIdentity,
  projectTrackedDisplayValue,
  statusGroupKey,
  type ProjectTableGroup,
  type ProjectTableModel,
  type ProjectTableModelInput,
} from '../../projects/projectTableModel';
import {
  buildDefaultProjectTableSettings,
  effectiveProjectTableDateDisplay,
  setProjectTableColumnDateDisplay,
} from '../../projects/projectTableSettings';
import {
  planProjectTimelineEdit,
  PROJECT_TIMELINE_INVALID_RANGE_REASON,
  projectTimelineRawEditEligibility,
  type ProjectTimelineEditPlan,
} from '../../projects/projectTimelineEdits';
import {
  buildProjectTimelineModel,
  type ProjectTimelineRow,
} from '../../projects/projectTimelineModel';
import {
  buildDefaultProjectTimelineSettings,
  projectTimelineDescriptionLines,
  projectTimelineFields,
  type ProjectTimelineSettings,
} from '../../projects/projectTimelineSettings';
import { projectStatusDisplayName, resolveStatus } from '../../projects/status';
import type { Project } from '../../projects/types';
import {
  enforceProjectTableColumnInvariants,
  setProjectColumnAlignment,
  setProjectColumnLabel,
  setProjectColumnWidth,
} from '../../settings/projectTableSettings';
import { saveSettingsDraft } from '../../settings/settingsSaveFailure';
import type { CalendarSettings, ProjectStatus } from '../../settings/types';
import type { ProjectPropertySuggestion } from '../../ui/ProjectPropertySuggest';
import {
  projectPropertyValuePresentation,
  projectTagLabel,
} from '../../ui/projectPropertyValuePresentation';
import { renderTaskText } from '../../ui/renderTaskText';
import {
  mountProjectCellEditor,
  type ProjectCellEditorHandle,
  type ProjectCellEditorNavigation,
} from './ProjectCellEditor';
import { mountProjectCellEditorPosition } from './projectCellEditorPosition';
import { ProjectCreationComposer } from './ProjectCreationComposer';
import { ProjectCreationPresentation } from './ProjectCreationPresentation';
import { formatProjectRelativeDate } from './projectDatePresentation';
import { forecastProjectGroupDrop, type ProjectGroupDropForecast } from './projectGroupDropPreview';
import { ProjectsKanbanView } from './ProjectsKanbanView';
import { ProjectsTableToolbar } from './ProjectsTableToolbar';
import { ProjectsTimelineView } from './ProjectsTimelineView';
import { renderProjectTableCell } from './projectTableCells';
import {
  clipboardPayloadFromText,
  coerceProjectClipboardValue,
  decodeProjectTableClipboard,
  deduplicateProjectCellAssignments,
  encodeProjectTableClipboard,
  formatProjectTableTsv,
  parseProjectTableTsv,
  PROJECT_TABLE_CLIPBOARD_TYPE,
  rebaseProjectClipboardLinks,
  resolveProjectPasteRectangle,
  type ProjectClipboardCell,
  type ProjectLinkRebaser,
} from './projectTableClipboard';
import {
  projectTableColumnWidth,
  renderProjectTableColumns,
  type ProjectTableColumnResize,
  type VisibleProjectColumn,
} from './projectTableColumns';
import { planProjectGroupDrop, type ProjectTableDragGroup } from './projectTableDrag';
import {
  ProjectTableSelection,
  type ProjectTableSelectableCell,
  type ProjectTableSelectionDirection,
} from './projectTableSelection';
import {
  sameProjectTimelineRangeBinding,
  sameProjectTimelineRangeSource,
  type FrozenProjectTimelineRangeSource,
  type ProjectTimelineEndpointEvidence,
  type ProjectTimelineRangeCapture,
  type ProjectTimelineRangeEditRequest,
} from './projectTimelineInteraction';

import { ProjectTableViewport } from './projectTableViewport';

const PROJECT_TABLE_ROW_DRAG_TYPE = 'application/x-abyss-project-table-row';

function projectManualOrderStatusKey(project: Project): string {
  if (project.statusId !== null && project.statusId.length > 0) return `id:${project.statusId}`;
  if (project.rawStatus !== null && project.rawStatus.length > 0) return `raw:${project.rawStatus}`;
  return 'none';
}

function projectPathsByStatus(projects: readonly Project[]): ReadonlyMap<string, string[]> {
  const observed = new Map<string, string[]>();
  for (const project of projects) {
    const key = projectManualOrderStatusKey(project);
    const paths = observed.get(key) ?? [];
    paths.push(project.path);
    observed.set(key, paths);
  }
  return observed;
}

function appendUnrankedProjectPaths(
  existing: readonly string[],
  observed: readonly string[],
): string[] {
  const sequence = [...existing];
  const known = new Set(existing);
  for (const path of observed) {
    if (known.has(path)) continue;
    known.add(path);
    sequence.push(path);
  }
  return sequence;
}

function exactGroupLinkLabel(value: string, label: string): string | undefined {
  return exactLinkToken(value) === undefined ? undefined : label;
}

function presetLabel(
  displayName: string | undefined,
  value: string | number,
  isTag: boolean,
): string {
  const trimmed = displayName?.trim();
  if (trimmed !== undefined && trimmed !== '') return trimmed;
  if (typeof value !== 'string') return String(value);
  const label = projectPropertyValuePresentation(value).label;
  return isTag ? projectTagLabel(label) : label;
}

function editorPresets(
  definition: unknown,
  isTag: boolean,
): readonly ProjectPropertySuggestion[] | undefined {
  const presets = compatibleProjectPropertyPresets(definition);
  if (presets.length === 0) return undefined;
  return presets.flatMap((preset) =>
    typeof preset.value === 'boolean'
      ? []
      : [
          {
            value: preset.value,
            label: presetLabel(preset.displayName, preset.value, isTag),
            ...(isTag ? { appearance: 'tag' as const } : {}),
            ...(preset.color === undefined ? {} : { color: preset.color }),
            display: preset.display ?? 'badge',
          },
        ],
  );
}

export interface ProjectsTableViewContext {
  readonly app: App;
  readonly state: AppState;
  readonly settings: CalendarSettings;
  readonly catalog: ProjectPropertyCatalog;
  readonly saveViewState: () => Promise<void>;
  readonly saveStatic?: () => Promise<void>;
  readonly applyEdits: (changes: readonly ProjectCellChange[]) => Promise<ProjectEditResult>;
  readonly history: ProjectEditHistory;
  readonly createProject: (request: ProjectCreateRequest) => Promise<string | null>;
  readonly openProject: (path: string) => void;
  readonly openNote?: (path: string) => void;
  readonly revalidateSourceObservation: (observation: ProjectSourceObservation) => Promise<boolean>;
}

interface ActiveEditor {
  readonly projectPath: string;
  readonly columnId: string;
  readonly handle: ProjectCellEditorHandle;
  readonly positionCleanup: () => void;
}

interface FocusedCellIdentity {
  readonly occurrenceId: string | undefined;
  readonly columnId: string | undefined;
}

interface TableSelectionBounds {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly focus: { readonly row: number; readonly column: number };
}

interface ProjectRowDragPayload {
  readonly version: 1;
  readonly projectPath: string;
  readonly occurrenceId: string;
  readonly sourceGroupKey: string;
}

interface GroupDropPlan {
  readonly cell: LogicalCellContext;
  readonly value: unknown;
  readonly target: RenderedGroupContext;
}

interface GroupDropPreview {
  readonly payload: ProjectRowDragPayload | undefined;
  readonly targetGroupKey: string;
  readonly revision: number;
  readonly allowed: boolean;
  readonly message: string;
  readonly plan?: GroupDropPlan;
  readonly rows: readonly HTMLTableRowElement[];
  readonly forecast?: ProjectGroupDropForecast;
  readonly line?: HTMLTableRowElement;
}

function overviewDescriptionLines(
  presentation: 'kanban' | 'timeline',
  field: ProjectFieldCatalogItem,
  settings: () => ProjectTimelineSettings,
): ReturnType<typeof projectTimelineDescriptionLines> | undefined {
  if (presentation !== 'timeline' || field.type !== 'name') return undefined;
  return projectTimelineDescriptionLines(settings());
}

function showOverviewNameDescription(
  presentation: 'kanban' | 'timeline',
  lines: ReturnType<typeof projectTimelineDescriptionLines> | undefined,
): boolean {
  return presentation === 'timeline' && lines !== undefined && lines !== 0;
}

type ResizeObserverConstructor = new (callback: ResizeObserverCallback) => ResizeObserver;

interface LogicalCellContext {
  identity: ProjectTableSelectableCell;
  project: Project;
  field: ProjectFieldCatalogItem;
  ownedClear: OwnedInferredPropertyClear | undefined;
}

export interface RenderedCellContext extends LogicalCellContext {
  readonly element: HTMLElement;
  readonly markdown?: Component;
  contentSignature: string;
  editorBoundary?: HTMLElement;
  stickyHeader?: HTMLElement;
  horizontalScroll?: HTMLElement;
  verticalScroll?: HTMLElement;
}

interface RenderedGroupContext extends ProjectTableDragGroup {
  label: string;
}

interface TableModelRow {
  readonly key: string;
  readonly group: ProjectTableGroup;
  readonly project?: Project;
}

interface RenderedProjectRow {
  readonly markdown: Component;
  readonly element: HTMLTableRowElement;
  readonly cells: Map<string, RenderedCellContext>;
  dragCleanup?: () => void;
  project: Project;
  groupKey: string;
  occurrenceId: string;
}

interface RenderedGroupRow {
  readonly markdown: Component;
  readonly element: HTMLTableRowElement;
  readonly cell: HTMLTableCellElement;
  readonly button: HTMLButtonElement;
  readonly chevron: HTMLElement;
  readonly statusDot: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly dropHint: HTMLElement;
  context: RenderedGroupContext;
  contentSignature: string;
}

function visibleRowCells(
  row: RenderedProjectRow,
  columns: readonly VisibleProjectColumn[],
): RenderedCellContext[] {
  const cells: RenderedCellContext[] = [];
  for (const { column } of columns) {
    const cell = row.cells.get(column.id);
    if (cell !== undefined) cells.push(cell);
  }
  return cells;
}

interface ProjectCellEditRequest {
  readonly project: Project;
  readonly field: ProjectField;
  readonly value: unknown;
  readonly expectedValue: unknown;
  readonly expectedExists: boolean;
  readonly sourceProperty: string;
  readonly sourceKey: string | undefined;
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
}

interface ProjectCellEditorState {
  expectedValue: unknown;
  expectedExists: boolean;
  sourceProperty: string;
  sourceKey: string | undefined;
  ownedClear: OwnedInferredPropertyClear | undefined;
}

interface EditCellOptions {
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
  readonly anchor?: HTMLElement;
}

interface EditorPositionRequest {
  readonly anchor: HTMLElement;
  readonly host: HTMLElement;
  readonly onMove: () => void;
  readonly avoid?: HTMLElement;
  readonly preferredWidth?: number;
}

interface MountedEditorRequest {
  readonly project: Project;
  readonly field: ProjectField;
  readonly cell: HTMLElement;
  readonly anchor: HTMLElement;
  readonly host: HTMLElement;
  readonly handle: ProjectCellEditorHandle;
}

function containsEditorAnchor(element: HTMLElement, anchor: HTMLElement): boolean {
  return element === anchor || element.contains(anchor) || anchor.contains(element);
}

function optionalEditorPositionFields(
  avoid: HTMLElement | undefined,
  preferredWidth: number | undefined,
  stickyHeader: HTMLElement | undefined,
): {
  readonly avoid?: HTMLElement;
  readonly preferredWidth?: number;
  readonly stickyHeader?: HTMLElement;
} {
  return {
    ...(avoid === undefined ? {} : { avoid }),
    ...(preferredWidth === undefined ? {} : { preferredWidth }),
    ...(stickyHeader === undefined ? {} : { stickyHeader }),
  };
}

interface EditorCloseDestination {
  readonly cell: ProjectTableSelectableCell | undefined;
  readonly preservesExternalFocus: boolean;
}

interface ProjectReceiptProjection {
  readonly receipt: AppliedProjectCellChange;
  readonly sourceRevisionAtMutationStart: number;
  readonly ordinal: number;
}

interface RemoveListValueRequest extends ProjectCellEditRequest {
  readonly value: unknown[];
  readonly expectedValue: unknown;
}

interface RenderGroupOptions {
  readonly body: HTMLTableSectionElement;
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly columnCount: number;
  readonly statuses: ProjectTableModel['availableStatusGroups'];
  readonly value: unknown;
  readonly sourcePath?: string;
  readonly presentation?: ProjectValuePresentation;
}

interface RenderProjectRowOptions {
  readonly body: HTMLTableSectionElement;
  readonly project: Project;
  readonly columns: readonly VisibleProjectColumn[];
  readonly group: ProjectTableModel['groups'][number];
  readonly grouped: boolean;
}

interface ReconciledBodyRows {
  readonly desired: HTMLTableRowElement[];
  readonly retainedProjects: Set<string>;
  readonly retainedGroups: Set<string>;
  readonly cells: RenderedCellContext[];
}

interface ReconcileProjectCellOptions {
  readonly row: RenderedProjectRow;
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly columnId: string;
  readonly occurrenceId: string;
  readonly groupKey: string;
  readonly grouped: boolean;
}

interface RenderProjectCellContentOptions {
  readonly preferredColumn?: ProjectColumn;
  readonly showNameDescription?: boolean;
  readonly presentation?: ProjectOverviewMode;
}

interface ProjectCellPresentation {
  readonly dateDisplay: ProjectDateDisplay;
  readonly progressDisplay?: ProjectTableProgressDisplay;
}

function editableField(field: ProjectFieldCatalogItem): field is ProjectField {
  return (
    isAvailableProjectField(field) &&
    field.type !== 'name' &&
    field.type !== 'progress' &&
    field.type !== 'tracked'
  );
}

function visibleColumns(
  settings: CalendarSettings,
  fields: readonly ProjectFieldCatalogItem[],
): VisibleProjectColumn[] {
  return settings.projects.table.columns.flatMap((column) => {
    if (!column.visible) return [];
    const field = findProjectFieldById(fields, column.id);
    return field === undefined ? [] : [{ column, field }];
  });
}

function copyProjectedValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyProjectedValue) : value;
}

function equalProjectedValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalProjectedValue(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function clipboardScalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  return '';
}

function selectionDirectionForKey(key: string): ProjectTableSelectionDirection | undefined {
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  return undefined;
}

function sameRowDragPayload(left: ProjectRowDragPayload, right: ProjectRowDragPayload): boolean {
  return (
    left.projectPath === right.projectPath &&
    left.occurrenceId === right.occurrenceId &&
    left.sourceGroupKey === right.sourceGroupKey
  );
}

function nearestViewportDelta(
  start: number,
  end: number,
  viewportStart: number,
  viewportEnd: number,
): number {
  if (start < viewportStart) return start - viewportStart;
  if (end > viewportEnd) return end - viewportEnd;
  return 0;
}

function observationMatchesReceipt(
  observation: ProjectSourceObservation,
  receipt: AppliedProjectCellChange,
): boolean {
  const source =
    observation.project === undefined
      ? undefined
      : findFrontmatterProperty(observation.project.frontmatter, receipt.sourceProperty);
  return (
    (source !== undefined) === receipt.appliedExists &&
    (!receipt.appliedExists || equalProjectedValue(source?.value, receipt.value))
  );
}

function projectionKey(receipt: AppliedProjectCellChange): string {
  return `${receipt.path}\u0000${receipt.field.id}`;
}

function isTagCarrier(property: string | undefined): boolean {
  const key = property?.toLocaleLowerCase();
  return key === 'tag' || key === 'tags';
}

function projectCellEditorState(
  project: Project,
  field: ProjectField,
  settings: CalendarSettings,
  ownedClear: OwnedInferredPropertyClear | undefined,
): ProjectCellEditorState {
  const sourceProperty =
    field.type === 'status' ? settings.projects.statusProperty : field.property;
  if (sourceProperty === undefined) throw new Error(`Field ${field.id} has no metadata source`);
  const source = findFrontmatterProperty(project.frontmatter, sourceProperty);
  return {
    expectedValue: source?.value,
    expectedExists: source !== undefined,
    sourceProperty,
    sourceKey: source?.key ?? ownedClear?.sourceKey,
    ownedClear,
  };
}

function expectProjectFieldProperty(field: ProjectField): string {
  if (field.property === undefined || field.property.length === 0) {
    throw new ProjectEditValidationError(`${field.label} has no configured source property.`);
  }
  return field.property;
}

function timelineDateField(
  fields: readonly ProjectFieldCatalogItem[],
  id: 'start' | 'end',
): ProjectField | undefined {
  const field = findProjectFieldById(fields, id);
  if (field === undefined || !isAvailableProjectField(field)) return undefined;
  if (field.type !== 'date' || field.property === undefined || field.property.length === 0) {
    return undefined;
  }
  return field;
}

function sameTimelineProperty(left: ProjectField, right: ProjectField): boolean {
  return sameProjectPropertyName(
    expectProjectFieldProperty(left),
    expectProjectFieldProperty(right),
  );
}

function ambiguousTimelineSource(
  project: Project,
  fields: readonly ProjectField[],
): ProjectField | undefined {
  return fields.find((field) => {
    const property = expectProjectFieldProperty(field);
    return (
      Object.keys(project.frontmatter).filter((key) => sameProjectPropertyName(key, property))
        .length > 1
    );
  });
}

function patchElementAttribute(
  element: HTMLElement,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function patchElementClass(element: HTMLElement, name: string, active: boolean): void {
  if (element.classList.contains(name) !== active) element.toggleClass(name, active);
}

function patchElementIcon(element: HTMLElement, icon: string): void {
  if (element.dataset['icon'] === icon) return;
  element.empty();
  patchElementAttribute(element, 'data-icon', icon);
  setIcon(element, icon);
}

function patchElementText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.setText(text);
}

export class ProjectsTableView {
  private projects_abyssPrivate: readonly Project[] = [];
  private fields_abyssPrivate: readonly ProjectFieldCatalogItem[] = [];
  private readonly root_abyssPrivate: HTMLElement;
  private readonly scroll_abyssPrivate: HTMLElement;
  private readonly tableHost_abyssPrivate: HTMLElement;
  private readonly feedback_abyssPrivate: HTMLElement;
  private readonly count_abyssPrivate: HTMLElement;
  private readonly toolbar_abyssPrivate: ProjectsTableToolbar;
  private readonly creationComposer_abyssPrivate: ProjectCreationComposer;
  private readonly creationPresentation_abyssPrivate: ProjectCreationPresentation;
  private creationInteractionRevision_abyssPrivate = 0;
  private creationInteractionToken_abyssPrivate: number | undefined;
  private creationInteractionSettling_abyssPrivate = false;
  private creationReconciliationPending_abyssPrivate = false;
  private notifyingCreationReconciliation_abyssPrivate = false;
  private kanbanView_abyssPrivate: ProjectsKanbanView<RenderedCellContext> | undefined;
  private timelineView_abyssPrivate: ProjectsTimelineView<RenderedCellContext> | undefined;
  private readonly markdown_abyssPrivate = new Component();
  private readonly ownerWindow_abyssPrivate: Window | undefined;
  private activeEditor_abyssPrivate: ActiveEditor | undefined;
  private projectDragActive_abyssPrivate = false;
  private activeRowDrag_abyssPrivate: ProjectRowDragPayload | undefined;
  private groupDropPreview_abyssPrivate: GroupDropPreview | undefined;
  private groupDropRevision_abyssPrivate = 0;
  private columnCleanup_abyssPrivate: (() => void) | undefined;
  private compiledPresets_abyssPrivate = new Map<string, CompiledProjectPropertyPresets>();
  /**
   * The instant tracked time is read at. It is taken once per render pass and never on a timer, so
   * every row is sorted and labelled against the same clock and a running project never repaints
   * on its own.
   */
  private trackedNowMs_abyssPrivate = Date.now();
  private readonly collapsedGroups_abyssPrivate = new Set<string>();
  private readonly tableSelection_abyssPrivate = new ProjectTableSelection();
  private readonly kanbanSelection_abyssPrivate = new ProjectTableSelection();
  private readonly timelineSelection_abyssPrivate = new ProjectTableSelection();
  private readonly tableViewport_abyssPrivate = new ProjectTableViewport();
  private tableSpacers_abyssPrivate = new Map<string, HTMLTableRowElement>();
  private tableRowsDirty_abyssPrivate = false;
  private tableModel_abyssPrivate: ProjectTableModel | undefined;
  private tableRows_abyssPrivate: TableModelRow[] = [];
  private tableLogicalCells_abyssPrivate: LogicalCellContext[] = [];
  private readonly tableCellIndex_abyssPrivate = new Map<string, LogicalCellContext>();
  private tableRowIds_abyssPrivate: string[] = [];
  private tableColumnIds_abyssPrivate: string[] = [];
  private tableSelectableCells_abyssPrivate: ProjectTableSelectableCell[] = [];
  private selectedKeys_abyssPrivate = new Set<string>();
  private tableRenderedCells_abyssPrivate: RenderedCellContext[] = [];
  private kanbanRenderedCells_abyssPrivate: RenderedCellContext[] = [];
  private timelineRenderedCells_abyssPrivate: RenderedCellContext[] = [];
  private readonly renderedGroups_abyssPrivate = new Map<string, RenderedGroupContext>();
  private readonly renderedProjectRows_abyssPrivate = new Map<string, RenderedProjectRow>();
  private readonly renderedGroupRows_abyssPrivate = new Map<string, RenderedGroupRow>();
  private table_abyssPrivate: HTMLTableElement | undefined;
  private body_abyssPrivate: HTMLTableSectionElement | undefined;
  private headerSignature_abyssPrivate = '';
  private columnResizePreview_abyssPrivate = false;
  private visibleColumns_abyssPrivate: readonly VisibleProjectColumn[] = [];
  private readonly searches_abyssPrivate: Record<ProjectOverviewMode, string> = {
    table: '',
    kanban: '',
    timeline: '',
  };
  private overviewMode_abyssPrivate: ProjectOverviewMode;
  private mounted_abyssPrivate = false;
  private timelineInteractionRevision_abyssPrivate = 0;
  private tableActionTail_abyssPrivate: Promise<void> = Promise.resolve();
  private mutationTail_abyssPrivate: Promise<void> = Promise.resolve();
  private mutationActive_abyssPrivate = false;
  private renderPending_abyssPrivate = false;
  private readonly sourceObservations_abyssPrivate = new Map<string, ProjectSourceObservation>();
  private readonly receiptProjections_abyssPrivate = new Map<string, ProjectReceiptProjection>();
  private activeMutationSourceRevisions_abyssPrivate: ReadonlyMap<string, number> | undefined;
  private nextReceiptOrdinal_abyssPrivate = 0;
  private pendingAction_abyssPrivate:
    { readonly run: () => void; readonly replace?: () => void } | undefined;
  private finishingEditor_abyssPrivate: Promise<boolean> | undefined;
  private preserveSubmittedActionFocus_abyssPrivate = false;
  private readonly resizeObserver_abyssPrivate: ResizeObserver | undefined;
  private nativeMenuOpen_abyssPrivate = false;
  private relativeDateInterval_abyssPrivate: number | undefined;

  constructor(
    host: HTMLElement,
    private readonly context_abyssPrivate: ProjectsTableViewContext,
  ) {
    this.overviewMode_abyssPrivate = context_abyssPrivate.settings.projects.overviewView ?? 'table';
    this.root_abyssPrivate = host.createDiv({ cls: 'abyss-projects-table' });
    this.toolbar_abyssPrivate = this.createToolbar_abyssPrivate();
    this.feedback_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-project-table-feedback',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });
    this.scroll_abyssPrivate = this.root_abyssPrivate.createDiv({
      cls: 'abyss-project-table-scroll',
      attr: { tabindex: '-1' },
    });
    this.root_abyssPrivate.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.clearGroupDropStates_abyssPrivate();
      this.handleTableKeydown_abyssPrivate(event);
    });
    this.ownerWindow_abyssPrivate = this.root_abyssPrivate.ownerDocument.defaultView ?? undefined;
    this.scroll_abyssPrivate.addEventListener('scroll', this.renderTableWindow_abyssPrivate);
    this.listenForOverviewBackgroundClick_abyssPrivate();
    this.listenForOwnerWindowF2_abyssPrivate();
    this.listenForRelativeDates_abyssPrivate();
    this.tableHost_abyssPrivate = this.scroll_abyssPrivate.createDiv({
      cls: 'abyss-project-table-host',
    });
    this.listenForDocumentFocus_abyssPrivate();
    const resizeObserver =
      this.scroll_abyssPrivate.ownerDocument.defaultView === null
        ? undefined
        : Reflect.get(this.scroll_abyssPrivate.ownerDocument.defaultView, 'ResizeObserver');
    if (typeof resizeObserver === 'function') {
      const ResizeObserverClass = resizeObserver as ResizeObserverConstructor;
      this.resizeObserver_abyssPrivate = new ResizeObserverClass(() => {
        this.handleTableResize_abyssPrivate();
      });
      this.resizeObserver_abyssPrivate.observe(this.scroll_abyssPrivate);
    }
    const footer = this.root_abyssPrivate.createDiv({ cls: 'abyss-project-table-footer' });
    const create = footer.createEl('button', {
      cls: 'abyss-projects-new',
      text: 'New project',
      attr: { type: 'button' },
    });
    create.addEventListener('click', () => {
      this.finishEditorBeforeAction(() => {
        this.showProjectComposer_abyssPrivate(create);
      });
    });
    this.count_abyssPrivate = footer.createSpan({ cls: 'abyss-project-table-count' });
    this.creationComposer_abyssPrivate = new ProjectCreationComposer({
      host: this.root_abyssPrivate,
      boundary: this.root_abyssPrivate,
      create: (request) => this.startProjectCreation_abyssPrivate(request),
      created: (path, statusId) => {
        this.enqueueCreatedProject_abyssPrivate(path, statusId);
      },
      failed: (error) => {
        this.creationInteractionToken_abyssPrivate = undefined;
        this.reportProjectCreationFailure_abyssPrivate(error);
      },
      openProject: (path) => {
        (this.context_abyssPrivate.openNote ?? this.context_abyssPrivate.openProject)(path);
      },
    });
    this.creationPresentation_abyssPrivate = new ProjectCreationPresentation({
      host: this.root_abyssPrivate,
      projects: () => this.projects_abyssPrivate,
      present: (project, focus) => this.presentCreatedProject_abyssPrivate(project, focus),
      inaccessible: (path) => {
        this.showExcludedCreatedProject_abyssPrivate(path);
      },
      reducedMotion: () =>
        typeof this.ownerWindow_abyssPrivate?.matchMedia === 'function' &&
        this.ownerWindow_abyssPrivate.matchMedia('(prefers-reduced-motion: reduce)').matches,
      now: () => Date.now(),
    });
  }

  private get selection_abyssPrivate(): ProjectTableSelection {
    if (this.overviewMode_abyssPrivate === 'kanban') return this.kanbanSelection_abyssPrivate;
    if (this.overviewMode_abyssPrivate === 'timeline') return this.timelineSelection_abyssPrivate;
    return this.tableSelection_abyssPrivate;
  }

  private get renderedCells_abyssPrivate(): RenderedCellContext[] {
    if (this.overviewMode_abyssPrivate === 'kanban') return this.kanbanRenderedCells_abyssPrivate;
    if (this.overviewMode_abyssPrivate === 'timeline')
      return this.timelineRenderedCells_abyssPrivate;
    return this.tableRenderedCells_abyssPrivate;
  }

  private set renderedCells_abyssPrivate(cells: RenderedCellContext[]) {
    if (this.overviewMode_abyssPrivate === 'kanban') this.kanbanRenderedCells_abyssPrivate = cells;
    else if (this.overviewMode_abyssPrivate === 'timeline')
      this.timelineRenderedCells_abyssPrivate = cells;
    else this.tableRenderedCells_abyssPrivate = cells;
  }

  private createToolbar_abyssPrivate(): ProjectsTableToolbar {
    return new ProjectsTableToolbar({
      host: this.root_abyssPrivate,
      settings: () => this.activeViewSettings_abyssPrivate(),
      tableSettings: () => this.context_abyssPrivate.settings.projects.table,
      mode: () => this.overviewMode_abyssPrivate,
      fields: () => this.fields_abyssPrivate,
      onSearch: (query) => {
        this.finishEditorBeforeAction(() => {
          this.searches_abyssPrivate[this.overviewMode_abyssPrivate] = query;
          this.renderTable_abyssPrivate();
        });
      },
      onStatusToggle: (key) => {
        this.finishEditorBeforeAction(() => {
          this.toggleStatus_abyssPrivate(key);
        });
      },
      onGroupBy: (field) =>
        this.requestViewChange_abyssPrivate(() => {
          this.context_abyssPrivate.settings.projects.table.groupBy = field;
        }),
      onSortBy: (field) =>
        this.requestViewChange_abyssPrivate(() => {
          this.transitionTableSort_abyssPrivate(field);
        }),
      onReset: () => {
        this.finishEditorBeforeAction(() => {
          this.resetViewState_abyssPrivate();
        });
      },
      onOverviewMode: (mode) => {
        this.switchOverviewMode_abyssPrivate(mode);
      },
      onViewOptionChange: (mutation) => this.requestViewChange_abyssPrivate(mutation),
      onTimelineScaleChange: (scale) => this.requestTimelineScaleChange_abyssPrivate(scale),
    });
  }

  private listenForRelativeDates_abyssPrivate(): void {
    this.ownerWindow_abyssPrivate?.addEventListener(
      'focus',
      this.refreshRelativeDates_abyssPrivate,
    );
    this.root_abyssPrivate.ownerDocument.addEventListener(
      'visibilitychange',
      this.refreshRelativeDates_abyssPrivate,
    );
  }

  private listenForDocumentFocus_abyssPrivate(): void {
    this.root_abyssPrivate.ownerDocument.addEventListener(
      'focusin',
      this.handleDocumentFocusIn_abyssPrivate,
      true,
    );
  }

  private resetViewState_abyssPrivate(): void {
    if (this.overviewMode_abyssPrivate === 'kanban') {
      this.context_abyssPrivate.settings.projects.kanban = buildDefaultProjectKanbanSettings(
        this.context_abyssPrivate.settings.projects.table,
      );
      this.prepareKanbanManualOrder_abyssPrivate(false);
      this.persistAndRender_abyssPrivate();
      return;
    }
    if (this.overviewMode_abyssPrivate === 'timeline') {
      this.context_abyssPrivate.settings.projects.timeline = buildDefaultProjectTimelineSettings(
        this.context_abyssPrivate.settings.projects.table,
      );
      this.persistAndRender_abyssPrivate();
      return;
    }
    const defaults = buildDefaultProjectTableSettings();
    const table = this.context_abyssPrivate.settings.projects.table;
    table.groupBy = defaults.groupBy;
    table.sortBy = defaults.sortBy;
    table.hiddenStatuses = defaults.hiddenStatuses;
    table.showDescription = defaults.showDescription;
    delete table.progress;
    delete table.dateDisplay;
    for (const column of table.columns) delete column.dateDisplay;
    this.persistAndRender_abyssPrivate();
  }

  private handleTableResize_abyssPrivate(): void {
    if (!this.mounted_abyssPrivate || this.overviewMode_abyssPrivate !== 'table') return;
    this.renderTableWindow_abyssPrivate();
    // A column drag owns the live widths until it commits or cancels. Reapplying the saved
    // widths here would revert its preview every time the observed table changes size.
    if (this.columnResizePreview_abyssPrivate) return;
    this.applyTableWidth_abyssPrivate();
    this.updateResponsiveNamePinning_abyssPrivate();
  }

  private activeViewSettings_abyssPrivate():
    ProjectTableSettings | ProjectKanbanSettings | ProjectTimelineSettings {
    if (this.overviewMode_abyssPrivate === 'table') {
      return this.context_abyssPrivate.settings.projects.table;
    }
    return this.overviewMode_abyssPrivate === 'kanban'
      ? this.ensureKanbanSettings_abyssPrivate()
      : this.ensureTimelineSettings_abyssPrivate();
  }

  private ensureKanbanSettings_abyssPrivate(): ProjectKanbanSettings {
    const projects = this.context_abyssPrivate.settings.projects;
    projects.kanban ??= buildDefaultProjectKanbanSettings(projects.table);
    return projects.kanban;
  }

  private ensureTimelineSettings_abyssPrivate(): ProjectTimelineSettings {
    const projects = this.context_abyssPrivate.settings.projects;
    projects.timeline ??= buildDefaultProjectTimelineSettings(projects.table);
    return projects.timeline;
  }

  private prepareKanbanManualOrder_abyssPrivate(create: boolean): boolean {
    const projectsSettings = this.context_abyssPrivate.settings.projects;
    const created = create && projectsSettings.kanban === undefined;
    if (created) this.ensureKanbanSettings_abyssPrivate();
    const settings = projectsSettings.kanban;
    if (settings === undefined) return false;
    let changed = created;
    for (const [key, paths] of projectPathsByStatus(this.projects_abyssPrivate)) {
      const existing = settings.manualOrder[key] ?? [];
      const sequence = appendUnrankedProjectPaths(existing, paths);
      if (sequence.length === existing.length && settings.manualOrder[key] !== undefined) continue;
      settings.manualOrder[key] = sequence;
      changed = true;
    }
    return changed;
  }

  private switchOverviewMode_abyssPrivate(mode: ProjectOverviewMode): void {
    if (mode === this.overviewMode_abyssPrivate) return;
    this.finishEditorBeforeAction(() => {
      if (mode === 'kanban') this.prepareKanbanManualOrder_abyssPrivate(true);
      if (this.overviewMode_abyssPrivate === 'timeline') {
        this.timelineInteractionRevision_abyssPrivate++;
      }
      this.overviewMode_abyssPrivate = mode;
      this.context_abyssPrivate.settings.projects.overviewView = mode;
      this.toolbar_abyssPrivate.setSearchValue(this.searches_abyssPrivate[mode]);
      this.persistAndRender_abyssPrivate();
    });
  }

  selectedProjectPath(): string | undefined {
    const focused = this.selection_abyssPrivate.focus;
    if (focused === undefined) return undefined;
    return this.logicalCell_abyssPrivate(focused)?.project.path;
  }

  captureViewportBeforeHide(): void {
    this.timelineInteractionRevision_abyssPrivate++;
    this.timelineView_abyssPrivate?.captureViewportBeforeHide();
  }

  mount(projects: readonly Project[]): void {
    this.mounted_abyssPrivate = true;
    this.markdown_abyssPrivate.load();
    this.projects_abyssPrivate = projects;
    this.refreshFields();
  }

  update(projects: readonly Project[]): void {
    this.projects_abyssPrivate = projects;
    const manualOrderChanged = this.prepareKanbanManualOrder_abyssPrivate(
      this.overviewMode_abyssPrivate === 'kanban',
    );
    this.renderTable_abyssPrivate();
    if (manualOrderChanged) this.persistSettings_abyssPrivate();
  }

  refreshFields(): void {
    const savedMode = this.context_abyssPrivate.settings.projects.overviewView ?? 'table';
    if (this.activeEditor_abyssPrivate === undefined) this.overviewMode_abyssPrivate = savedMode;
    this.fields_abyssPrivate = buildProjectFieldCatalog(
      this.context_abyssPrivate.settings.projects,
      this.context_abyssPrivate.catalog.list(),
    );
    const manualOrderChanged = this.prepareKanbanManualOrder_abyssPrivate(
      this.overviewMode_abyssPrivate === 'kanban',
    );
    this.renderTable_abyssPrivate();
    if (manualOrderChanged) this.persistSettings_abyssPrivate();
  }

  destroy(): void {
    this.mounted_abyssPrivate = false;
    this.timelineInteractionRevision_abyssPrivate++;
    this.creationInteractionRevision_abyssPrivate++;
    this.creationInteractionToken_abyssPrivate = undefined;
    this.clearGroupDropStates_abyssPrivate();
    this.pendingAction_abyssPrivate?.replace?.();
    this.pendingAction_abyssPrivate = undefined;
    this.activeEditor_abyssPrivate?.positionCleanup();
    this.activeEditor_abyssPrivate?.handle.destroy();
    this.activeEditor_abyssPrivate = undefined;
    this.activeRowDrag_abyssPrivate = undefined;
    this.clearOverviewState_abyssPrivate();
    this.renderedGroups_abyssPrivate.clear();
    this.destroyTableViewport_abyssPrivate();
    this.columnCleanup_abyssPrivate?.();
    this.columnCleanup_abyssPrivate = undefined;
    this.toolbar_abyssPrivate.destroy();
    this.creationComposer_abyssPrivate.destroy();
    this.creationPresentation_abyssPrivate.destroy();
    this.destroyOverviewSurfaces_abyssPrivate();
    this.resizeObserver_abyssPrivate?.disconnect();
    this.stopListening_abyssPrivate();
    this.markdown_abyssPrivate.unload();
    this.root_abyssPrivate.remove();
  }

  private destroyTableViewport_abyssPrivate(): void {
    this.scroll_abyssPrivate.removeEventListener('scroll', this.renderTableWindow_abyssPrivate);
    this.removeMissingRows_abyssPrivate(new Set(), new Set());
    this.tableModel_abyssPrivate = undefined;
    this.tableRows_abyssPrivate = [];
    this.tableLogicalCells_abyssPrivate = [];
    this.tableCellIndex_abyssPrivate.clear();
    this.tableViewport_abyssPrivate.replace([]);
    this.tableSpacers_abyssPrivate.clear();
    this.renderedProjectRows_abyssPrivate.clear();
    this.renderedGroupRows_abyssPrivate.clear();
  }

  private clearOverviewState_abyssPrivate(): void {
    this.selection_abyssPrivate.clear();
    this.tableSelection_abyssPrivate.clear();
    this.kanbanSelection_abyssPrivate.clear();
    this.timelineSelection_abyssPrivate.clear();
    this.tableRenderedCells_abyssPrivate = [];
    this.kanbanRenderedCells_abyssPrivate = [];
    this.timelineRenderedCells_abyssPrivate = [];
  }

  private destroyOverviewSurfaces_abyssPrivate(): void {
    this.kanbanView_abyssPrivate?.destroy();
    this.kanbanView_abyssPrivate = undefined;
    this.timelineView_abyssPrivate?.destroy();
    this.timelineView_abyssPrivate = undefined;
  }

  private stopListening_abyssPrivate(): void {
    this.ownerWindow_abyssPrivate?.removeEventListener(
      'keydown',
      this.handleOwnerWindowKeydown_abyssPrivate,
      true,
    );
    this.ownerWindow_abyssPrivate?.removeEventListener(
      'focus',
      this.refreshRelativeDates_abyssPrivate,
    );
    this.root_abyssPrivate.ownerDocument.removeEventListener(
      'visibilitychange',
      this.refreshRelativeDates_abyssPrivate,
    );
    this.stopRelativeDateTimer_abyssPrivate();
    this.root_abyssPrivate.ownerDocument.removeEventListener(
      'focusin',
      this.handleDocumentFocusIn_abyssPrivate,
      true,
    );
    this.root_abyssPrivate.removeEventListener(
      'click',
      this.handleOverviewBackgroundClick_abyssPrivate,
    );
  }

  private listenForOverviewBackgroundClick_abyssPrivate(): void {
    this.root_abyssPrivate.addEventListener(
      'click',
      this.handleOverviewBackgroundClick_abyssPrivate,
    );
  }

  /**
   * Serializes every table-session metadata mutation. Task 4 Undo/Redo uses this same queue.
   */
  runTableSessionMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.mutationActive_abyssPrivate = true;
      this.activeMutationSourceRevisions_abyssPrivate = new Map(
        Array.from(this.sourceObservations_abyssPrivate, ([path, observation]) => [
          path,
          observation.revision,
        ]),
      );
      try {
        return await mutation();
      } finally {
        this.activeMutationSourceRevisions_abyssPrivate = undefined;
        this.mutationActive_abyssPrivate = false;
        if (this.renderPending_abyssPrivate) this.renderTable_abyssPrivate();
      }
    };
    const result = this.mutationTail_abyssPrivate.then(run, run);
    this.mutationTail_abyssPrivate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Orders user-submitted actions before they enter the metadata mutation queue. */
  private runTableActionInOrder_abyssPrivate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tableActionTail_abyssPrivate.then(action, action);
    this.tableActionTail_abyssPrivate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Reconciles receipt projections only from ProjectStore's verified per-path source stream. */
  observeProjectSource(observation: ProjectSourceObservation): void {
    const current = this.sourceObservations_abyssPrivate.get(observation.path);
    if (current !== undefined && current.revision >= observation.revision) return;
    this.sourceObservations_abyssPrivate.set(observation.path, observation);
    let changed = false;
    for (const [key, projection] of this.receiptProjections_abyssPrivate) {
      if (
        projection.receipt.path === observation.path &&
        observation.revision > projection.sourceRevisionAtMutationStart
      ) {
        this.receiptProjections_abyssPrivate.delete(key);
        changed = true;
      }
    }
    if (changed) this.renderTable_abyssPrivate();
  }

  /** Keeps only the newest deliberate action while an editor is saving or blocked. */
  finishEditorBeforeAction(action: () => void): void {
    this.pendingAction_abyssPrivate?.replace?.();
    this.pendingAction_abyssPrivate = { run: action };
    this.finishActiveEditor_abyssPrivate().then(
      () => undefined,
      () => undefined,
    );
  }

  /** Resolves only when the current pending navigation may proceed. */
  requestFinishActiveEditor(): Promise<boolean> {
    if (this.activeEditor_abyssPrivate === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.pendingAction_abyssPrivate?.replace?.();
      this.pendingAction_abyssPrivate = {
        run: () => {
          resolve(true);
        },
        replace: () => {
          resolve(false);
        },
      };
      this.finishActiveEditor_abyssPrivate().then(
        () => undefined,
        () => undefined,
      );
    });
  }

  private finishActiveEditor_abyssPrivate(): Promise<boolean> {
    if (this.finishingEditor_abyssPrivate !== undefined) {
      return this.finishingEditor_abyssPrivate;
    }
    const editor = this.activeEditor_abyssPrivate;
    if (editor === undefined) {
      this.runPendingAction_abyssPrivate();
      return Promise.resolve(true);
    }
    const finishing = editor.handle.commit();
    this.finishingEditor_abyssPrivate = finishing;
    const settle = (): void => {
      if (this.finishingEditor_abyssPrivate === finishing) {
        this.finishingEditor_abyssPrivate = undefined;
      }
      if (this.activeEditor_abyssPrivate === undefined) this.runPendingAction_abyssPrivate();
    };
    finishing.then(settle, settle);
    return finishing;
  }

  private async finishEditorForTableAction_abyssPrivate(): Promise<boolean> {
    if (this.activeEditor_abyssPrivate === undefined) return true;
    this.preserveSubmittedActionFocus_abyssPrivate = true;
    try {
      const finished = await this.finishActiveEditor_abyssPrivate();
      if (!finished) this.preserveSubmittedActionFocus_abyssPrivate = false;
      return finished;
    } catch (error) {
      this.preserveSubmittedActionFocus_abyssPrivate = false;
      throw error;
    }
  }

  private takeSubmittedActionFocus_abyssPrivate(navigation: ProjectCellEditorNavigation): boolean {
    const preserve =
      this.preserveSubmittedActionFocus_abyssPrivate && navigation === 'restore-current';
    this.preserveSubmittedActionFocus_abyssPrivate = false;
    return preserve;
  }

  private runPendingAction_abyssPrivate(): void {
    const pending = this.pendingAction_abyssPrivate;
    this.pendingAction_abyssPrivate = undefined;
    pending?.run();
  }

  private persistAndRender_abyssPrivate(): void {
    this.renderTable_abyssPrivate();
    this.persistSettings_abyssPrivate();
  }

  private requestViewChange_abyssPrivate(mutation: () => void): Promise<boolean> {
    if (this.activeEditor_abyssPrivate === undefined) {
      mutation();
      this.persistAndRender_abyssPrivate();
      return Promise.resolve(true);
    }
    return this.requestFinishActiveEditor().then((finished) => {
      if (!finished) return false;
      mutation();
      this.persistAndRender_abyssPrivate();
      return true;
    });
  }

  private requestTimelineScaleChange_abyssPrivate(
    scale: ProjectTimelineSettings['scale'],
  ): Promise<boolean> {
    return this.requestViewChange_abyssPrivate(() => {
      this.timelineView_abyssPrivate?.prepareScaleChange();
      this.ensureTimelineSettings_abyssPrivate().scale = scale;
    });
  }

  private persistSettings_abyssPrivate(): void {
    this.feedback_abyssPrivate.empty();
    saveSettingsDraft({
      action: 'save project view settings',
      save: this.context_abyssPrivate.saveViewState,
    });
  }

  private toggleStatus_abyssPrivate(key: string): void {
    const hidden = this.activeViewSettings_abyssPrivate().hiddenStatuses;
    const index = hidden.indexOf(key);
    if (index >= 0) hidden.splice(index, 1);
    else hidden.push(key);
    this.persistAndRender_abyssPrivate();
  }

  private showProjectComposer_abyssPrivate(anchor: HTMLElement, statusId?: string): void {
    const status =
      statusId === undefined
        ? this.defaultCreationStatus_abyssPrivate()
        : this.context_abyssPrivate.settings.projects.statuses.find(({ id }) => id === statusId);
    this.creationComposer_abyssPrivate.open({
      anchor,
      ...(status === undefined
        ? {}
        : { statusId: status.id, statusLabel: projectStatusDisplayName(status) }),
    });
  }

  private defaultCreationStatus_abyssPrivate(): ProjectStatus | undefined {
    const projects = this.context_abyssPrivate.settings.projects;
    return (
      projects.statuses.find(({ id }) => id === projects.defaultStatusId) ?? projects.statuses[0]
    );
  }

  private startProjectCreation_abyssPrivate(request: ProjectCreateRequest): Promise<string | null> {
    this.creationInteractionToken_abyssPrivate = ++this.creationInteractionRevision_abyssPrivate;
    return this.context_abyssPrivate.createProject(request);
  }

  private enqueueCreatedProject_abyssPrivate(path: string, statusId: string | undefined): void {
    const interactionToken = this.creationInteractionToken_abyssPrivate;
    this.creationInteractionToken_abyssPrivate = undefined;
    this.creationPresentation_abyssPrivate.enqueue({
      path,
      ...(statusId === undefined ? {} : { expectedStatus: statusId }),
      ownsFocus: () =>
        interactionToken !== undefined &&
        interactionToken === this.creationInteractionRevision_abyssPrivate,
    });
  }

  private reportProjectCreationFailure_abyssPrivate(error: unknown): void {
    const cause = isProjectCreationError(error) ? error.cause : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error('[abyss-tasks] Could not create project', { cause, error });
    new Notice(`Could not create project: ${message}`);
  }

  private showExcludedCreatedProject_abyssPrivate(path: string): void {
    this.feedback_abyssPrivate.empty();
    this.feedback_abyssPrivate.createSpan({
      text: `Created ${path}, but it is outside the current project query. `,
    });
    const open = this.feedback_abyssPrivate.createEl('button', {
      text: 'Open note',
      attr: { type: 'button' },
    });
    open.addEventListener('click', () => {
      (this.context_abyssPrivate.openNote ?? this.context_abyssPrivate.openProject)(path);
    });
  }

  private presentCreatedProject_abyssPrivate(project: Project, focus: boolean): HTMLElement | null {
    if (!this.creationPresentationReady_abyssPrivate()) return null;
    if (focus) this.relaxCreationProjection_abyssPrivate(project);
    if (this.overviewMode_abyssPrivate === 'kanban') {
      return this.presentCreatedKanbanProject_abyssPrivate(project, focus);
    }
    if (this.overviewMode_abyssPrivate === 'timeline') {
      return this.presentCreatedTimelineProject_abyssPrivate(project, focus);
    }
    return this.presentCreatedTableProject_abyssPrivate(project, focus);
  }

  private creationPresentationReady_abyssPrivate(): boolean {
    return (
      this.mounted_abyssPrivate &&
      this.root_abyssPrivate.isConnected &&
      this.root_abyssPrivate.hidden === false &&
      this.context_abyssPrivate.state.get('projectsPanel').view === 'table' &&
      !this.mutationActive_abyssPrivate &&
      this.activeEditor_abyssPrivate === undefined &&
      !this.projectDragActive_abyssPrivate &&
      !this.renderPending_abyssPrivate
    );
  }

  private presentCreatedKanbanProject_abyssPrivate(
    project: Project,
    focus: boolean,
  ): HTMLElement | null {
    const board = this.kanbanView_abyssPrivate;
    if (board === undefined) return null;
    if (focus) {
      board.revealProject(project.path);
      this.kanbanRenderedCells_abyssPrivate = [...board.visibleCells()];
      this.kanbanSelection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    }
    const cell = this.kanbanRenderedCells_abyssPrivate.find(
      ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
    );
    if (cell === undefined) return null;
    if (focus) this.selectAndRevealCreationCell_abyssPrivate(cell);
    return cell.element.closest<HTMLElement>('.abyss-project-kanban-card') ?? cell.element;
  }

  private presentCreatedTableProject_abyssPrivate(
    project: Project,
    focus: boolean,
  ): HTMLElement | null {
    const model = buildProjectTableModel(this.projectTableModelInput_abyssPrivate());
    const group = model.groups.find(({ projects }) =>
      projects.some(({ path }) => path === project.path),
    );
    if (focus && group !== undefined && this.collapsedGroups_abyssPrivate.delete(group.key)) {
      this.renderTable_abyssPrivate();
    }
    const logical = this.tableLogicalCells_abyssPrivate.find(
      ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
    );
    if (focus && logical !== undefined) this.revealLogicalCell_abyssPrivate(logical.identity);
    const cell = this.tableRenderedCells_abyssPrivate.find(
      ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
    );
    if (cell === undefined) return null;
    if (focus) this.selectAndRevealCreationCell_abyssPrivate(cell);
    return cell.element.closest<HTMLElement>('.abyss-project-table-row') ?? cell.element;
  }

  private presentCreatedTimelineProject_abyssPrivate(
    project: Project,
    focus: boolean,
  ): HTMLElement | null {
    const timeline = this.timelineView_abyssPrivate;
    if (timeline === undefined) return null;
    if (focus) {
      timeline.revealProject(project.path);
      this.timelineRenderedCells_abyssPrivate = [...timeline.visibleCells()];
      this.timelineSelection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    }
    const cell = this.timelineRenderedCells_abyssPrivate.find(
      ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
    );
    if (cell === undefined) return null;
    if (focus) this.selectAndRevealCreationCell_abyssPrivate(cell);
    return cell.element.closest<HTMLElement>('.abyss-project-timeline-row') ?? cell.element;
  }

  private selectAndRevealCreationCell_abyssPrivate(cell: RenderedCellContext): void {
    this.selectCell_abyssPrivate(cell, false);
    this.revealSelectionCell_abyssPrivate(cell.element);
  }

  private relaxCreationProjection_abyssPrivate(project: Project): void {
    const settings = this.activeViewSettings_abyssPrivate();
    const statusKey = statusGroupKey(project);
    let changed = false;
    const hiddenIndex = settings.hiddenStatuses.indexOf(statusKey);
    if (hiddenIndex >= 0) {
      settings.hiddenStatuses.splice(hiddenIndex, 1);
      changed = true;
    }
    if (
      this.overviewMode_abyssPrivate === 'timeline' &&
      this.ensureTimelineSettings_abyssPrivate().showUnscheduled === false &&
      this.timelineProjectIsUnscheduled_abyssPrivate(project)
    ) {
      this.ensureTimelineSettings_abyssPrivate().showUnscheduled = true;
      changed = true;
    }
    const search = this.searches_abyssPrivate[this.overviewMode_abyssPrivate];
    if (search.length > 0 && !this.singletonVisible_abyssPrivate(project, search)) {
      this.searches_abyssPrivate[this.overviewMode_abyssPrivate] = '';
      this.toolbar_abyssPrivate.setSearchValue('');
      changed = true;
    }
    if (!changed) return;
    this.renderTable_abyssPrivate();
    this.persistSettings_abyssPrivate();
  }

  private timelineProjectIsUnscheduled_abyssPrivate(project: Project): boolean {
    const timeline = this.ensureTimelineSettings_abyssPrivate();
    const model = buildProjectTimelineModel({
      ...this.projectTableModelInput_abyssPrivate(),
      projects: [project],
      search: '',
      settings: { ...timeline, hiddenStatuses: [], showUnscheduled: true },
      tableSettings: this.context_abyssPrivate.settings.projects.table,
    });
    return model.groups.some(({ rows }) => rows.some(({ range }) => range.kind === 'unscheduled'));
  }

  private singletonVisible_abyssPrivate(project: Project, search: string): boolean {
    const common = {
      nowMs: this.trackedNowMs_abyssPrivate,
      projects: [project],
      fields: this.fields_abyssPrivate,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
      search,
      resolveLink: (target: string, sourcePath: string) =>
        this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
    };
    if (this.overviewMode_abyssPrivate === 'kanban') {
      return (
        buildProjectKanbanModel({
          ...common,
          settings: this.ensureKanbanSettings_abyssPrivate(),
        }).uniqueVisibleCount > 0
      );
    }
    if (this.overviewMode_abyssPrivate === 'timeline') {
      return (
        buildProjectTimelineModel({
          ...common,
          settings: this.ensureTimelineSettings_abyssPrivate(),
          tableSettings: this.context_abyssPrivate.settings.projects.table,
        }).uniqueVisibleCount > 0
      );
    }
    return (
      buildProjectTableModel({
        ...common,
        settings: this.context_abyssPrivate.settings.projects.table,
      }).uniqueVisibleCount > 0
    );
  }

  private renderTable_abyssPrivate(): void {
    if (!this.mounted_abyssPrivate) return;
    this.clearGroupDropStates_abyssPrivate();
    this.groupDropRevision_abyssPrivate++;
    if (
      this.mutationActive_abyssPrivate ||
      this.activeEditor_abyssPrivate !== undefined ||
      this.projectDragActive_abyssPrivate
    ) {
      this.renderPending_abyssPrivate = true;
      return;
    }
    this.renderPending_abyssPrivate = false;
    this.trackedNowMs_abyssPrivate = Date.now();
    if (this.renderAlternativeSurface_abyssPrivate()) return;
    this.showTableSurface_abyssPrivate();
    const scrollLeft = this.scroll_abyssPrivate.scrollLeft;
    const focusedIdentity = this.focusedCellIdentity_abyssPrivate();
    const availableWidth = this.scroll_abyssPrivate.clientWidth;

    const tableSettings = this.context_abyssPrivate.settings.projects.table;
    enforceProjectTableColumnInvariants(tableSettings);
    const columns = visibleColumns(this.context_abyssPrivate.settings, this.fields_abyssPrivate);
    this.syncRelativeDateTimer_abyssPrivate(columns, tableSettings.dateDisplay);
    this.compiledPresets_abyssPrivate = new Map(
      columns.map(({ field }) => [
        field.id,
        compileProjectPropertyPresets(this.projectPropertyDefinition_abyssPrivate(field.id)),
      ]),
    );
    const model = buildProjectTableModel(this.projectTableModelInput_abyssPrivate());
    this.toolbar_abyssPrivate.update(model.availableStatusGroups);
    this.count_abyssPrivate.setText(
      `${model.uniqueVisibleCount} ${model.uniqueVisibleCount === 1 ? 'project' : 'projects'}`,
    );

    const table = this.table_abyssPrivate ?? this.createTable_abyssPrivate();
    this.reconcileTableHeader_abyssPrivate(table, columns);
    this.applyTableWidth_abyssPrivate(availableWidth);
    this.renderTableBody_abyssPrivate(table, model, columns);
    this.updateResponsiveNamePinning_abyssPrivate(availableWidth);
    this.finishTableReconciliation_abyssPrivate(
      this.scroll_abyssPrivate.scrollTop,
      scrollLeft,
      focusedIdentity,
    );
  }

  private renderAlternativeSurface_abyssPrivate(): boolean {
    if (this.overviewMode_abyssPrivate === 'table') return false;
    if (this.overviewMode_abyssPrivate === 'kanban') this.renderKanban_abyssPrivate();
    else this.renderTimeline_abyssPrivate();
    this.notifyCreationReconciled_abyssPrivate();
    return true;
  }

  private finishTableReconciliation_abyssPrivate(
    scrollTop: number,
    scrollLeft: number,
    focusedIdentity: FocusedCellIdentity | undefined,
  ): void {
    this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    this.syncSelection_abyssPrivate();
    this.restoreTablePosition_abyssPrivate(scrollTop, scrollLeft, focusedIdentity);
    this.notifyCreationReconciled_abyssPrivate();
  }

  private notifyCreationReconciled_abyssPrivate(): void {
    if (this.creationInteractionSettling_abyssPrivate) {
      this.creationReconciliationPending_abyssPrivate = true;
      return;
    }
    if (this.notifyingCreationReconciliation_abyssPrivate) return;
    this.notifyingCreationReconciliation_abyssPrivate = true;
    try {
      this.creationPresentation_abyssPrivate.update();
    } finally {
      this.notifyingCreationReconciliation_abyssPrivate = false;
    }
  }

  private runSettledCreationInteraction_abyssPrivate(action: () => void): void {
    this.creationInteractionSettling_abyssPrivate = true;
    try {
      action();
    } finally {
      this.creationInteractionSettling_abyssPrivate = false;
      if (this.creationReconciliationPending_abyssPrivate) {
        this.creationReconciliationPending_abyssPrivate = false;
        this.notifyCreationReconciled_abyssPrivate();
      }
    }
  }

  private showTableSurface_abyssPrivate(): void {
    this.scroll_abyssPrivate.hidden = false;
    if (this.kanbanView_abyssPrivate !== undefined) this.kanbanView_abyssPrivate.root.hidden = true;
    if (this.timelineView_abyssPrivate !== undefined) {
      this.timelineView_abyssPrivate.cancelInteraction();
      this.timelineView_abyssPrivate.root.hidden = true;
    }
  }

  private projectTableModelInput_abyssPrivate(): ProjectTableModelInput {
    return {
      projects: this.projectedProjects_abyssPrivate(),
      fields: this.fields_abyssPrivate,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      settings: this.context_abyssPrivate.settings.projects.table,
      propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
      search: this.searches_abyssPrivate.table,
      nowMs: this.trackedNowMs_abyssPrivate,
      resolveLink: (target, sourcePath) =>
        this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
    };
  }

  private renderKanban_abyssPrivate(): void {
    this.scroll_abyssPrivate.hidden = true;
    if (this.timelineView_abyssPrivate !== undefined) {
      this.timelineView_abyssPrivate.cancelInteraction();
      this.timelineView_abyssPrivate.root.hidden = true;
    }
    const board = (this.kanbanView_abyssPrivate ??= this.createKanbanView_abyssPrivate());
    board.root.hidden = false;
    const settings = this.ensureKanbanSettings_abyssPrivate();
    this.compiledPresets_abyssPrivate = new Map(
      settings.fields.map(({ id }) => [
        id,
        compileProjectPropertyPresets(this.projectPropertyDefinition_abyssPrivate(id)),
      ]),
    );
    const relativeColumns = settings.fields.flatMap((column) => {
      const field = findProjectFieldById(this.fields_abyssPrivate, column.id);
      return field === undefined ? [] : [{ column, field }];
    });
    this.syncRelativeDateTimer_abyssPrivate(relativeColumns);
    if (board.currentModel() === undefined) {
      board.mount(this.projectedProjects_abyssPrivate(), this.searches_abyssPrivate.kanban);
    } else {
      board.update(this.projectedProjects_abyssPrivate(), this.searches_abyssPrivate.kanban);
    }
    const model = board.currentModel();
    this.renderedCells_abyssPrivate = [...board.visibleCells()];
    this.toolbar_abyssPrivate.update(model?.availableStatusGroups ?? []);
    const count = model?.uniqueVisibleCount ?? 0;
    this.count_abyssPrivate.setText(`${count} ${count === 1 ? 'project' : 'projects'}`);
    this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    this.syncSelection_abyssPrivate();
  }

  private renderTimeline_abyssPrivate(): void {
    this.scroll_abyssPrivate.hidden = true;
    if (this.kanbanView_abyssPrivate !== undefined) this.kanbanView_abyssPrivate.root.hidden = true;
    const timeline = (this.timelineView_abyssPrivate ??= this.createTimelineView_abyssPrivate());
    timeline.root.hidden = false;
    const timelineSettings = this.ensureTimelineSettings_abyssPrivate();
    const timelineFields = projectTimelineFields(timelineSettings);
    this.compiledPresets_abyssPrivate = new Map(
      timelineFields.map(({ id }) => [
        id,
        compileProjectPropertyPresets(this.projectPropertyDefinition_abyssPrivate(id)),
      ]),
    );
    const relativeColumns = timelineFields.flatMap((column) => {
      const field = findProjectFieldById(this.fields_abyssPrivate, column.id);
      return field === undefined ? [] : [{ column, field }];
    });
    this.syncRelativeDateTimer_abyssPrivate(relativeColumns);
    if (timeline.currentModel() === undefined) {
      timeline.mount(this.projectedProjects_abyssPrivate(), this.searches_abyssPrivate.timeline);
    } else {
      timeline.update(this.projectedProjects_abyssPrivate(), this.searches_abyssPrivate.timeline);
    }
    const model = timeline.currentModel();
    this.renderedCells_abyssPrivate = [...timeline.visibleCells()];
    this.toolbar_abyssPrivate.update(model?.availableStatusGroups ?? []);
    const count = model?.uniqueVisibleCount ?? 0;
    this.count_abyssPrivate.setText(`${count} ${count === 1 ? 'project' : 'projects'}`);
    this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    this.syncSelection_abyssPrivate();
  }

  private createTimelineView_abyssPrivate(): ProjectsTimelineView<RenderedCellContext> {
    const timeline = new ProjectsTimelineView<RenderedCellContext>(this.root_abyssPrivate, {
      settings: () => this.ensureTimelineSettings_abyssPrivate(),
      modelInput: () => ({
        nowMs: this.trackedNowMs_abyssPrivate,
        fields: this.fields_abyssPrivate,
        statuses: this.context_abyssPrivate.settings.projects.statuses,
        propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
        tableSettings: this.context_abyssPrivate.settings.projects.table,
        resolveLink: (target, sourcePath) =>
          this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
            ?.path,
      }),
      renderCell: (options) => this.renderTimelineCell_abyssPrivate(options),
      selectCell: (cell) => {
        this.selectCell_abyssPrivate(cell, false);
      },
      requestViewChange: (mutation) => this.requestViewChange_abyssPrivate(mutation),
      requestNavigation: (action) => {
        this.finishEditorBeforeAction(action);
      },
      requestScaleChange: (scale) => this.requestTimelineScaleChange_abyssPrivate(scale),
      renderGroupContent: (marker, label, group) => {
        this.renderGroupContent_abyssPrivate(
          { marker, host: label, component: this.markdown_abyssPrivate },
          group,
          group.presentation?.color,
        );
      },
      statusColor: (project) =>
        this.context_abyssPrivate.settings.projects.statuses.find(
          ({ id }) => id === project.statusId,
        )?.color,
      captureRangeSource: (occurrenceId) =>
        this.captureTimelineRangeSource_abyssPrivate(occurrenceId),
      commitRangeEdit: (request) => this.commitTimelineRangeEdit_abyssPrivate(request),
      reportRangeFailure: (failure) => {
        this.reportTimelineRangeFailure_abyssPrivate(failure);
      },
      finishEditor: () => this.requestFinishActiveEditor(),
      openRangeMenu: (occurrenceId, event) => {
        const rendered = this.timelineRenderedCells_abyssPrivate.find(
          ({ identity }) => identity.occurrenceId === occurrenceId && identity.columnId === 'name',
        );
        if (rendered === undefined) return;
        this.selectCell_abyssPrivate(rendered, false);
        this.showDescriptionMenu_abyssPrivate(rendered, event);
      },
    });
    this.scroll_abyssPrivate.after(timeline.root);
    return timeline;
  }

  private createKanbanView_abyssPrivate(): ProjectsKanbanView<RenderedCellContext> {
    const board = new ProjectsKanbanView<RenderedCellContext>(this.root_abyssPrivate, {
      beginDrag: () => this.beginProjectDrag_abyssPrivate(),
      settings: () => this.ensureKanbanSettings_abyssPrivate(),
      modelInput: () => ({
        nowMs: this.trackedNowMs_abyssPrivate,
        fields: this.fields_abyssPrivate,
        statuses: this.context_abyssPrivate.settings.projects.statuses,
        propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
        resolveLink: (target, sourcePath) =>
          this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
            ?.path,
      }),
      renderCell: (options) => this.renderKanbanCell_abyssPrivate(options),
      selectCell: (cell) => {
        this.selectCell_abyssPrivate(cell, false);
      },
      requestViewChange: (mutation) => this.requestViewChange_abyssPrivate(mutation),
      renderGroupContent: (marker, label, group) => {
        this.renderGroupContent_abyssPrivate(
          { marker, host: label, component: this.markdown_abyssPrivate },
          group,
          group.presentation?.color,
        );
      },
      applyChanges: (changes) => this.applyBoardChanges_abyssPrivate(changes),
      projectSnapshot: (path) =>
        this.projectedProjects_abyssPrivate().find((project) => project.path === path),
      projectsSnapshot: () => this.projectedProjects_abyssPrivate(),
      statusProperty: () => this.context_abyssPrivate.settings.projects.statusProperty,
      membershipQuery: () => this.context_abyssPrivate.settings.projects.membershipQuery,
      tagsReliable: (path, fieldId) => this.boardTagsReliable_abyssPrivate(path, fieldId),
      rebaseGroupValue: (value, sourcePath, destinationPath) =>
        rebaseProjectClipboardLinks(
          value,
          sourcePath,
          destinationPath,
          this.linkRebaser_abyssPrivate(),
        ),
      commitDrop: (build) => this.commitBoardDrop_abyssPrivate(build),
      reportDropFailure: (error) => {
        this.reportBoardDropFailure_abyssPrivate(error);
      },
      createProject: (anchor, statusId) => {
        this.finishEditorBeforeAction(() => {
          this.showProjectComposer_abyssPrivate(anchor, statusId);
        });
      },
    });
    this.scroll_abyssPrivate.after(board.root);
    return board;
  }

  private applyBoardChanges_abyssPrivate(
    changes: readonly ProjectCellChange[],
  ): Promise<ProjectEditResult> {
    return this.runTableSessionMutation(async () => {
      const result = await this.context_abyssPrivate.applyEdits(changes);
      this.context_abyssPrivate.history.record(result);
      this.publishAppliedReceipts(result.applied);
      return result;
    });
  }

  private async commitBoardDrop_abyssPrivate(
    build: () => {
      readonly changes: readonly ProjectCellChange[];
      readonly afterApplied?: () => void;
    },
  ): Promise<ProjectEditResult> {
    if (!(await this.requestFinishActiveEditor())) {
      throw new Error('The active project edit must finish before moving the card');
    }
    return this.runTableSessionMutation(async () => {
      const planned = build();
      const result: ProjectEditResult =
        planned.changes.length === 0
          ? { applied: [], failed: [] }
          : await this.context_abyssPrivate.applyEdits(planned.changes);
      if (result.applied.length > 0) {
        this.context_abyssPrivate.history.record(result);
        this.publishAppliedReceipts(result.applied);
      }
      if (result.failed.length === 0 && result.applied.length === planned.changes.length) {
        planned.afterApplied?.();
        if (planned.afterApplied !== undefined) {
          this.renderTable_abyssPrivate();
          this.persistSettings_abyssPrivate();
        }
      }
      return result;
    });
  }

  private reportBoardDropFailure_abyssPrivate(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.feedback_abyssPrivate.setText(message);
    if (isProjectEditValidationError(error)) return;
    console.error('[abyss-tasks] Could not move project card', { cause: error });
    new Notice(`Could not move project card: ${message}`);
  }

  private captureTimelineEndpoint_abyssPrivate(
    project: Project,
    field: ProjectField,
  ): ProjectTimelineEndpointEvidence {
    const sourceProperty = expectProjectFieldProperty(field);
    const source = findFrontmatterProperty(project.frontmatter, sourceProperty);
    return {
      field: { ...field },
      sourceProperty,
      sourceKey: source?.key ?? sourceProperty,
      expectedExists: source !== undefined,
      expectedValue: copyProjectedValue(source?.value),
    };
  }

  private visibleTimelineRow_abyssPrivate(occurrenceId: string): ProjectTimelineRow | undefined {
    if (
      !this.mounted_abyssPrivate ||
      !this.root_abyssPrivate.isConnected ||
      Boolean(this.root_abyssPrivate.hidden) ||
      this.context_abyssPrivate.state.get('projectsPanel').view !== 'table' ||
      this.overviewMode_abyssPrivate !== 'timeline' ||
      this.timelineView_abyssPrivate?.root.hidden === true
    ) {
      return undefined;
    }
    return this.timelineView_abyssPrivate?.visibleRow(occurrenceId);
  }

  private captureTimelineRangeSource_abyssPrivate(
    occurrenceId: string,
  ): ProjectTimelineRangeCapture {
    const row = this.visibleTimelineRow_abyssPrivate(occurrenceId);
    if (row === undefined) {
      return { kind: 'rejected', reason: 'This project range is no longer visible.' };
    }
    if (row.range.kind === 'malformed') {
      return { kind: 'rejected', reason: PROJECT_TIMELINE_INVALID_RANGE_REASON };
    }
    const start = timelineDateField(this.fields_abyssPrivate, 'start');
    const end = timelineDateField(this.fields_abyssPrivate, 'end');
    if (start === undefined || end === undefined || sameTimelineProperty(start, end)) {
      return {
        kind: 'rejected',
        reason:
          'Configure distinct available date properties for Start and End before Timeline editing.',
      };
    }
    const ambiguous = ambiguousTimelineSource(row.project, [start, end]);
    if (ambiguous !== undefined) {
      return {
        kind: 'rejected',
        reason: `${ambiguous.label} has ambiguous source spelling. Repair the duplicate properties before Timeline editing.`,
      };
    }
    const source: FrozenProjectTimelineRangeSource = {
      occurrenceId,
      path: row.project.path,
      start: this.captureTimelineEndpoint_abyssPrivate(row.project, start),
      end: this.captureTimelineEndpoint_abyssPrivate(row.project, end),
      range: { ...row.range },
    };
    const eligibility = projectTimelineRawEditEligibility(
      { exists: source.start.expectedExists, value: source.start.expectedValue },
      { exists: source.end.expectedExists, value: source.end.expectedValue },
    );
    return eligibility.kind === 'eligible'
      ? { kind: 'ready', source }
      : { kind: 'rejected', reason: eligibility.reason };
  }

  private timelineChangesForPlan_abyssPrivate(
    source: FrozenProjectTimelineRangeSource,
    plan: Extract<ProjectTimelineEditPlan, { readonly kind: 'ready' }>,
  ): readonly ProjectCellChange[] {
    const endpoint = (
      evidence: ProjectTimelineEndpointEvidence,
      desiredDay: string | undefined,
    ): {
      readonly changed: boolean;
      readonly change: ProjectCellChange;
    } => {
      const desiredExists = desiredDay === undefined ? evidence.expectedExists : true;
      const desiredValue = desiredDay ?? copyProjectedValue(evidence.expectedValue);
      const changed =
        desiredExists !== evidence.expectedExists ||
        !Object.is(desiredValue, evidence.expectedValue);
      return {
        changed,
        change: {
          path: source.path,
          field: { ...evidence.field },
          value: desiredValue,
          expectedValue: copyProjectedValue(evidence.expectedValue),
          expectedExists: evidence.expectedExists,
          sourceProperty: evidence.sourceProperty,
          sourceKey: evidence.sourceKey,
        },
      };
    };
    const start = endpoint(source.start, plan.startDay);
    const end = endpoint(source.end, plan.endDay);
    if (!start.changed && !end.changed) return [];
    return [
      start.changed
        ? start.change
        : {
            ...start.change,
            valueExists: source.start.expectedExists,
            restoreSourceValue: true,
          },
      end.changed
        ? end.change
        : {
            ...end.change,
            valueExists: source.end.expectedExists,
            restoreSourceValue: true,
          },
    ];
  }

  private commitTimelineRangeEdit_abyssPrivate(
    request: ProjectTimelineRangeEditRequest,
  ): Promise<ProjectEditResult> {
    const interactionRevision = this.timelineInteractionRevision_abyssPrivate;
    return this.runTableActionInOrder_abyssPrivate(async () => {
      const finished = await this.finishEditorForTableAction_abyssPrivate();
      if (!finished) {
        throw new ProjectEditValidationError(
          'The active project edit must finish before changing Timeline dates.',
        );
      }
      return this.runTableSessionMutation(async () => {
        if (interactionRevision !== this.timelineInteractionRevision_abyssPrivate) {
          throw new ProjectEditValidationError('This project range is no longer visible.');
        }
        const capture = this.captureTimelineRangeSource_abyssPrivate(
          request.kind === 'pointer' ? request.source.occurrenceId : request.target.occurrenceId,
        );
        if (capture.kind === 'rejected') throw new ProjectEditValidationError(capture.reason);
        const current = capture.source;
        if (
          request.kind === 'pointer'
            ? !sameProjectTimelineRangeSource(request.source, current)
            : !sameProjectTimelineRangeBinding(request.target, current)
        ) {
          throw new ProjectEditValidationError(
            'The project dates changed after this Timeline edit started. Reload and try again.',
          );
        }
        const plan = planProjectTimelineEdit(
          request.kind === 'pointer' ? request.source.range : current.range,
          request.intent,
        );
        if (plan.kind === 'rejected') throw new ProjectEditValidationError(plan.reason);
        const changes = this.timelineChangesForPlan_abyssPrivate(current, plan);
        if (changes.length === 0) return { applied: [], failed: [] };
        const result = await this.context_abyssPrivate.applyEdits(changes);
        if (result.applied.length > 0) {
          this.context_abyssPrivate.history.record(result);
          this.publishAppliedReceipts(result.applied);
        }
        return result;
      });
    });
  }

  private reportTimelineRangeFailure_abyssPrivate(failure: unknown): void {
    const label = 'Could not update project Timeline dates';
    if (
      typeof failure === 'object' &&
      failure !== null &&
      'failed' in failure &&
      Array.isArray((failure as ProjectEditResult).failed)
    ) {
      const result = failure as ProjectEditResult;
      if (result.failed.length === 0) return;
      const first = result.failed[0];
      const detail = first === undefined ? '' : `: ${first.message}`;
      const message = `${result.applied.length} updated; ${result.failed.length} failed${detail}`;
      console.error(`[abyss-tasks] ${label}`, { result });
      new Notice(`${label}: ${message}`);
      return;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    if (typeof failure === 'string' || isProjectEditValidationError(failure)) {
      new Notice(message);
      return;
    }
    console.error(`[abyss-tasks] ${label}`, { cause: failure });
    new Notice(`${label}: ${message}`);
  }

  private boardTagsReliable_abyssPrivate(path: string, fieldId: string): boolean {
    const field = findProjectFieldById(this.fields_abyssPrivate, fieldId);
    const property = field?.property;
    const pendingTagChange = Array.from(this.receiptProjections_abyssPrivate.values()).some(
      ({ receipt }) => receipt.path === path && isTagCarrier(receipt.sourceKey),
    );
    return field?.type !== 'tags' && !isTagCarrier(property) && !pendingTagChange;
  }

  private renderKanbanCell_abyssPrivate(options: {
    readonly host: HTMLElement;
    readonly project: Project;
    readonly field: ProjectFieldCatalogItem;
    readonly column: ProjectColumn | undefined;
    readonly occurrenceId: string;
    readonly groupKey: string;
    readonly existing?: RenderedCellContext;
  }): RenderedCellContext {
    return this.renderOverviewCell_abyssPrivate(options, 'kanban');
  }

  private renderTimelineCell_abyssPrivate(options: {
    readonly host: HTMLElement;
    readonly project: Project;
    readonly field: ProjectFieldCatalogItem;
    readonly column?: ProjectColumn;
    readonly occurrenceId: string;
    readonly groupKey: string;
    readonly existing?: RenderedCellContext;
  }): RenderedCellContext {
    return this.renderOverviewCell_abyssPrivate(options, 'timeline');
  }

  private renderOverviewCell_abyssPrivate(
    options: {
      readonly host: HTMLElement;
      readonly project: Project;
      readonly field: ProjectFieldCatalogItem;
      readonly column?: ProjectColumn | undefined;
      readonly occurrenceId: string;
      readonly groupKey: string;
      readonly existing?: RenderedCellContext;
    },
    presentation: 'kanban' | 'timeline',
  ): RenderedCellContext {
    const { field, ownedClear } = this.effectiveField_abyssPrivate(options.project, options.field);
    const rendered = options.existing ?? {
      identity: {
        occurrenceId: options.occurrenceId,
        projectPath: options.project.path,
        groupKey: options.groupKey,
        columnId: field.id,
      },
      project: options.project,
      field,
      ownedClear,
      element: options.host,
      contentSignature: '',
    };
    rendered.identity = {
      occurrenceId: options.occurrenceId,
      projectPath: options.project.path,
      groupKey: options.groupKey,
      columnId: field.id,
    };
    rendered.project = options.project;
    rendered.field = field;
    rendered.ownedClear = ownedClear;
    this.assignOverviewCellViewport_abyssPrivate(rendered, options.host, presentation);
    options.host.addClass('abyss-project-table-cell', `abyss-project-${presentation}-cell`);
    options.host.tabIndex = 0;
    options.host.dataset['columnId'] = field.id;
    options.host.setAttribute('aria-label', `${field.label} for ${options.project.name}`);
    options.host.toggleClass('is-editable', editableField(field));
    const descriptionLines = overviewDescriptionLines(presentation, field, () =>
      this.ensureTimelineSettings_abyssPrivate(),
    );
    const signature = JSON.stringify({
      field,
      value: projectFieldValue(options.project, field),
      project: options.project,
      statuses:
        field.type === 'status' ? this.context_abyssPrivate.settings.projects.statuses : undefined,
      definition: this.projectPropertyDefinition_abyssPrivate(field.id),
      column: options.column,
      ownedClear,
      presentation,
      display: this.projectCellPresentation_abyssPrivate(options.column, presentation),
      descriptionLines,
    });
    if (options.existing === undefined) this.decorateProjectCell_abyssPrivate(rendered);
    if (signature !== rendered.contentSignature) {
      rendered.contentSignature = signature;
      options.host.empty();
      const content =
        field.type === 'name'
          ? options.host.createDiv({ cls: 'abyss-project-table-name-content' })
          : options.host;
      this.renderProjectCellContent_abyssPrivate(content, rendered, {
        ...(options.column === undefined ? {} : { preferredColumn: options.column }),
        showNameDescription: showOverviewNameDescription(presentation, descriptionLines),
        presentation,
      });
    }
    return rendered;
  }

  private assignOverviewCellViewport_abyssPrivate(
    rendered: RenderedCellContext,
    host: HTMLElement,
    presentation: 'kanban' | 'timeline',
  ): void {
    if (presentation === 'kanban') {
      this.assignKanbanCellViewport_abyssPrivate(rendered, host);
      return;
    }
    const scroll = this.timelineView_abyssPrivate?.scroll;
    if (scroll === undefined) {
      delete rendered.editorBoundary;
      delete rendered.horizontalScroll;
      delete rendered.verticalScroll;
    } else {
      rendered.editorBoundary = scroll;
      rendered.horizontalScroll = scroll;
      rendered.verticalScroll = scroll;
    }
    const stickyHeader = this.timelineView_abyssPrivate?.root.querySelector<HTMLElement>(
      '.abyss-project-timeline-axis',
    );
    if (stickyHeader === null || stickyHeader === undefined) delete rendered.stickyHeader;
    else rendered.stickyHeader = stickyHeader;
  }

  private assignKanbanCellViewport_abyssPrivate(
    rendered: RenderedCellContext,
    host: HTMLElement,
  ): void {
    const editorBoundary = this.kanbanView_abyssPrivate?.scroll;
    if (editorBoundary === undefined) delete rendered.editorBoundary;
    else rendered.editorBoundary = editorBoundary;
    if (editorBoundary === undefined) delete rendered.horizontalScroll;
    else rendered.horizontalScroll = editorBoundary;
    const verticalScroll = host.closest<HTMLElement>('.abyss-project-kanban-column-body');
    if (verticalScroll === null) delete rendered.verticalScroll;
    else rendered.verticalScroll = verticalScroll;
    const stickyHeader =
      host
        .closest<HTMLElement>('.abyss-project-kanban-column')
        ?.querySelector<HTMLElement>('.abyss-project-kanban-column-header') ?? undefined;
    if (stickyHeader === undefined) delete rendered.stickyHeader;
    else rendered.stickyHeader = stickyHeader;
  }

  private projectPropertyDefinition_abyssPrivate(
    fieldId: string,
  ): ProjectPropertyDefinition | undefined {
    return Object.entries(this.context_abyssPrivate.settings.projects.propertyDefinitions).find(
      ([candidate]) => sameProjectPropertyName(candidate, fieldId),
    )?.[1];
  }

  private editorPresets_abyssPrivate(
    field: ProjectField,
  ): readonly ProjectPropertySuggestion[] | undefined {
    return editorPresets(
      this.projectPropertyDefinition_abyssPrivate(field.id),
      field.type === 'tags',
    );
  }

  private createTable_abyssPrivate(): HTMLTableElement {
    const table = this.tableHost_abyssPrivate.createEl('table', {
      cls: 'abyss-project-table',
    });
    this.table_abyssPrivate = table;
    this.resizeObserver_abyssPrivate?.observe(table);
    table.addEventListener('copy', (event) => {
      this.handleCopy_abyssPrivate(event);
    });
    table.addEventListener('paste', (event) => {
      this.handlePaste_abyssPrivate(event);
    });
    return table;
  }

  private reconcileTableHeader_abyssPrivate(
    table: HTMLTableElement,
    columns: readonly VisibleProjectColumn[],
  ): void {
    const tableSettings = this.context_abyssPrivate.settings.projects.table;
    const signature = JSON.stringify({
      columns: columns.map(({ column, field }) => ({
        id: column.id,
        label: column.label ?? field.label,
        width: projectTableColumnWidth(column, field),
        type: field.type,
        alignment: column.alignment ?? 'left',
      })),
      sort: tableSettings.sortBy,
    });
    this.visibleColumns_abyssPrivate = columns;
    if (signature === this.headerSignature_abyssPrivate) return;
    this.headerSignature_abyssPrivate = signature;
    this.columnCleanup_abyssPrivate?.();
    table.querySelector(':scope > colgroup')?.remove();
    table.querySelector(':scope > thead')?.remove();
    this.columnCleanup_abyssPrivate = renderProjectTableColumns(table, {
      columns,
      sort: tableSettings.sortBy,
      onSort: (field) => {
        this.finishEditorBeforeAction(() => {
          this.sortByColumn_abyssPrivate(field);
        });
      },
      onSortExact: (field, direction) => {
        const target = this.context_abyssPrivate.settings.projects.table;
        target.sortBy =
          direction === 'none' ? { field: 'none', dir: 'asc' } : { field, dir: direction };
        this.persistAndRender_abyssPrivate();
      },
      beforeAction: (action) => {
        this.finishEditorBeforeAction(action);
      },
      onAlignment: (columnId, alignment) => {
        this.setColumnAlignment_abyssPrivate(columnId, alignment);
      },
      dateDisplay: (column) => effectiveProjectTableDateDisplay(tableSettings, column),
      onDateDisplay: (columnId, display) => {
        this.setColumnDateDisplay_abyssPrivate(columnId, display);
      },
      typeChoices: (columnId) => this.projectColumnTypeChoices_abyssPrivate(columnId),
      onType: (columnId, type) => {
        this.setProjectColumnType_abyssPrivate(columnId, type);
      },
      restoreTableFocus: () => this.restoreTableSelectionFocus_abyssPrivate(),
      onRename: (columnId, label) => {
        this.finishEditorBeforeAction(() => {
          this.renameColumn_abyssPrivate(columnId, label);
        });
      },
      onMove: (columnId, targetColumnId, placement) => {
        this.finishEditorBeforeAction(() => {
          this.moveColumn_abyssPrivate(columnId, targetColumnId, placement);
        });
      },
      onResize: (resize) => {
        this.finishEditorBeforeAction(() => {
          this.resizeColumns_abyssPrivate(resize);
        });
      },
      onResizePreview: (active) => {
        this.columnResizePreview_abyssPrivate = active;
      },
    });
    const colgroup = table.querySelector(':scope > colgroup');
    if (colgroup !== null) table.insertBefore(colgroup, table.firstChild);
    const head = table.querySelector(':scope > thead');
    if (head !== null && this.body_abyssPrivate !== undefined) {
      table.insertBefore(head, this.body_abyssPrivate);
    }
  }

  private restoreTableSelectionFocus_abyssPrivate(): boolean {
    const focus = this.selection_abyssPrivate.focus;
    if (focus === undefined) return false;
    this.focusSelectionCell_abyssPrivate(focus, false);
    return true;
  }

  private setColumnAlignment_abyssPrivate(
    columnId: string,
    alignment: 'left' | 'center' | 'right',
  ): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    if (setProjectColumnAlignment(table, columnId, alignment)) this.persistAndRender_abyssPrivate();
  }

  private setColumnDateDisplay_abyssPrivate(columnId: string, display: ProjectDateDisplay): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    if (setProjectTableColumnDateDisplay(table, this.fields_abyssPrivate, columnId, display)) {
      this.persistAndRender_abyssPrivate();
    }
  }

  private renderTableBody_abyssPrivate(
    table: HTMLTableElement,
    model: ProjectTableModel,
    columns: readonly VisibleProjectColumn[],
  ): void {
    const body = this.body_abyssPrivate ?? table.createEl('tbody');
    this.body_abyssPrivate = body;
    this.tableRowsDirty_abyssPrivate = true;
    this.tableModel_abyssPrivate = model;
    this.tableRows_abyssPrivate = [];
    this.tableLogicalCells_abyssPrivate = [];
    this.tableCellIndex_abyssPrivate.clear();
    this.tableRowIds_abyssPrivate = [];
    this.tableColumnIds_abyssPrivate = columns.map(({ column }) => column.id);
    this.renderedGroups_abyssPrivate.clear();
    const grouped = this.context_abyssPrivate.settings.projects.table.groupBy !== 'none';
    for (const group of model.groups) {
      this.renderedGroups_abyssPrivate.set(group.key, group);
      if (grouped) this.tableRows_abyssPrivate.push({ key: `group:${group.key}`, group });
      if (grouped && this.collapsedGroups_abyssPrivate.has(group.key)) continue;
      this.appendLogicalGroup_abyssPrivate(group, columns);
    }
    this.tableSelectableCells_abyssPrivate = this.tableLogicalCells_abyssPrivate.map(
      ({ identity }) => identity,
    );
    this.tableViewport_abyssPrivate.replace(
      this.tableRows_abyssPrivate.map(({ key, project }) => ({
        key,
        height: project === undefined ? 32 : 34,
      })),
    );
    this.renderTableWindow_abyssPrivate();
  }

  private appendLogicalGroup_abyssPrivate(
    group: ProjectTableGroup,
    columns: readonly VisibleProjectColumn[],
  ): void {
    for (const project of group.projects) {
      const key = `${encodeURIComponent(group.key)}:${encodeURIComponent(project.path)}`;
      this.tableRows_abyssPrivate.push({ key, group, project });
      this.tableRowIds_abyssPrivate.push(key);
      for (const { column, field: rawField } of columns) {
        const { field, ownedClear } = this.effectiveField_abyssPrivate(project, rawField);
        const cell = {
          identity: {
            occurrenceId: key,
            projectPath: project.path,
            groupKey: group.key,
            columnId: column.id,
          },
          project,
          field,
          ownedClear,
        };
        this.tableLogicalCells_abyssPrivate.push(cell);
        this.tableCellIndex_abyssPrivate.set(`${key}\u0000${column.id}`, cell);
      }
    }
  }

  private tableViewportHeight_abyssPrivate(): number {
    const height = this.scroll_abyssPrivate.clientHeight;
    const header = this.table_abyssPrivate?.tHead?.getBoundingClientRect().height ?? 0;
    const headerHeight = Number.isFinite(header) ? header : 0;
    return height > 0 ? Math.max(1, height - headerHeight) : 0;
  }

  private readonly renderTableWindow_abyssPrivate = (): void => {
    const body = this.body_abyssPrivate;
    const model = this.tableModel_abyssPrivate;
    if (
      !this.mounted_abyssPrivate ||
      this.overviewMode_abyssPrivate !== 'table' ||
      body === undefined ||
      model === undefined
    )
      return;
    const pinned = this.pinnedTableRows_abyssPrivate();
    let top = this.scroll_abyssPrivate.scrollTop;
    // One measured correction pass fills newly exposed rows without scheduling a work queue.
    for (let pass = 0; pass < 2; pass++) {
      const window = this.tableViewport_abyssPrivate.window(
        top,
        this.tableViewportHeight_abyssPrivate(),
        pinned,
      );
      this.scroll_abyssPrivate.scrollTop = window.scrollTop;
      const mounted = this.reconcileTableWindow_abyssPrivate(body, model, window.segments);
      this.scroll_abyssPrivate.scrollTop = window.scrollTop;
      const correction = this.tableViewport_abyssPrivate.measure(
        mounted.map(({ key, element }) => ({
          key,
          height: element.getBoundingClientRect().height,
        })),
        window.scrollTop,
      );
      if (!correction.changed) break;
      top = correction.scrollTop;
    }
    this.tableRowsDirty_abyssPrivate = false;
    this.patchSelection_abyssPrivate();
  };

  private reconcileTableWindow_abyssPrivate(
    body: HTMLTableSectionElement,
    model: ProjectTableModel,
    segments: ReturnType<ProjectTableViewport['window']>['segments'],
  ): Array<{ key: string; element: HTMLTableRowElement }> {
    const rows: ReconciledBodyRows = {
      desired: [],
      retainedProjects: new Set(),
      retainedGroups: new Set(),
      cells: [],
    };
    const mounted: Array<{ key: string; element: HTMLTableRowElement }> = [];
    const spacers = new Map<string, HTMLTableRowElement>();
    for (const [index, segment] of segments.entries()) {
      if ('height' in segment) {
        const key = this.tableSpacerKey_abyssPrivate(segments[index + 1]);
        const spacer = this.reconcileTableSpacer_abyssPrivate(body, key, segment.height);
        spacers.set(key, spacer);
        rows.desired.push(spacer);
        continue;
      }
      const item = this.tableRows_abyssPrivate[segment.index];
      if (item === undefined) continue;
      const element = this.mountTableRow_abyssPrivate(body, item, model, rows);
      mounted.push({ key: item.key, element });
    }
    if (model.groups.length === 0) {
      const row = body.createEl('tr');
      row.createEl('td', {
        cls: 'abyss-projects-empty',
        text: this.projects_abyssPrivate.length === 0 ? 'No projects yet' : 'No matching projects',
        attr: { colspan: String(Math.max(1, this.visibleColumns_abyssPrivate.length)) },
      });
      rows.desired.push(row);
    }
    this.removeMissingRows_abyssPrivate(rows.retainedProjects, rows.retainedGroups);
    this.reconcileRowOrder_abyssPrivate(body, rows.desired);
    this.tableSpacers_abyssPrivate = spacers;
    this.tableRenderedCells_abyssPrivate = rows.cells;

    return mounted;
  }

  private tableSpacerKey_abyssPrivate(
    next: ReturnType<ProjectTableViewport['window']>['segments'][number] | undefined,
  ): string {
    // A gap stays immediately before the same logical row; the empty key is the trailing gap.
    return next !== undefined && 'index' in next
      ? (this.tableRows_abyssPrivate[next.index]?.key ?? '')
      : '';
  }

  private reconcileTableSpacer_abyssPrivate(
    body: HTMLTableSectionElement,
    key: string,
    height: number,
  ): HTMLTableRowElement {
    const row =
      this.tableSpacers_abyssPrivate.get(key) ??
      body.createEl('tr', {
        cls: 'abyss-project-table-spacer',
        attr: { 'aria-hidden': 'true' },
      });
    const cell = row.cells[0] ?? row.createEl('td');
    const columnCount = Math.max(1, this.visibleColumns_abyssPrivate.length);
    if (cell.colSpan !== columnCount) cell.colSpan = columnCount;
    const heightStyle = `${height}px`;
    if (cell.style.height !== heightStyle) cell.style.height = heightStyle;
    return row;
  }

  private pinnedTableRows_abyssPrivate(): string[] {
    const pinned: string[] = [];
    if (this.activeRowDrag_abyssPrivate !== undefined)
      pinned.push(this.activeRowDrag_abyssPrivate.occurrenceId);
    for (const [key, row] of this.renderedProjectRows_abyssPrivate) {
      if (row.element.querySelector('.is-editor-anchor, .is-editing') !== null) pinned.push(key);
    }
    return pinned;
  }

  private mountTableRow_abyssPrivate(
    body: HTMLTableSectionElement,
    item: TableModelRow,
    model: ProjectTableModel,
    rows: ReconciledBodyRows,
  ): HTMLTableRowElement {
    const { project, group } = item;
    const columns = this.visibleColumns_abyssPrivate;
    let element: HTMLTableRowElement;
    if (project === undefined) {
      rows.retainedGroups.add(group.key);
      const existing = this.renderedGroupRows_abyssPrivate.get(group.key);
      element =
        existing !== undefined && !this.tableRowsDirty_abyssPrivate
          ? existing.element
          : this.reconcileGroupRow_abyssPrivate({
              body,
              ...group,
              count: group.projects.length,
              columnCount: columns.length,
              statuses: model.availableStatusGroups,
            });
    } else {
      const existing = this.renderedProjectRows_abyssPrivate.get(item.key);
      const row =
        existing !== undefined && !this.tableRowsDirty_abyssPrivate
          ? existing
          : this.reconcileProjectRow_abyssPrivate({
              body,
              project,
              columns,
              group,
              grouped: this.context_abyssPrivate.settings.projects.table.groupBy !== 'none',
            });
      rows.retainedProjects.add(item.key);
      element = row.element;
      rows.cells.push(...visibleRowCells(row, columns));
    }
    rows.desired.push(element);
    return element;
  }

  private restoreTablePosition_abyssPrivate(
    scrollTop: number,
    scrollLeft: number,
    focusedIdentity: FocusedCellIdentity | undefined,
  ): void {
    this.scroll_abyssPrivate.scrollTop = scrollTop;
    this.scroll_abyssPrivate.scrollLeft = scrollLeft;
    if (focusedIdentity?.occurrenceId === undefined || focusedIdentity.columnId === undefined)
      return;
    const restored = this.findOccurrenceCell_abyssPrivate(
      focusedIdentity.occurrenceId,
      focusedIdentity.columnId,
    );
    if (restored === null) this.scroll_abyssPrivate.focus({ preventScroll: true });
    else restored.focus({ preventScroll: true });
  }

  private reconcileGroupRow_abyssPrivate(options: RenderGroupOptions): HTMLTableRowElement {
    const { key, label, value, sourcePath, count, columnCount, statuses, presentation } = options;
    const rendered =
      this.renderedGroupRows_abyssPrivate.get(key) ?? this.createGroupRow_abyssPrivate(options);
    rendered.context = { key, label, value, ...(sourcePath === undefined ? {} : { sourcePath }) };
    patchElementAttribute(rendered.element, 'data-group-key', key);
    const colSpan = Math.max(1, columnCount);
    if (rendered.cell.colSpan !== colSpan) rendered.cell.colSpan = colSpan;
    patchElementAttribute(rendered.button, 'data-group-key', key);
    const collapsed = this.collapsedGroups_abyssPrivate.has(key);
    patchElementClass(rendered.element, 'is-collapsed', collapsed);
    patchElementAttribute(rendered.button, 'aria-expanded', String(!collapsed));
    const chevronIcon = collapsed ? 'chevron-right' : 'chevron-down';
    patchElementIcon(rendered.chevron, chevronIcon);
    const status = statuses.find((candidate) => candidate.key === key);
    const color = status?.color ?? presentation?.color;
    const signature = JSON.stringify([label, value, sourcePath, color, presentation?.display]);
    if (signature !== rendered.contentSignature)
      this.patchGroupContent_abyssPrivate(rendered, options, color, signature);
    patchElementText(rendered.count, String(count));
    return rendered.element;
  }

  private createGroupRow_abyssPrivate(options: RenderGroupOptions): RenderedGroupRow {
    const { body, key, label, value, sourcePath } = options;
    const row = body.createEl('tr', { cls: 'abyss-project-table-group-row' });
    const cell = row.createEl('td');
    const button = cell.createEl('button', {
      cls: 'abyss-project-table-group-toggle',
      attr: { type: 'button', 'data-group-key': key },
    });
    const rendered: RenderedGroupRow = {
      markdown: this.markdown_abyssPrivate.addChild(new Component()),
      element: row,
      cell,
      button,
      chevron: button.createSpan({ cls: 'abyss-project-table-group-chevron' }),
      statusDot: button.createSpan({ cls: 'abyss-status-dot' }),
      label: button.createSpan({ cls: 'abyss-projects-group-label' }),
      count: button.createSpan({ cls: 'abyss-projects-group-count' }),
      dropHint: button.createSpan({ cls: 'abyss-project-table-drop-hint' }),
      context: { key, label, value, ...(sourcePath === undefined ? {} : { sourcePath }) },
      contentSignature: '',
    };
    this.renderedGroupRows_abyssPrivate.set(key, rendered);
    this.bindGroupRow_abyssPrivate(rendered);
    return rendered;
  }

  private patchGroupContent_abyssPrivate(
    rendered: RenderedGroupRow,
    options: RenderGroupOptions,
    color: string | undefined,
    signature: string,
  ): void {
    rendered.contentSignature = signature;
    this.renderGroupContent_abyssPrivate(
      { marker: rendered.statusDot, host: rendered.label, component: rendered.markdown },
      options,
      color,
    );
  }

  private renderGroupContent_abyssPrivate(
    target: { marker: HTMLElement; host: HTMLElement; component: Component },
    group: Pick<ProjectTableGroup, 'key' | 'label' | 'value' | 'sourcePath' | 'presentation'>,
    color: string | undefined,
  ): void {
    const { marker, host, component } = target;
    const resolvedColor = this.groupColor_abyssPrivate(group.key, color);
    marker.hidden = resolvedColor === undefined && group.presentation?.display !== 'dot';
    marker.style.background = resolvedColor ?? '';
    host.empty();
    host.style.color = group.presentation?.display === 'text' ? (resolvedColor ?? '') : '';
    const { value, sourcePath, label } = group;
    if (typeof value !== 'string' || sourcePath === undefined || parseLinks(value).length === 0) {
      host.setText(label);
      return;
    }
    renderTaskText(host, value, {
      app: this.context_abyssPrivate.app,
      sourcePath,
      component,
      beforeOpenLink: () => this.requestFinishActiveEditor(),
      exactLinkLabel: exactGroupLinkLabel(value, label),
    });
  }

  private groupColor_abyssPrivate(key: string, fallback: string | undefined): string | undefined {
    return (
      this.context_abyssPrivate.settings.projects.statuses.find(({ id }) => key === `id:${id}`)
        ?.color ?? fallback
    );
  }

  private bindGroupRow_abyssPrivate(rendered: RenderedGroupRow): void {
    const { element: row, cell } = rendered;
    cell.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) return;
      const key = rendered.context.key;
      this.finishEditorBeforeAction(() => {
        if (this.collapsedGroups_abyssPrivate.has(key))
          this.collapsedGroups_abyssPrivate.delete(key);
        else this.collapsedGroups_abyssPrivate.add(key);
        this.renderTable_abyssPrivate();
      });
    });
    this.bindGroupDropTarget_abyssPrivate(row, () => rendered.context.key);
  }

  private bindGroupDropTarget_abyssPrivate(
    row: HTMLTableRowElement,
    groupKey: () => string,
  ): () => void {
    const previewDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      const preview = this.showGroupDropPreview_abyssPrivate(groupKey());
      event.dataTransfer.dropEffect = preview.allowed ? 'move' : 'none';
    };
    const leaveDropTarget = (event: DragEvent): void => {
      const related = event.relatedTarget;
      const ownerWindow = row.ownerDocument.defaultView;
      if (
        ownerWindow === null ||
        !(related instanceof ownerWindow.Element) ||
        related.closest<HTMLElement>('[data-group-key]')?.dataset['groupKey'] !== groupKey()
      ) {
        this.clearGroupDropStates_abyssPrivate();
      }
    };
    const drop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes(PROJECT_TABLE_ROW_DRAG_TYPE) !== true) return;
      event.preventDefault();
      this.clearGroupDropStates_abyssPrivate();
      this.dropProjectIntoGroup_abyssPrivate(event.dataTransfer, groupKey());
    };
    row.addEventListener('dragenter', previewDrop);
    row.addEventListener('dragover', previewDrop);
    row.addEventListener('dragleave', leaveDropTarget);
    row.addEventListener('drop', drop);
    return () => {
      this.clearGroupDropStates_abyssPrivate();
      row.removeEventListener('dragenter', previewDrop);
      row.removeEventListener('dragover', previewDrop);
      row.removeEventListener('dragleave', leaveDropTarget);
      row.removeEventListener('drop', drop);
    };
  }

  private removeMissingRows_abyssPrivate(
    retainedProjects: ReadonlySet<string>,
    retainedGroups: ReadonlySet<string>,
  ): void {
    for (const [key, rendered] of this.renderedProjectRows_abyssPrivate) {
      if (retainedProjects.has(key)) continue;
      rendered.dragCleanup?.();
      this.markdown_abyssPrivate.removeChild(rendered.markdown);
      rendered.element.remove();
      this.renderedProjectRows_abyssPrivate.delete(key);
    }
    for (const [key, rendered] of this.renderedGroupRows_abyssPrivate) {
      if (retainedGroups.has(key)) continue;
      this.markdown_abyssPrivate.removeChild(rendered.markdown);
      rendered.element.remove();
      this.renderedGroupRows_abyssPrivate.delete(key);
    }
  }

  private reconcileRowOrder_abyssPrivate(
    body: HTMLTableSectionElement,
    desired: readonly HTMLTableRowElement[],
  ): void {
    // Remove obsolete gaps before ordering so retained rows never move around stale cursors.
    // Moving a focused/editor/drag row, even within this body, triggers native blur/drag teardown.
    const retained = new Set<Node>(desired);
    for (const child of Array.from(body.childNodes)) {
      if (!retained.has(child)) child.remove();
    }
    let cursor = body.firstChild;
    for (const row of desired) {
      if (row === cursor) cursor = cursor.nextSibling;
      else body.insertBefore(row, cursor);
    }
  }

  private applyTableWidth_abyssPrivate(
    availableWidth = this.scroll_abyssPrivate.clientWidth,
  ): void {
    const table = this.table_abyssPrivate;
    if (table === undefined) return;
    const widths = this.visibleColumns_abyssPrivate.map(({ column, field }) =>
      projectTableColumnWidth(column, field),
    );
    const configuredWidth = widths.reduce((total, width) => total + width, 0);
    const spare = Math.max(0, availableWidth - configuredWidth);
    const cols = new Map(
      Array.from(table.querySelectorAll<HTMLElement>('col[data-column-id]'), (col) => [
        col.dataset['columnId'],
        col,
      ]),
    );
    for (const [index, { column }] of this.visibleColumns_abyssPrivate.entries()) {
      const col = cols.get(column.id);
      const width = `${(widths[index] ?? 150) + (column.id === 'name' ? spare : 0)}px`;
      if (col !== undefined && col.style.width !== width) col.style.width = width;
    }
    const renderedWidth = configuredWidth + spare;
    const width = `${renderedWidth}px`;
    if (table.style.width !== width) table.style.width = width;
    if (table.style.minWidth !== width) table.style.minWidth = width;
  }

  private focusedCellIdentity_abyssPrivate(): FocusedCellIdentity | undefined {
    const active = this.tableHost_abyssPrivate.ownerDocument.activeElement;
    const focusedCell = this.keydownCell_abyssPrivate(active);
    if (focusedCell === undefined) return undefined;
    return {
      occurrenceId: focusedCell.identity.occurrenceId,
      columnId: focusedCell.identity.columnId,
    };
  }

  private sortByColumn_abyssPrivate(field: string): void {
    this.transitionTableSort_abyssPrivate(field);
    this.persistAndRender_abyssPrivate();
  }

  private transitionTableSort_abyssPrivate(field: string): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    if (field === 'none') table.sortBy = { field: 'none', dir: 'asc' };
    else if (table.sortBy.field !== field) table.sortBy = { field, dir: 'asc' };
    else if (table.sortBy.dir === 'asc') table.sortBy = { field, dir: 'desc' };
    else table.sortBy = { field: 'none', dir: 'asc' };
  }

  private projectColumnTypeChoices_abyssPrivate(columnId: string): readonly ProjectPropertyType[] {
    if (this.context_abyssPrivate.saveStatic === undefined || !columnId.startsWith('property:')) {
      return [];
    }
    const property = columnId.slice('property:'.length);
    if (isReservedProjectProperty(this.context_abyssPrivate.settings.projects, property)) return [];
    const matches = Object.keys(
      this.context_abyssPrivate.settings.projects.propertyDefinitions,
    ).filter((candidate) => sameProjectPropertyName(candidate, columnId));
    return matches.length > 1 ? [] : projectPropertyTypeChoices(property);
  }

  private setProjectColumnType_abyssPrivate(columnId: string, type: ProjectPropertyType): void {
    const saveStatic = this.context_abyssPrivate.saveStatic;
    if (
      saveStatic === undefined ||
      !setProjectPropertyDefinitionType(this.context_abyssPrivate.settings.projects, columnId, type)
    ) {
      return;
    }
    this.refreshFields();
    saveSettingsDraft({ action: 'save project property type', save: saveStatic });
  }

  private renameColumn_abyssPrivate(columnId: string, label: string): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    if (setProjectColumnLabel(table, columnId, label)) this.persistAndRender_abyssPrivate();
  }

  private moveColumn_abyssPrivate(
    columnId: string,
    targetColumnId: string,
    placement: 'before' | 'after',
  ): void {
    const columns = this.context_abyssPrivate.settings.projects.table.columns;
    const from = columns.findIndex(({ id }) => id === columnId);
    const to = columns.findIndex(({ id }) => id === targetColumnId);
    if (from <= 0 || to <= 0 || from === to) return;
    const moved = columns.splice(from, 1)[0];
    if (moved === undefined) return;
    const target = columns.findIndex(({ id }) => id === targetColumnId);
    columns.splice(placement === 'after' ? target + 1 : target, 0, moved);
    this.persistAndRender_abyssPrivate();
  }

  private resizeColumns_abyssPrivate(resize: ProjectTableColumnResize): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    let changed = false;
    for (const { columnId, width } of resize.visibleWidths) {
      changed =
        setProjectColumnWidth(
          table,
          columnId,
          columnId === resize.columnId ? resize.width : width,
        ) || changed;
    }
    if (changed) this.persistAndRender_abyssPrivate();
  }

  private updateResponsiveNamePinning_abyssPrivate(
    available = this.scroll_abyssPrivate.clientWidth,
  ): void {
    const nameColumn = this.tableHost_abyssPrivate.querySelector<HTMLElement>(
      'col[data-column-id="name"]',
    );
    const width = nameColumn === null ? 0 : Number.parseFloat(nameColumn.style.width);
    const shouldUnpin = available > 0 && Number.isFinite(width) && available - width < 160;
    this.root_abyssPrivate.toggleClass('is-name-unpinned', shouldUnpin);
  }

  private reconcileProjectRow_abyssPrivate(options: RenderProjectRowOptions): RenderedProjectRow {
    const { project, group, grouped } = options;
    const occurrenceId = `${encodeURIComponent(group.key)}:${encodeURIComponent(project.path)}`;
    const renderedRow =
      this.renderedProjectRows_abyssPrivate.get(occurrenceId) ??
      this.createProjectRow_abyssPrivate(options.body, project, group.key, occurrenceId);
    renderedRow.project = project;
    renderedRow.groupKey = group.key;
    renderedRow.occurrenceId = occurrenceId;
    const row = renderedRow.element;
    patchElementAttribute(row, 'data-project-path', project.path);
    patchElementAttribute(row, 'data-occurrence-id', occurrenceId);
    patchElementAttribute(row, 'data-group-key', group.key);
    if (row.draggable !== grouped) row.draggable = grouped;
    this.reconcileProjectCells_abyssPrivate(renderedRow, options, occurrenceId);
    return renderedRow;
  }

  private createProjectRow_abyssPrivate(
    body: HTMLTableSectionElement,
    project: Project,
    groupKey: string,
    occurrenceId: string,
  ): RenderedProjectRow {
    const rendered: RenderedProjectRow = {
      markdown: this.markdown_abyssPrivate.addChild(new Component()),
      element: body.createEl('tr', { cls: 'abyss-project-table-row' }),
      cells: new Map(),
      project,
      groupKey,
      occurrenceId,
    };
    this.renderedProjectRows_abyssPrivate.set(occurrenceId, rendered);
    rendered.dragCleanup = this.bindProjectRowDrag_abyssPrivate(rendered);
    return rendered;
  }

  private reconcileProjectCells_abyssPrivate(
    row: RenderedProjectRow,
    options: RenderProjectRowOptions,
    occurrenceId: string,
  ): void {
    const { project, columns, group, grouped } = options;
    const desiredCells: HTMLElement[] = [];
    const retainedColumns = new Set<string>();
    for (const { column, field: rawField } of columns) {
      retainedColumns.add(column.id);
      const rendered = this.reconcileProjectCell_abyssPrivate({
        row,
        project,
        field: rawField,
        columnId: column.id,
        occurrenceId,
        groupKey: group.key,
        grouped,
      });
      desiredCells.push(rendered.element);
    }
    for (const [columnId, cell] of row.cells) {
      if (retainedColumns.has(columnId)) continue;
      cell.element.remove();
      row.cells.delete(columnId);
    }
    let cursor = row.element.firstChild;
    for (const cell of desiredCells) {
      if (cell === cursor) cursor = cursor.nextSibling;
      else row.element.insertBefore(cell, cursor);
    }
  }

  private reconcileProjectCell_abyssPrivate(
    options: ReconcileProjectCellOptions,
  ): RenderedCellContext {
    const { row, project, field: rawField, columnId, occurrenceId, groupKey, grouped } = options;
    const { field, ownedClear } = this.effectiveField_abyssPrivate(project, rawField);
    let rendered = row.cells.get(columnId);
    if (rendered === undefined) {
      rendered = {
        identity: { occurrenceId, projectPath: project.path, groupKey, columnId },
        project,
        field,
        ownedClear,
        markdown: row.markdown,
        element: row.element.createEl('td'),
        contentSignature: '',
      };
      row.cells.set(columnId, rendered);
      this.decorateProjectCell_abyssPrivate(rendered);
    }
    rendered.identity = { occurrenceId, projectPath: project.path, groupKey, columnId };
    rendered.project = project;
    rendered.field = field;
    rendered.ownedClear = ownedClear;
    if (!rendered.element.classList.contains('is-editing'))
      this.patchProjectCell_abyssPrivate(rendered, grouped);
    return rendered;
  }

  private patchProjectCell_abyssPrivate(rendered: RenderedCellContext, grouped: boolean): void {
    const { element: cell, field } = rendered;
    const invalidRange = this.patchProjectCellAttributes_abyssPrivate(rendered);
    const contentSignature = this.projectCellContentSignature_abyssPrivate(
      rendered,
      grouped,
      invalidRange,
    );
    if (contentSignature === rendered.contentSignature) return;
    rendered.contentSignature = contentSignature;
    cell.empty();
    const content =
      field.type === 'name' ? cell.createDiv({ cls: 'abyss-project-table-name-content' }) : cell;
    this.renderProjectCellContent_abyssPrivate(content, rendered, {});
    if (invalidRange) {
      cell.createSpan({
        cls: 'abyss-project-table-range-warning',
        text: '!',
        attr: { 'aria-label': 'Invalid date range' },
      });
    }
  }

  private patchProjectCellAttributes_abyssPrivate(rendered: RenderedCellContext): boolean {
    const { element: cell, project, field } = rendered;
    const alignment =
      this.context_abyssPrivate.settings.projects.table.columns.find(
        ({ id }) => id === rendered.identity.columnId,
      )?.alignment ?? 'left';
    patchElementClass(cell, 'abyss-project-table-cell', true);
    for (const option of ['left', 'center', 'right']) {
      patchElementClass(cell, `is-align-${option}`, alignment === option);
    }
    patchElementClass(cell, 'abyss-project-table-name-cell', field.type === 'name');
    patchElementAttribute(cell, 'tabindex', '0');
    patchElementAttribute(cell, 'data-column-id', rendered.identity.columnId);
    patchElementAttribute(cell, 'aria-label', `${field.label} for ${project.name}`);
    patchElementAttribute(
      cell,
      'aria-description',
      field.type === 'name' ? 'Use the context menu to add or edit the description' : undefined,
    );
    patchElementAttribute(
      cell,
      'aria-keyshortcuts',
      field.type === 'name' ? 'Shift+F10' : undefined,
    );
    const invalidRange =
      (field.id === 'start' || field.id === 'end') &&
      this.projectHasInvalidRange_abyssPrivate(project);
    patchElementClass(cell, 'is-invalid-range', invalidRange);
    if (invalidRange) {
      patchElementAttribute(cell, 'aria-invalid', 'true');
      patchElementAttribute(cell, 'title', 'Project start is after its end date');
    } else {
      patchElementAttribute(cell, 'aria-invalid', undefined);
      patchElementAttribute(cell, 'title', undefined);
    }
    patchElementClass(cell, 'is-editable', editableField(field));
    return invalidRange;
  }

  private projectCellContentSignature_abyssPrivate(
    rendered: RenderedCellContext,
    grouped: boolean,
    invalidRange: boolean,
  ): string {
    const { project, field } = rendered;
    const descriptionField =
      field.type === 'name'
        ? findProjectFieldById(this.fields_abyssPrivate, 'description')
        : undefined;
    return JSON.stringify({
      field,
      value: projectFieldValue(project, field),
      name: project.name,
      path: project.path,
      statusId: project.statusId,
      rawStatus: project.rawStatus,
      stats: field.type === 'progress' ? project.stats : undefined,
      tracked:
        field.type === 'tracked'
          ? projectTrackedDisplayValue(project.stats, this.trackedNowMs_abyssPrivate)
          : undefined,
      progressDisplay:
        field.type === 'progress'
          ? (this.context_abyssPrivate.settings.projects.table.progress ?? 'full')
          : undefined,
      statuses:
        field.type === 'status' ? this.context_abyssPrivate.settings.projects.statuses : undefined,
      definition: this.projectPropertyDefinition_abyssPrivate(field.id),
      invalidRange,
      ownedClear: rendered.ownedClear,
      grouped,
      dateDisplay:
        field.type === 'date' || field.type === 'datetime'
          ? effectiveProjectTableDateDisplay(
              this.context_abyssPrivate.settings.projects.table,
              this.context_abyssPrivate.settings.projects.table.columns.find(
                ({ id }) => id === rendered.identity.columnId,
              ),
            )
          : undefined,
      description:
        descriptionField === undefined
          ? undefined
          : {
              field: descriptionField,
              value: projectFieldValue(project, descriptionField),
              show: this.context_abyssPrivate.settings.projects.table.showDescription,
            },
    });
  }

  private cellMarkdown_abyssPrivate(rendered: RenderedCellContext): Component {
    return rendered.markdown ?? this.markdown_abyssPrivate;
  }

  private renderProjectCellContent_abyssPrivate(
    content: HTMLElement,
    rendered: RenderedCellContext,
    options: RenderProjectCellContentOptions,
  ): void {
    const { preferredColumn, showNameDescription, presentation = 'table' } = options;
    const includeNameDescription = showNameDescription ?? true;
    const descriptionField = findProjectFieldById(this.fields_abyssPrivate, 'description');
    const effectiveDescription =
      descriptionField === undefined
        ? undefined
        : this.effectiveField_abyssPrivate(rendered.project, descriptionField);
    const compiledPresets = this.compiledPresets_abyssPrivate.get(rendered.field.id);
    const column =
      preferredColumn ??
      this.context_abyssPrivate.settings.projects.table.columns.find(
        ({ id }) => id === rendered.identity.columnId,
      );
    const cellPresentation = this.projectCellPresentation_abyssPrivate(column, presentation);
    renderProjectTableCell(content, rendered.project, {
      field: rendered.field,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      ...(compiledPresets === undefined ? {} : { compiledPresets }),
      app: this.context_abyssPrivate.app,
      component: this.cellMarkdown_abyssPrivate(rendered),
      beforeOpenLink: () => this.requestFinishActiveEditor(),
      openProject: (path) => {
        this.finishEditorBeforeAction(() => {
          this.context_abyssPrivate.openProject(path);
        });
      },
      onRemoveListValue: (valueIndex) => {
        this.requestRemoveListValue_abyssPrivate(
          rendered.project,
          rendered.field,
          rendered.ownedClear,
          valueIndex,
        );
      },
      onToggleCheckbox: (value, input) => {
        this.requestToggleCheckbox_abyssPrivate(rendered, value, input);
      },
      ...cellPresentation,
      now: new Date(),
      trackedNowMs: this.trackedNowMs_abyssPrivate,
      locale: moment.locale(),
      ...(rendered.field.type !== 'name' ||
      effectiveDescription === undefined ||
      !includeNameDescription
        ? {}
        : {
            description: {
              field: effectiveDescription.field,
              show:
                showNameDescription === true ||
                this.context_abyssPrivate.settings.projects.table.showDescription,
              preserveNewlines: presentation === 'timeline',
            },
          }),
    });
  }

  private projectCellPresentation_abyssPrivate(
    column: ProjectColumn | undefined,
    presentation: ProjectOverviewMode,
  ): ProjectCellPresentation {
    if (presentation === 'kanban') return { dateDisplay: column?.dateDisplay ?? 'pretty' };
    if (presentation === 'timeline') {
      const progress = this.ensureTimelineSettings_abyssPrivate().progress;
      return {
        dateDisplay: column?.dateDisplay ?? 'pretty',
        ...(progress === 'hidden' ? {} : { progressDisplay: progress }),
      };
    }
    const table = this.context_abyssPrivate.settings.projects.table;
    return {
      dateDisplay: effectiveProjectTableDateDisplay(table, column),
      progressDisplay: table.progress ?? 'full',
    };
  }

  private readonly refreshRelativeDates_abyssPrivate = (): void => {
    const ownerDocument = this.root_abyssPrivate.ownerDocument;
    if (
      !this.mounted_abyssPrivate ||
      !this.root_abyssPrivate.isConnected ||
      !this.root_abyssPrivate.isShown() ||
      ownerDocument.visibilityState === 'hidden'
    ) {
      return;
    }
    const now = new Date();
    const locale = moment.locale();
    for (const text of this.root_abyssPrivate.querySelectorAll<HTMLElement>(
      '.abyss-project-relative-date',
    )) {
      const raw = text.dataset['relativeDateValue'];
      const displayed = formatProjectRelativeDate(raw, now, locale);
      if (displayed !== undefined) text.setText(displayed);
    }
  };

  private syncRelativeDateTimer_abyssPrivate(
    columns: readonly VisibleProjectColumn[],
    globalDisplay?: ProjectDateDisplay,
  ): void {
    const needed = columns.some(
      ({ column, field }) =>
        (globalDisplay ?? column.dateDisplay ?? 'pretty') === 'relative' &&
        (field.type === 'date' || field.type === 'datetime'),
    );
    if (!needed) {
      this.stopRelativeDateTimer_abyssPrivate();
      return;
    }
    this.relativeDateInterval_abyssPrivate ??= this.ownerWindow_abyssPrivate?.setInterval(
      this.refreshRelativeDates_abyssPrivate,
      60_000,
    );
    this.refreshRelativeDates_abyssPrivate();
  }

  private stopRelativeDateTimer_abyssPrivate(): void {
    if (this.relativeDateInterval_abyssPrivate === undefined) return;
    this.ownerWindow_abyssPrivate?.clearInterval(this.relativeDateInterval_abyssPrivate);
    this.relativeDateInterval_abyssPrivate = undefined;
  }

  private editDescription_abyssPrivate(
    rendered: RenderedCellContext,
    field: ProjectFieldCatalogItem,
    ownedClear: OwnedInferredPropertyClear | undefined,
    preferredAnchor?: HTMLElement,
  ): void {
    this.finishEditorBeforeAction(() => {
      if (!editableField(field)) return;
      const anchor =
        preferredAnchor?.isConnected === true
          ? preferredAnchor
          : (rendered.element.querySelector<HTMLElement>('.abyss-project-description') ??
            rendered.element
              .querySelector<HTMLElement>('.abyss-project-table-name-content')
              ?.createDiv({
                cls: 'abyss-project-description abyss-project-description-editor-anchor',
              }));
      if (anchor === undefined) return;
      this.selectCell_abyssPrivate(rendered, false);
      this.editCell_abyssPrivate(rendered.element, rendered.project, field, { ownedClear, anchor });
    });
  }

  private showDescriptionMenu_abyssPrivate(
    rendered: RenderedCellContext,
    event: MouseEvent | KeyboardEvent,
  ): boolean {
    if (rendered.field.type !== 'name') return false;
    const menu = new Menu();
    const descriptionAdded = this.addDescriptionMenuItem_abyssPrivate(menu, rendered);
    if (!descriptionAdded) return false;
    this.showCellMenu_abyssPrivate(menu, rendered, event);
    return true;
  }

  private addDescriptionMenuItem_abyssPrivate(menu: Menu, rendered: RenderedCellContext): boolean {
    const description = findProjectFieldById(this.fields_abyssPrivate, 'description');
    if (description === undefined) return false;
    const effective = this.effectiveField_abyssPrivate(rendered.project, description);
    if (!editableField(effective.field)) return false;
    const value = projectFieldValue(rendered.project, effective.field);
    const hasDescription = typeof value === 'string' && value.length > 0;
    menu.addItem((item) => {
      item
        .setTitle(hasDescription ? 'Edit description' : 'Add description')
        .setIcon('pencil')
        .onClick(() => {
          this.editDescription_abyssPrivate(rendered, effective.field, effective.ownedClear);
        });
    });
    return true;
  }

  private showCellMenu_abyssPrivate(
    menu: Menu,
    rendered: RenderedCellContext,
    event: MouseEvent | KeyboardEvent,
  ): void {
    this.nativeMenuOpen_abyssPrivate = true;
    this.syncSelection_abyssPrivate();
    menu.onHide(() => {
      this.nativeMenuOpen_abyssPrivate = false;
      const active = rendered.element.ownerDocument.activeElement;
      if (
        active === rendered.element.ownerDocument.body ||
        (active instanceof HTMLElement && active.contains(this.root_abyssPrivate))
      ) {
        this.focusSelectionCell_abyssPrivate(rendered.identity);
      } else {
        this.syncSelection_abyssPrivate();
      }
    });
    if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
    else {
      const bounds = rendered.element.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left + 8, y: bounds.bottom }, rendered.element.ownerDocument);
    }
  }

  private requestToggleCheckbox_abyssPrivate(
    rendered: RenderedCellContext,
    value: boolean,
    input: HTMLInputElement,
  ): void {
    const { project, field, ownedClear } = rendered;
    const current = projectFieldValue(project, field);
    const restore = (): void => {
      input.checked = current === true;
      input.indeterminate = false;
      input.dataset['indeterminate'] = String(current !== true && current !== false);
    };
    if (this.activeEditor_abyssPrivate !== undefined) restore();
    this.finishEditorBeforeAction(() => {
      if (!editableField(field) || field.type !== 'checkbox') {
        restore();
        return;
      }
      const state = projectCellEditorState(
        project,
        field,
        this.context_abyssPrivate.settings,
        ownedClear,
      );
      void this.applyCellEdit_abyssPrivate({
        project,
        field,
        value,
        expectedValue: state.expectedValue,
        expectedExists: state.expectedExists,
        sourceProperty: state.sourceProperty,
        sourceKey: state.sourceKey,
        ownedClear: state.ownedClear,
      }).catch((error: unknown) => {
        restore();
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(`Could not update ${field.label}: ${message}`);
        if (isProjectEditValidationError(error)) return;
        console.error('[abyss-tasks] Could not update project checkbox property', {
          property: field.property,
          cause: error,
        });
        new Notice(`Could not update ${field.label}: ${message}`);
      });
    });
  }

  private decorateProjectCell_abyssPrivate(rendered: RenderedCellContext): void {
    const cell = rendered.element;
    cell.addEventListener('click', (event) => {
      if (!this.isCellActionTarget_abyssPrivate(event.target, cell)) {
        this.selectCell_abyssPrivate(rendered, event.shiftKey);
      }
    });
    cell.addEventListener('focus', () => {
      if (!this.sameCell_abyssPrivate(this.selection_abyssPrivate.focus, rendered.identity))
        this.selectCell_abyssPrivate(rendered, false);
      else this.syncSelection_abyssPrivate();
    });
    cell.addEventListener('dblclick', (event) => {
      if (
        !editableField(rendered.field) ||
        this.isCellActionTarget_abyssPrivate(event.target, cell)
      )
        return;
      event.preventDefault();
      this.selectCell_abyssPrivate(rendered, false);
      this.editCell_abyssPrivate(cell, rendered.project, rendered.field, {
        ownedClear: rendered.ownedClear,
      });
    });
    cell.addEventListener('contextmenu', (event) => {
      const field = rendered.field;
      if (
        event.target instanceof Element &&
        event.target.closest('.abyss-project-cell-editor') !== null
      )
        return;
      if (field.type === 'name') {
        const description = findProjectFieldById(this.fields_abyssPrivate, 'description');
        if (description === undefined) return;
        const effective = this.effectiveField_abyssPrivate(rendered.project, description);
        if (!editableField(effective.field)) return;
        event.preventDefault();
        event.stopPropagation();
        this.editDescription_abyssPrivate(rendered, effective.field, effective.ownedClear);
        return;
      }
      if (!editableField(field)) return;
      event.preventDefault();
      event.stopPropagation();
      const active = this.activeEditor_abyssPrivate;
      if (active?.projectPath === rendered.project.path && active.columnId === rendered.field.id)
        return;
      this.finishEditorBeforeAction(() => {
        this.selectCell_abyssPrivate(rendered, false);
        this.editCell_abyssPrivate(cell, rendered.project, field, {
          ownedClear: rendered.ownedClear,
        });
      });
    });
  }

  private selectableCells_abyssPrivate(): ProjectTableSelectableCell[] {
    return this.overviewMode_abyssPrivate === 'table'
      ? this.tableSelectableCells_abyssPrivate
      : this.renderedCells_abyssPrivate.map(({ identity }) => identity);
  }

  private renderedCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
  ): RenderedCellContext | undefined {
    return this.renderedCells_abyssPrivate.find(
      ({ identity: candidate }) =>
        candidate.occurrenceId === identity.occurrenceId &&
        candidate.columnId === identity.columnId,
    );
  }

  private logicalCells_abyssPrivate(): readonly LogicalCellContext[] {
    return this.overviewMode_abyssPrivate === 'table'
      ? this.tableLogicalCells_abyssPrivate
      : this.renderedCells_abyssPrivate;
  }

  private logicalCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
  ): LogicalCellContext | undefined {
    return this.overviewMode_abyssPrivate === 'table'
      ? this.tableCellIndex_abyssPrivate.get(`${identity.occurrenceId}\u0000${identity.columnId}`)
      : this.renderedCell_abyssPrivate(identity);
  }

  private selectedCells_abyssPrivate(): LogicalCellContext[] {
    return this.selection_abyssPrivate
      .selected(this.selectableCells_abyssPrivate())
      .flatMap((identity) => {
        const cell = this.logicalCell_abyssPrivate(identity);
        return cell === undefined ? [] : [cell];
      });
  }

  private selectCell_abyssPrivate(cell: RenderedCellContext, extend: boolean): void {
    this.selection_abyssPrivate.select(cell.identity, this.selectableCells_abyssPrivate(), extend);
    cell.element.focus({ preventScroll: true });
    this.syncSelection_abyssPrivate();
  }

  private readonly handleOverviewBackgroundClick_abyssPrivate = (event: MouseEvent): void => {
    const ownerWindow = this.root_abyssPrivate.ownerDocument.defaultView;
    const target = event.target as Node | null;
    if (ownerWindow === null || target?.instanceOf(ownerWindow.Element) !== true) return;
    if (
      !target.matches(
        [
          '.abyss-project-table-scroll',
          '.abyss-project-table-host',
          '.abyss-project-kanban-scroll',
          '.abyss-project-kanban-column-body',
          '.abyss-project-kanban-group-body',
          '.abyss-project-timeline-scroll',
          '.abyss-project-timeline-groups',
          '.abyss-project-timeline-group-body',
        ].join(', '),
      )
    )
      return;
    this.finishEditorBeforeAction(() => {
      this.selection_abyssPrivate.clear();
      this.syncSelection_abyssPrivate();
      this.overviewFocusSurface_abyssPrivate().focus({ preventScroll: true });
    });
  };

  private overviewFocusSurface_abyssPrivate(): HTMLElement {
    if (this.overviewMode_abyssPrivate === 'kanban') {
      return this.kanbanView_abyssPrivate?.scroll ?? this.scroll_abyssPrivate;
    }
    if (this.overviewMode_abyssPrivate === 'timeline') {
      return this.timelineView_abyssPrivate?.scroll ?? this.scroll_abyssPrivate;
    }
    return this.scroll_abyssPrivate;
  }

  private focusSelectionCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
    reveal = true,
  ): void {
    if (reveal) this.revealLogicalCell_abyssPrivate(identity);
    const rendered = this.renderedCell_abyssPrivate(identity);
    if (rendered === undefined) return;
    rendered.element.focus({ preventScroll: true });
    this.syncSelection_abyssPrivate();
    if (reveal) this.revealSelectionCell_abyssPrivate(rendered.element);
  }

  private syncSelection_abyssPrivate(): void {
    this.selectedKeys_abyssPrivate = new Set(
      this.selection_abyssPrivate
        .selected(this.selectableCells_abyssPrivate())
        .map(({ occurrenceId, columnId }) => `${occurrenceId}\u0000${columnId}`),
    );
    this.patchSelection_abyssPrivate();
  }

  private patchSelection_abyssPrivate(): void {
    const selected = this.selectedKeys_abyssPrivate;
    const focus = this.selection_abyssPrivate.focus;
    this.syncOverviewSelectedProject_abyssPrivate(focus);
    const active = this.tableHost_abyssPrivate.ownerDocument.activeElement;
    for (const cell of this.renderedCells_abyssPrivate) {
      const key = `${cell.identity.occurrenceId}\u0000${cell.identity.columnId}`;
      patchElementClass(cell.element, 'is-selected', selected.has(key));
      patchElementClass(
        cell.element,
        'is-selection-focus',
        focus?.occurrenceId === cell.identity.occurrenceId &&
          focus.columnId === cell.identity.columnId &&
          active === cell.element &&
          !this.nativeMenuOpen_abyssPrivate,
      );
      patchElementAttribute(cell.element, 'aria-selected', String(selected.has(key)));
    }
  }

  private syncOverviewSelectedProject_abyssPrivate(
    focus: ProjectTableSelectableCell | undefined,
  ): void {
    if (this.overviewMode_abyssPrivate === 'table') return;
    const path =
      focus === undefined ? undefined : this.renderedCell_abyssPrivate(focus)?.project.path;
    if (this.overviewMode_abyssPrivate === 'kanban') {
      this.kanbanView_abyssPrivate?.syncSelectedProjectPath(path);
    } else {
      this.timelineView_abyssPrivate?.syncSelectedProjectPath(path);
    }
  }

  private isCellActionTarget_abyssPrivate(target: EventTarget | null, cell: HTMLElement): boolean {
    if (!(target instanceof Element) || target === cell) return false;
    return (
      target.closest(
        'a, button, input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor',
      ) !== null
    );
  }

  private isTextEditingTarget_abyssPrivate(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return (
      target.closest(
        'input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor',
      ) !== null
    );
  }

  private readonly handleOwnerWindowKeydown_abyssPrivate = (event: KeyboardEvent): void => {
    if (!this.isOwnerWindowF2_abyssPrivate(event)) return;
    const cell = this.keydownCell_abyssPrivate(event.target);
    if (cell === undefined || !editableField(cell.field)) return;
    const selected = this.selection_abyssPrivate.focus;
    if (
      selected !== undefined &&
      (selected.occurrenceId !== cell.identity.occurrenceId ||
        selected.columnId !== cell.identity.columnId)
    )
      return;
    this.handleTableKeydown_abyssPrivate(event);
    if (event.defaultPrevented) event.stopPropagation();
  };

  private listenForOwnerWindowF2_abyssPrivate(): void {
    this.ownerWindow_abyssPrivate?.addEventListener(
      'keydown',
      this.handleOwnerWindowKeydown_abyssPrivate,
      true,
    );
  }

  private isOwnerWindowF2_abyssPrivate(event: KeyboardEvent): boolean {
    return (
      this.mounted_abyssPrivate &&
      this.isUnmodifiedF2_abyssPrivate(event) &&
      !event.isComposing &&
      !this.isTextEditingTarget_abyssPrivate(event.target)
    );
  }

  private isUnmodifiedF2_abyssPrivate(event: KeyboardEvent): boolean {
    return (
      event.key === 'F2' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    );
  }

  private handleTableKeydown_abyssPrivate(event: KeyboardEvent): void {
    if (event.isComposing || this.isTextEditingTarget_abyssPrivate(event.target)) return;
    if (this.handleHistoryShortcut_abyssPrivate(event)) return;
    const modifier = event.metaKey || event.ctrlKey;
    const cell = this.keydownCell_abyssPrivate(event.target);
    if (cell === undefined) return;
    if (event.key === 'Enter' && this.isCellActionTarget_abyssPrivate(event.target, cell.element))
      return;
    this.ensureSelectionFocus_abyssPrivate(cell);
    if (this.handleSelectionModifier_abyssPrivate(event, modifier)) return;
    if (this.handleSelectionMovement_abyssPrivate(event)) return;
    this.handleSelectionAction_abyssPrivate(event, cell);
  }

  private keydownCell_abyssPrivate(target: EventTarget | null): RenderedCellContext | undefined {
    if (!(target instanceof Node)) return undefined;
    return this.renderedCells_abyssPrivate.find(
      ({ element }) => element === target || element.contains(target),
    );
  }

  private ensureSelectionFocus_abyssPrivate(cell: RenderedCellContext): void {
    if (!this.sameCell_abyssPrivate(this.selection_abyssPrivate.focus, cell.identity)) {
      this.selection_abyssPrivate.select(cell.identity, this.selectableCells_abyssPrivate(), false);
    }
  }

  private sameCell_abyssPrivate(
    left: ProjectTableSelectableCell | undefined,
    right: ProjectTableSelectableCell,
  ): boolean {
    return left?.occurrenceId === right.occurrenceId && left.columnId === right.columnId;
  }

  private readonly handleDocumentFocusIn_abyssPrivate = (event: FocusEvent): void => {
    if (event.target instanceof Node && !this.root_abyssPrivate.contains(event.target)) {
      this.creationInteractionRevision_abyssPrivate++;
      this.creationInteractionToken_abyssPrivate = undefined;
    }
    const cell = this.keydownCell_abyssPrivate(event.target);
    if (cell !== undefined && !this.isTextEditingTarget_abyssPrivate(event.target)) {
      if (!this.sameCell_abyssPrivate(this.selection_abyssPrivate.focus, cell.identity)) {
        this.selection_abyssPrivate.select(
          cell.identity,
          this.selectableCells_abyssPrivate(),
          false,
        );
      }
    }
    this.syncSelection_abyssPrivate();
  };

  private handleHistoryShortcut_abyssPrivate(event: KeyboardEvent): boolean {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      this.finishEditorBeforeAction(() => {
        this.runHistory_abyssPrivate(event.shiftKey ? 'redo' : 'undo');
      });
      return true;
    }
    return false;
  }

  private handleSelectionModifier_abyssPrivate(event: KeyboardEvent, modifier: boolean): boolean {
    if (modifier && event.key.toLocaleLowerCase() === 'a') {
      event.preventDefault();
      this.selection_abyssPrivate.selectCurrentGroup(this.selectableCells_abyssPrivate());
      this.syncSelection_abyssPrivate();
      return true;
    }
    return false;
  }

  private handleSelectionMovement_abyssPrivate(event: KeyboardEvent): boolean {
    const direction = selectionDirectionForKey(event.key);
    let next: ProjectTableSelectableCell | undefined;
    if (direction !== undefined) {
      event.preventDefault();
      next = this.selection_abyssPrivate.move(
        direction,
        this.selectableCells_abyssPrivate(),
        event.shiftKey,
      );
    } else if (event.key === 'Tab') {
      event.preventDefault();
      next = this.selection_abyssPrivate.tab(this.selectableCells_abyssPrivate(), event.shiftKey);
    } else {
      return false;
    }
    if (next === undefined) this.syncSelection_abyssPrivate();
    else this.focusSelectionCell_abyssPrivate(next);
    return true;
  }

  private revealLogicalCell_abyssPrivate(identity: ProjectTableSelectableCell): void {
    if (this.overviewMode_abyssPrivate !== 'table') return;
    this.scroll_abyssPrivate.scrollTop = this.tableViewport_abyssPrivate.reveal(
      identity.occurrenceId,
      this.scroll_abyssPrivate.scrollTop,
      this.tableViewportHeight_abyssPrivate(),
    );
    this.renderTableWindow_abyssPrivate();
  }

  private revealSelectionCell_abyssPrivate(cell: HTMLElement): void {
    const rendered = this.renderedCells_abyssPrivate.find(({ element }) => element === cell);
    if (rendered?.horizontalScroll !== undefined && rendered.verticalScroll !== undefined) {
      this.revealKanbanCell_abyssPrivate(cell, rendered);
      return;
    }
    const viewport = this.scroll_abyssPrivate.getBoundingClientRect();
    const target = cell.getBoundingClientRect();
    const header = this.tableHost_abyssPrivate.querySelector<HTMLElement>(
      '.abyss-project-table-header-cell',
    );
    const pinnedName = this.root_abyssPrivate.classList.contains('is-name-unpinned')
      ? null
      : this.tableHost_abyssPrivate.querySelector<HTMLElement>('.abyss-project-table-name-cell');
    const usableTop = Math.max(
      viewport.top,
      header?.getBoundingClientRect().bottom ?? viewport.top,
    );
    const usableLeft =
      pinnedName === null || cell.classList.contains('abyss-project-table-name-cell')
        ? viewport.left
        : Math.max(viewport.left, pinnedName.getBoundingClientRect().right);
    const horizontal = nearestViewportDelta(target.left, target.right, usableLeft, viewport.right);
    const vertical = nearestViewportDelta(target.top, target.bottom, usableTop, viewport.bottom);
    this.scroll_abyssPrivate.scrollLeft = Math.max(
      0,
      this.scroll_abyssPrivate.scrollLeft + horizontal,
    );
    this.scroll_abyssPrivate.scrollTop = Math.max(0, this.scroll_abyssPrivate.scrollTop + vertical);
  }

  private revealKanbanCell_abyssPrivate(cell: HTMLElement, rendered: RenderedCellContext): void {
    const horizontalScroll = rendered.horizontalScroll;
    const verticalScroll = rendered.verticalScroll;
    if (horizontalScroll === undefined || verticalScroll === undefined) return;
    const horizontalViewport = horizontalScroll.getBoundingClientRect();
    const verticalViewport = verticalScroll.getBoundingClientRect();
    const target = cell.getBoundingClientRect();
    const usableTop = Math.max(
      verticalViewport.top,
      rendered.stickyHeader?.getBoundingClientRect().bottom ?? verticalViewport.top,
    );
    horizontalScroll.scrollLeft = Math.max(
      0,
      horizontalScroll.scrollLeft +
        nearestViewportDelta(
          target.left,
          target.right,
          horizontalViewport.left,
          horizontalViewport.right,
        ),
    );
    verticalScroll.scrollTop = Math.max(
      0,
      verticalScroll.scrollTop +
        nearestViewportDelta(target.top, target.bottom, usableTop, verticalViewport.bottom),
    );
  }

  private handleSelectionAction_abyssPrivate(
    event: KeyboardEvent,
    cell: RenderedCellContext,
  ): void {
    if (this.handleDescriptionMenuKey_abyssPrivate(event, cell)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.selection_abyssPrivate.clear();
      this.syncSelection_abyssPrivate();
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      this.finishEditorBeforeAction(() => {
        this.clearSelection_abyssPrivate();
      });
      return;
    }
    if (event.key !== 'Enter' && !this.isUnmodifiedF2_abyssPrivate(event)) return;
    event.preventDefault();
    const focused = this.selection_abyssPrivate.focus;
    const editorCell = focused === undefined ? cell : this.renderedCell_abyssPrivate(focused);
    if (editorCell !== undefined && editableField(editorCell.field)) {
      this.editCell_abyssPrivate(editorCell.element, editorCell.project, editorCell.field, {
        ownedClear: editorCell.ownedClear,
      });
    }
  }

  private handleDescriptionMenuKey_abyssPrivate(
    event: KeyboardEvent,
    cell: RenderedCellContext,
  ): boolean {
    const requestsMenu = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (!requestsMenu || !this.showDescriptionMenu_abyssPrivate(cell, event)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  private rowIds_abyssPrivate(): string[] {
    if (this.overviewMode_abyssPrivate === 'table') return this.tableRowIds_abyssPrivate;
    return [
      ...new Set(this.renderedCells_abyssPrivate.map(({ identity }) => identity.occurrenceId)),
    ];
  }

  private columnIds_abyssPrivate(): string[] {
    if (this.overviewMode_abyssPrivate === 'table') return this.tableColumnIds_abyssPrivate;
    return [...new Set(this.renderedCells_abyssPrivate.map(({ identity }) => identity.columnId))];
  }

  private cellAt_abyssPrivate(row: number, column: number): LogicalCellContext | undefined {
    const occurrenceId = this.rowIds_abyssPrivate()[row];
    const columnId = this.columnIds_abyssPrivate()[column];
    if (occurrenceId === undefined || columnId === undefined) return undefined;
    if (this.overviewMode_abyssPrivate === 'table')
      return this.tableCellIndex_abyssPrivate.get(`${occurrenceId}\u0000${columnId}`);
    return this.renderedCells_abyssPrivate.find(
      ({ identity }) => identity.occurrenceId === occurrenceId && identity.columnId === columnId,
    );
  }

  private selectionBounds_abyssPrivate(): TableSelectionBounds | undefined {
    const anchor = this.selection_abyssPrivate.anchor;
    const focus = this.selection_abyssPrivate.focus;
    if (anchor === undefined || focus === undefined) return undefined;
    const rowIds = this.rowIds_abyssPrivate();
    const columnIds = this.columnIds_abyssPrivate();
    const anchorRow = rowIds.indexOf(anchor.occurrenceId);
    const focusRow = rowIds.indexOf(focus.occurrenceId);
    const anchorColumn = columnIds.indexOf(anchor.columnId);
    const focusColumn = columnIds.indexOf(focus.columnId);
    if (anchorRow < 0 || focusRow < 0 || anchorColumn < 0 || focusColumn < 0) return undefined;
    return {
      top: Math.min(anchorRow, focusRow),
      left: Math.min(anchorColumn, focusColumn),
      bottom: Math.max(anchorRow, focusRow),
      right: Math.max(anchorColumn, focusColumn),
      focus: { row: focusRow, column: focusColumn },
    };
  }

  private clipboardValue_abyssPrivate(cell: LogicalCellContext): unknown {
    if (cell.field.type === 'name') return cell.project.name;
    if (cell.field.type === 'progress') return projectProgressDisplayValue(cell.project.stats);
    if (cell.field.type === 'tracked') {
      return projectTrackedDisplayValue(cell.project.stats, this.trackedNowMs_abyssPrivate);
    }
    const property =
      cell.field.id === 'status'
        ? this.context_abyssPrivate.settings.projects.statusProperty
        : cell.field.property;
    return property === undefined
      ? undefined
      : findFrontmatterProperty(cell.project.frontmatter, property)?.value;
  }

  private clipboardText_abyssPrivate(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value))
      return value.map((entry) => this.clipboardText_abyssPrivate(entry)).join('\n');
    return clipboardScalarText(value);
  }

  private selectedClipboardRows_abyssPrivate():
    | {
        readonly internal: ProjectClipboardCell[][];
        readonly external: string[][];
      }
    | undefined {
    const bounds = this.selectionBounds_abyssPrivate();
    if (bounds === undefined) return undefined;
    const internal: ProjectClipboardCell[][] = [];
    const external: string[][] = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const internalRow: ProjectClipboardCell[] = [];
      const externalRow: string[] = [];
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        const cell = this.cellAt_abyssPrivate(row, column);
        if (cell === undefined) return undefined;
        const value = this.clipboardValue_abyssPrivate(cell);
        internalRow.push({
          value: copyProjectedValue(value),
          sourcePath: cell.project.path,
          fieldType: cell.field.type,
        });
        externalRow.push(this.clipboardText_abyssPrivate(value));
      }
      internal.push(internalRow);
      external.push(externalRow);
    }
    return { internal, external };
  }

  private handleCopy_abyssPrivate(event: ClipboardEvent): void {
    if (this.isTextEditingTarget_abyssPrivate(event.target)) return;
    const rows = this.selectedClipboardRows_abyssPrivate();
    if (rows === undefined || event.clipboardData === null) return;
    event.preventDefault();
    event.clipboardData.setData(
      PROJECT_TABLE_CLIPBOARD_TYPE,
      encodeProjectTableClipboard(rows.internal),
    );
    event.clipboardData.setData('text/plain', formatProjectTableTsv(rows.external));
  }

  private handlePaste_abyssPrivate(event: ClipboardEvent): void {
    if (this.isTextEditingTarget_abyssPrivate(event.target) || event.clipboardData === null) return;
    const bounds = this.selectionBounds_abyssPrivate();
    if (bounds === undefined) return;
    event.preventDefault();
    try {
      const internal = decodeProjectTableClipboard(
        event.clipboardData.getData(PROJECT_TABLE_CLIPBOARD_TYPE),
      );
      const source =
        internal ??
        parseProjectTableTsv(event.clipboardData.getData('text/plain')).map((row) =>
          row.map(clipboardPayloadFromText),
        );
      this.finishEditorBeforeAction(() => {
        this.pasteCells_abyssPrivate(source, bounds);
      });
    } catch (error) {
      this.showInputFailure_abyssPrivate(error);
    }
  }

  private linkRebaser_abyssPrivate(): ProjectLinkRebaser {
    return {
      resolve: (target: string, sourcePath: string) =>
        this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
      linktext: (path: string, destinationPath: string) => {
        const file = this.context_abyssPrivate.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile
          ? this.context_abyssPrivate.app.metadataCache.fileToLinktext(file, destinationPath, true)
          : path;
      },
    };
  }

  private pasteCells_abyssPrivate(
    source: ReadonlyArray<readonly ProjectClipboardCell[]>,
    bounds: TableSelectionBounds,
  ): void {
    try {
      const mappings = resolveProjectPasteRectangle(source, {
        selection: bounds,
        focus: bounds.focus,
        rowCount: this.rowIds_abyssPrivate().length,
        columnCount: this.columnIds_abyssPrivate().length,
      });
      const statusNames = this.context_abyssPrivate.settings.projects.statuses.map(
        ({ name }) => name,
      );
      const assignments = mappings.map(({ row, column, source: clipboard }) => {
        const target = this.cellAt_abyssPrivate(row, column);
        if (target === undefined) throw new Error('Clipboard target is no longer visible');
        if (!editableField(target.field)) throw new Error(`${target.field.label} is read-only`);
        const coerced = coerceProjectClipboardValue(clipboard, target.field.type, statusNames);
        const value = rebaseProjectClipboardLinks(
          coerced,
          clipboard.sourcePath,
          target.project.path,
          this.linkRebaser_abyssPrivate(),
        );
        const change = this.changeForCell_abyssPrivate(target, value);
        return {
          key: `${change.path}\u0000${change.sourceProperty?.toLocaleLowerCase()}`,
          value,
          change,
        };
      });
      const changes = deduplicateProjectCellAssignments(assignments).map(({ change }) => change);
      this.runEditBatch_abyssPrivate('Could not paste project cells', changes);
    } catch (error) {
      this.showInputFailure_abyssPrivate(error);
    }
  }

  private changeForCell_abyssPrivate(cell: LogicalCellContext, value: unknown): ProjectCellChange {
    if (!editableField(cell.field)) throw new Error(`${cell.field.label} is read-only`);
    const state = projectCellEditorState(
      cell.project,
      cell.field,
      this.context_abyssPrivate.settings,
      cell.ownedClear,
    );
    return {
      path: cell.project.path,
      field: cell.field,
      value,
      expectedValue: copyProjectedValue(state.expectedValue),
      expectedExists: state.expectedExists,
      sourceProperty: state.sourceProperty,
      ...(state.sourceKey === undefined ? {} : { sourceKey: state.sourceKey }),
      ...(state.ownedClear === undefined ? {} : { ownedClear: state.ownedClear }),
    };
  }

  private clearSelection_abyssPrivate(): void {
    try {
      const assignments = this.selectedCells_abyssPrivate().map((cell) => {
        const change = this.changeForCell_abyssPrivate(cell, undefined);
        return {
          key: `${change.path}\u0000${change.sourceProperty?.toLocaleLowerCase()}`,
          value: undefined,
          change,
        };
      });
      if (assignments.length === 0) return;
      const changes = deduplicateProjectCellAssignments(assignments).map(({ change }) => change);
      this.runEditBatch_abyssPrivate('Could not clear project cells', changes);
    } catch (error) {
      this.showInputFailure_abyssPrivate(error);
    }
  }

  private runEditBatch_abyssPrivate(label: string, changes: readonly ProjectCellChange[]): void {
    this.runTableAction_abyssPrivate(label, async () => {
      const result = await this.context_abyssPrivate.applyEdits(changes);
      this.context_abyssPrivate.history.record(result);
      this.publishAppliedReceipts(result.applied);
      return result;
    });
  }

  private runHistory_abyssPrivate(direction: 'undo' | 'redo'): void {
    this.runTableAction_abyssPrivate(
      direction === 'undo' ? 'Could not undo project edits' : 'Could not redo project edits',
      async () => {
        const result = await this.context_abyssPrivate.history[direction]();
        this.publishAppliedReceipts(result.applied);
        return result;
      },
    );
  }

  private runTableAction_abyssPrivate(
    label: string,
    mutation: () => Promise<ProjectEditResult>,
  ): void {
    this.feedback_abyssPrivate.empty();
    void this.runTableActionInOrder_abyssPrivate(() => this.runTableSessionMutation(mutation)).then(
      (result) => {
        if (result.failed.length === 0) return;
        const first = result.failed[0];
        const firstFailure = first === undefined ? '' : `: ${first.message}`;
        const message = `${result.applied.length} updated; ${result.failed.length} failed${firstFailure}`;
        this.feedback_abyssPrivate.setText(message);
        console.error(`[abyss-tasks] ${label}`, { result });
        new Notice(`${label}: ${message}`);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(message);
        if (isProjectEditValidationError(error)) return;
        console.error(`[abyss-tasks] ${label}`, error);
        new Notice(`${label}: ${message}`);
      },
    );
  }

  private showInputFailure_abyssPrivate(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.feedback_abyssPrivate.setText(message);
  }

  private bindProjectRowDrag_abyssPrivate(rendered: RenderedProjectRow): () => void {
    const row = rendered.element;
    let suppressClick = false;
    let clickTimer: number | undefined;
    const ownerWindow = row.ownerDocument.defaultView;
    let releaseDrag: (() => void) | undefined;
    let gestureTarget: EventTarget | null = null;
    let gestureCleanup: (() => void) | undefined;
    const clearGesture = (): void => {
      gestureCleanup?.();
      gestureCleanup = undefined;
      gestureTarget = null;
    };
    const rememberGesture = (event: PointerEvent): void => {
      clearGesture();
      gestureTarget = event.target;
      const ownerDocument = row.ownerDocument;
      const finishGesture = (): void => {
        clearGesture();
      };
      gestureCleanup = () => {
        ownerDocument.removeEventListener('pointerup', finishGesture, true);
        ownerDocument.removeEventListener('pointercancel', finishGesture, true);
      };
      ownerDocument.addEventListener('pointerup', finishGesture, true);
      ownerDocument.addEventListener('pointercancel', finishGesture, true);
    };
    const startDrag = (event: DragEvent): void => {
      const origin = gestureTarget ?? event.target;
      clearGesture();
      releaseDrag = this.startProjectRowDrag_abyssPrivate(rendered, event, origin);
      if (releaseDrag === undefined) return;
      suppressClick = true;
    };
    const finishDrag = (): void => {
      clearGesture();
      row.removeClass('is-dragging');
      this.activeRowDrag_abyssPrivate = undefined;
      this.clearGroupDropStates_abyssPrivate();
      releaseDrag?.();
      releaseDrag = undefined;
      ownerWindow?.clearTimeout(clickTimer);
      clickTimer = ownerWindow?.setTimeout(() => {
        suppressClick = false;
        clickTimer = undefined;
      }, 0);
      this.renderTableWindow_abyssPrivate();
    };
    const suppressDraggedClick = (event: MouseEvent): void => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const dropCleanup = this.bindGroupDropTarget_abyssPrivate(row, () => rendered.groupKey);
    row.addEventListener('pointerdown', rememberGesture, true);
    row.addEventListener('dragstart', startDrag);
    row.addEventListener('dragend', finishDrag);
    row.addEventListener('click', suppressDraggedClick, true);
    return () => {
      ownerWindow?.clearTimeout(clickTimer);
      clearGesture();
      row.removeClass('is-dragging');
      dropCleanup();
      row.removeEventListener('pointerdown', rememberGesture, true);
      row.removeEventListener('dragstart', startDrag);
      row.removeEventListener('dragend', finishDrag);
      row.removeEventListener('click', suppressDraggedClick, true);
      releaseDrag?.();
      releaseDrag = undefined;
    };
  }

  private startProjectRowDrag_abyssPrivate(
    rendered: RenderedProjectRow,
    event: DragEvent,
    origin: EventTarget | null,
  ): (() => void) | undefined {
    const row = rendered.element;
    if (!row.draggable || this.isProtectedRowDragTarget_abyssPrivate(origin, row)) {
      event.preventDefault();
      return;
    }
    const dataTransfer = event.dataTransfer;
    if (dataTransfer === null) return;
    const payload: ProjectRowDragPayload = {
      version: 1,
      projectPath: rendered.project.path,
      occurrenceId: rendered.occurrenceId,
      sourceGroupKey: rendered.groupKey,
    };
    dataTransfer.setData(PROJECT_TABLE_ROW_DRAG_TYPE, JSON.stringify(payload));
    dataTransfer.effectAllowed = 'move';
    const release = this.beginProjectDrag_abyssPrivate();
    this.activeRowDrag_abyssPrivate = payload;
    row.addClass('is-dragging');
    return release;
  }

  private beginProjectDrag_abyssPrivate(): () => void {
    this.root_abyssPrivate.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
    this.selection_abyssPrivate.clear();
    this.syncSelection_abyssPrivate();
    this.projectDragActive_abyssPrivate = true;
    this.root_abyssPrivate.addClass('is-project-dragging');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.projectDragActive_abyssPrivate = false;
      this.root_abyssPrivate.removeClass('is-project-dragging');
      if (this.renderPending_abyssPrivate) this.renderTable_abyssPrivate();
    };
  }

  private isProtectedRowDragTarget_abyssPrivate(
    target: EventTarget | null,
    row: HTMLTableRowElement,
  ): boolean {
    if (this.activeEditor_abyssPrivate !== undefined || !(target instanceof Element)) return true;
    const action = target.closest(
      'a, input, select, textarea, [contenteditable="true"], .abyss-project-cell-editor, button',
    );
    if (action === null || !row.contains(action)) return false;
    return !action.classList.contains('abyss-project-table-name');
  }

  private readRowDragPayload_abyssPrivate(
    dataTransfer: DataTransfer,
  ): ProjectRowDragPayload | undefined {
    try {
      const value = JSON.parse(
        dataTransfer.getData(PROJECT_TABLE_ROW_DRAG_TYPE),
      ) as Partial<ProjectRowDragPayload>;
      return value.version === 1 &&
        typeof value.projectPath === 'string' &&
        typeof value.occurrenceId === 'string' &&
        typeof value.sourceGroupKey === 'string'
        ? (value as ProjectRowDragPayload)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private groupDropPlan_abyssPrivate(
    payload: ProjectRowDragPayload,
    targetGroupKey: string,
  ): GroupDropPlan {
    const source = this.renderedGroups_abyssPrivate.get(payload.sourceGroupKey);
    const target = this.renderedGroups_abyssPrivate.get(targetGroupKey);
    if (source === undefined || target === undefined) {
      throw new Error('Project group is no longer visible');
    }
    const sourceCell = this.logicalCells_abyssPrivate().find(
      ({ identity }) =>
        identity.occurrenceId === payload.occurrenceId &&
        identity.projectPath === payload.projectPath &&
        identity.groupKey === payload.sourceGroupKey,
    );
    if (sourceCell === undefined) throw new Error('Project row is no longer visible');
    const visibleProject = sourceCell.project;
    const groupField = findProjectFieldById(
      this.fields_abyssPrivate,
      this.context_abyssPrivate.settings.projects.table.groupBy,
    );
    if (groupField === undefined) throw new Error('Project grouping field is unavailable');
    const effective = this.effectiveField_abyssPrivate(visibleProject, groupField);
    const cell: LogicalCellContext = {
      identity: {
        occurrenceId: payload.occurrenceId,
        projectPath: visibleProject.path,
        groupKey: payload.sourceGroupKey,
        columnId: effective.field.id,
      },
      project: visibleProject,
      field: effective.field,
      ownedClear: effective.ownedClear,
    };
    const currentValue = editableField(effective.field)
      ? projectCellSourceValue(
          visibleProject,
          effective.field,
          this.context_abyssPrivate.settings.projects,
        )
      : undefined;
    const value = planProjectGroupDrop({
      field: effective.field,
      currentValue,
      projectPath: visibleProject.path,
      source,
      target,
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      groupIdentity: (raw, sourcePath) =>
        projectTableGroupLinkIdentity(
          raw,
          sourcePath,
          (linkTarget, linkSourcePath) =>
            this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(
              linkTarget,
              linkSourcePath,
            )?.path,
        ),
      rebase: (raw, sourcePath, destinationPath) =>
        rebaseProjectClipboardLinks(
          raw,
          sourcePath,
          destinationPath,
          this.linkRebaser_abyssPrivate(),
        ),
    });
    return { cell, value, target };
  }

  private showGroupDropPreview_abyssPrivate(targetGroupKey: string): GroupDropPreview {
    const payload = this.activeRowDrag_abyssPrivate;
    const current = this.cachedGroupDropPreview_abyssPrivate(payload, targetGroupKey);
    if (current !== undefined) return current;
    this.clearGroupDropStates_abyssPrivate();
    const result = this.groupDropPreviewResult_abyssPrivate(payload, targetGroupKey);
    const targetRows = this.displayedGroupRows_abyssPrivate(targetGroupKey);
    const groupRow = this.renderedGroupRows_abyssPrivate.get(targetGroupKey);
    const rows = [groupRow?.element, ...targetRows.map(({ element }) => element)].filter(
      (row) => row !== undefined,
    );
    const state = result.allowed ? 'is-drop-target' : 'is-drop-disabled';
    for (const row of rows) {
      row.addClass(state);
      row.setAttribute('title', result.message);
    }
    groupRow?.dropHint.setText(result.message);
    const insertion =
      result.plan === undefined
        ? {}
        : this.groupDropInsertion_abyssPrivate(result.plan, targetGroupKey, targetRows, groupRow);
    insertion.line?.addClass(
      insertion.forecast?.kind === 'before' ? 'is-drop-before' : 'is-drop-after',
    );
    const preview: GroupDropPreview = {
      payload,
      targetGroupKey,
      revision: this.groupDropRevision_abyssPrivate,
      ...result,
      rows,
      ...insertion,
    };
    this.groupDropPreview_abyssPrivate = preview;
    return preview;
  }

  private displayedGroupRows_abyssPrivate(groupKey: string): RenderedProjectRow[] {
    const rows: RenderedProjectRow[] = [];
    for (const element of this.body_abyssPrivate?.rows ?? []) {
      const occurrenceId = element.dataset['occurrenceId'];
      if (occurrenceId === undefined) continue;
      const row = this.renderedProjectRows_abyssPrivate.get(occurrenceId);
      if (row?.groupKey === groupKey) rows.push(row);
    }
    return rows;
  }

  private cachedGroupDropPreview_abyssPrivate(
    payload: ProjectRowDragPayload | undefined,
    targetGroupKey: string,
  ): GroupDropPreview | undefined {
    const current = this.groupDropPreview_abyssPrivate;
    if (current === undefined) return undefined;
    return current.payload === payload &&
      current.targetGroupKey === targetGroupKey &&
      current.revision === this.groupDropRevision_abyssPrivate
      ? current
      : undefined;
  }

  private groupDropPreviewResult_abyssPrivate(
    payload: ProjectRowDragPayload | undefined,
    targetGroupKey: string,
  ): Pick<GroupDropPreview, 'allowed' | 'message' | 'plan'> {
    let result: Pick<GroupDropPreview, 'allowed' | 'message' | 'plan'>;
    try {
      if (payload === undefined) throw new Error('Invalid project row drag');
      const plan = this.groupDropPlan_abyssPrivate(payload, targetGroupKey);
      const clearsList =
        (plan.cell.field.type === 'list' || plan.cell.field.type === 'tags') &&
        (targetGroupKey === 'empty' || targetGroupKey === 'none');
      result = {
        allowed: true,
        message: clearsList
          ? `Drop to clear the entire ${plan.cell.field.label} list`
          : `Drop to move to ${plan.target.label}`,
        plan,
      };
    } catch (error) {
      result = {
        allowed: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return result;
  }

  private groupDropInsertion_abyssPrivate(
    plan: GroupDropPlan,
    targetGroupKey: string,
    targetRows: readonly RenderedProjectRow[],
    groupRow: RenderedGroupRow | undefined,
  ): Pick<GroupDropPreview, 'forecast' | 'line'> {
    if (this.collapsedGroups_abyssPrivate.has(targetGroupKey)) return {};
    try {
      const change = this.changeForCell_abyssPrivate(plan.cell, plan.value);
      if (change.sourceProperty === undefined) return {};
      const forecast = forecastProjectGroupDrop({
        model: this.projectTableModelInput_abyssPrivate(),
        change: { ...change, sourceProperty: change.sourceProperty },
        targetGroupKey,
        currentTargetPaths: targetRows.map(({ project }) => project.path),
        projectsSettings: this.context_abyssPrivate.settings.projects,
        tagsReliable: this.groupDropTagsReliable_abyssPrivate(change, plan),
      });
      const line = this.groupDropLine_abyssPrivate(forecast, targetRows, groupRow);
      return { forecast, ...(line === undefined ? {} : { line }) };
    } catch {
      return { forecast: { kind: 'none' } };
    }
  }

  private groupDropLine_abyssPrivate(
    forecast: ProjectGroupDropForecast,
    targetRows: readonly RenderedProjectRow[],
    groupRow: RenderedGroupRow | undefined,
  ): HTMLTableRowElement | undefined {
    if (forecast.kind === 'before') {
      const before = targetRows.find(({ project }) => project.path === forecast.projectPath);
      return before?.element;
    }
    if (forecast.kind !== 'append') return undefined;
    return targetRows[targetRows.length - 1]?.element ?? groupRow?.element;
  }

  private groupDropTagsReliable_abyssPrivate(
    change: ProjectCellChange,
    plan: GroupDropPlan,
  ): boolean {
    const pendingTagChange = Array.from(this.receiptProjections_abyssPrivate.values()).some(
      ({ receipt }) => receipt.path === change.path && isTagCarrier(receipt.sourceKey),
    );
    return (
      plan.cell.field.type !== 'tags' &&
      !isTagCarrier(change.sourceProperty) &&
      !isTagCarrier(change.sourceKey) &&
      !pendingTagChange
    );
  }

  private dropProjectIntoGroup_abyssPrivate(
    dataTransfer: DataTransfer,
    targetGroupKey: string,
  ): void {
    const active = this.activeRowDrag_abyssPrivate;
    const payload = this.readRowDragPayload_abyssPrivate(dataTransfer);
    this.activeRowDrag_abyssPrivate = undefined;
    if (payload === undefined || active === undefined || !sameRowDragPayload(payload, active)) {
      this.showInputFailure_abyssPrivate(new Error('Invalid project row drag'));
      return;
    }
    this.finishEditorBeforeAction(() => {
      try {
        const plan = this.groupDropPlan_abyssPrivate(payload, targetGroupKey);
        const change = this.changeForCell_abyssPrivate(plan.cell, plan.value);
        if (equalProjectedValue(change.expectedValue, change.value)) return;
        this.runEditBatch_abyssPrivate('Could not move project to group', [change]);
      } catch (error) {
        this.showInputFailure_abyssPrivate(error);
      }
    });
  }

  private clearGroupDropStates_abyssPrivate(): void {
    const preview = this.groupDropPreview_abyssPrivate;
    if (preview === undefined) return;
    this.groupDropPreview_abyssPrivate = undefined;
    for (const row of preview.rows) {
      row.removeClass('is-drop-target', 'is-drop-disabled');
      row.removeAttribute('title');
    }
    preview.line?.removeClass('is-drop-before', 'is-drop-after');
    this.renderedGroupRows_abyssPrivate.get(preview.targetGroupKey)?.dropHint.empty();
  }

  private requestRemoveListValue_abyssPrivate(
    project: Project,
    field: ProjectFieldCatalogItem,
    ownedClear: OwnedInferredPropertyClear | undefined,
    valueIndex: number,
  ): void {
    this.finishEditorBeforeAction(() => {
      if (!editableField(field) || field.property === undefined) return;
      const current = projectCellSourceValue(
        project,
        field,
        this.context_abyssPrivate.settings.projects,
      );
      let value: unknown[] | undefined;
      if (Array.isArray(current)) {
        value = current.filter((_value, index) => index !== valueIndex);
      } else if (valueIndex === 0) {
        value = [];
      }
      if (value === undefined) return;
      this.removeListValue_abyssPrivate({
        ...projectCellEditorState(project, field, this.context_abyssPrivate.settings, ownedClear),
        project,
        field,
        value,
        expectedValue: current,
      });
    });
  }

  private finishEditorNavigation_abyssPrivate(
    edited: ProjectTableSelectableCell | undefined,
    navigation: ProjectCellEditorNavigation,
    deliberateFocus?: ProjectTableSelectableCell,
  ): void {
    const cells = this.selectableCells_abyssPrivate();
    if (navigation === 'preserve-focus') {
      const requested = deliberateFocus ?? edited;
      if (requested === undefined) return;
      const target = this.currentProjectionCell_abyssPrivate(requested, cells);
      if (target === undefined) return;
      this.selection_abyssPrivate.select(target, cells, false);
      this.focusSelectionCell_abyssPrivate(target);
      return;
    }
    if (edited === undefined) return;
    const origin = this.currentProjectionCell_abyssPrivate(edited, cells);
    if (origin === undefined) return;
    this.selection_abyssPrivate.select(origin, cells, false);
    const target =
      navigation === 'restore-current'
        ? origin
        : this.selection_abyssPrivate.tab(cells, navigation === 'tab-backward');
    if (target !== undefined) this.focusSelectionCell_abyssPrivate(target);
  }

  private editorCloseDestination_abyssPrivate(
    edited: ProjectTableSelectableCell | undefined,
    navigation: ProjectCellEditorNavigation,
    initialTarget: HTMLElement | undefined,
    editorCell: HTMLElement,
  ): EditorCloseDestination {
    const initialCell = this.keydownCell_abyssPrivate(initialTarget ?? null)?.identity;
    const activeElement = this.tableHost_abyssPrivate.ownerDocument.activeElement;
    const activeCell = this.keydownCell_abyssPrivate(activeElement)?.identity;
    const selectedCell = this.selection_abyssPrivate.focus;
    const selectionMoved =
      selectedCell !== undefined &&
      edited !== undefined &&
      (selectedCell.occurrenceId !== edited.occurrenceId ||
        selectedCell.columnId !== edited.columnId);
    return {
      cell: activeCell ?? (selectionMoved ? selectedCell : initialCell),
      preservesExternalFocus:
        navigation === 'preserve-focus' &&
        this.isExternalFocusDestination_abyssPrivate(activeElement, activeCell, editorCell),
    };
  }

  private isExternalFocusDestination_abyssPrivate(
    activeElement: Element | null,
    activeCell: ProjectTableSelectableCell | undefined,
    editorCell: HTMLElement,
  ): boolean {
    if (!(activeElement instanceof HTMLElement)) return false;
    if (!activeElement.isConnected) return false;
    if (activeElement === this.tableHost_abyssPrivate.ownerDocument.body) return false;
    if (activeElement.contains(this.root_abyssPrivate)) return false;
    if (activeCell !== undefined) return false;
    return !editorCell.contains(activeElement);
  }

  private currentProjectionCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
    cells: readonly ProjectTableSelectableCell[],
  ): ProjectTableSelectableCell | undefined {
    return (
      cells.find(
        ({ occurrenceId, columnId }) =>
          occurrenceId === identity.occurrenceId && columnId === identity.columnId,
      ) ??
      cells.find(
        ({ projectPath, columnId }) =>
          projectPath === identity.projectPath && columnId === identity.columnId,
      )
    );
  }

  private positionEditorHost_abyssPrivate(request: EditorPositionRequest): () => void {
    const { anchor, host, onMove, avoid, preferredWidth } = request;
    const rendered = this.renderedCells_abyssPrivate.find(({ element }) =>
      containsEditorAnchor(element, anchor),
    );
    const stickyHeader = rendered?.stickyHeader ?? this.table_abyssPrivate?.tHead ?? undefined;
    return mountProjectCellEditorPosition({
      anchor,
      host,
      boundary: rendered?.editorBoundary ?? this.scroll_abyssPrivate,
      positioningContainer: preferredWidth === undefined ? anchor : this.root_abyssPrivate,
      onMove,
      ...optionalEditorPositionFields(avoid, preferredWidth, stickyHeader),
    });
  }

  private activateEditor_abyssPrivate(request: MountedEditorRequest): () => void {
    const { project, field, cell, anchor, host, handle } = request;
    if (handle.preferredWidth !== undefined) {
      host.addClass('is-picker');
      this.root_abyssPrivate.appendChild(host);
    }
    const positionCleanup = this.positionEditorHost_abyssPrivate({
      anchor,
      host,
      onMove: () => {
        handle.closeSuggestion();
      },
      ...(field.id === 'description' ? { avoid: cell } : {}),
      ...(handle.preferredWidth === undefined ? {} : { preferredWidth: handle.preferredWidth }),
    });
    this.activeEditor_abyssPrivate = {
      projectPath: project.path,
      columnId: field.id,
      handle,
      positionCleanup,
    };
    handle.focus();
    return positionCleanup;
  }

  private editCell_abyssPrivate(
    cell: HTMLElement,
    project: Project,
    field: ProjectField,
    options: EditCellOptions,
  ): void {
    if (this.activeEditor_abyssPrivate !== undefined || !cell.isConnected) return;
    const { ownedClear } = options;
    const anchor = options.anchor ?? cell;
    const editorState = projectCellEditorState(
      project,
      field,
      this.context_abyssPrivate.settings,
      ownedClear,
    );
    const edited = this.renderedCells_abyssPrivate.find(
      ({ element }) => element === cell,
    )?.identity;
    const editorHost = anchor.createDiv({ cls: 'abyss-project-cell-editor-host' });
    anchor.prepend(editorHost);
    editorHost.toggleClass('is-expanded', field.id === 'description');
    cell.addClass('is-editing');
    anchor.addClass('is-editor-anchor');
    let positionCleanup = (): void => {};
    const presets = this.editorPresets_abyssPrivate(field);
    const handle = mountProjectCellEditor({
      app: this.context_abyssPrivate.app,
      container: editorHost,
      field,
      value: editorState.expectedValue,
      catalog: this.context_abyssPrivate.catalog,
      resolveField: (fieldId) =>
        resolveConfiguredProjectField(this.context_abyssPrivate.settings.projects, fieldId),
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      ...(field.property === undefined ? {} : { sourceField: field.property }),
      ...(presets === undefined ? {} : { presets }),
      sourcePath: project.path,
      save: (value) => this.saveEditorValue_abyssPrivate(project, field, editorState, value),
      onClose: (_result, closeContext) => {
        this.runSettledCreationInteraction_abyssPrivate(() => {
          const destination = this.editorCloseDestination_abyssPrivate(
            edited,
            closeContext.navigation,
            closeContext.focusTarget,
            cell,
          );
          positionCleanup();
          editorHost.remove();
          this.clearEditorAnchor_abyssPrivate(anchor, cell);
          this.activeEditor_abyssPrivate = undefined;
          this.renderTable_abyssPrivate();
          const preserveActionFocus = this.takeSubmittedActionFocus_abyssPrivate(
            closeContext.navigation,
          );
          const pendingAction = this.pendingAction_abyssPrivate !== undefined;
          this.runPendingAction_abyssPrivate();
          if (!pendingAction && !preserveActionFocus && !destination.preservesExternalFocus) {
            this.finishEditorNavigation_abyssPrivate(
              edited,
              closeContext.navigation,
              destination.cell,
            );
          }
        });
      },
      restoreFocus: () => {},
    });
    positionCleanup = this.activateEditor_abyssPrivate({
      project,
      field,
      cell,
      anchor,
      host: editorHost,
      handle,
    });
  }

  private clearEditorAnchor_abyssPrivate(anchor: HTMLElement, cell: HTMLElement): void {
    anchor.removeClass('is-editor-anchor');
    if (anchor.hasClass('abyss-project-description-editor-anchor')) anchor.remove();
    cell.removeClass('is-editing');
  }

  private async saveEditorValue_abyssPrivate(
    project: Project,
    field: ProjectField,
    state: ProjectCellEditorState,
    value: unknown,
  ): Promise<void> {
    const nextState = await this.applyCellEdit_abyssPrivate({
      project,
      field,
      value,
      expectedValue: state.expectedValue,
      expectedExists: state.expectedExists,
      sourceProperty: state.sourceProperty,
      sourceKey: state.sourceKey,
      ownedClear: state.ownedClear,
    });
    Object.assign(state, nextState);
  }

  private effectiveField_abyssPrivate(
    project: Project,
    field: ProjectFieldCatalogItem,
  ): { readonly field: ProjectFieldCatalogItem; readonly ownedClear?: OwnedInferredPropertyClear } {
    if (field.property === undefined) return { field };
    let ownedClear: OwnedInferredPropertyClear | undefined;
    try {
      ownedClear = this.context_abyssPrivate.history.ownedClear(project.path, field);
    } catch {
      return { field };
    }
    if (ownedClear === undefined) return { field };
    return {
      field: projectFieldWithOwnedClear(
        project,
        field,
        this.context_abyssPrivate.catalog.inspect(field.property),
        ownedClear,
      ),
      ownedClear,
    };
  }

  private async applyCellEdit_abyssPrivate(
    request: ProjectCellEditRequest,
  ): Promise<ProjectCellEditorState> {
    const {
      project,
      field,
      value,
      expectedValue,
      expectedExists,
      sourceProperty,
      sourceKey,
      ownedClear,
    } = request;
    const receipt = await this.runTableSessionMutation(async () => {
      const change: ProjectCellChange = {
        path: project.path,
        field,
        value,
        expectedValue,
        expectedExists,
        sourceProperty,
        ...(sourceKey === undefined ? {} : { sourceKey }),
        ...(ownedClear === undefined ? {} : { ownedClear }),
      };
      const result = await this.context_abyssPrivate.applyEdits([change]);
      this.context_abyssPrivate.history.record(result);
      this.publishAppliedReceipts(result.applied);
      const failure = result.failed[0];
      if (failure !== undefined) throw new Error(failure.message);
      const applied = result.applied[0];
      if (applied === undefined) throw new Error(`Could not update ${field.label}`);
      return applied;
    });
    return {
      expectedValue: copyProjectedValue(receipt.value),
      expectedExists: receipt.appliedExists,
      sourceProperty: receipt.sourceProperty,
      sourceKey: receipt.sourceKey,
      ownedClear: this.context_abyssPrivate.history.ownedClear(project.path, field),
    };
  }

  /** Publishes successful editor, paste, drop, Undo, and Redo receipts into this session. */
  publishAppliedReceipts(receipts: readonly AppliedProjectCellChange[]): void {
    for (const receipt of receipts) {
      this.publishAppliedReceipt_abyssPrivate(receipt);
    }
    this.renderTable_abyssPrivate();
  }

  private publishAppliedReceipt_abyssPrivate(receipt: AppliedProjectCellChange): void {
    const activeRevisions = this.activeMutationSourceRevisions_abyssPrivate;
    const sourceRevisionAtMutationStart =
      activeRevisions !== undefined
        ? (activeRevisions.get(receipt.path) ?? 0)
        : (this.sourceObservations_abyssPrivate.get(receipt.path)?.revision ?? 0);
    const observation = this.sourceObservations_abyssPrivate.get(receipt.path);
    const observedDuringMutation =
      observation !== undefined && observation.revision > sourceRevisionAtMutationStart;
    const key = projectionKey(receipt);
    if (observedDuringMutation && observationMatchesReceipt(observation, receipt)) {
      this.receiptProjections_abyssPrivate.delete(key);
      return;
    }
    const projection: ProjectReceiptProjection = {
      receipt,
      sourceRevisionAtMutationStart,
      ordinal: ++this.nextReceiptOrdinal_abyssPrivate,
    };
    this.receiptProjections_abyssPrivate.set(key, projection);
    if (observedDuringMutation) {
      this.revalidateReceiptProjection_abyssPrivate(key, projection, observation);
    }
  }

  private revalidateReceiptProjection_abyssPrivate(
    key: string,
    projection: ProjectReceiptProjection,
    observation: ProjectSourceObservation,
  ): void {
    void this.context_abyssPrivate.revalidateSourceObservation(observation).then(
      (current) => {
        if (!current || this.receiptProjections_abyssPrivate.get(key) !== projection) return;
        if (this.sourceObservations_abyssPrivate.get(observation.path) !== observation) return;
        this.receiptProjections_abyssPrivate.delete(key);
        this.renderTable_abyssPrivate();
      },
      (error: unknown) => {
        console.error('[abyss-tasks] Could not revalidate project receipt projection', {
          path: observation.path,
          cause: error,
        });
      },
    );
  }

  private projectedProjects_abyssPrivate(): readonly Project[] {
    const byPath = new Map<string, ProjectReceiptProjection[]>();
    for (const projection of this.receiptProjections_abyssPrivate.values()) {
      const projections = byPath.get(projection.receipt.path) ?? [];
      projections.push(projection);
      byPath.set(projection.receipt.path, projections);
    }
    return this.projects_abyssPrivate.map((project) => {
      const projections = byPath.get(project.path);
      if (projections === undefined) return project;
      const frontmatter = { ...project.frontmatter };
      const sortedProjections = [...projections];
      sortedProjections.sort((left, right) => left.ordinal - right.ordinal);
      for (const { receipt } of sortedProjections) {
        if (receipt.appliedExists) {
          frontmatter[receipt.sourceKey] = copyProjectedValue(receipt.value);
        } else {
          delete frontmatter[receipt.sourceKey];
        }
      }
      return {
        ...project,
        frontmatter,
        ...resolveStatus(this.context_abyssPrivate.settings.projects, frontmatter),
      };
    });
  }

  private removeListValue_abyssPrivate(request: RemoveListValueRequest): void {
    const { field } = request;
    this.applyCellEdit_abyssPrivate(request).then(
      () => undefined,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.feedback_abyssPrivate.setText(`Could not update ${field.label}: ${message}`);
        if (isProjectEditValidationError(error)) return;
        console.error('[abyss-tasks] Could not update project list property', {
          property: field.property,
          cause: error,
        });
        new Notice(`Could not update ${field.label}: ${message}`);
      },
    );
  }

  private findOccurrenceCell_abyssPrivate(
    occurrenceId: string,
    columnId: string,
  ): HTMLElement | null {
    return (
      this.renderedCells_abyssPrivate.find(
        ({ identity }) => identity.occurrenceId === occurrenceId && identity.columnId === columnId,
      )?.element ?? null
    );
  }

  private projectHasInvalidRange_abyssPrivate(project: Project): boolean {
    const startField = findProjectFieldById(this.fields_abyssPrivate, 'start');
    const endField = findProjectFieldById(this.fields_abyssPrivate, 'end');
    if (startField === undefined || endField === undefined) return false;
    const start = projectFieldValue(project, startField);
    const end = projectFieldValue(project, endField);
    return (
      typeof start === 'string' &&
      typeof end === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(start) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(end) &&
      start > end
    );
  }
}
