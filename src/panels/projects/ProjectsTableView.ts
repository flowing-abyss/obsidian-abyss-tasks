import { Menu } from 'obsidian';
import {
  ProjectPropertyAdapter,
  parseProjectPropertyEditorValue,
  projectPropertyEditorValue,
  type ProjectPropertyDescriptor,
  type ProjectPropertyWrite,
  type PublicBasesDescriptor,
} from '../../projects/properties/ProjectPropertyAdapter';
import type { ProjectPropertyWriteResult } from '../../projects/properties/ProjectPropertyCommands';
import type { ProjectWorkspaceSnapshot } from '../../projects/types';
import type {
  CalendarSettings,
  PortfolioGroupBy,
  PortfolioSort,
  ProjectsTablePreference,
} from '../../settings/types';
import { EntityPresentation } from '../../ui/entity/EntityPresentation';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import {
  resizeTableColumn,
  safeFieldLabel,
  setTableGroupCollapsed,
} from '../../ui/table/TablePreferences';
import { renderVirtualTable, type VirtualTableHandle } from '../../ui/table/VirtualTable';

const DEFAULT_COLUMNS = [
  ['project', 'Project'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['progress', 'Progress'],
  ['nextAction', 'Next action'],
  ['start', 'Start'],
  ['end', 'End'],
] as const;

export function projectTableFields(
  snapshots: readonly ProjectWorkspaceSnapshot[],
  bases: readonly PublicBasesDescriptor[] = [],
): readonly (readonly [string, string])[] {
  const labels = new Map<string, string>(DEFAULT_COLUMNS);
  const adapter = new ProjectPropertyAdapter();
  for (const snapshot of snapshots) {
    for (const descriptor of adapter.describeAll(snapshot.project.frontmatter, bases)) {
      if (!labels.has(descriptor.id)) labels.set(descriptor.id, descriptor.displayName);
    }
  }
  return [...labels];
}

export interface ProjectsTableOptions {
  readonly settings: CalendarSettings;
  readonly onOpen: (path: string) => void;
  readonly onOpenNote?: (path: string) => void;
  readonly preference?: ProjectsTablePreference;
  readonly onPreferenceChange?: (next: ProjectsTablePreference) => void;
  readonly groupBy?: PortfolioGroupBy;
  readonly sortBy?: PortfolioSort;
  /** Guarded generic writer. Built-in lifecycle/range fields use specialised callbacks. */
  readonly onWriteProperty?: (write: ProjectPropertyWrite) => Promise<ProjectPropertyWriteResult>;
  readonly onSetStatus?: (path: string, statusId: string) => Promise<{ readonly type: string }>;
  readonly onSetPriority?: (
    path: string,
    priority: ProjectWorkspaceSnapshot['project']['priority'],
  ) => Promise<{ readonly type: string }>;
  readonly onSetRange?: (
    path: string,
    endpoint: 'start' | 'end',
    raw: string | null,
  ) => Promise<{ readonly type: string }>;
  /** Optional public Bases descriptors augment native frontmatter inference. */
  readonly bases?: readonly PublicBasesDescriptor[];
}

function columns(
  preference: ProjectsTablePreference,
  snapshots: readonly ProjectWorkspaceSnapshot[],
  bases: readonly PublicBasesDescriptor[],
): readonly { readonly id: string; readonly label: string; readonly width?: number }[] {
  const labels = new Map(projectTableFields(snapshots, bases));
  return preference.columns
    .filter(({ visible }) => visible)
    .map(({ propertyId, width }) => ({
      id: propertyId,
      label: labels.get(propertyId) ?? safeFieldLabel(propertyId),
      width,
    }));
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}

function projectSortValue(
  snapshot: ProjectWorkspaceSnapshot,
  field: Exclude<PortfolioSort['field'], 'progress'>,
): string | undefined {
  if (field === 'title') return snapshot.project.name;
  if (field === 'status')
    return snapshot.project.statusId ?? snapshot.project.rawStatus ?? undefined;
  if (field === 'priority') return snapshot.project.priority ?? undefined;
  return snapshot.project.range[field]?.raw;
}

function compareProgress(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function sortProjects(
  snapshots: readonly ProjectWorkspaceSnapshot[],
  sort: PortfolioSort,
): readonly ProjectWorkspaceSnapshot[] {
  const direction = sort.dir === 'asc' ? 1 : -1;
  return [...snapshots].sort((left, right) => {
    const explicit =
      sort.field === 'progress'
        ? compareProgress(left.taskRollup.progress, right.taskRollup.progress)
        : compareOptional(projectSortValue(left, sort.field), projectSortValue(right, sort.field));
    return explicit === 0
      ? left.project.path.localeCompare(right.project.path)
      : explicit * direction;
  });
}

function projectGroups(
  snapshots: readonly ProjectWorkspaceSnapshot[],
  groupBy: PortfolioGroupBy,
  preference: ProjectsTablePreference,
  settings: CalendarSettings,
) {
  if (groupBy === 'none') return undefined;
  const buckets = new Map<string, { label: string; rows: ProjectWorkspaceSnapshot[] }>();
  for (const snapshot of snapshots) {
    let value: string;
    let label: string;
    if (groupBy === 'status') {
      value = snapshot.project.statusId ?? '__unmapped__';
      label =
        settings.projects.statuses.find(({ id }) => id === snapshot.project.statusId)?.label ??
        snapshot.project.rawStatus ??
        'No status';
    } else {
      value = snapshot.project.priority ?? 'none';
      label = snapshot.project.priority ? `Priority ${snapshot.project.priority}` : 'No priority';
    }
    const key = `${groupBy}:${value}`;
    const bucket = buckets.get(key) ?? { label, rows: [] };
    bucket.rows.push(snapshot);
    buckets.set(key, bucket);
  }
  const priorityOrder = new Map(['A', 'B', 'C', 'D', 'E', 'F', 'none'].map((key, i) => [key, i]));
  const statusOrder = new Map(settings.projects.statuses.map(({ id }, i) => [id, i]));
  return [...buckets.entries()]
    .sort(([left], [right]) => {
      const leftValue = left.slice(groupBy.length + 1);
      const rightValue = right.slice(groupBy.length + 1);
      const order = groupBy === 'priority' ? priorityOrder : statusOrder;
      return (
        (order.get(leftValue) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(rightValue) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
      );
    })
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      rows: bucket.rows,
      collapsed: preference.collapsedGroups.includes(key),
    }));
}

