import { Component, Menu, Notice, TFile, type App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import { exactLinkToken, parseLinks } from '../../markdown/links';
import { moment } from '../../obsidianMoment';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import {
  projectCreationFailureNotice,
  type ProjectCreateRequest,
} from '../../projects/projectCreation';
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
  buildConfiguredProjectFieldCatalog,
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
import {
  hasAuthoritativeProjectPropertyDefinitions,
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
  type ProjectTableModelInput,
} from '../../projects/projectTableModel';
import {
  buildDefaultProjectTableSettings,
  effectiveConfiguredProjectViewSettings,
  effectiveProjectTableDateDisplay,
  setProjectTableColumnDateDisplay,
} from '../../projects/projectTableSettings';
import {
  PROJECT_TIMELINE_INVALID_RANGE_REASON,
  projectTimelineRawEditEligibility,
  type ProjectTimelineRawEndpoint,
} from '../../projects/projectTimelineEdits';
import {
  planProjectTimelineEndpointEdit,
  type ProjectTimelineEndpointEditPlan,
} from '../../projects/projectTimelineEndpointEdits';
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
import { writeClass, writeOptionalAttribute } from '../../ui/guardedDomWrites';
import type { ProjectPropertySuggestion } from '../../ui/ProjectPropertySuggest';
import {
  projectPropertyValuePresentation,
  projectTagLabel,
} from '../../ui/projectPropertyValuePresentation';
import { prefersReducedMotion } from '../../ui/reducedMotion';
import { renderTaskText } from '../../ui/renderTaskText';
import { runAsyncAction } from '../../ui/runAsyncAction';
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
import {
  NO_PROJECT_OVERVIEW_CELLS,
  visibleProjectColumns,
  type ProjectOverviewCell,
  type ProjectOverviewCells,
} from './projectOverviewCells';
import { ProjectsKanbanView } from './ProjectsKanbanView';
import {
  cellContaining,
  type ProjectOverviewRenderHooks,
  type ProjectsOverviewSurface,
  type RenderedCellContext,
} from './ProjectsOverviewSurface';
import {
  ProjectsTableSurface,
  type ProjectsTableSurfaceContext,
  type ReconcileProjectCellOptions,
  type RenderedGroupContext,
  type RenderedGroupRow,
  type RenderedProjectRow,
} from './ProjectsTableSurface';
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
import { type ProjectTableColumnResize, type VisibleProjectColumn } from './projectTableColumns';
import { planProjectGroupDrop } from './projectTableDrag';
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
  /** Writes view state; the injected save presents its own failure. */
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
  readonly cell: ProjectOverviewCell;
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

/** A view's selection and search, which it keeps across mode switches. */
interface OverviewSession {
  readonly selection: ProjectTableSelection;
  search: string;
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

/** Marks the last row of each run of drop target rows, which draws the run's bottom edge. */
function markDropRunEnds(rows: readonly RenderedProjectRow[], state: string): void {
  for (const { element } of rows) {
    element.toggleClass('is-drop-end', element.nextElementSibling?.hasClass(state) !== true);
  }
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

export class ProjectsTableView {
  private projects_abyssPrivate: readonly Project[] = [];
  private fields_abyssPrivate: readonly ProjectFieldCatalogItem[] = [];
  private readonly root_abyssPrivate: HTMLElement;
  private readonly tableSurface_abyssPrivate: ProjectsTableSurface;
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
  private compiledPresets_abyssPrivate = new Map<string, CompiledProjectPropertyPresets>();
  /**
   * The instant tracked time is read at. It is taken once per render pass and never on a timer, so
   * every row is sorted and labelled against the same clock and a running project never repaints
   * on its own.
   */
  private trackedNowMs_abyssPrivate = Date.now();
  private readonly sessions_abyssPrivate: Record<ProjectOverviewMode, OverviewSession> = {
    table: { selection: new ProjectTableSelection(), search: '' },
    kanban: { selection: new ProjectTableSelection(), search: '' },
    timeline: { selection: new ProjectTableSelection(), search: '' },
  };
  private selectedKeys_abyssPrivate = new Set<string>();
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
  private nativeMenuOpen_abyssPrivate = false;
  private relativeDateInterval_abyssPrivate: number | undefined;
  /** How a render reports back: the toolbar and count first, then the settled selection. */
  private readonly renderHooks_abyssPrivate: ProjectOverviewRenderHooks = {
    publish: ({ availableStatusGroups, uniqueVisibleCount }) => {
      this.toolbar_abyssPrivate.update(availableStatusGroups);
      this.count_abyssPrivate.setText(
        `${uniqueVisibleCount} ${uniqueVisibleCount === 1 ? 'project' : 'projects'}`,
      );
    },
    settleSelection: () => {
      this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
      this.syncSelection_abyssPrivate();
    },
  };

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
    this.tableSurface_abyssPrivate = new ProjectsTableSurface(
      this.tableSurfaceContext_abyssPrivate(),
    );
    this.root_abyssPrivate.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.clearGroupDropStates_abyssPrivate();
      this.handleTableKeydown_abyssPrivate(event);
    });
    this.ownerWindow_abyssPrivate = this.root_abyssPrivate.ownerDocument.defaultView ?? undefined;
    this.listenForOverviewBackgroundClick_abyssPrivate();
    this.listenForOwnerWindowF2_abyssPrivate();
    this.listenForRelativeDates_abyssPrivate();
    this.listenForDocumentFocus_abyssPrivate();
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
      reducedMotion: () => prefersReducedMotion(this.ownerWindow_abyssPrivate),
      now: () => Date.now(),
    });
  }

  private get selection_abyssPrivate(): ProjectTableSelection {
    return this.sessions_abyssPrivate[this.overviewMode_abyssPrivate].selection;
  }

  private get renderedCells_abyssPrivate(): readonly RenderedCellContext[] {
    if (this.overviewMode_abyssPrivate === 'table')
      return this.tableSurface_abyssPrivate.renderedCells();
    return this.activeSurface_abyssPrivate()?.renderedCells() ?? [];
  }

  /** The Kanban or Timeline surface of the current mode once it exists, not yet the Table. */
  private activeSurface_abyssPrivate(): ProjectsOverviewSurface<RenderedCellContext> | undefined {
    if (this.overviewMode_abyssPrivate === 'kanban') return this.kanbanView_abyssPrivate;
    if (this.overviewMode_abyssPrivate === 'timeline') return this.timelineView_abyssPrivate;
    return undefined;
  }

  private overviewCells_abyssPrivate(): ProjectOverviewCells {
    if (this.overviewMode_abyssPrivate === 'table') return this.tableSurface_abyssPrivate.cells();
    return this.activeSurface_abyssPrivate()?.cells() ?? NO_PROJECT_OVERVIEW_CELLS;
  }

  private createToolbar_abyssPrivate(): ProjectsTableToolbar {
    return new ProjectsTableToolbar({
      host: this.root_abyssPrivate,
      settings: () => this.activeViewSettings_abyssPrivate(),
      effectiveSettings: () => this.effectiveActiveViewSettings_abyssPrivate(),
      tableSettings: () => this.context_abyssPrivate.settings.projects.table,
      effectiveTableSettings: () => this.effectiveTableSettings_abyssPrivate(),
      mode: () => this.overviewMode_abyssPrivate,
      fields: () => buildConfiguredProjectFieldCatalog(this.context_abyssPrivate.settings.projects),
      onSearch: (query) => {
        this.finishEditorBeforeAction(() => {
          this.sessions_abyssPrivate[this.overviewMode_abyssPrivate].search = query;
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

  /** What the Table surface reads from the controller: settings, rendering, and commands. */
  private tableSurfaceContext_abyssPrivate(): ProjectsTableSurfaceContext {
    return {
      root: this.root_abyssPrivate,
      markdown: this.markdown_abyssPrivate,
      isActive: () => this.mounted_abyssPrivate && this.overviewMode_abyssPrivate === 'table',
      grouped: () => this.context_abyssPrivate.settings.projects.table.groupBy !== 'none',
      tableSettings: () => this.context_abyssPrivate.settings.projects.table,
      columns: () => this.tableColumns_abyssPrivate(),
      modelInput: () => this.tableModelInputBase_abyssPrivate(),
      effectiveField: (project, field) => this.effectiveField_abyssPrivate(project, field),
      reconcileCell: (options) => this.reconcileProjectCell_abyssPrivate(options),
      renderGroupContent: (target, group, color) => {
        this.renderGroupContent_abyssPrivate(target, group, color);
      },
      columnActions: this.tableColumnActions_abyssPrivate(),
      copy: (event) => {
        this.handleCopy_abyssPrivate(event);
      },
      paste: (event) => {
        this.handlePaste_abyssPrivate(event);
      },
      rowDrag: {
        bindRow: (row) => this.bindProjectRowDrag_abyssPrivate(row),
        bindGroupDropTarget: (row, groupKey) =>
          this.bindGroupDropTarget_abyssPrivate(row, groupKey),
        draggedOccurrence: () => this.activeRowDrag_abyssPrivate?.occurrenceId,
      },
      finishEditorBefore: (action) => {
        this.finishEditorBeforeAction(action);
      },
      render: () => {
        this.renderTable_abyssPrivate();
      },
      windowRendered: () => {
        this.patchSelection_abyssPrivate();
      },
    };
  }

  /** The Table header's sort, column, and resize commands. */
  private tableColumnActions_abyssPrivate(): ProjectsTableSurfaceContext['columnActions'] {
    return {
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
    };
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

  private activeViewSettings_abyssPrivate():
    ProjectTableSettings | ProjectKanbanSettings | ProjectTimelineSettings {
    if (this.overviewMode_abyssPrivate === 'table') {
      return this.context_abyssPrivate.settings.projects.table;
    }
    return this.overviewMode_abyssPrivate === 'kanban'
      ? this.ensureKanbanSettings_abyssPrivate()
      : this.ensureTimelineSettings_abyssPrivate();
  }

  private effectiveActiveViewSettings_abyssPrivate():
    ProjectTableSettings | ProjectKanbanSettings | ProjectTimelineSettings {
    if (this.overviewMode_abyssPrivate === 'table')
      return this.effectiveTableSettings_abyssPrivate();
    return this.overviewMode_abyssPrivate === 'kanban'
      ? this.effectiveKanbanSettings_abyssPrivate()
      : this.effectiveTimelineSettings_abyssPrivate();
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
    const live = this.projects_abyssPrivate.filter(({ path }) =>
      this.isLiveProjectPath_abyssPrivate(path),
    );
    for (const [key, paths] of projectPathsByStatus(live)) {
      const existing = settings.manualOrder[key] ?? [];
      const sequence = appendUnrankedProjectPaths(existing, paths);
      if (sequence.length === existing.length && settings.manualOrder[key] !== undefined) continue;
      settings.manualOrder[key] = sequence;
      changed = true;
    }
    return changed;
  }

  /** Whether a project's note exists; an appender never ranks a path whose note is gone. */
  private isLiveProjectPath_abyssPrivate(path: string): boolean {
    return this.context_abyssPrivate.app.vault.getAbstractFileByPath(path) instanceof TFile;
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
      this.toolbar_abyssPrivate.setSearchValue(this.sessions_abyssPrivate[mode].search);
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
    this.kanbanView_abyssPrivate?.captureViewportBeforeHide();
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
    this.tableSurface_abyssPrivate.destroy();
    this.toolbar_abyssPrivate.destroy();
    this.creationComposer_abyssPrivate.destroy();
    this.creationPresentation_abyssPrivate.destroy();
    this.destroyOverviewSurfaces_abyssPrivate();
    this.stopListening_abyssPrivate();
    this.markdown_abyssPrivate.unload();
    this.root_abyssPrivate.remove();
  }

  private clearOverviewState_abyssPrivate(): void {
    for (const session of Object.values(this.sessions_abyssPrivate)) session.selection.clear();
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
    runAsyncAction(
      this.context_abyssPrivate.saveViewState(),
      'Could not save project view settings',
    );
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
    console.error('[abyss-tasks] Could not create project', { error });
    new Notice(projectCreationFailureNotice(error));
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
    if (this.overviewMode_abyssPrivate === 'table') {
      return this.presentCreatedTableProject_abyssPrivate(project, focus);
    }
    const surface = this.activeSurface_abyssPrivate();
    if (surface === undefined) return null;
    return this.presentCreatedSurfaceProject_abyssPrivate(surface, project, focus);
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

  /**
   * Opens the created project's group or column, then reveals, selects, and highlights its Name
   * cell: the Table's sequence below, run through the surface.
   */
  private presentCreatedSurfaceProject_abyssPrivate(
    surface: ProjectsOverviewSurface<RenderedCellContext>,
    project: Project,
    focus: boolean,
  ): HTMLElement | null {
    if (focus) {
      surface.revealProject(project.path);
      this.selection_abyssPrivate.reconcile(this.selectableCells_abyssPrivate());
    }
    const logical = surface
      .cells()
      .cells.find(
        ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
      );
    if (focus && logical !== undefined) surface.revealCell(logical.identity);
    const cell = surface
      .renderedCells()
      .find(
        ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
      );
    if (cell === undefined) return null;
    if (focus) this.selectAndRevealCreationCell_abyssPrivate(cell);
    return surface.occurrenceElement(cell);
  }

  private presentCreatedTableProject_abyssPrivate(
    project: Project,
    focus: boolean,
  ): HTMLElement | null {
    const model = buildProjectTableModel(this.projectTableModelInput_abyssPrivate());
    const group = model.groups.find(({ projects }) =>
      projects.some(({ path }) => path === project.path),
    );
    if (focus && group !== undefined && this.tableSurface_abyssPrivate.expandGroup(group.key)) {
      this.renderTable_abyssPrivate();
    }
    const logical = this.tableSurface_abyssPrivate
      .cells()
      .cells.find(
        ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
      );
    if (focus && logical !== undefined) this.revealLogicalCell_abyssPrivate(logical.identity);
    const cell = this.tableSurface_abyssPrivate
      .renderedCells()
      .find(
        ({ project: candidate, field }) => candidate.path === project.path && field.id === 'name',
      );
    if (cell === undefined) return null;
    if (focus) this.selectAndRevealCreationCell_abyssPrivate(cell);
    return cell.element.closest<HTMLElement>('.abyss-project-table-row') ?? cell.element;
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
    const session = this.sessions_abyssPrivate[this.overviewMode_abyssPrivate];
    if (session.search.length > 0 && !this.singletonVisible_abyssPrivate(project, session.search)) {
      session.search = '';
      this.toolbar_abyssPrivate.setSearchValue('');
      changed = true;
    }
    if (!changed) return;
    this.renderTable_abyssPrivate();
    this.persistSettings_abyssPrivate();
  }

  private timelineProjectIsUnscheduled_abyssPrivate(project: Project): boolean {
    const timeline = this.effectiveTimelineSettings_abyssPrivate();
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
      fields: this.renderFields_abyssPrivate(),
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
          settings: this.effectiveKanbanSettings_abyssPrivate(),
        }).uniqueVisibleCount > 0
      );
    }
    if (this.overviewMode_abyssPrivate === 'timeline') {
      return (
        buildProjectTimelineModel({
          ...common,
          settings: this.effectiveTimelineSettings_abyssPrivate(),
          tableSettings: this.context_abyssPrivate.settings.projects.table,
        }).uniqueVisibleCount > 0
      );
    }
    return (
      buildProjectTableModel({
        ...common,
        settings: this.effectiveTableSettings_abyssPrivate(),
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
    this.tableSurface_abyssPrivate.render(
      this.projectedProjects_abyssPrivate(),
      this.sessions_abyssPrivate.table.search,
      this.renderHooks_abyssPrivate,
    );
    this.notifyCreationReconciled_abyssPrivate();
  }

  /** The Table's visible columns, once their presets are compiled and relative dates timed. */
  private tableColumns_abyssPrivate(): readonly VisibleProjectColumn[] {
    const tableSettings = this.context_abyssPrivate.settings.projects.table;
    enforceProjectTableColumnInvariants(tableSettings);
    const columns = visibleProjectColumns(tableSettings.columns, this.renderFields_abyssPrivate());
    this.syncRelativeDateTimer_abyssPrivate(columns, tableSettings.dateDisplay);
    this.compiledPresets_abyssPrivate = new Map(
      columns.map(({ field }) => [
        field.id,
        compileProjectPropertyPresets(this.projectPropertyDefinition_abyssPrivate(field.id)),
      ]),
    );
    return columns;
  }

  private renderAlternativeSurface_abyssPrivate(): boolean {
    const mode = this.overviewMode_abyssPrivate;
    if (mode === 'table') return false;
    this.tableSurface_abyssPrivate.hide();
    const surface =
      mode === 'kanban'
        ? this.showKanbanSurface_abyssPrivate()
        : this.showTimelineSurface_abyssPrivate();
    surface.render(
      this.projectedProjects_abyssPrivate(),
      this.sessions_abyssPrivate[mode].search,
      this.renderHooks_abyssPrivate,
    );
    this.notifyCreationReconciled_abyssPrivate();
    return true;
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
    this.tableSurface_abyssPrivate.show();
    this.kanbanView_abyssPrivate?.hide();
    this.timelineView_abyssPrivate?.hide();
  }

  private renderFields_abyssPrivate(): readonly ProjectFieldCatalogItem[] {
    const projects = this.context_abyssPrivate.settings.projects;
    return hasAuthoritativeProjectPropertyDefinitions(projects)
      ? buildConfiguredProjectFieldCatalog(projects)
      : this.fields_abyssPrivate;
  }

  private effectiveTableSettings_abyssPrivate(): ProjectTableSettings {
    const projects = this.context_abyssPrivate.settings.projects;
    return effectiveConfiguredProjectViewSettings(projects, projects.table);
  }

  private effectiveKanbanSettings_abyssPrivate(): ProjectKanbanSettings {
    return effectiveConfiguredProjectViewSettings(
      this.context_abyssPrivate.settings.projects,
      this.ensureKanbanSettings_abyssPrivate(),
      this.effectiveTableSettings_abyssPrivate(),
    );
  }

  private effectiveTimelineSettings_abyssPrivate(): ProjectTimelineSettings {
    return effectiveConfiguredProjectViewSettings(
      this.context_abyssPrivate.settings.projects,
      this.ensureTimelineSettings_abyssPrivate(),
      this.effectiveTableSettings_abyssPrivate(),
    );
  }

  private projectTableModelInput_abyssPrivate(): ProjectTableModelInput {
    return {
      ...this.tableModelInputBase_abyssPrivate(),
      projects: this.projectedProjects_abyssPrivate(),
      search: this.sessions_abyssPrivate.table.search,
    };
  }

  /** The Table model input apart from the projects and search that each render passes in. */
  private tableModelInputBase_abyssPrivate(): Omit<ProjectTableModelInput, 'projects' | 'search'> {
    return {
      fields: this.renderFields_abyssPrivate(),
      statuses: this.context_abyssPrivate.settings.projects.statuses,
      settings: this.effectiveTableSettings_abyssPrivate(),
      propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
      nowMs: this.trackedNowMs_abyssPrivate,
      resolveLink: (target, sourcePath) =>
        this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
    };
  }

  /** Hides the Timeline, then shows the board, created on first use, with its card fields. */
  private showKanbanSurface_abyssPrivate(): ProjectsKanbanView<RenderedCellContext> {
    this.timelineView_abyssPrivate?.hide();
    const board = (this.kanbanView_abyssPrivate ??= this.createKanbanView_abyssPrivate());
    board.show();
    this.prepareCardFields_abyssPrivate(this.ensureKanbanSettings_abyssPrivate().fields);
    return board;
  }

  /** Hides the board, then shows the Timeline, created on first use, with its row fields. */
  private showTimelineSurface_abyssPrivate(): ProjectsTimelineView<RenderedCellContext> {
    this.kanbanView_abyssPrivate?.hide();
    const timeline = (this.timelineView_abyssPrivate ??= this.createTimelineView_abyssPrivate());
    timeline.show();
    this.prepareCardFields_abyssPrivate(
      projectTimelineFields(this.ensureTimelineSettings_abyssPrivate()),
    );
    return timeline;
  }

  /** Compiles the presets of a Kanban or Timeline view's fields and times their relative dates. */
  private prepareCardFields_abyssPrivate(columns: readonly ProjectColumn[]): void {
    this.compiledPresets_abyssPrivate = new Map(
      columns.map(({ id }) => [
        id,
        compileProjectPropertyPresets(this.projectPropertyDefinition_abyssPrivate(id)),
      ]),
    );
    const relativeColumns = columns.flatMap((column) => {
      const field = findProjectFieldById(this.fields_abyssPrivate, column.id);
      return field === undefined ? [] : [{ column, field }];
    });
    this.syncRelativeDateTimer_abyssPrivate(relativeColumns);
  }

  private createTimelineView_abyssPrivate(): ProjectsTimelineView<RenderedCellContext> {
    const timeline = new ProjectsTimelineView<RenderedCellContext>(this.root_abyssPrivate, {
      settings: () => this.effectiveTimelineSettings_abyssPrivate(),
      modelInput: () => ({
        nowMs: this.trackedNowMs_abyssPrivate,
        fields: this.renderFields_abyssPrivate(),
        statuses: this.context_abyssPrivate.settings.projects.statuses,
        propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
        tableSettings: this.context_abyssPrivate.settings.projects.table,
        resolveLink: (target, sourcePath) =>
          this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
            ?.path,
      }),
      effectiveField: (project, field) => this.effectiveField_abyssPrivate(project, field),
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
        const rendered = this.timelineView_abyssPrivate
          ?.renderedCells()
          .find(
            ({ identity }) =>
              identity.occurrenceId === occurrenceId && identity.columnId === 'name',
          );
        if (rendered === undefined) return;
        this.selectCell_abyssPrivate(rendered, false);
        this.showDescriptionMenu_abyssPrivate(rendered, event);
      },
    });
    this.tableSurface_abyssPrivate.scroll.after(timeline.root);
    return timeline;
  }

  private createKanbanView_abyssPrivate(): ProjectsKanbanView<RenderedCellContext> {
    const board = new ProjectsKanbanView<RenderedCellContext>(this.root_abyssPrivate, {
      beginDrag: () => this.beginProjectDrag_abyssPrivate(),
      settings: () => this.effectiveKanbanSettings_abyssPrivate(),
      modelInput: () => ({
        nowMs: this.trackedNowMs_abyssPrivate,
        fields: this.renderFields_abyssPrivate(),
        statuses: this.context_abyssPrivate.settings.projects.statuses,
        propertyDefinitions: this.context_abyssPrivate.settings.projects.propertyDefinitions,
        resolveLink: (target, sourcePath) =>
          this.context_abyssPrivate.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
            ?.path,
      }),
      effectiveField: (project, field) => this.effectiveField_abyssPrivate(project, field),
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
      isLiveProjectPath: (path) => this.isLiveProjectPath_abyssPrivate(path),
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
    this.tableSurface_abyssPrivate.scroll.after(board.root);
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
    plan: Extract<ProjectTimelineEndpointEditPlan, { readonly kind: 'ready' }>,
  ): readonly ProjectCellChange[] {
    const endpoint = (
      evidence: ProjectTimelineEndpointEvidence,
      desired: ProjectTimelineRawEndpoint,
    ): {
      readonly changed: boolean;
      readonly change: ProjectCellChange;
    } => {
      const desiredExists = desired.exists;
      const desiredValue = desired.value;
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
    const start = endpoint(source.start, plan.start);
    const end = endpoint(source.end, plan.end);
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
        const source = request.kind === 'pointer' ? request.source : current;
        const plan = planProjectTimelineEndpointEdit(
          source.range,
          {
            start: { exists: source.start.expectedExists, value: source.start.expectedValue },
            end: { exists: source.end.expectedExists, value: source.end.expectedValue },
          },
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

  private sortByColumn_abyssPrivate(field: string): void {
    this.transitionTableSort_abyssPrivate(field);
    this.persistAndRender_abyssPrivate();
  }

  private transitionTableSort_abyssPrivate(field: string): void {
    const table = this.context_abyssPrivate.settings.projects.table;
    if (field === 'none') table.sortBy = { field: 'none', dir: 'asc' };
    else if (!sameProjectPropertyName(table.sortBy.field, field))
      table.sortBy = { field, dir: 'asc' };
    else if (table.sortBy.dir === 'asc') table.sortBy = { field, dir: 'desc' };
    else table.sortBy = { field: 'none', dir: 'asc' };
  }

  private projectColumnTypeChoices_abyssPrivate(columnId: string): readonly ProjectPropertyType[] {
    if (this.context_abyssPrivate.saveStatic === undefined || !columnId.startsWith('property:')) {
      return [];
    }
    const projects = this.context_abyssPrivate.settings.projects;
    if (
      projects.propertyDefinitionsVersion !== undefined &&
      !hasAuthoritativeProjectPropertyDefinitions(projects)
    )
      return [];
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
    writeClass(cell, 'abyss-project-table-cell', true);
    for (const option of ['left', 'center', 'right']) {
      writeClass(cell, `is-align-${option}`, alignment === option);
    }
    writeClass(cell, 'abyss-project-table-name-cell', field.type === 'name');
    writeOptionalAttribute(cell, 'tabindex', '0');
    writeOptionalAttribute(cell, 'data-column-id', rendered.identity.columnId);
    writeOptionalAttribute(cell, 'aria-label', `${field.label} for ${project.name}`);
    writeOptionalAttribute(
      cell,
      'aria-description',
      field.type === 'name' ? 'Use the context menu to add or edit the description' : undefined,
    );
    writeOptionalAttribute(
      cell,
      'aria-keyshortcuts',
      field.type === 'name' ? 'Shift+F10' : undefined,
    );
    const invalidRange =
      (field.id === 'start' || field.id === 'end') &&
      this.projectHasInvalidRange_abyssPrivate(project);
    writeClass(cell, 'is-invalid-range', invalidRange);
    if (invalidRange) {
      writeOptionalAttribute(cell, 'aria-invalid', 'true');
      writeOptionalAttribute(cell, 'title', 'Project start is after its end date');
    } else {
      writeOptionalAttribute(cell, 'aria-invalid', undefined);
      writeOptionalAttribute(cell, 'title', undefined);
    }
    writeClass(cell, 'is-editable', editableField(field));
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

  private selectableCells_abyssPrivate(): readonly ProjectTableSelectableCell[] {
    return this.overviewCells_abyssPrivate().identities;
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

  private logicalCells_abyssPrivate(): readonly ProjectOverviewCell[] {
    return this.overviewCells_abyssPrivate().cells;
  }

  private logicalCell_abyssPrivate(
    identity: ProjectTableSelectableCell,
  ): ProjectOverviewCell | undefined {
    return this.overviewCells_abyssPrivate().cell(identity.occurrenceId, identity.columnId);
  }

  private selectedCells_abyssPrivate(): ProjectOverviewCell[] {
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
    return this.activeSurface_abyssPrivate()?.scroll ?? this.tableSurface_abyssPrivate.scroll;
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
    const active = this.root_abyssPrivate.ownerDocument.activeElement;
    for (const cell of this.renderedCells_abyssPrivate) {
      const key = `${cell.identity.occurrenceId}\u0000${cell.identity.columnId}`;
      writeClass(cell.element, 'is-selected', selected.has(key));
      writeClass(
        cell.element,
        'is-selection-focus',
        focus?.occurrenceId === cell.identity.occurrenceId &&
          focus.columnId === cell.identity.columnId &&
          active === cell.element &&
          !this.nativeMenuOpen_abyssPrivate,
      );
      writeOptionalAttribute(cell.element, 'aria-selected', String(selected.has(key)));
    }
  }

  private syncOverviewSelectedProject_abyssPrivate(
    focus: ProjectTableSelectableCell | undefined,
  ): void {
    if (this.overviewMode_abyssPrivate === 'table') return;
    const path =
      focus === undefined ? undefined : this.logicalCell_abyssPrivate(focus)?.project.path;
    this.activeSurface_abyssPrivate()?.syncSelectedProjectPath(path);
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
    return cellContaining(this.renderedCells_abyssPrivate, target);
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
    if (this.overviewMode_abyssPrivate !== 'table') {
      this.activeSurface_abyssPrivate()?.revealCell(identity);
      return;
    }
    this.tableSurface_abyssPrivate.revealCell(identity);
  }

  private revealSelectionCell_abyssPrivate(cell: HTMLElement): void {
    const surface = this.activeSurface_abyssPrivate();
    const rendered = this.renderedCells_abyssPrivate.find(({ element }) => element === cell);
    if (surface !== undefined && rendered !== undefined) {
      surface.scrollCellIntoView(rendered);
      return;
    }
    this.tableSurface_abyssPrivate.scrollCellIntoView(cell);
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

  private rowIds_abyssPrivate(): readonly string[] {
    return this.overviewCells_abyssPrivate().rowIds;
  }

  private columnIds_abyssPrivate(): readonly string[] {
    return this.overviewCells_abyssPrivate().columnIds;
  }

  private cellAt_abyssPrivate(row: number, column: number): ProjectOverviewCell | undefined {
    const occurrenceId = this.rowIds_abyssPrivate()[row];
    const columnId = this.columnIds_abyssPrivate()[column];
    if (occurrenceId === undefined || columnId === undefined) return undefined;
    return this.overviewCells_abyssPrivate().cell(occurrenceId, columnId);
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

  private clipboardValue_abyssPrivate(cell: ProjectOverviewCell): unknown {
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

  private changeForCell_abyssPrivate(cell: ProjectOverviewCell, value: unknown): ProjectCellChange {
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
      this.tableSurface_abyssPrivate.renderWindow();
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
    const source = this.tableSurface_abyssPrivate.group(payload.sourceGroupKey);
    const target = this.tableSurface_abyssPrivate.group(targetGroupKey);
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
      this.effectiveTableSettings_abyssPrivate().groupBy,
    );
    if (groupField === undefined) throw new Error('Project grouping field is unavailable');
    const effective = this.effectiveField_abyssPrivate(visibleProject, groupField);
    const cell: ProjectOverviewCell = {
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
    const targetRows = this.tableSurface_abyssPrivate.displayedGroupRows(targetGroupKey);
    const groupRow = this.tableSurface_abyssPrivate.groupRow(targetGroupKey);
    const rows = [groupRow?.element, ...targetRows.map(({ element }) => element)].filter(
      (row) => row !== undefined,
    );
    const state = result.allowed ? 'is-drop-target' : 'is-drop-disabled';
    for (const row of rows) {
      row.addClass(state);
      row.setAttribute('title', result.message);
    }
    markDropRunEnds(targetRows, state);
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
    if (this.tableSurface_abyssPrivate.isGroupCollapsed(targetGroupKey)) return {};
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
      row.removeClass('is-drop-target', 'is-drop-disabled', 'is-drop-end');
      row.removeAttribute('title');
    }
    preview.line?.removeClass('is-drop-before', 'is-drop-after');
    this.tableSurface_abyssPrivate.groupRow(preview.targetGroupKey)?.dropHint.empty();
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
    const activeElement = this.root_abyssPrivate.ownerDocument.activeElement;
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
    if (activeElement === this.root_abyssPrivate.ownerDocument.body) return false;
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
    const frame =
      rendered === undefined ? undefined : this.activeSurface_abyssPrivate()?.editorFrame(rendered);
    const tableFrame = this.tableSurface_abyssPrivate.editorFrame();
    const stickyHeader = frame?.stickyHeader ?? tableFrame.stickyHeader;
    return mountProjectCellEditorPosition({
      anchor,
      host,
      boundary: frame?.boundary ?? tableFrame.boundary,
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
    this.timelineView_abyssPrivate?.setEditingCell(cell);
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
    this.timelineView_abyssPrivate?.setEditingCell(undefined);
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
