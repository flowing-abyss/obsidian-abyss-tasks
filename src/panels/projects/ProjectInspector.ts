import { setIcon } from 'obsidian';
import type {
  ProjectCommandService,
  ProjectFieldObservation,
  ProjectRangeObservation,
} from '../../projects/ProjectCommandService';
import { parseProjectDate } from '../../projects/projectDates';
import type { Project, ProjectPriority, TaskRollup } from '../../projects/types';
import {
  formatCommentTimeLabel,
  type CommentTimeContext,
  type CommentTimeContextProvider,
} from '../../tasks';
import {
  type InspectorDraftEntry,
  type InspectorDraftField,
  type InspectorDraftIdentity,
  type InspectorDraftRegistry,
  type InspectorDraftResult,
} from '../../ui/projectDraftContinuity';

interface ProjectInspectorCommandResult {
  readonly type: string;
}

export interface ProjectInspectorOptions {
  readonly project: Project;
  readonly taskRollup: TaskRollup;
  readonly healthReason?: string;
  readonly openNote: (path: string) => void;
  readonly commands?: Pick<
    ProjectCommandService,
    | 'observeRange'
    | 'observeComments'
    | 'setPriority'
    | 'setDescription'
    | 'setRange'
    | 'appendComment'
  >;
  readonly statuses?: readonly { readonly id: string; readonly label: string }[];
  readonly onSetStatus?: (
    statusId: string,
  ) => Promise<ProjectInspectorCommandResult> | ProjectInspectorCommandResult | void;
  readonly commentTimeContext?: CommentTimeContextProvider;
  readonly draftRegistry?: InspectorDraftRegistry;
  readonly onDraftSettled?: () => void;
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;
type TimestampedProjectComment = Extract<
  NonNullable<Project['comments']>[number],
  { readonly kind: 'timestamp' }
>;

function absoluteCommentTitle(
  entry: TimestampedProjectComment,
  context: CommentTimeContext,
): string {
  if (entry.timestamp.precision === 'instant') {
    return new Intl.DateTimeFormat(context.locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZone: context.timeZone,
      timeZoneName: 'short',
    }).format(entry.timestamp.epochMs);
  }
  return new Intl.DateTimeFormat(context.locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(`${entry.timestamp.value}T12:00:00.000Z`));
}

function knownResult(type: string): InspectorDraftResult {
  if (
    type === 'ok' ||
    type === 'unchanged' ||
    type === 'conflict' ||
    type === 'unsupported' ||
    type === 'invalid' ||
    type === 'io-error'
  ) {
    return type;
  }
  return 'io-error';
}

function resultMessage(result: ProjectInspectorCommandResult, field: InspectorDraftField): string {
  const label = field === 'comment' ? 'Comment' : `${field[0]!.toUpperCase()}${field.slice(1)}`;
  if (result.type === 'ok') return `${label} updated.`;
  if (result.type === 'unchanged') return `${label} is unchanged.`;
  if (result.type === 'conflict') return 'This field changed outside calendar. Draft kept.';
  if (result.type === 'unsupported') {
    return 'This field is not supported by this project note. Draft kept.';
  }
  if (result.type === 'io-error') return 'Could not save this field. Draft kept.';
  if (result.type === 'invalid') return 'This value is not valid. Draft kept.';
  return 'Could not save this field. Draft kept.';
}

function failureResult(result: ProjectInspectorCommandResult): boolean {
  return result.type !== 'ok' && result.type !== 'unchanged';
}

function fieldFeedback(
  host: HTMLElement,
  field: InspectorDraftField,
  draft: InspectorDraftEntry | undefined,
): HTMLElement {
  const feedback = host.createDiv({
    cls: 'abyss-project-inspector-result',
    attr: {
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      'data-project-field-result': field,
    },
  });
  if (draft?.pending) {
    feedback.dataset['resultType'] = 'pending';
    feedback.setText(`Saving ${field}…`);
  } else if (draft?.result) {
    feedback.dataset['resultType'] = draft.result;
    feedback.setText(resultMessage({ type: draft.result }, field));
  }
  return feedback;
}

function selection(control: TextControl): { selectionStart: number; selectionEnd: number } {
  return {
    selectionStart: control.selectionStart ?? control.value.length,
    selectionEnd: control.selectionEnd ?? control.value.length,
  };
}

