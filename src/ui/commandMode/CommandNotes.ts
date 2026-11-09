import { Component, type App } from 'obsidian';
import type { NotePlanV1, NoteReadPageV1 } from '../../../api';
import { commandMessage } from '../../ai/commandMessages';
import { isCommandNoteReadback } from '../../ai/commandSchemas';
import type {
  CommandJournalEntry,
  CommandNoteRead,
  CommandSessionSnapshot,
  CommandSubmissionBasis,
} from '../../ai/commandTypes';
import { RetainedTaskText, type PreparedTaskTextUpdate } from '../retainedTaskText';

interface NoteFieldDisplay {
  readonly key: string;
  readonly text: string;
  readonly before?: string;
}
interface NoteDisplay {
  readonly key: string;
  readonly path: string;
  readonly scope: string;
  readonly fields: readonly NoteFieldDisplay[];
}
interface NoteRow {
  readonly host: HTMLElement;
  readonly title: HTMLElement;
  readonly path: HTMLElement;
  readonly scope: HTMLElement;
  readonly owner: Component;
  readonly fields: Map<string, NoteField>;
}
interface NoteField {
  readonly body: HTMLElement;
  readonly owner: Component;
  text: RetainedTaskText;
  pending?: PreparedTaskTextUpdate;
  value?: NoteFieldDisplay;
  path?: string;
  ready?: boolean;
  failed?: boolean;
}
function readScope(page: NoteReadPageV1 & { continued?: boolean }): string {
  const part =
    page.resolvedSubpath ??
    (page.selection === 'note' ? commandMessage('Note') : commandMessage('Selected section'));
  if (page.continued === true)
    return commandMessage('Continuation · {detail}', {
      detail: page.complete
        ? commandMessage('End of selection.')
        : commandMessage('More content remains; ask to continue.'),
    });
  if (!page.complete || page.truncated)
    return commandMessage(
      '{part} excerpt · More content remains; ask to continue or read the full note.',
      { part },
    );
  return page.selection === 'note'
    ? commandMessage('Full note')
    : commandMessage('{part} · Complete selection', { part });
}
function displays(state: CommandSessionSnapshot): NoteDisplay[] {
  const result = new Map<string, NoteDisplay>();
  for (const page of state.entities.notes) {
    if (!showRead(state, page)) continue;
    result.set(page.note.path, {
      key: page.note.path,
      path: page.note.path,
      scope: currentReadScope(state, page),
      fields: [{ key: 'read', text: page.segments.map((segment) => segment.text).join('') }],
    });
  }
  for (const change of state.proposal.changes) {
    if (change.kind !== 'note') continue;
    // A verified note receipt supersedes its old proposal even when a later dependent task fails.
    const written = [...state.journal]
      .reverse()
      .find(
        (entry) =>
          entry.change.kind === 'note' &&
          entry.change.plan.target === change.plan.target &&
          entry.change.plan.revision === change.plan.revision &&
          entry.effects !== 'unchanged',
      );
    if (
      written !== undefined &&
      state.entities.notes.some((page) => isCommandNoteReadback(written, page)) &&
      result.has(change.plan.path)
    )
      continue;
    const plan = change.plan;
    result.delete(plan.path);
    result.set(plan.target, {
      key: plan.target,
      path: plan.path,
      scope: proposalScope(state, plan, written),
      fields: planFields(plan),
    });
  }
  return [...result.values()];
}
function currentReadScope(state: CommandSessionSnapshot, page: CommandNoteRead): string {
  const written = [...state.journal]
    .reverse()
    .find(
      (entry) =>
        entry.change.kind === 'note' &&
        entry.change.plan.path === page.note.path &&
        entry.effects !== 'unchanged',
    );
  return written !== undefined && !isCommandNoteReadback(written, page, 'current')
    ? commandMessage('Historical read · Current content unverified')
    : readScope(page);
}
function proposalScope(
  state: CommandSessionSnapshot,
  plan: NotePlanV1,
  written?: CommandJournalEntry,
): string {
  if (written === undefined) return previewScope(state, plan);
  return written.effects === 'committed'
    ? commandMessage('Written · Current content unverified · Proposed changes')
    : commandMessage('Write outcome unverified · Proposed changes');
}
function planFields(plan: NotePlanV1): readonly NoteFieldDisplay[] {
  return (
    plan.sections?.map((section) => ({
      key: section.section,
      text: section.after.text,
      before: section.before.text,
    })) ?? [{ key: 'body', text: plan.after.text, before: plan.before?.text ?? '' }]
  );
}
/** Retained native Markdown, in the same Q canvas as task and project review. */
export class CommandNotes {
  private readonly rows = new Map<string, NoteRow>();
  private basis: CommandSubmissionBasis | undefined;
  private reviewKeys: readonly string[] = [];
  constructor(
    private readonly host: HTMLElement,
    private readonly app: App,
    private readonly component: Component,
    private readonly options: {
      allowLink(href: string, path: string): boolean;
      changed(): void;
    },
  ) {}
  reviewStatus(basis: CommandSubmissionBasis): 'ready' | 'pending' | 'failed' {
    if (
      this.basis?.sessionId !== basis.sessionId ||
      this.basis.proposalRevision !== basis.proposalRevision
    )
      return 'pending';
    const rows = this.reviewKeys.map((key) => this.rows.get(key));
    if (rows.some((row) => row === undefined || row.fields.size === 0)) return 'pending';
    const fields = rows.flatMap((row) => [...(row?.fields.values() ?? [])]);
    if (fields.some((field) => field.failed === true)) return 'failed';
    return fields.every((field) => field.ready === true) ? 'ready' : 'pending';
  }
  update(state: CommandSessionSnapshot): void {
    this.basis = { sessionId: state.id, proposalRevision: state.proposal.revision };
    this.reviewKeys = state.proposal.changes.flatMap((change) =>
      change.kind === 'note' ? [change.plan.target] : [],
    );
    const notes = displays(state);
    const keys = new Set(notes.map((note) => note.key));
    for (const [key, row] of this.rows) if (!keys.has(key)) this.release(key, row);
    for (const note of notes) this.render(note);
    this.host.hidden = notes.length === 0;
  }
  private render(note: NoteDisplay): void {
    const row = this.row(note.key);
    row.title.textContent = note.path.split('/').pop()?.replace(/\.md$/i, '') ?? note.path;
    row.path.textContent = note.path;
    row.path.setAttribute('title', note.path);
    row.scope.textContent = note.scope;
    const keys = new Set(note.fields.map((field) => field.key));
    for (const [key, field] of row.fields) if (!keys.has(key)) this.releaseField(row, key, field);
    for (const value of note.fields) this.renderField(note, row, value);
  }
  private renderField(note: NoteDisplay, row: NoteRow, value: NoteFieldDisplay): void {
    const field = this.field(row, value.key);
    if (
      field.path === note.path &&
      field.value?.text === value.text &&
      field.value.before === value.before
    )
      return;
    // The error body replaced the renderer's visible DOM; its old source cache is no longer proof.
    if (field.failed === true) {
      field.text.destroy();
      field.body.empty();
      field.text = new RetainedTaskText(field.body, field.owner);
    }
    field.value = value;
    field.path = note.path;
    field.ready = false;
    field.failed = false;
    const current = (): boolean =>
      this.rows.get(note.key) === row &&
      row.fields.get(value.key) === field &&
      field.value === value;
    const failed = (): void => {
      if (!current()) return;
      field.failed = true;
      field.ready = false;
      field.body.textContent = commandMessage('Could not display note content.');
      this.options.changed();
    };
    field.body.dataset['taskSourcePath'] = note.path;
    field.body.dataset['change'] = noteChange(value);
    field.pending = field.text.prepare({
      source: {
        target: { type: 'display', key: `${note.key}:${value.key}` },
        markdown: value.text,
        path: note.path,
        presentation: 'markdown',
      },
      decoration: {
        kind: 'complete',
        ...(value.before === undefined
          ? {}
          : { previousMarkdown: value.before, compareMarkdown: true }),
      },
      callbacks: {
        app: this.app,
        isCurrent: current,
        beforeOpenLink: async ({ href, sourcePath }) => this.options.allowLink(href, sourcePath),
        onRenderFailure: failed,
      },
    });
    const pending = field.pending;
    void pending.ready.then(
      () => {
        if (current() && field.pending === pending) this.commit(field);
      },
      () => {
        if (field.pending === pending) failed();
      },
    );
  }
  private commit(field: NoteField): void {
    if (field.pending?.commit() !== true) return;
    for (const checkbox of field.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      checkbox.disabled = true;
    if (field.ready !== true) {
      field.ready = true;
      this.options.changed();
    }
  }
  private field(row: NoteRow, key: string): NoteField {
    const previous = row.fields.get(key);
    if (previous !== undefined) return previous;
    const body = row.host.createDiv({ cls: 'abyss-command-note-body' });
    const owner = row.owner.addChild(new Component());
    const field = { body, owner, text: new RetainedTaskText(body, owner) };
    row.fields.set(key, field);
    owner.registerDomEvent(body, 'focusout', () => {
      body.win.queueMicrotask(() => {
        if (row.fields.get(key) === field) this.commit(field);
      });
    });
    return field;
  }
  private row(key: string): NoteRow {
    const previous = this.rows.get(key);
    if (previous !== undefined) return previous;
    const host = this.host.createEl('section', { cls: 'abyss-command-note' });
    const title = host.createEl('h3', { cls: 'abyss-command-note-title' });
    const path = host.createDiv({ cls: 'abyss-command-note-path' });
    const scope = host.createDiv({ cls: 'abyss-command-note-scope' });
    const owner = this.component.addChild(new Component());
    const row = { host, title, path, scope, owner, fields: new Map<string, NoteField>() };
    this.rows.set(key, row);
    return row;
  }
  private release(key: string, row: NoteRow): void {
    for (const [fieldKey, field] of row.fields) this.releaseField(row, fieldKey, field);
    this.component.removeChild(row.owner);
    row.host.remove();
    this.rows.delete(key);
  }
  private releaseField(row: NoteRow, key: string, field: NoteField): void {
    field.pending?.cancel();
    field.text.destroy();
    row.owner.removeChild(field.owner);
    field.body.remove();
    row.fields.delete(key);
  }
  destroy(): void {
    this.basis = undefined;
    for (const [key, row] of this.rows) this.release(key, row);
  }
}

function showRead(state: CommandSessionSnapshot, page: NoteReadPageV1): boolean {
  return (
    state.focus.some((focus) => focus.kind === 'note' && focus.target === page.note.target) ||
    state.journal.some(
      (entry) =>
        entry.change.kind === 'note' &&
        entry.change.plan.path === page.note.path &&
        entry.effects === 'committed',
    )
  );
}
function previewScope(state: CommandSessionSnapshot, plan: NotePlanV1): string {
  if (plan.kind === 'create') return commandMessage('New note · Complete preview');
  if ((plan.sections?.length ?? 0) > 1)
    return commandMessage('Changed sections · Complete preview');
  const label = state.entities.notes
    .flatMap((page) => page.segments)
    .find((segment) => segment.section.target === plan.section)?.section.label;
  const scope =
    label === undefined
      ? commandMessage('Changed section')
      : commandMessage('Changed section · {label}', { label });
  return commandMessage('{scope} · Complete preview', { scope });
}
function noteChange(note: NoteFieldDisplay): string {
  if (note.before === undefined) return '';
  return note.before === '' ? 'added' : 'changed';
}