function makeCellFocusable(cell: HTMLElement, value: string, activate: () => void): void {
  cell.tabIndex = 0;
  if (value) {
    cell.title = value;
    cell.setAttribute('aria-label', value);
  }
  cell.addEventListener('keydown', (event) => {
    if (event.target !== cell || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
}

function makeEditableCell(cell: HTMLElement, value: string, renderEditor: () => void): void {
  const activate = (): void => {
    cell.empty();
    renderEditor();
    cell.querySelector<HTMLElement>('input, select, textarea, button')?.focus({
      preventScroll: true,
    });
  };
  makeCellFocusable(cell, value, activate);
  cell.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
  if (value) cell.createSpan({ text: value, attr: { title: value } });
}

function propertyDescriptor(
  adapter: ProjectPropertyAdapter,
  snapshot: ProjectWorkspaceSnapshot,
  id: string,
  bases: readonly PublicBasesDescriptor[],
): ProjectPropertyDescriptor {
  return adapter.describe(
    id,
    snapshot.project.frontmatter[id],
    bases.find((descriptor) => descriptor.id === id),
  );
}

function editorType(kind: ProjectPropertyDescriptor['kind']): string | null {
  if (kind === 'number') return 'number';
  if (kind === 'checkbox') return 'checkbox';
  if (kind === 'date') return 'date';
  if (kind === 'datetime') return 'datetime-local';
  if (kind === 'text' || kind === 'link' || kind === 'list' || kind === 'tags') return 'text';
  return null;
}

function resultMessage(
  result: Exclude<ProjectPropertyWriteResult, { readonly type: 'ok' }>,
): string {
  if (result.type === 'conflict') return 'This property changed elsewhere.';
  if (result.type === 'unsupported') return 'This property is read-only.';
  if (result.type === 'io-error') return 'Could not save this property.';
  if (result.type === 'invalid') return 'This property value is invalid.';
  return '';
}

function renderPropertyEditor(
  cell: HTMLElement,
  descriptor: ProjectPropertyDescriptor,
  observed: unknown,
  path: string,
  options: ProjectsTableOptions,
): void {
  const type = editorType(descriptor.kind);
  if (!type || !descriptor.writable) return;
  const input = cell.createEl('input', {
    cls: 'abyss-table-property-editor',
    attr: {
      type,
      'data-property-editor': descriptor.id,
      'aria-label': `Edit ${descriptor.displayName}`,
    },
  });
  let settled = observed;
  const restore = (): void => {
    if (type === 'checkbox') input.checked = settled === true;
    else input.value = projectPropertyEditorValue(descriptor, settled);
    const value = projectPropertyEditorValue(descriptor, settled);
    if (value) {
      input.title = value;
      input.setAttribute('aria-label', `Edit ${descriptor.displayName}: ${value}`);
    }
  };
  restore();
  const feedback = cell.createSpan({
    cls: 'abyss-table-property-feedback',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  const commit = async (): Promise<void> => {
    const parsed = parseProjectPropertyEditorValue(descriptor, input.value, input.checked);
    if (parsed.type === 'invalid') {
      feedback.textContent = 'Enter a valid value.';
      restore();
      return;
    }
    if (!options.onWriteProperty) {
      feedback.textContent = 'Property editing is unavailable.';
      restore();
      return;
    }
    input.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      const result = await options.onWriteProperty({
        path,
        propertyId: descriptor.id,
        expected: settled,
        next: parsed.value,
      });
      if (result.type === 'ok') {
        settled = result.value;
        feedback.textContent = '';
      } else if (result.type === 'unchanged') {
        feedback.textContent = '';
      } else {
        if (result.type === 'conflict') settled = result.current;
        feedback.textContent = resultMessage(result);
        restore();
      }
    } catch {
      feedback.textContent = 'Could not save this property.';
      restore();
    } finally {
      input.disabled = false;
    }
  };
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
      input.blur();
    } else if (event.key === 'Enter' && type !== 'checkbox') {
      event.preventDefault();
      void commit();
    }
  });
  input.addEventListener('change', () => void commit());
}

function renderOwnedSelect(
  cell: HTMLElement,
  label: string,
  value: string | null,
  entries: readonly { readonly value: string; readonly label: string }[],
  onCommit: ((next: string | null) => Promise<{ readonly type: string }>) | undefined,
): void {
  const select = cell.createEl('select', {
    cls: 'abyss-table-property-editor',
    attr: { 'data-property-editor': label.toLowerCase(), 'aria-label': `Edit ${label}` },
  });
  select.createEl('option', { value: '', text: 'None' });
  for (const entry of entries) select.createEl('option', { value: entry.value, text: entry.label });
  select.value = value ?? '';
  let settled = value ?? '';
  const feedback = cell.createSpan({
    cls: 'abyss-table-property-feedback',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  const restore = (): void => {
    select.value = settled;
    const value = select.selectedOptions[0]?.textContent ?? '';
    if (value) {
      select.title = value;
      select.setAttribute('aria-label', `Edit ${label}: ${value}`);
    }
  };
  select.addEventListener('click', (event) => event.stopPropagation());
  select.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
      select.blur();
    }
  });
  select.addEventListener('change', () => {
    const next = select.value || null;
    if (!onCommit) {
      feedback.textContent = 'Property editing is unavailable.';
      restore();
      return;
    }
    select.disabled = true;
    feedback.textContent = 'Saving…';
    void onCommit(next)
      .then((result) => {
        if (result.type === 'ok' || result.type === 'unchanged') {
          settled = next ?? '';
          feedback.textContent = '';
        } else {
          feedback.textContent = 'This property could not be saved.';
          restore();
        }
      })
      .catch(() => {
        feedback.textContent = 'This property could not be saved.';
        restore();
      })
      .finally(() => {
        select.disabled = false;
      });
  });
}

