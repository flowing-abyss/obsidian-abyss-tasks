import { Component } from 'obsidian';
import type { ProjectDtoV1, ProjectFieldValueV1, ProjectStatusV1 } from '../../../api';
import type { CommandChange, CommandSessionSnapshot } from '../../ai/commandTypes';
import { formatProjectPrettyDate } from '../../panels/projects/projectDatePresentation';
import { applyProjectStatusPresentation } from '../../panels/projects/projectStatusPresentation';
import {
  buildConfiguredProjectFieldCatalog,
  findProjectFieldById,
} from '../../projects/projectFields';
import { projectStatusDisplayName } from '../../projects/status';
import type { ProjectStatus } from '../../settings/types';
import { createProjectDateParts } from '../projectDateParts';
import { projectMetadataText } from '../projectPropertyValuePresentation';
import { RetainedTaskText, type PreparedTaskTextUpdate } from '../retainedTaskText';
import type { CommandModeOptions } from './CommandModeSurface';
type ProjectChange = Extract<CommandChange, { kind: 'project' }>;
interface PaintedValue {
  readonly value: string | undefined;
  readonly markdown: string;
}
export interface CommandProjectFields {
  readonly revision: string;
  readonly iteration: number;
  readonly current: ReadonlyMap<string, PaintedValue>;
  readonly comparison: ReadonlyMap<string, PaintedValue>;
  readonly changed: ReadonlySet<string>;
}
interface ProjectDate {
  readonly element: HTMLElement;
  readonly label: HTMLElement;
}
interface PropertyRow {
  readonly host: HTMLElement;
  readonly value: HTMLElement;
  readonly label: HTMLElement;
  readonly text: RetainedTaskText;
  pending?: PreparedTaskTextUpdate;
}
interface ProjectRow {
  readonly owner: Component;
  readonly properties: Map<string, PropertyRow>;

