import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import { isProjectStatusField, projectFieldValue } from '../../projects/projectFields';
import {
  projectProgress,
  projectProgressDisplayValue,
  projectTableDisplayValues,
} from '../../projects/projectTableModel';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';

function statusFor(
  project: Project,
  statuses: readonly ProjectStatus[],
): ProjectStatus | undefined {
  return project.statusId === null ? undefined : statuses.find(({ id }) => id === project.statusId);
}

function renderProgress(cell: HTMLElement, project: Project): void {
  const progress = projectProgress(project.stats);
  const root = cell.createDiv({
    cls: `abyss-project-table-progress${progress.percent === null ? ' is-empty' : ''}`,
    attr: {
      'aria-label':
        progress.percent === null
          ? 'No included tasks'
          : `${progress.percent}% (${progress.done}/${progress.total})`,
    },
  });
  const segments = root.createDiv({
    cls: 'abyss-project-progress-segments',
    attr: { 'aria-hidden': 'true' },
  });
  const filled = progress.percent === null ? 0 : Math.round(progress.percent / 10);
  for (let index = 0; index < 10; index += 1) {
    segments.createSpan({
      cls: `abyss-project-progress-segment${index < filled ? ' is-filled' : ''}`,
    });
  }
  root.createSpan({
    cls: 'abyss-project-progress-value',
    text: projectProgressDisplayValue(project.stats),
  });
}

function renderStatus(
  cell: HTMLElement,
  project: Project,
  field: ProjectFieldCatalogItem,
  statuses: readonly ProjectStatus[],
): void {
  const status = statusFor(project, statuses);
  const pill = cell.createSpan({
    cls: 'abyss-project-table-status-pill',
    text: projectTableDisplayValues(project, field, statuses)[0] ?? 'No status',
  });
  if (status?.color !== undefined && status.color.length > 0) {
    pill.style.setProperty('--abyss-project-status-color', status.color);
  }
  renderUnavailableType(cell, field);
}

function renderUnavailableType(cell: HTMLElement, field: ProjectFieldCatalogItem): void {
  if (field.type !== null) return;
  const explanation = `${field.property} is read-only because its Obsidian property type is unavailable`;
  cell.createSpan({
    cls: 'abyss-project-table-unavailable',
    text: 'Type unavailable',
    attr: { role: 'note', title: explanation, 'aria-label': explanation },
  });
}

interface RenderProjectTableCellOptions {
  readonly field: ProjectFieldCatalogItem;
  readonly statuses: readonly ProjectStatus[];
  readonly openProject: (path: string) => void;
}

function renderPropertyValue(
  cell: HTMLElement,
  project: Project,
  field: ProjectFieldCatalogItem,
  statuses: readonly ProjectStatus[],
): void {
  const value = projectFieldValue(project, field);
  const displayedValues = projectTableDisplayValues(project, field, statuses);
  if (Array.isArray(value)) {
    const list = cell.createDiv({ cls: 'abyss-project-table-values' });
    for (const displayed of displayedValues) {
      list.createSpan({
        cls: value.length === 0 ? 'abyss-project-table-empty-value' : 'abyss-project-table-value',
        text: displayed,
      });
    }
  } else {
    cell.createSpan({
      cls:
        value === null || value === undefined || value === ''
          ? 'abyss-project-table-empty-value'
          : '',
      text: displayedValues[0] ?? '—',
    });
  }
  renderUnavailableType(cell, field);
}

export function renderProjectTableCell(
  cell: HTMLElement,
  project: Project,
  options: RenderProjectTableCellOptions,
): void {
  const { field, statuses, openProject } = options;
  if (field.type === 'name') {
    const button = cell.createEl('button', {
      cls: 'abyss-project-table-name',
      text: project.name,
      attr: { type: 'button', title: project.path },
    });
    button.addEventListener('click', () => {
      openProject(project.path);
    });
    return;
  }
  if (isProjectStatusField(field)) {
    renderStatus(cell, project, field, statuses);
    return;
  }
  if (field.type === 'progress') {
    renderProgress(cell, project);
    return;
  }
  renderPropertyValue(cell, project, field, statuses);
}
