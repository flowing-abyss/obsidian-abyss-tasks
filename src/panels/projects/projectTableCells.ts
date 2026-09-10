import type { App, Component } from 'obsidian';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import { isProjectStatusField, projectFieldValue } from '../../projects/projectFields';
import { projectProgress, projectTableDisplayValues } from '../../projects/projectTableModel';
import type { Project } from '../../projects/types';
import type { ProjectStatus } from '../../settings/types';
import { renderTaskText } from '../../ui/renderTaskText';
import { runAsyncAction } from '../../ui/runAsyncAction';
import {
  projectPropertyValuePresentation,
  projectTagLabel,
} from './projectPropertyValuePresentation';

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
  readonly onToggleCheckbox: (value: boolean, input: HTMLInputElement) => void;
  readonly description?: {
    readonly field: ProjectFieldCatalogItem;
    readonly show: boolean;
  };
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
  const presentation = projectPropertyValuePresentation(raw);
  if (presentation.link !== undefined) host.addClass('is-link');
  renderTaskText(host, raw, {
    app: options.app,
    sourcePath,
    component: options.component,
    beforeOpenLink: options.beforeOpenLink,
    ...(presentation.link === undefined ? {} : { exactLinkLabel: presentation.label }),
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

interface RenderListValueOptions {
  readonly list: HTMLElement;
  readonly values: RenderListValuesOptions;
  readonly index: number;
  readonly displayed: string;
  readonly nativeTags: boolean;
  readonly cell: RenderProjectTableCellOptions;
}

async function openTagSearch(app: App, raw: string): Promise<void> {
  const tag = raw.startsWith('#') ? raw : `#${raw}`;
  const leaf =
    app.workspace.getLeavesOfType('search')[0] ??
    app.workspace.getLeftLeaf(false) ??
    app.workspace.getLeftLeaf(true);
  if (leaf === null) return;
  const current = leaf.getViewState();
  const state = current.type === 'search' ? current.state : {};
  await leaf.setViewState({
    type: 'search',
    active: true,
    state: { ...state, query: `tag:${tag}` },
  });
  await app.workspace.revealLeaf(leaf);
}

function tagHref(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.startsWith('#') ? raw : `#${raw}`;
}

function activateTag(
  anchor: HTMLAnchorElement,
  raw: string,
  options: RenderProjectTableCellOptions,
): void {
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    runAsyncAction(
      (async () => {
        if ((await options.beforeOpenLink()) === false) return;
        await openTagSearch(options.app, raw);
      })(),
      'Could not open project tag',
    );
  });
}

function renderListValue(itemOptions: RenderListValueOptions): void {
  const { list, values, index, displayed, nativeTags, cell } = itemOptions;
  const raw = values.values[index];
  const item = list.createSpan({
    cls: nativeTags ? 'abyss-project-table-tag-value' : 'abyss-project-table-value',
  });
  const text = item.createSpan({
    cls: nativeTags ? 'abyss-project-table-tag-content' : 'abyss-project-table-value-text',
  });
  if (nativeTags && typeof raw === 'string') {
    const link = text.createEl('a', {
      cls: 'tag abyss-project-table-tag-link',
      text: projectTagLabel(raw),
      attr: { href: tagHref(raw) },
    });
    activateTag(link, raw, cell);
  } else {
    renderValueText({ host: text, raw, displayed, sourcePath: values.project.path }, cell);
  }
  if (values.field.type === null) return;
  const remove = item.createEl('button', {
    cls: 'abyss-project-table-value-remove',
    text: '×',
    attr: { type: 'button', 'aria-label': `Remove ${displayed}` },
  });
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cell.onRemoveListValue(index);
  });
}

function renderListValues(
  valueOptions: RenderListValuesOptions,
  options: RenderProjectTableCellOptions,
): void {
  const { cell, field, values, displayedValues } = valueOptions;
  if (values.length === 0) {
    renderEmptyList(cell);
    return;
  }
  const nativeTags = field.type === 'tags';
  const list = cell.createDiv({
    cls: nativeTags
      ? 'abyss-project-table-values metadata-property-value'
      : 'abyss-project-table-values',
    ...(nativeTags ? { attr: { 'data-property-type': 'tags' } } : {}),
  });
  for (const [index, displayed] of displayedValues.entries()) {
    renderListValue({ list, values: valueOptions, index, displayed, nativeTags, cell: options });
  }
}

function renderCheckbox(
  cell: HTMLElement,
  value: unknown,
  options: RenderProjectTableCellOptions,
): void {
  const input = cell.createEl('input', {
    cls: 'metadata-input-checkbox',
    attr: {
      type: 'checkbox',
      'aria-label': options.field.label,
      'data-indeterminate': String(value !== true && value !== false),
    },
  });
  input.checked = value === true;
  input.indeterminate = false;
  input.addEventListener('change', () => {
    options.onToggleCheckbox(input.checked, input);
  });
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
  if (field.type === 'checkbox') {
    renderCheckbox(cell, value, options);
    return;
  }
  const displayedValues = projectTableDisplayValues(project, field, options.statuses);
  if (Array.isArray(value) || (field.type === 'tags' && typeof value === 'string')) {
    const values = Array.isArray(value) ? value : [value];
    renderListValues({ cell, project, field, values, displayedValues }, options);
  } else {
    renderScalarValue({ cell, project, value, displayed: displayedValues[0] ?? '—' }, options);
  }
  renderUnavailableType(cell, field);
}

function renderName(
  cell: HTMLElement,
  project: Project,
  options: RenderProjectTableCellOptions,
): void {
  const button = cell.createEl('button', {
    cls: 'abyss-project-table-name',
    text: project.name,
    attr: { type: 'button', title: project.path },
  });
  button.addEventListener('click', () => {
    options.openProject(project.path);
  });
  const description = options.description;
  if (description?.show !== true) return;
  const raw = projectFieldValue(project, description.field);
  const value = typeof raw === 'string' ? (raw.split('\n', 1)[0] ?? '') : '';
  if (value.length === 0) return;
  const detail = cell.createDiv({ cls: 'abyss-project-description' });
  if (description.field.type !== 'text') {
    detail.createSpan({ cls: 'abyss-project-description-text', text: value });
    return;
  }
  detail.createSpan({
    cls: 'abyss-project-description-text',
    text: value,
  });
}

export function renderProjectTableCell(
  cell: HTMLElement,
  project: Project,
  options: RenderProjectTableCellOptions,
): void {
  const { field, statuses } = options;
  if (field.type === 'name') {
    renderName(cell, project, options);
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
