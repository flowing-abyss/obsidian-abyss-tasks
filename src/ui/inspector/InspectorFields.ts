/**
 * The small, semantic building blocks shared by every entity inspector.  They
 * deliberately own only presentation markup; callers keep their existing
 * command and draft-continuity responsibilities.
 */
export type InspectorEntityKind = 'task' | 'project' | 'work-note';

export type InspectorFieldKind =
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