function restoreTextControl(
  control: TextControl,
  identity: InspectorDraftIdentity,
  field: InspectorDraftField,
  baseline: string,
  registry: InspectorDraftRegistry | undefined,
  observation?: unknown,
): InspectorDraftEntry | undefined {
  const draft = registry?.reconcile(identity, field, baseline, observation);
  control.value = draft?.value ?? baseline;
  control.dataset['inspectorBaseline'] = draft?.baseline ?? baseline;
  control.dataset['inspectorField'] = field;
  if (draft) control.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  const capture = (preserveResult: boolean): void => {
    const current = registry?.get(identity, field);
    registry?.capture(identity, field, {
      ...current,
      value: control.value,
      baseline: control.dataset['inspectorBaseline'] ?? baseline,
      ...selection(control),
      hadFocus: control.ownerDocument.activeElement === control,
      observation: registry?.get(identity, field)?.observation ?? observation,
      result: preserveResult ? current?.result : undefined,
    });
  };
  control.addEventListener('input', () => capture(false));
  control.addEventListener('focus', () => capture(true));
  control.addEventListener('select', () => capture(true));
  control.addEventListener('blur', () => capture(true));
  if (draft?.hadFocus) {
    queueMicrotask(() => {
      if (!control.isConnected) return;
      control.focus({ preventScroll: true });
      control.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    });
  }
  return draft;
}

function captureSelect(
  select: HTMLSelectElement,
  identity: InspectorDraftIdentity,
  baseline: string,
  registry: InspectorDraftRegistry | undefined,
): InspectorDraftEntry | undefined {
  const draft = registry?.reconcile(identity, 'status', baseline);
  const failed = draft?.result && draft.result !== 'ok' && draft.result !== 'unchanged';
  select.value = failed ? draft.baseline : (draft?.value ?? baseline);
  select.dataset['inspectorBaseline'] = draft?.baseline ?? baseline;
  select.dataset['inspectorField'] = 'status';
  if (draft?.hadFocus) {
    queueMicrotask(() => {
      if (select.isConnected) select.focus({ preventScroll: true });
    });
  }
  return draft;
}

export function renderInspectorDraftRecovery(
  container: HTMLElement,
  drafts: readonly InspectorDraftEntry[],
  onDiscard?: (draft: InspectorDraftEntry) => void,
): void {
  if (drafts.length === 0) return;
  const recovery = container.createDiv({
    cls: 'abyss-inspector-draft-recovery',
    attr: { role: 'region', 'aria-label': 'Unsaved inspector drafts' },
  });
  recovery.createEl('h4', { text: 'Unsaved drafts' });
  recovery.createEl('p', {
    text: 'The source note is no longer available. Copy the draft before dismissing it.',
  });
  for (const draft of drafts) {
    const row = recovery.createDiv({ cls: 'abyss-inspector-draft-recovery-row' });
    row.createEl('span', { text: `${draft.identity.path} · ${draft.field}` });
    const value = row.createEl('textarea', {
      attr: { readonly: '', 'aria-label': `${draft.field} recovery draft` },
    });
    value.value = draft.value;
    const copy = row.createEl('button', {
      text: 'Copy',
      attr: { type: 'button', 'aria-label': `Copy ${draft.field} recovery draft` },
    });
    copy.addEventListener('click', () => {
      const clipboard = row.ownerDocument.defaultView?.navigator.clipboard;
      if (clipboard) void clipboard.writeText(draft.value);
    });
    if (onDiscard) {
      const discard = row.createEl('button', {
        text: 'Discard',
        attr: { type: 'button', 'aria-label': `Discard ${draft.field} recovery draft` },
      });
      discard.addEventListener('click', () => {
        onDiscard(draft);
        row.remove();
      });
    }
  }
}