function renderRangeEditor(
  cell: HTMLElement,
  endpoint: 'start' | 'end',
  raw: string | undefined,
  options: ProjectsTableOptions,
  path: string,
): void {
  const input = cell.createEl('input', {
    cls: 'abyss-table-property-editor',
    attr: { type: 'date', 'data-property-editor': endpoint, 'aria-label': `Edit ${endpoint}` },
  });
  let settled = raw ?? '';
  input.value = settled;
  const feedback = cell.createSpan({
    cls: 'abyss-table-property-feedback',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  const restore = (): void => {
    input.value = settled;
    if (settled) {
      input.title = settled;
      input.setAttribute('aria-label', `Edit ${endpoint}: ${settled}`);
    }
  };
  const commit = async (): Promise<void> => {
    if (!options.onSetRange) {
      feedback.textContent = 'Property editing is unavailable.';
      restore();
      return;
    }
    input.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      const result = await options.onSetRange(path, endpoint, input.value || null);
      if (result.type === 'ok' || result.type === 'unchanged') {
        settled = input.value;
        feedback.textContent = '';
      } else {
        feedback.textContent = 'This property could not be saved.';
        restore();
      }
    } catch {
      feedback.textContent = 'This property could not be saved.';
      restore();
    } finally {
      input.disabled = false;
    }
  };
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
      input.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    }
  });
  input.addEventListener('change', () => void commit());
}

