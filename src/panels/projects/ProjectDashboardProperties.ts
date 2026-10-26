import { setIcon } from 'obsidian';
import {
  buildProjectFieldCatalog,
  findFrontmatterProperty,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import { resolveConfiguredProjectField } from '../../projects/projectPropertyDefinitions';
import { projectTrackedDisplayValue } from '../../projects/projectTableModel';
import type { Project } from '../../projects/types';
import { openAnchoredPopover, type AnchoredPopover } from '../../ui/anchoredPopover';
import { localSearchSurfaceIsVisible } from '../../ui/localSearchKeys';
import { mountProjectCellEditor, type ProjectCellEditorHandle } from './ProjectCellEditor';
import { mountProjectCellEditorPosition } from './projectCellEditorPosition';
import { formatProjectPrettyDate } from './projectDatePresentation';
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

/** Retains date anchors during saves and shares the overview's exact editor session. */
export class ProjectDashboardProperties {
  readonly #dates: HTMLElement;
  readonly #dateControls = new Map<string, DateControl>();
  readonly #plus: HTMLButtonElement;
  #popover: AnchoredPopover | undefined;
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
        this.#popover = undefined;
        if (restoreFocus && !this.#destroyed) this.#plus.focus();
        this.#plus.setAttribute('aria-expanded', 'false');
      },
    });
    this.#renderProperties(this.#popover.element);
    this.#popover.reposition();
  }
  #renderProperties(body: HTMLElement): void {
    body.empty();
    for (const field of this.#fields()) {
      const row = body.createEl('button', { cls: 'abyss-project-dashboard-property' });
      row.dataset['projectField'] = field.id;
      row.createSpan({ text: field.label });
      row.createSpan({
        text: this.#display(field) === '' ? '—' : this.#display(field),
        cls: field.id === 'description' ? 'abyss-project-description' : '',
      });
      row.addEventListener('click', () => {
        this.#popover?.close(false);
        this.#edit(field, this.#plus);
      });
    }
    const tracked = projectTrackedDisplayValue(this.project().stats, Date.now());
    if (tracked !== '') {
      const time = body.createDiv({ cls: 'abyss-project-time' });
      time.createSpan({ cls: 'abyss-project-time-label', text: 'Time' });
      time.createSpan({ cls: 'abyss-project-time-value', text: tracked });
    }
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
