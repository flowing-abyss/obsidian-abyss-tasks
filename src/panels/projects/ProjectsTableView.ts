import { Menu, setIcon } from 'obsidian';
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
import type { CalendarSettings, ProjectsTablePreference } from '../../settings/types';
import { EntityPresentation } from '../../ui/entity/EntityPresentation';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
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

export interface ProjectsTableOptions {
  readonly settings: CalendarSettings;
  readonly onOpen: (path: string) => void;
  readonly preference?: ProjectsTablePreference;
  readonly onPreferenceChange?: (next: ProjectsTablePreference) => void;
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
  const labels = new Map<string, string>(DEFAULT_COLUMNS);
  const adapter = new ProjectPropertyAdapter();
  for (const snapshot of snapshots) {
    for (const descriptor of adapter.describeAll(snapshot.project.frontmatter, bases)) {
      if (!labels.has(descriptor.id)) labels.set(descriptor.id, descriptor.displayName);
    }
  }
  return preference.columns
    .filter(({ visible }) => visible)
    .map(({ propertyId, width }) => ({
      id: propertyId,
      label: labels.get(propertyId) ?? propertyId,
      width,
    }));
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
  const adapter = new ProjectPropertyAdapter();
  const table = renderVirtualTable(parent, {
    columns: columns(preference, snapshots, options.bases ?? []),
    rows: [...snapshots],
    key: ({ project }) => project.path,
    label: 'Projects overview table',
    renderRow: (snapshot, host) => {
      const row = host.createDiv({
        cls: 'abyss-virtual-table-row',
        attr: { role: 'row', tabindex: '0', 'data-project-table-row': snapshot.project.path },
      });
      const open = (): void => options.onOpen(snapshot.project.path);
      row.addEventListener('dblclick', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      for (const column of columns(preference, snapshots, options.bases ?? [])) {
        const cell = row.createDiv({
          cls: 'abyss-virtual-table-cell',
          attr: { role: 'cell', 'data-table-column': column.id },
        });
        let value: string;
        switch (column.id) {
          case 'project': {
            new EntityPresentation({
              identity: snapshot.project.name,
              priority: snapshot.project.priority,
            }).render(cell);
            const menu = cell.createEl('button', {
              cls: 'abyss-project-overflow-btn',
              attr: { type: 'button', 'aria-label': 'Project actions', title: 'Project actions' },
            });
            setIcon(menu, 'ellipsis');
            menu.addEventListener('click', (event) => showProjectMenu(event, snapshot, options));
            cell.addEventListener('contextmenu', (event) =>
              showProjectMenu(event, snapshot, options),
            );
            continue;
          }
          case 'status': {
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
            );
            continue;
          }
          case 'priority':
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
            );
            continue;
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
            renderRangeEditor(
              cell,
              'start',
              snapshot.project.range.start?.raw,
              options,
              snapshot.project.path,
            );
            continue;
          case 'end':
            renderRangeEditor(
              cell,
              'end',
              snapshot.project.range.end?.raw,
              options,
              snapshot.project.path,
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
            renderPropertyEditor(
              cell,
              descriptor,
              snapshot.project.frontmatter[column.id],
              snapshot.project.path,
              options,
            );
            if (cell.querySelector('[data-property-editor]')) continue;
          }
        }
        if (value) cell.createSpan({ text: value, attr: { title: value } });
      }
      return row;
    },
  });
  return table;
}