function showProjectMenu(
  event: MouseEvent,
  snapshot: ProjectWorkspaceSnapshot,
  options: ProjectsTableOptions,
): void {
  event.preventDefault();
  event.stopPropagation();
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle('Open project')
      .setIcon('folder-open')
      .onClick(() => options.onOpen(snapshot.project.path)),
  );
  if (options.onOpenNote) {
    menu.addItem((item) =>
      item
        .setTitle('Open note')
        .setIcon('file-text')
        .onClick(() => options.onOpenNote!(snapshot.project.path)),
    );
  }
  const statusMenu = (
    menu.addItem((item) => item.setTitle('Status')) as unknown as { setSubmenu(): Menu }
  ).setSubmenu();
  for (const status of options.settings.projects.statuses) {
    statusMenu.addItem((item) =>
      item
        .setTitle(status.label)
        .setChecked(snapshot.project.statusId === status.id)
        .onClick(() => {
          if (options.onSetStatus) void options.onSetStatus(snapshot.project.path, status.id);
        }),
    );
  }
  const priorityMenu = (
    menu.addItem((item) => item.setTitle('Priority')) as unknown as { setSubmenu(): Menu }
  ).setSubmenu();
  for (const priority of ['A', 'B', 'C', 'D', 'E', 'F'] as const) {
    priorityMenu.addItem((item) =>
      item
        .setTitle(priority)
        .setChecked(snapshot.project.priority === priority)
        .onClick(() => {
          if (options.onSetPriority) void options.onSetPriority(snapshot.project.path, priority);
        }),
    );
  }
  showMenuAtMouseEventWithFocus(menu, event);
}

