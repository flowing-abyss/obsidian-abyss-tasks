import type { App, Component } from 'obsidian';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import { isProjectStatusField, projectFieldValue } from '../../projects/projectFields';
import { projectProgress, projectTableDisplayValues } from '../../projects/projectTableModel';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { renderTaskText } from '../../ui/renderTaskText';

function statusFor(
  project: Project,
  statuses: readonly ProjectStatus[],
): ProjectStatus | undefined {
  return project.statusId === null ? undefined : statuses.find(({ id }) => id === project.statusId);
}

function progressBand(percent: number | null): 'empty' | 'low' | 'quarter' | 'half' | 'high' {
  if (percent === null || percent === 0) return 'empty';
  if (percent < 25) return 'low';
  if (percent < 50) return 'quarter';
  if (percent < 75) return 'half';
  return 'high';
}

function renderProgress(cell: HTMLElement, project: Project): void {
  const progress = projectProgress(project.stats);
  const root = cell.createDiv({
    cls: `abyss-project-table-progress is-${progressBand(progress.percent)}`,
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
  const value = root.createSpan({ cls: 'abyss-project-progress-value' });
  if (progress.percent === null) value.setText('—');
  else {
    value.createSpan({ cls: 'abyss-project-progress-percent', text: `${progress.percent}%` });
    value.createSpan({
      cls: 'abyss-project-progress-count',
      text: ` (${progress.done}/${progress.total})`,
    });
  }
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
  readonly app: App;
  readonly component: Component;
  readonly beforeOpenLink: () => Promise<boolean>;
  readonly openProject: (path: string) => void;
  readonly onRemoveListValue: (index: number) => void;
}

interface RenderValueTextOptions {
  readonly host: HTMLElement;
  readonly raw: unknown;
  readonly displayed: string;
  readonly sourcePath: string;
}

function renderValueText(
  valueOptions: RenderValueTextOptions,
  options: RenderProjectTableCellOptions,
): void {
  const { host, raw, displayed, sourcePath } = valueOptions;
  if (typeof raw !== 'string') {
    host.setText(displayed);
    return;
  }
  renderTaskText(host, raw, {
    app: options.app,
    sourcePath,
    component: options.component,
    beforeOpenLink: options.beforeOpenLink,
  });
}

function renderEmptyList(cell: HTMLElement): void {
  cell.createSpan({ cls: 'abyss-project-table-empty-value', text: '—' });
}

interface RenderListValuesOptions {
  readonly cell: HTMLElement;
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly values: readonly unknown[];
  readonly displayedValues: readonly string[];
}

function renderListValues(
  valueOptions: RenderListValuesOptions,
  options: RenderProjectTableCellOptions,
): void {
  const { cell, project, field, values, displayedValues } = valueOptions;
  if (values.length === 0) {
    renderEmptyList(cell);
    return;
  }
  const list = cell.createDiv({ cls: 'abyss-project-table-values' });
  for (const [index, displayed] of displayedValues.entries()) {
    const item = list.createSpan({ cls: 'abyss-project-table-value' });
    const text = item.createSpan({ cls: 'abyss-project-table-value-text' });
    renderValueText(
      { host: text, raw: values[index], displayed, sourcePath: project.path },
      options,
    );
    if (field.type === null) continue;
    const remove = item.createEl('button', {
      cls: 'abyss-project-table-value-remove',
      text: '×',
      attr: { type: 'button', 'aria-label': `Remove ${displayed}` },
    });
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onRemoveListValue(index);
    });
  }
}

interface RenderScalarValueOptions {
  readonly cell: HTMLElement;
  readonly project: Project;
  readonly value: unknown;
  readonly displayed: string;
}

function renderScalarValue(
  valueOptions: RenderScalarValueOptions,
  options: RenderProjectTableCellOptions,
): void {
  const { cell, project, value, displayed } = valueOptions;
  const empty = value === null || value === undefined || value === '';
  const text = cell.createSpan({ cls: empty ? 'abyss-project-table-empty-value' : '' });
  renderValueText({ host: text, raw: value, displayed, sourcePath: project.path }, options);
}

function renderPropertyValue(
  cell: HTMLElement,
  project: Project,
  field: ProjectFieldCatalogItem,
  options: RenderProjectTableCellOptions,
): void {
  const value = projectFieldValue(project, field);
  const displayedValues = projectTableDisplayValues(project, field, options.statuses);
  if (Array.isArray(value)) {
    renderListValues({ cell, project, field, values: value, displayedValues }, options);
  } else {
    renderScalarValue({ cell, project, value, displayed: displayedValues[0] ?? '—' }, options);
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
  renderPropertyValue(cell, project, field, options);
}