/** Compact Project content rendered inside the one common inspector shell. */
export function renderProjectInspector(
  container: HTMLElement,
  options: ProjectInspectorOptions,
): void {
  container.empty();
  container.addClass('abyss-project-inspector');
  const { project, draftRegistry } = options;
  const identity = { type: 'project' as const, path: project.path };
  const unsupported = new Set(
    (project.metadataDiagnostics ?? [])
      .filter((diagnostic) => diagnostic.issue === 'unsupported')
      .map((diagnostic) => diagnostic.field),
  );
  const header = container.createDiv({ cls: 'abyss-project-inspector-header' });
  header.createEl('h3', { text: project.name });
  const open = header.createEl('button', {
    cls: 'abyss-project-inspector-open',
    attr: { type: 'button', 'aria-label': 'Open project note', title: 'Open project note' },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', () => options.openNote(project.path));

  const fields = container.createDiv({ cls: 'abyss-project-inspector-fields' });
  const labeledField = (
    label: 'Status' | 'Priority' | 'Start' | 'End' | 'Description',
  ): { readonly row: HTMLElement; readonly controlLabel: HTMLLabelElement } => {
    const row = fields.createDiv({ cls: 'abyss-project-inspector-field' });
    const controlLabel = row.createEl('label', { cls: 'abyss-project-inspector-control-label' });
    controlLabel.createSpan({ cls: 'abyss-project-inspector-field-label', text: label });
    return { row, controlLabel };
  };
  const run = async (
    field: InspectorDraftField,
    control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    feedback: HTMLElement,
    command: Promise<ProjectInspectorCommandResult> | ProjectInspectorCommandResult | void,
    onSuccess: () => void,
    onFailure?: () => void,
    restoreFocusOnFailure = false,
  ): Promise<void> => {
    const baseline = control.dataset['inspectorBaseline'] ?? '';
    const hadFocus = control.ownerDocument.activeElement === control;
    const pendingEntry = draftRegistry?.markPending(
      identity,
      field,
      control.value,
      baseline,
      hadFocus || restoreFocusOnFailure,
    );
    feedback.dataset['resultType'] = 'pending';
    feedback.setText(`Saving ${field}…`);
    control.disabled = true;
    let commandResult: ProjectInspectorCommandResult;
    try {
      commandResult = (await command) ?? { type: 'unchanged' };
    } catch {
      commandResult = { type: 'io-error' };
    }
    const resultType = knownResult(commandResult.type);
    feedback.dataset['resultType'] = resultType;
    feedback.setText(resultMessage({ type: resultType }, field));
    control.disabled = false;
    if (failureResult(commandResult)) {
      if (pendingEntry) draftRegistry?.settlePending(pendingEntry, resultType);
      onFailure?.();
      options.onDraftSettled?.();
      if ((hadFocus || restoreFocusOnFailure) && control.isConnected) {
        control.focus({ preventScroll: true });
      }
      return;
    }
    onSuccess();
    if (pendingEntry) draftRegistry?.settlePending(pendingEntry, resultType, control.value);
    options.onDraftSettled?.();
  };
  const recordInvalid = (
    field: InspectorDraftField,
    control: HTMLInputElement | HTMLTextAreaElement,
    feedback: HTMLElement,
  ): void => {
    const current = draftRegistry?.get(identity, field);
    draftRegistry?.capture(identity, field, {
      ...current,
      value: control.value,
      baseline: current?.baseline ?? control.dataset['inspectorBaseline'] ?? '',
      ...selection(control),
      hadFocus: control.ownerDocument.activeElement === control,
      pending: false,
      result: 'invalid',
    });
    feedback.dataset['resultType'] = 'invalid';
    feedback.setText(resultMessage({ type: 'invalid' }, field));
  };

  if (options.statuses && options.onSetStatus) {
    const statusBaseline = project.statusId ?? '';
    const statusField = labeledField('Status');
    const status = statusField.controlLabel.createEl('select', {
      attr: { 'aria-label': 'Project status' },
    });
    for (const definition of options.statuses) {
      status.createEl('option', { text: definition.label, value: definition.id });
    }
    const draft = captureSelect(status, identity, statusBaseline, draftRegistry);
    status.disabled = draft?.pending === true;
    const feedback = fieldFeedback(statusField.row, 'status', draft);
    status.addEventListener('focus', () => {
      const current = draftRegistry?.get(identity, 'status');
      draftRegistry?.capture(identity, 'status', {
        ...current,
        value: current?.value ?? status.value,
        baseline: current?.baseline ?? status.dataset['inspectorBaseline'] ?? statusBaseline,
        selectionStart: 0,
        selectionEnd: 0,
        hadFocus: true,
      });
    });
    status.addEventListener('blur', () => {
      const current = draftRegistry?.get(identity, 'status');
      if (current) draftRegistry?.capture(identity, 'status', { ...current, hadFocus: false });
    });
    status.addEventListener('change', () => {
      const requested = status.value;
      const baseline = status.dataset['inspectorBaseline'] ?? statusBaseline;
      void run(
        'status',
        status,
        feedback,
        options.onSetStatus?.(requested),
        () => {
          status.dataset['inspectorBaseline'] = requested;
        },
        () => {
          status.value = baseline;
        },
      );
    });
  }

  const priorityField = labeledField('Priority');
  const priority = priorityField.controlLabel.createEl('input', {
    attr: { type: 'text', maxlength: '1', 'aria-label': 'Project priority' },
  });
  const priorityDraft = restoreTextControl(
    priority,
    identity,
    'priority',
    project.priority ?? 'D',
    draftRegistry,
    {
      path: project.path,
      value: project.observed?.priority ?? project.frontmatter['priority'],
    } satisfies ProjectFieldObservation,
  );
  const priorityFeedback = fieldFeedback(priorityField.row, 'priority', priorityDraft);
  priority.disabled = unsupported.has('priority') || priorityDraft?.pending === true;
  priority.addEventListener('change', () => {
    const value = priority.value.trim().toUpperCase();
    if (!/^[A-F]$/u.test(value)) {
      recordInvalid('priority', priority, priorityFeedback);
      return;
    }
    if (!options.commands) return;
    priority.value = value;
    void run(
      'priority',
      priority,
      priorityFeedback,
      options.commands.setPriority(
        (draftRegistry?.get(identity, 'priority')?.observation ?? {
          path: project.path,
          value: project.observed?.priority ?? project.frontmatter['priority'],
        }) as ProjectFieldObservation,
        value as ProjectPriority,
      ),
      () => {
        priority.dataset['inspectorBaseline'] = priority.value;
      },
    );
  });

  const startField = labeledField('Start');
  const start = startField.controlLabel.createEl('input', {
    attr: { type: 'text', 'aria-label': 'Project start' },
  });
  const observedRange =
    typeof options.commands?.observeRange === 'function'
      ? options.commands.observeRange(project)
      : undefined;
  const startDraft = restoreTextControl(
    start,
    identity,
    'start',
    project.range.start?.raw ?? '',
    draftRegistry,
    observedRange,
  );
  const startFeedback = fieldFeedback(startField.row, 'start', startDraft);
  start.disabled = startDraft?.pending === true;
  const endField = labeledField('End');
  const end = endField.controlLabel.createEl('input', {
    attr: { type: 'text', 'aria-label': 'Project end' },
  });
  const endDraft = restoreTextControl(
    end,
    identity,
    'end',
    project.range.end?.raw ?? '',
    draftRegistry,
    observedRange,
  );
  const endFeedback = fieldFeedback(endField.row, 'end', endDraft);
  end.disabled = endDraft?.pending === true;
  const saveRange = (field: 'start' | 'end', control: HTMLInputElement): void => {
    if (!options.commands) return;
    const startValue = start.value.trim();
    const endValue = end.value.trim();
    const nextStart = startValue ? parseProjectDate(startValue) : null;
    const nextEnd = endValue ? parseProjectDate(endValue) : null;
    const feedback = field === 'start' ? startFeedback : endFeedback;
    if ((startValue && !nextStart) || (endValue && !nextEnd)) {
      recordInvalid(field, control, feedback);
      return;
    }
    void run(
      field,
      control,
      feedback,
      options.commands.setRange(
        (draftRegistry?.get(identity, field)?.observation ??
          options.commands.observeRange(project)) as ProjectRangeObservation,
        {
          start: nextStart,
          end: nextEnd,
        },
      ),
      () => {
        start.dataset['inspectorBaseline'] = start.value;
        end.dataset['inspectorBaseline'] = end.value;
      },
      undefined,
      true,
    );
  };
  start.addEventListener('blur', () => saveRange('start', start));
  end.addEventListener('blur', () => saveRange('end', end));

  const descriptionField = labeledField('Description');
  const description = descriptionField.controlLabel.createEl('textarea', {
    attr: { 'aria-label': 'Project description' },
  });
  const descriptionDraft = restoreTextControl(
    description,
    identity,
    'description',
    project.description ?? '',
    draftRegistry,
    {
      path: project.path,
      value: project.observed?.description ?? project.frontmatter['description'],
    } satisfies ProjectFieldObservation,
  );
  const descriptionFeedback = fieldFeedback(descriptionField.row, 'description', descriptionDraft);
  description.disabled = unsupported.has('description') || descriptionDraft?.pending === true;
  description.addEventListener('blur', () => {
    if (!options.commands) return;
    void run(
      'description',
      description,
      descriptionFeedback,
      options.commands.setDescription(
        (draftRegistry?.get(identity, 'description')?.observation ?? {
          path: project.path,
          value: project.observed?.description ?? project.frontmatter['description'],
        }) as ProjectFieldObservation,
        description.value || null,
      ),
      () => {
        description.dataset['inspectorBaseline'] = description.value;
      },
      undefined,
      true,
    );
  });

  const comment = fields.createEl('input', {
    attr: { type: 'text', 'aria-label': 'Add project comment', placeholder: 'Add comment' },
  });
  const observedComments =
    typeof options.commands?.observeComments === 'function'
      ? options.commands.observeComments(project)
      : undefined;
  const commentDraft = restoreTextControl(
    comment,
    identity,
    'comment',
    '',
    draftRegistry,
    observedComments,
  );
  const commentFeedback = fieldFeedback(fields, 'comment', commentDraft);
  comment.disabled = unsupported.has('comments') || commentDraft?.pending === true;
  comment.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Enter' ||
      event.isComposing ||
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Chromium can expose IME ownership only through the legacy 229 sentinel.
      event.keyCode === 229 ||
      !options.commands ||
      !comment.value.trim()
    ) {
      return;
    }
    event.preventDefault();
    const submitted = comment.value.trim().replace(/[\r\n]+/gu, ' ');
    void run(
      'comment',
      comment,
      commentFeedback,
      options.commands.appendComment(
        (draftRegistry?.get(identity, 'comment')?.observation ??
          options.commands.observeComments(project)) as ProjectFieldObservation,
        submitted,
      ),
      () => {
        if (comment.value.trim().replace(/[\r\n]+/gu, ' ') === submitted) comment.value = '';
        comment.dataset['inspectorBaseline'] = '';
      },
    );
  });

  if ((project.comments?.length ?? 0) > 0) {
    const comments = container.createDiv({ cls: 'abyss-project-inspector-comments' });
    comments.createEl('h4', { text: 'Comments' });
    for (const entry of project.comments ?? []) {
      const row = comments.createDiv({ cls: 'abyss-project-inspector-comment' });
      if (entry.kind === 'timestamp') {
        const context = options.commentTimeContext?.();
        const label = context
          ? formatCommentTimeLabel({ ...context, timestamp: entry.timestamp })
          : entry.timestamp.raw;
        row.createEl('time', {
          text: label,
          attr: {
            datetime: entry.timestamp.raw,
            title: context ? absoluteCommentTitle(entry, context) : entry.timestamp.raw,
          },
        });
        row.createSpan({ text: ` ${entry.text}` });
      } else if (entry.kind === 'undated') {
        row.setText(entry.text);
      } else {
        row.setText(entry.raw);
      }
    }
  }

  for (const field of unsupported) {
    container.createDiv({
      cls: 'abyss-project-inspector-diagnostic',
      text: `${field[0]!.toUpperCase()}${field.slice(1)} is read-only for this project note.`,
    });
  }
  for (const diagnostic of project.metadataDiagnostics ?? []) {
    if (diagnostic.issue !== 'malformed') continue;
    container.createDiv({
      cls: 'abyss-project-inspector-diagnostic',
      text: `Comment ${String(diagnostic.index + 1)} has a malformed timestamp and is read-only.`,
    });
  }

  const progress = container.createDiv({ cls: 'abyss-project-inspector-progress' });
  progress.setText(
    options.taskRollup.progress === null
      ? 'No tasks'
      : `${String(options.taskRollup.done)} of ${String(options.taskRollup.total)} tasks complete`,
  );
  if (options.healthReason) {
    container.createDiv({ cls: 'abyss-project-inspector-health', text: options.healthReason });
  }
  if (draftRegistry) {
    renderInspectorDraftRecovery(
      container,
      draftRegistry
        .detached()
        .filter(
          (draft) =>
            (draft.identity.type === 'project' && draft.identity.path === project.path) ||
            (draft.identity.type === 'work-note' && draft.identity.projectPath === project.path),
        ),
      (draft) => draftRegistry.discardEntry(draft),
    );
  }
}
