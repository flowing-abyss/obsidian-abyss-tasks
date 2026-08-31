/**
 * The small, semantic building blocks shared by every entity inspector.  They
 * deliberately own only presentation markup; callers keep their existing
 * command and draft-continuity responsibilities.
 */
export type InspectorEntityKind = 'task' | 'project' | 'work-note';

export type InspectorFieldKind =
  | 'title'
  | 'status'
  | 'priority'
  | 'date'
  | 'range-start'
  | 'range-end'
  | 'description'
  | 'comments'
  | 'progress'
  | 'diagnostics'
  | 'relations'
  | 'health'
  | 'recurrence'
  | 'subtasks'
  | 'dependencies';

export interface InspectorFieldHandle {
  readonly row: HTMLElement;
  readonly label: HTMLSpanElement;
  readonly content: HTMLElement;
}

type InspectorFieldResultType =
  | 'ok'
  | 'unchanged'
  | 'conflict'
  | 'invalid'
  | 'unsupported'
  | 'io-error';

export interface InspectorFieldPresenter {
  run<T extends { readonly type: string }>(
    input: {
      readonly field: string;
      readonly control: HTMLElement;
      readonly resultMessage?: (result: T | { readonly type: 'io-error' }) => string;
    },
    command: () => Promise<T> | T,
  ): Promise<T | { readonly type: 'io-error' }>;
}

function resultType(result: { readonly type: string }): InspectorFieldResultType {
  if (
    result.type === 'ok' ||
    result.type === 'unchanged' ||
    result.type === 'conflict' ||
    result.type === 'invalid' ||
    result.type === 'unsupported'
  )
    return result.type;
  return 'io-error';
}

function resultMessage(field: string, type: InspectorFieldResultType): string {
  if (type === 'ok' || type === 'unchanged') return `${field} updated.`;
  if (type === 'conflict') return 'This field changed outside calendar. Draft kept.';
  return `Could not save ${field}. Draft kept.`;
}

/** Shared pending/result presentation; entity command services remain the sole writers. */
export function createInspectorFieldPresenter(feedback: HTMLElement): InspectorFieldPresenter {
  feedback.setAttr('role', 'status');
  feedback.setAttr('aria-live', 'polite');
  return {
    async run<T extends { readonly type: string }>(
      {
        field,
        control,
        resultMessage: formatResult,
      }: {
        readonly field: string;
        readonly control: HTMLElement;
        readonly resultMessage?: (result: T | { readonly type: 'io-error' }) => string;
      },
      command: () => Promise<T> | T,
    ): Promise<T | { readonly type: 'io-error' }> {
      feedback.dataset['resultType'] = 'pending';
      feedback.setText(`Saving ${field}…`);
      (control as HTMLButtonElement).disabled = true;
      let result: T | { readonly type: 'io-error' };
      try {
        result = await command();
      } catch {
        result = { type: 'io-error' };
      }
      const type = resultType(result);
      feedback.dataset['resultType'] = type;
      feedback.setText(formatResult?.(result) ?? resultMessage(field, type));
      (control as HTMLButtonElement).disabled = false;
      if (type !== 'ok' && type !== 'unchanged' && control.isConnected) {
        control.focus({ preventScroll: true });
      }
      return result;
    },
  };
}

export function markInspectorEntity(host: HTMLElement, kind: InspectorEntityKind): void {
  host.addClass('abyss-entity-inspector');
  host.dataset['inspectorEntity'] = kind;
}

export function markInspectorField(host: HTMLElement, field: InspectorFieldKind): HTMLElement {
  host.addClass('abyss-inspector-field');
  host.dataset['inspectorField'] = field;
  return host;
}

export function renderInspectorField(
  host: HTMLElement,
  field: InspectorFieldKind,
  label: string,
  className = '',
): InspectorFieldHandle {
  const row = markInspectorField(
    host.createDiv({ cls: ['abyss-inspector-field-row', className].filter(Boolean).join(' ') }),
    field,
  );
  const fieldLabel = row.createSpan({ cls: 'abyss-inspector-field-label', text: label });
  const content = row.createDiv({ cls: 'abyss-inspector-field-content' });
  return { row, label: fieldLabel, content };
}

/** A semantic field row that hosts legacy controls without making the control the row. */
export function renderInspectorControlField(
  host: HTMLElement,
  field: InspectorFieldKind,
  label: string,
  className = '',
): InspectorFieldHandle {
  const handle = renderInspectorField(host, field, label, className);
  handle.row.addClass('abyss-inspector-control-field');
  handle.label.addClass('abyss-sr-only');
  return handle;
}