  readonly host: HTMLElement;
  readonly title: HTMLElement;
  readonly status: HTMLElement;
  readonly dates: Map<string, ProjectDate>;
}
function displayedStatus(
  project: ProjectDtoV1,
  change: ProjectChange | undefined,
): ProjectStatusV1 {
  if (change?.statusId === undefined) return project.status;
  return change.statusId === null
    ? { state: 'absent' }
    : { state: 'configured', id: change.statusId };
}
function statusLabel(value: ProjectStatusV1, configured: ProjectStatus | undefined): string {
  if (configured !== undefined) return projectStatusDisplayName(configured);
  if (value.state === 'unrecognized') return value.value;
  return value.state === 'unsupported' ? 'Unsupported status' : 'No status';
}
function fieldValue(project: ProjectDtoV1, id: string): ProjectFieldValueV1 | undefined {
  const field = project.fields.find((field) => field.fieldId === id);
  return field?.state === 'value' ? field.value : undefined;
}
function values(project: ProjectDtoV1, change?: ProjectChange): ReadonlyMap<string, PaintedValue> {
  const fields = new Map<string, PaintedValue>();
  for (const id of new Set([
    ...project.fields.map((field) => field.fieldId),
    ...(change?.fields ?? []).map((field) => field.fieldId),
  ])) {
    const assignment = change?.fields?.find((field) => field.fieldId === id);
    const value = assignment === undefined ? fieldValue(project, id) : assignment.value;
    fields.set(id, { value: JSON.stringify(value), markdown: projectMetadataText(value) });
  }
  fields.set('status', { value: JSON.stringify(displayedStatus(project, change)), markdown: '' });
  return fields;
}
function changedFields(
  current: ReadonlyMap<string, PaintedValue>,
  previous: ReadonlyMap<string, PaintedValue>,
): ReadonlySet<string> {
  return new Set(
    [...current].flatMap(([id, field]) => (field.value === previous.get(id)?.value ? [] : [id])),
  );
}
function projectFields(
  project: ProjectDtoV1,
  change: ProjectChange,
  iteration: number,
  prior: CommandProjectFields | undefined,
): CommandProjectFields {
  const current = values(project, change);
  const before = values(project);
  const sameIteration = prior?.iteration === iteration;
  const comparison = sameIteration ? prior.comparison : (prior?.current ?? before);
  const changed = new Set(sameIteration ? prior.changed : []);
  for (const id of changedFields(current, prior?.current ?? before)) changed.add(id);
  return { revision: project.revision, iteration, current, comparison, changed };
}
export class CommandProjects {
  private readonly rows = new Map<string, ProjectRow>();
  private sessionId = '';
  private previous: ReadonlyMap<string, CommandProjectFields> = new Map();
  private changed: ReadonlySet<string> = new Set();
  private comparison: ReadonlyMap<string, PaintedValue> = new Map();
  constructor(
    private readonly host: HTMLElement,
    private readonly options: CommandModeOptions,
    private readonly component: Component,
    private readonly allowLink: (href: string, path: string) => boolean,
  ) {}
  update(state: CommandSessionSnapshot): void {
    this.restorePresentation(state);
    const iteration = state.exchanges.filter((exchange) => exchange.role === 'user').length;
    const next = new Map<string, CommandProjectFields>();
    const projects = this.selected(state);
    for (const [key, row] of this.rows)
      if (!projects.has(key)) {
        this.release(row);
        this.rows.delete(key);
      }
    for (const [key, project] of projects) {
      const row = this.row(key);
      row.title.textContent = project.name;
      const change = state.proposal.changes.find(
        (entry): entry is ProjectChange => entry.kind === 'project' && entry.before.target === key,
      );
      this.projectChanges(state, project, change, { iteration, next });
      this.status(row, project, change);
      for (const id of ['start', 'end']) this.date(row, project, id, change);
      this.properties(row, project, change);
    }
    this.retainPresentation(state, next);
    this.host.hidden = projects.size === 0;
  }
  private restorePresentation(state: CommandSessionSnapshot): void {
    if (this.sessionId === state.id) return;
    const retained = this.options.memory.presentation?.get(state.id);
    this.previous =
      retained?.proposalRevision === state.proposal.revision
        ? (retained.projects ?? new Map())
        : new Map();
    this.sessionId = state.id;
  }
  private retainPresentation(
    state: CommandSessionSnapshot,
    next: ReadonlyMap<string, CommandProjectFields>,
  ): void {
    this.previous = next;
    const memory = (this.options.memory.presentation ??= new Map());
    memory.set(state.id, {
      proposalRevision: state.proposal.revision,
      owners: memory.get(state.id)?.owners ?? new Map(),
      projects: next,
    });
  }
  private projectChanges(
    state: CommandSessionSnapshot,
    project: ProjectDtoV1,
    change: ProjectChange | undefined,
    context: { iteration: number; next: Map<string, CommandProjectFields> },
  ): void {
    this.changed = new Set();
    this.comparison = values(project);
    if (change === undefined) return;
    const previous = this.previous.get(project.target);
    const paint = projectFields(
      project,
      change,
      context.iteration,
      previous?.revision === project.revision ? previous : undefined,
    );
    context.next.set(project.target, paint);
    if (state.presentation?.changes === 'cumulative')
      this.changed = changedFields(paint.current, this.comparison);
    else {
      this.changed = paint.changed;
      this.comparison = paint.comparison;
    }
  }
  private selected(state: CommandSessionSnapshot): ReadonlyMap<string, ProjectDtoV1> {
    const projects = new Map<string, ProjectDtoV1>();
    for (const project of state.entities.projects)
      if (state.focus.some((focus) => focus.kind === 'project' && focus.target === project.target))
        projects.set(project.target, project);
    for (const change of state.proposal.changes)
      if (change.kind === 'project') projects.set(change.before.target, change.before);
    return projects;
  }
  private row(key: string): ProjectRow {
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;
    const host = this.host.createDiv({ cls: 'abyss-project-dashboard-header' });
    const status = host.createSpan({ cls: 'abyss-status-pill abyss-project-dashboard-status' });
    const title = host.createSpan({ cls: 'abyss-project-dashboard-title' });
    const owner = this.component.addChild(new Component());
    const row = {
      host,
      status,
      title,
      owner,
      properties: new Map<string, PropertyRow>(),
      dates: new Map<string, ProjectDate>(),
    };
    this.rows.set(key, row);
    return row;
  }
  private properties(
    row: ProjectRow,
    project: ProjectDtoV1,
    change: ProjectChange | undefined,
  ): void {
    const ids = new Set(['description', ...(change?.fields ?? []).map((field) => field.fieldId)]);
    for (const id of ['start', 'end']) ids.delete(id);
    for (const [id, field] of row.properties)
      if (!ids.has(id)) {
        field.text.destroy();
        field.host.remove();
        row.properties.delete(id);
      }
    for (const id of ids) this.property(row, project, id, change);
  }
  private property(
    row: ProjectRow,
    project: ProjectDtoV1,
    id: string,
    change: ProjectChange | undefined,
  ): void {
    const assignment = change?.fields?.find((field) => field.fieldId === id);
    const original = fieldValue(project, id);
    const value = assignment === undefined ? original : assignment.value;
    if (value == null && original === undefined) return;
    const catalog = buildConfiguredProjectFieldCatalog(this.options.projectSettings());
    const field = this.propertyRow(row, id);
    field.label.textContent = findProjectFieldById(catalog, id)?.label ?? 'Unavailable property';
    this.dateChange(field.host, assignment?.value, id);
    field.host.inert = field.host.dataset['change'] === 'removed';
    field.value.dataset['taskSourcePath'] = project.path;
    this.prepareProperty(field, {
      row,
      project,
      id,
      value,
      original,
      previousMarkdown: this.previousMarkdown(id),
    });
  }
  private previousMarkdown(id: string): string | undefined {
    return this.changed.has(id) ? this.comparison.get(id)?.markdown : undefined;
  }
  private prepareProperty(
    field: PropertyRow,
    input: {
      row: ProjectRow;
      project: ProjectDtoV1;
      id: string;
      value: ProjectFieldValueV1 | null | undefined;
      original: ProjectFieldValueV1 | undefined;
      previousMarkdown: string | undefined;
    },
  ): void {
    const { row, project, id, value, original, previousMarkdown } = input;
    field.pending = field.text.prepare({
      source: {
        target: { type: 'display', key: `${project.target}:${id}` },
        markdown: projectMetadataText(value ?? original),
        path: project.path,
        presentation: id === 'description' ? 'description' : 'markdown',
      },
      decoration: {
        kind: 'complete',
        ...(previousMarkdown === undefined || value === null ? {} : { previousMarkdown }),
      },
      callbacks: {
        app: this.options.app,
        isCurrent: () => this.rows.get(project.target) === row,
        beforeOpenLink: async ({ href, sourcePath }) => this.allowLink(href, sourcePath),
        onRenderFailure: () => {
          field.value.textContent = 'Could not display property.';
        },
      },
    });
    const pending = field.pending;
    void pending.ready.then(
      () => {
        if (field.pending === pending) pending.commit();
      },
      () => {
        if (field.pending === pending) field.value.textContent = 'Could not display property.';
      },
    );
  }
  private propertyRow(row: ProjectRow, id: string): PropertyRow {
    const previous = row.properties.get(id);
    if (previous !== undefined) return previous;
    const host = row.host.createDiv({ cls: 'abyss-project-dashboard-property' });
    host.dataset['projectField'] = id;
    const label = host.createSpan({ cls: 'abyss-project-dashboard-property-label' });
    const value = host.createDiv({ cls: id === 'description' ? 'abyss-project-description' : '' });
    const field: PropertyRow = { host, label, value, text: new RetainedTaskText(value, row.owner) };
    row.owner.registerDomEvent(value, 'focusout', () => {
      value.win.queueMicrotask(() => {
        field.pending?.commit();
      });
    });
    row.properties.set(id, field);
    return field;
  }
  private release(row: ProjectRow): void {
    for (const field of row.properties.values()) field.text.destroy();
    this.component.removeChild(row.owner);
    row.host.remove();
  }
  private status(row: ProjectRow, project: ProjectDtoV1, change: ProjectChange | undefined): void {
    const value = displayedStatus(project, change);
    const configured =
      value.state === 'configured'
        ? this.options.projectSettings().statuses.find((status) => status.id === value.id)
        : undefined;
    applyProjectStatusPresentation(row.status, configured);
    row.status.textContent = statusLabel(value, configured);
    row.status.dataset['change'] =
      change?.statusId === undefined || !this.changed.has('status') ? '' : 'changed';
  }
  private date(
    row: ProjectRow,
    project: ProjectDtoV1,
    id: string,
    change: ProjectChange | undefined,
  ): void {
    const assignment = change?.fields?.find((field) => field.fieldId === id);
    const original = fieldValue(project, id);
    const value = assignment === undefined ? original : assignment.value;
    const displayed = value ?? original;
    if (displayed == null) {
      row.dates.get(id)?.element.remove();
      row.dates.delete(id);
      return;
    }
    const date = row.dates.get(id) ?? this.createDate(row, id);
    const text = this.dateText(displayed);
    date.label.textContent = text;
    date.element.setAttribute('aria-label', `${id === 'start' ? 'Start' : 'End'}: ${text}`);
    this.dateChange(date.element, assignment?.value, id);
  }
  private createDate(row: ProjectRow, id: string): ProjectDate {
    const element = row.host.createSpan({ cls: 'abyss-project-dashboard-date' });
    const followingDate = id === 'start' ? row.dates.get('end')?.element : undefined;
    const property = row.properties.values().next().value;
    row.host.insertBefore(element, followingDate ?? property?.host ?? null);
    const date = { element, label: createProjectDateParts(element, id) };
    row.dates.set(id, date);
    return date;
  }
  private dateText(value: ProjectFieldValueV1): string {
    return (
      formatProjectPrettyDate(
        value,
        this.host.ownerDocument.defaultView?.navigator.language ?? 'en',
      ) ?? String(value)
    );
  }
  private dateChange(
    element: HTMLElement,
    value: ProjectFieldValueV1 | null | undefined,
    id: string,
  ): void {
    let change = '';
    if (value === null) change = 'removed';
    else if (value !== undefined && this.changed.has(id)) change = 'changed';
    element.dataset['change'] = change;
  }
  destroy(): void {
    for (const row of this.rows.values()) this.release(row);
    this.rows.clear();
  }
}