/** Portfolio overview adapter. Projection-only: snapshots stay owned by ProjectWorkspaceCoordinator. */
export function renderProjectsTable(
  parent: HTMLElement,
  snapshots: readonly ProjectWorkspaceSnapshot[],
  options: ProjectsTableOptions,
): VirtualTableHandle {
  const preference = options.preference ?? options.settings.projects.view.table;
  const adapter = new ProjectPropertyAdapter(options.settings.projects.statuses);
  const tableColumns = columns(preference, snapshots, options.bases ?? []);
  const ordered = sortProjects(
    snapshots,
    options.sortBy ??
      options.settings.projects.view.portfolioSortBy ?? { field: 'title', dir: 'asc' },
  );
  const groups = projectGroups(
    ordered,
    options.groupBy ?? options.settings.projects.view.portfolioGroupBy ?? 'none',
    preference,
    options.settings,
  );
  const table = renderVirtualTable(parent, {
    columns: tableColumns,
    rows: ordered,
    ...(groups ? { groups } : {}),
    key: ({ project }) => project.path,
    label: 'Projects overview table',
    onColumnResize: (propertyId, width) =>
      options.onPreferenceChange?.(resizeTableColumn(preference, propertyId, width)),
    onGroupToggle: (groupKey, collapsed) =>
      options.onPreferenceChange?.(setTableGroupCollapsed(preference, groupKey, collapsed)),
    renderRow: (snapshot, host) => {
      const row = host.createDiv({
        cls: 'abyss-virtual-table-row',
        attr: { role: 'row', tabindex: '0', 'data-project-table-row': snapshot.project.path },
      });
      const open = (): void => options.onOpen(snapshot.project.path);
      row.addEventListener('dblclick', open);
      row.addEventListener('keydown', (event) => {
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      for (const column of tableColumns) {
        const cell = row.createDiv({
          cls: 'abyss-virtual-table-cell',
          attr: { role: 'cell', tabindex: '0', 'data-table-column': column.id },
        });
        let value: string;
        switch (column.id) {
          case 'project': {
            new EntityPresentation({
              identity: snapshot.project.name,
              priority: snapshot.project.priority,
              actions: [
                {
                  label: 'Project actions',
                  icon: 'ellipsis',
                  onClick: (event) => showProjectMenu(event, snapshot, options),
                },
              ],
            }).render(cell);
            cell.addEventListener('contextmenu', (event) =>
              showProjectMenu(event, snapshot, options),
            );
            makeCellFocusable(cell, snapshot.project.name, open);
            continue;
          }
          case 'status': {
            const value =
              options.settings.projects.statuses.find(({ id }) => id === snapshot.project.statusId)
                ?.label ??
              snapshot.project.rawStatus ??
              '';
            makeEditableCell(cell, value, () =>
              renderOwnedSelect(
                cell,
                'Status',
                snapshot.project.statusId,
                options.settings.projects.statuses.map((status) => ({
                  value: status.id,
                  label: status.label,
                })),
                options.onSetStatus
                  ? (next) =>
                      next
                        ? options.onSetStatus!(snapshot.project.path, next)
                        : Promise.resolve({ type: 'invalid' })
                  : undefined,
              ),
            );
            continue;
          }
          case 'priority': {
            const value = snapshot.project.priority ?? '';
            makeEditableCell(cell, value, () =>
              renderOwnedSelect(
                cell,
                'Priority',
                snapshot.project.priority ?? null,
                ['A', 'B', 'C', 'D', 'E', 'F'].map((priority) => ({
                  value: priority,
                  label: priority,
                })),
                options.onSetPriority
                  ? (next) =>
                      options.onSetPriority!(
                        snapshot.project.path,
                        next as ProjectWorkspaceSnapshot['project']['priority'],
                      )
                  : undefined,
              ),
            );
            continue;
          }
          case 'progress':
            value =
              snapshot.taskRollup.progress === null
                ? ''
                : `${Math.round(snapshot.taskRollup.progress * 100)}%`;
            break;
          case 'nextAction':
            value = snapshot.tasks.some(({ task }) => task.tags?.includes('#task/next_action'))
              ? 'Next action'
              : '';
            break;
          case 'start':
            makeEditableCell(cell, snapshot.project.range.start?.raw ?? '', () =>
              renderRangeEditor(
                cell,
                'start',
                snapshot.project.range.start?.raw,
                options,
                snapshot.project.path,
              ),
            );
            continue;
          case 'end':
            makeEditableCell(cell, snapshot.project.range.end?.raw ?? '', () =>
              renderRangeEditor(
                cell,
                'end',
                snapshot.project.range.end?.raw,
                options,
                snapshot.project.path,
              ),
            );
            continue;
          default: {
            const descriptor = propertyDescriptor(
              adapter,
              snapshot,
              column.id,
              options.bases ?? [],
            );
            value = adapter.display(snapshot.project.frontmatter[column.id]);
            if (descriptor.writable && editorType(descriptor.kind)) {
              makeEditableCell(cell, value, () =>
                renderPropertyEditor(
                  cell,
                  descriptor,
                  snapshot.project.frontmatter[column.id],
                  snapshot.project.path,
                  options,
                ),
              );
              continue;
            }
          }
        }
        makeCellFocusable(cell, value, open);
        if (value) cell.createSpan({ text: value, attr: { title: value } });
      }
      return row;
    },
  });
  return table;
}
