import { Component, Notice, setIcon } from 'obsidian';
import { moment } from '../../obsidianMoment';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import {
  buildProjectFieldCatalog,
  findFrontmatterProperty,
  type ProjectDateDisplay,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import { resolveConfiguredProjectField } from '../../projects/projectPropertyDefinitions';
import { sameProjectPropertyName } from '../../projects/projectPropertyNames';
import { compileProjectPropertyPresets } from '../../projects/projectPropertyPresets';
import { projectTrackedDisplayValue } from '../../projects/projectTableModel';
import { effectiveProjectTableDateDisplay } from '../../projects/projectTableSettings';
import type { Project } from '../../projects/types';
import { openAnchoredPopover, type AnchoredPopover } from '../../ui/anchoredPopover';
import { localSearchSurfaceIsVisible } from '../../ui/localSearchKeys';
import { runAsyncAction } from '../../ui/runAsyncAction';
import {
  mountProjectCellEditor,
  type ProjectCellEditSession,
  type ProjectCellEditorHandle,
} from './ProjectCellEditor';
import { mountProjectCellEditorPosition } from './projectCellEditorPosition';
import { formatProjectPrettyDate } from './projectDatePresentation';
import { renderProjectTableCell } from './projectTableCells';
import type { ProjectsDashboardContext } from './viewContext';

function metadataText(value: unknown): string {
  if (Array.isArray(value)) return value.map(metadataText).filter(Boolean).join(', ');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return '';
}

interface DateControl {
  readonly button: HTMLButtonElement;
  readonly label: HTMLElement;
  field: ProjectFieldCatalogItem;
}

interface PropertyRow {
  readonly element: HTMLElement;
  readonly component: Component;
  signature: string;
  session: ProjectCellEditSession | undefined;
}
interface PropertyValueContext {
  readonly project: Project;
  readonly field: ProjectFieldCatalogItem;
  readonly session: ProjectCellEditSession | undefined;
  readonly definition: unknown;
  readonly dateDisplay: ProjectDateDisplay;
  readonly locale: string;
  readonly nowMs: number;
  readonly value: unknown;
}
interface PropertyFocus {
  readonly field: string;
  readonly index: number;
}
function propertyFocus(body: HTMLElement): PropertyFocus | undefined {
  const focused = body.ownerDocument.activeElement;
  if (focused === null || !body.contains(focused)) return undefined;
  const row = focused.closest<HTMLElement>('.abyss-project-dashboard-property');
  const field = row?.dataset['projectField'];
  if (row === null || field === undefined) return undefined;
  return { field, index: [...row.querySelectorAll('button, a, input')].indexOf(focused) };
}
function restorePropertyFocus(body: HTMLElement, focus: PropertyFocus | undefined): void {
  if (focus === undefined || body.ownerDocument.activeElement !== body.ownerDocument.body) return;
  const row = [...body.querySelectorAll<HTMLElement>('.abyss-project-dashboard-property')].find(
    (candidate) => candidate.dataset['projectField'] === focus.field,
  );
  const controls = row?.querySelectorAll<HTMLElement>('button, a, input');
  (controls?.[focus.index] ?? controls?.[0])?.focus({ preventScroll: true });
}

/** Retains date anchors during saves and shares the overview's exact editor session. */
export class ProjectDashboardProperties {
  readonly #dates: HTMLElement;
  readonly #dateControls = new Map<string, DateControl>();
  readonly #plus: HTMLButtonElement;
  #popover: AnchoredPopover | undefined;
  readonly #rows = new Map<string, PropertyRow>();
  #editor: ProjectCellEditorHandle | undefined;
  #readOnly = false;
  #releaseEditor: (() => void) | undefined;
  #destroyed = false;
  #pendingAction: (() => void) | undefined;
  #finishing: Promise<boolean> | undefined;
  readonly #migration: () => void;

  constructor(
    private readonly owner: HTMLElement,
    header: HTMLElement,
    private readonly project: () => Project,
    private readonly context: ProjectsDashboardContext,
  ) {
    this.#dates = header.createDiv({ cls: 'abyss-project-dashboard-dates' });
    header.prepend(this.#dates);
    this.#plus = header.createEl('button', {
      cls: 'clickable-icon abyss-project-dashboard-details',
      attr: { 'aria-label': 'Project properties', 'aria-expanded': 'false' },
    });
    setIcon(this.#plus, 'plus');
    this.#plus.addEventListener('click', () => {
      this.#toggle();
    });
    this.#migration = owner.onWindowMigrated(() => {
      this.#popover?.close(false);
      this.#editor?.cancel();
    });
    this.refresh();
  }

  refresh(): void {
    if (this.#destroyed || this.#editor !== undefined) return;
    const visible = new Set<string>();
    for (const field of this.#fields().filter(({ id }) => id === 'start' || id === 'end')) {
      if (metadataText(this.#value(field)) === '') continue;
      visible.add(field.id);
      this.#patchDate(field);
    }
    for (const [id, control] of this.#dateControls) {
      if (visible.has(id)) continue;
      if (control.button === this.owner.ownerDocument.activeElement) this.#plus.focus();
      control.button.remove();
      this.#dateControls.delete(id);
    }
    if (this.#popover !== undefined) this.#renderProperties(this.#popover.element);
  }

  #patchDate(field: ProjectFieldCatalogItem): void {
    let control = this.#dateControls.get(field.id);
    if (control === undefined) {
      const button = this.#dates.createEl('button', { cls: 'abyss-project-dashboard-date' });
      button.dataset['projectField'] = field.id;
      setIcon(button.createSpan(), field.id === 'start' ? 'calendar-arrow-up' : 'calendar-check');
      const created = { button, field, label: button.createSpan() };
      button.addEventListener('click', () => {
        this.#edit(created.field, button);
      });
      control = created;
      this.#dateControls.set(field.id, control);
      if (field.id === 'start') this.#dates.prepend(button);
    }
    control.field = field;
    const text = this.#display(field);
    control.button.setAttribute('aria-label', `${field.label}: ${text}`);
    if (control.label.textContent !== text) control.label.setText(text);
  }

  #fields(): ProjectFieldCatalogItem[] {
    const properties = [
      ...(this.context.editor?.catalog.list() ?? []),
      ...Object.keys(this.project().frontmatter).map((name) => ({ name, type: null })),
    ];
    return buildProjectFieldCatalog(this.context.settings.projects, properties).filter(
      (field) =>
        field.property !== undefined &&
        field.id !== 'status' &&
        field.property !== 'position' &&
        (!field.id.startsWith('property:') ||
          field.type !== null ||
          findFrontmatterProperty(this.project().frontmatter, field.property) !== undefined),
    );
  }
  #value(field: ProjectFieldCatalogItem): unknown {
    return field.property === undefined
      ? undefined
      : findFrontmatterProperty(this.project().frontmatter, field.property)?.value;
  }
  #display(field: ProjectFieldCatalogItem): string {
    const value = this.#value(field);
    return (
      (field.type === 'date' || field.type === 'datetime'
        ? formatProjectPrettyDate(
            value,
            this.owner.ownerDocument.defaultView?.navigator.language ?? 'en',
          )
        : undefined) ?? metadataText(value)
    );
  }
  #toggle(): void {
    if (this.#editor !== undefined) {
      this.#editor.cancel();
      return;
    }
    if (this.#popover !== undefined) {
      this.#popover.close(false);
      return;
    }
    this.#plus.setAttribute('aria-expanded', 'true');
    this.#popover = openAnchoredPopover({
      owner: this.owner,
      boundary: this.owner,
      anchor: this.#plus,
      preferred: 'below-start',
      cls: 'abyss-project-dashboard-properties',
      onClose: (restoreFocus) => {
        this.#releaseRows();
        this.#popover = undefined;
        if (restoreFocus && !this.#destroyed) this.#plus.focus();
        this.#plus.setAttribute('aria-expanded', 'false');
      },
    });
    this.#renderProperties(this.#popover.element);
    this.#popover.reposition();
  }
  #releaseRows(): void {
    const rows = [...this.#rows.values()];
    this.#rows.clear();
    for (const row of rows) row.component.unload();
  }
  #renderProperties(body: HTMLElement): void {
    const focus = propertyFocus(body);
    try {
      this.#renderFields(body);
    } catch (error) {
      this.#releaseRows();
      body.setText('Could not display project properties. Close and reopen to retry.');
      this.#reportFailure('render project properties', undefined, error);
    }
    restorePropertyFocus(body, focus);
  }
  #renderFields(body: HTMLElement): void {
    const project = this.project();
    const nowMs = Date.now();
    const fields = this.#fields();
    const visible = new Set(fields.map(({ id }) => id));
    for (const [id, row] of this.#rows) {
      if (visible.has(id)) continue;
      this.#rows.delete(id);
      row.component.unload();
      row.element.remove();
    }
    let index = 0;
    for (const field of fields) {
      const row = this.#patchRow(body, project, field, nowMs);
      const before = body.children[index] ?? null;
      if (row !== before) body.insertBefore(row, before);
      index += 1;
    }
    body.querySelector('.abyss-project-time')?.remove();
    const tracked = projectTrackedDisplayValue(project.stats, nowMs);
    if (tracked !== '') {
      const time = body.createDiv({ cls: 'abyss-project-time' });
      time.createSpan({ cls: 'abyss-project-time-label', text: 'Time' });
      time.createSpan({ cls: 'abyss-project-time-value', text: tracked });
    }
  }
  #patchRow(
    body: HTMLElement,
    project: Project,
    field: ProjectFieldCatalogItem,
    nowMs: number,
  ): HTMLElement {
    const data = this.#propertyValueContext(project, field, nowMs);
    const signature = JSON.stringify({
      ...data,
      session: undefined,
      nowMs: undefined,
      day: data.dateDisplay === 'relative' ? moment(nowMs).format('YYYY-MM-DD') : undefined,
      project: project.path,
    });
    const previous = this.#rows.get(field.id);
    if (previous?.signature === signature) {
      previous.session = data.session;
      return previous.element;
    }
    previous?.component.unload();
    const element = this.#createPropertyRow(body, field);
    // Replace in place so siblings (including focused links) keep their native lifetime.
    previous?.element.replaceWith(element);
    const component = new Component();
    const row = { element, component, signature, session: data.session };
    this.#rows.set(field.id, row);
    component.load();
    const value = element.createDiv({
      cls: field.id === 'description' ? 'abyss-project-description' : '',
    });
    this.#renderValue(value, row, data);
    return element;
  }
  #propertyValueContext(
    project: Project,
    field: ProjectFieldCatalogItem,
    nowMs: number,
  ): PropertyValueContext {
    const settings = this.context.settings.projects;
    const session = this.context.editor?.capture(project, field);
    const definition = Object.entries(settings.propertyDefinitions).find(([id]) =>
      sameProjectPropertyName(id, field.id),
    )?.[1];
    const dateDisplay = effectiveProjectTableDateDisplay(
      settings.table,
      settings.table.columns.find(({ id }) => id === field.id),
    );
    const locale = moment.locale();
    return {
      project,
      field: session?.field ?? field,
      value: session === undefined ? this.#value(field) : session.value,
      session,
      definition,
      dateDisplay,
      locale,
      nowMs,
    };
  }
  #createPropertyRow(body: HTMLElement, field: ProjectFieldCatalogItem): HTMLElement {
    const row = body.createDiv({ cls: 'abyss-project-dashboard-property' });
    row.dataset['projectField'] = field.id;
    const edit = row.createEl('button', {
      text: field.label,
      cls: 'abyss-project-dashboard-property-label',
      attr: { 'aria-label': `Edit ${field.label}` },
    });
    const open = (): void => {
      this.#popover?.close(false);
      this.#edit(field, this.#plus);
    };
    edit.addEventListener('click', open);
    row.addEventListener('click', (event) => {
      const target = event.target as Node | null;
      const ownerWindow = row.ownerDocument.defaultView;
      if (
        ownerWindow !== null &&
        target?.instanceOf(ownerWindow.Element) === true &&
        target.closest('a, button, input') !== null
      )
        return;
      open();
    });
    return row;
  }
  #renderValue(value: HTMLElement, row: PropertyRow, data: PropertyValueContext): void {
    const { project, field, session } = data;
    const port = this.context.editor;
    if (port === undefined || session === undefined) {
      const displayed = this.#display(field);
      value.setText(displayed === '' ? '—' : displayed);
      return;
    }
    const isCurrent = (): boolean => this.#rows.get(field.id) === row;
    let reported = false;
    renderProjectTableCell(value, project, {
      field,
      statuses: this.context.settings.projects.statuses,
      compiledPresets: compileProjectPropertyPresets(data.definition),
      app: port.app,
      component: row.component,
      isCurrent,
      onRenderFailure: (error) => {
        if (!isCurrent() || reported) return;
        reported = true;
        row.signature = '';
        this.#reportFailure('render project property', field, error);
      },
      beforeOpenLink: async () => isCurrent(),
      openProject: (path) => {
        this.context.openNote(path);
      },
      onRemoveListValue: (index) => {
        const session = row.session;
        if (!isCurrent() || session === undefined) return;
        const values = Array.isArray(session.value) ? session.value : [session.value];
        runAsyncAction(
          this.#saveValue(
            session,
            values.filter((_value, at) => at !== index),
          ),
          'Could not update project list property',
        );
      },
      onToggleCheckbox: this.#checkboxToggle(row, isCurrent),
      dateDisplay: data.dateDisplay,
      trackedNowMs: data.nowMs,
      locale: data.locale,
    });
  }
  #checkboxToggle(
    row: PropertyRow,
    isCurrent: () => boolean,
  ): (checked: boolean, input: HTMLInputElement) => void {
    let pending: boolean | undefined;
    return (checked, input) => {
      const session = row.session;
      if (!isCurrent() || session === undefined) return;
      if (pending !== undefined) {
        input.checked = pending;
        return;
      }
      pending = checked;
      input.setAttribute('aria-disabled', 'true');
      runAsyncAction(
        this.#saveValue(session, checked, () => {
          input.checked = session.value === true;
          input.dataset['indeterminate'] = String(
            session.value !== true && session.value !== false,
          );
        }).finally(() => {
          pending = undefined;
          input.removeAttribute('aria-disabled');
        }),
        'Could not update project checkbox property',
      );
    };
  }
  async #saveValue(
    session: ProjectCellEditSession,
    value: unknown,
    restore?: () => void,
  ): Promise<void> {
    try {
      await session.save(value);
    } catch (error) {
      restore?.();
      this.#reportFailure('update project property', session.field, error);
    }
  }
  #reportFailure(action: string, field: ProjectFieldCatalogItem | undefined, error: unknown): void {
    if (!isProjectEditValidationError(error))
      console.error(`[abyss-tasks] Could not ${action}`, {
        property: field?.property,
        cause: error,
      });
    const label = field === undefined ? '' : ` ${field.label}`;
    new Notice(
      `Could not ${action}${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  #edit(field: ProjectFieldCatalogItem, anchor: HTMLElement): void {
    if (this.#editor !== undefined || this.#destroyed) return;
    const port = this.context.editor;
    const project = this.project();
    const session = port?.capture(project, field);
    if (port === undefined || session === undefined) return;
    const host = this.owner.createDiv({
      cls: 'abyss-project-cell-editor-host abyss-project-dashboard-editor',
    });
    host.toggleClass('is-expanded', field.id === 'description');
    let positionCleanup = (): void => {};
    const release = (): void => {
      positionCleanup();
      host.remove();
      this.#editor = undefined;
      this.#releaseEditor = undefined;
    };
    this.#releaseEditor = release;
    this.#readOnly = session.field.type === null;
    this.#editor = mountProjectCellEditor({
      ...session,
      app: port.app,
      container: host,
      catalog: port.catalog,
      resolveField: (id) => resolveConfiguredProjectField(this.context.settings.projects, id),
      statuses: this.context.settings.projects.statuses,
      ...(field.property === undefined ? {} : { sourceField: field.property }),
      sourcePath: project.path,
      onClose: (_result, close) => {
        release();
        this.refresh();
        if (!this.#runPending()) this.#restoreFocus(anchor, field.id, close.navigation);
      },
      restoreFocus: () => {},
    });
    const toolbar = this.owner.querySelector<HTMLElement>('.abyss-center-header');
    positionCleanup = mountProjectCellEditorPosition({
      ...(toolbar === null ? {} : { stickyHeader: toolbar }),
      host,
      anchor,
      boundary: this.owner,
      positioningContainer: this.owner,
      preferredWidth: this.#editor.preferredWidth ?? host.getBoundingClientRect().width,
    });
    if (this.#readOnly) {
      this.#editor.element.tabIndex = -1;
      this.#editor.element.focus();
    } else this.#editor.focus();
  }
  #restoreFocus(anchor: HTMLElement, fieldId: string, navigation: string): void {
    if (this.#destroyed || navigation === 'preserve-focus') return;
    const current =
      anchor === this.#plus
        ? this.#plus
        : (this.#dates.querySelector<HTMLElement>(`[data-project-field="${fieldId}"]`) ??
          this.#plus);
    let destination = current;
    if (navigation === 'tab-forward' || navigation === 'tab-backward') {
      const controls = [
        ...this.owner.querySelectorAll<HTMLElement>(
          '.abyss-center-header button, .abyss-center-header input',
        ),
      ].filter((element) => !element.matches(':disabled') && localSearchSurfaceIsVisible(element));
      const index = controls.indexOf(current);
      destination = controls[index + (navigation === 'tab-forward' ? 1 : -1)] ?? current;
    }
    destination.focus({ preventScroll: true });
  }

  finishBefore(action: () => void): void {
    this.#pendingAction = action;
    if (this.#readOnly && this.#editor !== undefined) {
      this.#editor.cancel();
      return;
    }
    if (this.#runPending() || this.#finishing !== undefined) return;
    const finishing = this.#editor?.commit();
    if (finishing === undefined) return;
    this.#finishing = finishing;
    const settle = (): void => {
      if (this.#finishing === finishing) this.#finishing = undefined;
      this.#runPending();
    };
    void finishing.then(settle, settle);
  }
  #runPending(): boolean {
    if (this.#destroyed || this.#editor !== undefined || this.#pendingAction === undefined)
      return false;
    const action = this.#pendingAction;
    this.#pendingAction = undefined;
    action();
    return true;
  }
  destroy(): void {
    this.#destroyed = true;
    this.#pendingAction = undefined;
    this.#migration();
    this.#popover?.close(false);
    this.#editor?.destroy();
    this.#releaseEditor?.();
  }
}
