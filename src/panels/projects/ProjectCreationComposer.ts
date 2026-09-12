import { isProjectCreationError, type ProjectCreateRequest } from '../../projects/projectCreation';
import { mountProjectCellEditorPosition } from './projectCellEditorPosition';

interface ProjectCreationComposerOpenOptions {
  readonly anchor: HTMLElement;
  readonly statusId?: string;
  readonly statusLabel?: string;
}

interface ProjectCreationComposerOptions {
  readonly host: HTMLElement;
  readonly boundary: HTMLElement;
  readonly create: (request: ProjectCreateRequest) => Promise<string | null>;
  readonly created: (path: string, statusId: string | undefined) => void;
  readonly failed: (error: unknown) => void;
  readonly openProject: (path: string) => void;
}

interface RetainedDraft {
  name: string;
  statusId: string | undefined;
  statusLabel: string | undefined;
  recoveryPath: string | undefined;
  blockedPath: string | undefined;
  error: string | undefined;
}

function failureMessage(error: unknown): string {
  const cause = isProjectCreationError(error) ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Owns the single retained project-name composer and its in-flight command. */
export class ProjectCreationComposer {
  private surface_abyssPrivate: HTMLElement | undefined;
  private anchor_abyssPrivate: HTMLElement | undefined;
  private positionCleanup_abyssPrivate: (() => void) | undefined;
  private submitting_abyssPrivate = false;
  private destroyed_abyssPrivate = false;
  private freshStatusId_abyssPrivate: string | undefined;
  private freshStatusLabel_abyssPrivate: string | undefined;
  private draft_abyssPrivate: RetainedDraft = {
    name: '',
    statusId: undefined,
    statusLabel: undefined,
    recoveryPath: undefined,
    blockedPath: undefined,
    error: undefined,
  };

  constructor(private readonly options_abyssPrivate: ProjectCreationComposerOptions) {}

  open(options: ProjectCreationComposerOpenOptions): void {
    if (this.destroyed_abyssPrivate) return;
    if (this.surface_abyssPrivate !== undefined) {
      this.surface_abyssPrivate
        .querySelector<HTMLInputElement>('.abyss-project-creation-name')
        ?.focus();
      return;
    }
    this.freshStatusId_abyssPrivate = options.statusId;
    this.freshStatusLabel_abyssPrivate = options.statusLabel;
    if (
      !this.submitting_abyssPrivate &&
      this.draft_abyssPrivate.recoveryPath === undefined &&
      this.draft_abyssPrivate.blockedPath === undefined
    ) {
      this.draft_abyssPrivate.statusId = this.freshStatusId_abyssPrivate;
      this.draft_abyssPrivate.statusLabel = this.freshStatusLabel_abyssPrivate;
      this.draft_abyssPrivate.blockedPath = undefined;
      this.draft_abyssPrivate.error = undefined;
    }
    this.anchor_abyssPrivate = options.anchor;
    this.render_abyssPrivate();
  }

  destroy(): void {
    this.destroyed_abyssPrivate = true;
    this.close_abyssPrivate(false);
  }

  private render_abyssPrivate(): void {
    const anchor = this.anchor_abyssPrivate;
    if (anchor?.isConnected !== true) return;
    const surface = this.options_abyssPrivate.host.createDiv({
      cls: 'abyss-project-creation-composer',
      attr: { role: 'dialog', 'aria-label': 'Create project' },
    });
    this.surface_abyssPrivate = surface;
    const title = surface.createDiv({ cls: 'abyss-project-creation-title', text: 'New project' });
    title.id = `abyss-project-creation-${String(Date.now())}`;
    surface.setAttribute('aria-labelledby', title.id);
    if (this.draft_abyssPrivate.statusLabel !== undefined) {
      surface.createDiv({
        cls: 'abyss-project-creation-status',
        text: `Status: ${this.draft_abyssPrivate.statusLabel}`,
      });
    }
    const input = surface.createEl('input', {
      cls: 'abyss-project-creation-name',
      attr: {
        type: 'text',
        placeholder: 'Project name…',
        'aria-label': 'Project name',
      },
    });
    input.value = this.draft_abyssPrivate.name;
    const error = surface.createDiv({
      cls: 'abyss-project-creation-error',
      attr: { role: 'alert' },
    });
    error.setText(this.draft_abyssPrivate.error ?? '');
    error.hidden = this.draft_abyssPrivate.error === undefined;
    this.renderActions_abyssPrivate(surface, input);
    surface.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close_abyssPrivate(true);
      } else if (event.key === 'Enter' && event.target === input) {
        event.preventDefault();
        this.submit_abyssPrivate(input);
      }
    });
    surface.ownerDocument.addEventListener(
      'pointerdown',
      this.handlePointerDown_abyssPrivate,
      true,
    );
    this.positionCleanup_abyssPrivate = mountProjectCellEditorPosition({
      anchor,
      host: surface,
      boundary: this.options_abyssPrivate.boundary,
      positioningContainer: this.options_abyssPrivate.host,
      preferredWidth: 320,
    });
    this.patchSurface_abyssPrivate();
    if (!input.readOnly) input.focus({ preventScroll: true });
  }

  private renderActions_abyssPrivate(surface: HTMLElement, input: HTMLInputElement): void {
    const actions = surface.createDiv({ cls: 'abyss-project-creation-actions' });
    const submit = actions.createEl('button', {
      cls: 'mod-cta abyss-project-creation-submit',
      text: 'Create',
      attr: { type: 'button' },
    });
    const open = actions.createEl('button', {
      cls: 'abyss-project-creation-open',
      text: 'Open note',
      attr: { type: 'button' },
    });
    open.addEventListener('click', () => {
      const blockedPath = this.draft_abyssPrivate.blockedPath;
      if (blockedPath !== undefined) this.options_abyssPrivate.openProject(blockedPath);
    });
    const another = actions.createEl('button', {
      cls: 'abyss-project-creation-another',
      text: 'Create another',
      attr: { type: 'button' },
    });
    another.addEventListener('click', () => {
      this.draft_abyssPrivate = {
        name: '',
        statusId: this.freshStatusId_abyssPrivate,
        statusLabel: this.freshStatusLabel_abyssPrivate,
        recoveryPath: undefined,
        blockedPath: undefined,
        error: undefined,
      };
      input.value = '';
      this.patchSurface_abyssPrivate();
      input.focus({ preventScroll: true });
    });
    const cancel = actions.createEl('button', {
      cls: 'abyss-project-creation-cancel',
      text: 'Cancel',
      attr: { type: 'button' },
    });
    submit.addEventListener('click', () => {
      this.submit_abyssPrivate(input);
    });
    cancel.addEventListener('click', () => {
      this.close_abyssPrivate(true);
    });
  }

  private readonly handlePointerDown_abyssPrivate = (event: PointerEvent): void => {
    const surface = this.surface_abyssPrivate;
    if (
      surface === undefined ||
      !(event.target instanceof Node) ||
      surface.contains(event.target)
    ) {
      return;
    }
    this.close_abyssPrivate(false);
  };

  private close_abyssPrivate(restoreFocus: boolean): void {
    const surface = this.surface_abyssPrivate;
    if (surface === undefined) return;
    const input = surface.querySelector<HTMLInputElement>('.abyss-project-creation-name');
    if (input !== null) this.draft_abyssPrivate.name = input.value;
    surface.ownerDocument.removeEventListener(
      'pointerdown',
      this.handlePointerDown_abyssPrivate,
      true,
    );
    this.positionCleanup_abyssPrivate?.();
    this.positionCleanup_abyssPrivate = undefined;
    surface.remove();
    this.surface_abyssPrivate = undefined;
    const anchor = this.anchor_abyssPrivate;
    this.anchor_abyssPrivate = undefined;
    if (restoreFocus && anchor?.isConnected === true) anchor.focus({ preventScroll: true });
  }

  private submit_abyssPrivate(input: HTMLInputElement): void {
    if (this.submitting_abyssPrivate || this.draft_abyssPrivate.blockedPath !== undefined) return;
    const name = input.value.trim();
    this.draft_abyssPrivate.name = input.value;
    if (name.length === 0) return;
    this.submitting_abyssPrivate = true;
    this.patchSurface_abyssPrivate();
    const request: ProjectCreateRequest = {
      name,
      ...(this.draft_abyssPrivate.statusId === undefined
        ? {}
        : { statusId: this.draft_abyssPrivate.statusId }),
      ...(this.draft_abyssPrivate.recoveryPath === undefined
        ? {}
        : { recoveryPath: this.draft_abyssPrivate.recoveryPath }),
    };
    void this.options_abyssPrivate.create(request).then(
      (path) => {
        this.submitting_abyssPrivate = false;
        if (path !== null) this.options_abyssPrivate.created(path, request.statusId);
        this.close_abyssPrivate(false);
        this.draft_abyssPrivate = {
          name: '',
          statusId: undefined,
          statusLabel: undefined,
          recoveryPath: undefined,
          blockedPath: undefined,
          error: undefined,
        };
      },
      (error: unknown) => {
        this.submitting_abyssPrivate = false;
        this.draft_abyssPrivate.error = failureMessage(error);
        if (isProjectCreationError(error)) {
          if (error.phase === 'status') this.draft_abyssPrivate.recoveryPath = error.createdPath;
          else this.draft_abyssPrivate.blockedPath = error.createdPath;
        }
        this.options_abyssPrivate.failed(error);
        this.patchSurface_abyssPrivate();
      },
    );
  }

  private patchSurface_abyssPrivate(): void {
    const surface = this.surface_abyssPrivate;
    if (surface === undefined) return;
    const blocked = this.draft_abyssPrivate.blockedPath !== undefined;
    surface.setAttribute('aria-busy', String(this.submitting_abyssPrivate));
    const input = surface.querySelector<HTMLInputElement>('.abyss-project-creation-name');
    if (input !== null) input.readOnly = this.submitting_abyssPrivate || blocked;
    const submit = surface.querySelector<HTMLButtonElement>('.abyss-project-creation-submit');
    if (submit !== null) {
      submit.disabled = this.submitting_abyssPrivate || blocked;
      submit.setText(this.submitLabel_abyssPrivate());
    }
    const error = surface.querySelector<HTMLElement>('.abyss-project-creation-error');
    if (error !== null) {
      error.setText(this.draft_abyssPrivate.error ?? '');
      error.hidden = this.draft_abyssPrivate.error === undefined;
    }
    const open = surface.querySelector<HTMLButtonElement>('.abyss-project-creation-open');
    if (open !== null) open.hidden = !blocked;
    const another = surface.querySelector<HTMLButtonElement>('.abyss-project-creation-another');
    if (another !== null) another.hidden = !blocked;
  }

  private submitLabel_abyssPrivate(): string {
    return this.draft_abyssPrivate.recoveryPath === undefined ? 'Create' : 'Retry status';
  }
}
