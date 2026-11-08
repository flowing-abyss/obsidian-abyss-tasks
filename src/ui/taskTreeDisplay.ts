import { Component } from 'obsidian';
import { isImeOwnedEvent } from './ime';
import {
  RetainedTaskText,
  sameRetainedTextIdentity,
  type PreparedTaskTextUpdate,
  type RetainedTaskTextInput,
  type RetainedTextIdentity,
} from './retainedTaskText';
import type { TaskRenderOutcome } from './taskRenderScope';
import { TaskTreeMotion } from './taskTreeMotion';

export interface TaskDisplayField {
  readonly key: string;
  readonly input: RetainedTaskTextInput;
  readonly change?: 'added' | 'changed' | 'removed';
}
export interface TaskDisplayComment {
  readonly kind: 'comment';
  readonly key: string;
  readonly field: TaskDisplayField;
}
export interface TaskDisplayNode {
  readonly kind: 'task';
  readonly key: string;
  readonly identity: RetainedTextIdentity;
  readonly title?: TaskDisplayField;
  readonly description?: TaskDisplayField;
  readonly descriptionPreview?: boolean;
  readonly entries: ReadonlyArray<TaskDisplayNode | TaskDisplayComment>;
  readonly complete: boolean;
  readonly done: boolean;
  readonly change?: 'added' | 'removed';
  readonly renderHeader?: (host: HTMLElement, owner: Component) => void;
  readonly onActivate: (event?: MouseEvent) => void;
  readonly onContextMenu?: (event: MouseEvent, row: HTMLElement) => void;
}
export interface TaskTreeDisplayOptions {
  readonly owner: Component;
  readonly roots: readonly TaskDisplayNode[];
  readonly isCurrent: () => boolean;
  readonly onRenderFailure?: (error: unknown) => void;
  /** Native cards already own the root title/header; its description remains in this host. */
  readonly baseTextHost?: HTMLElement;
  readonly motion?: boolean;
}
export interface TaskTreeDisplayMount {
  readonly settled: Promise<TaskRenderOutcome>;
  update(options: TaskTreeDisplayOptions): void;
  cancelPending(): void;
  destroy(): void;
}
export function createTaskRow(
  host: HTMLElement,
  root: boolean,
): {
  row: HTMLElement;
  body: HTMLElement;
  titleRow: HTMLElement;
  title: HTMLElement;
} {
  const row = host.createDiv({
    cls: root ? 'abyss-task-card-main-row' : 'abyss-subtask-row abyss-task-card-main-row',
  });
  const body = row.createDiv({
    cls: root ? 'abyss-task-body' : 'abyss-subtask-content abyss-task-body',
  });
  const titleRow = body.createDiv({
    cls: root ? 'abyss-task-title-row' : 'abyss-subtask-title-row',
  });
  const title = titleRow.createSpan({ cls: root ? 'abyss-task-title' : 'abyss-subtask-label' });
  return { row, body, titleRow, title };
}
export function reconcileTaskElements(
  container: HTMLElement,
  elements: readonly HTMLElement[],
): void {
  const desired = new Set(elements);
  for (const child of [...container.children])
    if (!desired.has(child as HTMLElement)) child.remove();
  let cursor = container.firstChild;
  for (const element of elements) {
    if (element === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(element, cursor);
  }
}
interface FieldRecord {
  active: boolean;
  readonly element: HTMLElement;
  readonly wrapper: HTMLElement;
  readonly text: RetainedTaskText;
  readonly owner: Component;
}
interface EntryRecord {
  value: TaskDisplayNode;
  readonly host: HTMLElement;
  readonly row: HTMLElement | undefined;
  readonly body: HTMLElement;
  readonly owner: Component;
  readonly fields: Map<string, FieldRecord>;
  title: FieldRecord | undefined;
  live: boolean;
}
interface Preparation {
  readonly records: Map<string, EntryRecord>;
  readonly fields: Map<EntryRecord, Set<string>>;
  readonly updates: PreparedTaskTextUpdate[];
  readonly placements: Array<readonly [HTMLElement, readonly HTMLElement[]]>;
  readonly created: EntryRecord[];
  readonly added: Array<readonly [EntryRecord, string]>;
}
class RetainedTaskTree implements TaskTreeDisplayMount {
  private readonly owner: Component;
  private records = new Map<string, EntryRecord>();
  private live = true;
  private motion: TaskTreeMotion | undefined;
  private cancel = (): void => {};
  settled: Promise<TaskRenderOutcome> = Promise.resolve({ type: 'ready' });
  constructor(
    private readonly host: HTMLElement,
    private options: TaskTreeDisplayOptions,
  ) {
    this.owner = options.owner.addChild(new Component());
    this.update(options);
  }
  private current(record: EntryRecord): boolean {
    return (
      this.live && record.live && record.value.change !== 'removed' && this.options.isCurrent()
    );
  }
  private field(
    record: EntryRecord,
    key: string,
    kind: 'description' | 'comment',
    plan: Preparation,
  ): FieldRecord {
    let field = record.fields.get(key);
    if (field !== undefined) return field;
    const wrapper = record.host.createDiv({
      cls: kind === 'comment' ? 'abyss-comment-row' : 'abyss-task-desc',
    });
    wrapper.remove();
    const element =
      kind === 'comment' ? wrapper.createEl('p', { cls: 'abyss-comment-text' }) : wrapper;
    field = this.makeField(record, element, wrapper);
    record.fields.set(key, field);
    plan.added.push([record, key]);
    return field;
  }
  private makeField(record: EntryRecord, element: HTMLElement, wrapper: HTMLElement): FieldRecord {
    const owner = record.owner.addChild(new Component());
    const text = new RetainedTaskText(
      element,
      owner,
      this.host.closest<HTMLElement>('.abyss-panel-view') ?? this.host.ownerDocument.body,
    );
    const field = { element, wrapper, text, owner, active: false };
    owner.registerDomEvent(element, 'click', (event) => {
      if (!field.active || !this.current(record)) {
        event.stopPropagation();
        return;
      }
      const target = event.target;
      if (
        element.ownerDocument.defaultView !== null &&
        target instanceof element.ownerDocument.defaultView.Element &&
        target.closest('a, button, .abyss-status-control, .abyss-task-tag, .abyss-task-date') !==
          null
      )
        return;
      record.value.onActivate(event);
    });
    return field;
  }
  private entry(value: TaskDisplayNode, root: boolean, plan: Preparation): EntryRecord {
    const previous = this.records.get(value.key);
    let record =
      previous !== undefined && sameRetainedTextIdentity(previous.value.identity, value.identity)
        ? previous
        : undefined;
    if (record === undefined) {
      record = this.createEntry(value, root);
      plan.created.push(record);
    }
    record.value = value;
    record.live = true;
    for (const field of record.fields.values()) field.active = false;
    plan.records.set(value.key, record);
    plan.fields.set(record, new Set());
    record.host.dataset['change'] = value.change ?? '';
    record.host.inert = value.change === 'removed';
    record.host.setAttribute('aria-disabled', String(value.change === 'removed'));
    if (record.row !== undefined) value.renderHeader?.(record.row, record.owner);
    return record;
  }
  private createEntry(value: TaskDisplayNode, root: boolean): EntryRecord {
    const external = root && this.options.baseTextHost !== undefined;
    const host = this.host.createDiv({
      cls: root && !external ? 'abyss-task-card' : 'abyss-subtask-content',
    });
    host.dataset['taskDisplayKey'] = value.key;
    host.remove();
    const owner = this.owner.addChild(new Component());
    const shell = external ? undefined : createTaskRow(host, root);
    const body = shell === undefined ? this.baseBody(host) : shell.body;
    const record: EntryRecord = {
      value,
      host,
      owner,
      row: shell?.row,
      body,
      fields: new Map(),
      title: undefined,
      live: true,
    };
    if (shell !== undefined) record.title = this.makeField(record, shell.title, shell.titleRow);
    if (shell !== undefined) this.bindEntry(record, shell.row);
    return record;
  }
  private baseBody(host: HTMLElement): HTMLElement {
    return this.options.baseTextHost?.createDiv({ cls: 'abyss-search-context' }) ?? host;
  }
  private bindEntry(record: EntryRecord, row: HTMLElement): void {
    row.tabIndex = 0;
    record.owner.registerDomEvent(row, 'keydown', (event) => {
      if (event.target !== row || !['Enter', ' '].includes(event.key) || isImeOwnedEvent(event))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (this.current(record)) record.value.onActivate();
    });
    record.owner.registerDomEvent(record.host, 'contextmenu', (event) => {
      if (this.current(record)) record.value.onContextMenu?.(event, row);
    });
  }
  private prepareField(field: FieldRecord, value: TaskDisplayField, plan: Preparation): void {
    field.active = true;
    field.element.dataset['taskSourcePath'] = value.input.source.path;
    field.wrapper.dataset['change'] = value.change ?? '';
    if (value.change === undefined) field.wrapper.removeAttribute('aria-description');
    else field.wrapper.setAttribute('aria-description', value.change);
    field.wrapper.inert = value.change === 'removed';
    plan.updates.push(field.text.prepare(value.input));
  }
  private prepare(value: TaskDisplayNode, root: boolean, plan: Preparation): EntryRecord {
    const record = this.entry(value, root, plan);
    this.prepareBody(record, root, plan);
    const entries: HTMLElement[] = record.row === undefined ? [] : [record.row];
    for (const entry of value.entries) {
      if (entry.kind === 'task') entries.push(this.prepare(entry, false, plan).host);
      else {
        const field = this.field(record, entry.key, 'comment', plan);
        this.prepareField(field, entry.field, plan);
        plan.fields.get(record)?.add(entry.key);
        entries.push(field.wrapper);
      }
    }
    plan.placements.push([record.host, entries]);
    return record;
  }
  private prepareBody(record: EntryRecord, root: boolean, plan: Preparation): void {
    const value = record.value;
    const body: HTMLElement[] = [];
    if (record.title !== undefined && value.title !== undefined) {
      this.prepareField(record.title, value.title, plan);
      record.title.element.classList.toggle('is-done', value.done);
      body.push(record.title.wrapper);
    }
    let description: FieldRecord | undefined;
    if (value.description !== undefined) {
      description = this.field(record, value.description.key, 'description', plan);
      this.prepareField(description, value.description, plan);
      plan.fields.get(record)?.add(value.description.key);
      if (value.descriptionPreview !== true) body.push(description.element);
    }
    plan.placements.push([record.body, body]);
    if (root && this.options.baseTextHost !== undefined)
      plan.placements.push([
        this.options.baseTextHost,
        [
          ...(value.descriptionPreview === true && description !== undefined
            ? [description.element]
            : []),
          record.body,
        ],
      ]);
  }
  private releaseField(record: EntryRecord, field: FieldRecord): void {
    field.text.destroy();
    record.owner.removeChild(field.owner);
    field.wrapper.remove();
  }
  private release(record: EntryRecord): void {
    record.live = false;
    record.title?.text.destroy();
    for (const field of record.fields.values()) this.releaseField(record, field);
    this.owner.removeChild(record.owner);
    record.host.remove();
    if (record.row === undefined) record.body.remove();
  }
  private focusedRemoval(plan: Preparation): boolean {
    const active = this.host.ownerDocument.activeElement;
    for (const [key, record] of this.records) {
      if (
        plan.records.get(key) !== record &&
        (record.host.contains(active) || record.body.contains(active))
      )
        return true;
      for (const [fieldKey, field] of record.fields)
        if (plan.fields.get(record)?.has(fieldKey) !== true && field.element.contains(active))
          return true;
    }
    return false;
  }
  private commit(plan: Preparation, retry: () => void): boolean {
    if (this.focusedRemoval(plan)) return false;
    if (!plan.updates.every((update) => update.canCommit())) return false;
    if (this.motion?.before(plan.placements, retry) === false) return false;
    if (!plan.updates.every((update) => update.commit())) return false;
    for (const [host, elements] of plan.placements) reconcileTaskElements(host, elements);
    this.motion?.after();
    for (const [key, record] of this.records)
      if (plan.records.get(key) !== record) this.release(record);
    this.retireFields(plan);
    this.records = plan.records;
    return true;
  }
  private retireFields(plan: Preparation): void {
    for (const [record, fields] of plan.fields)
      for (const [key, field] of record.fields)
        if (!fields.has(key)) {
          this.releaseField(record, field);
          record.fields.delete(key);
        }
  }
  update(options: TaskTreeDisplayOptions): void {
    this.cancel();
    this.motion?.cancel();
    if (options.motion === true) this.motion ??= new TaskTreeMotion(this.host);
    this.options = options;
    const plan: Preparation = {
      records: new Map(),
      fields: new Map(),
      updates: [],
      placements: [],
      created: [],
      added: [],
    };
    const roots = options.roots.map((root) => this.prepare(root, true, plan).host);
    plan.placements.push([this.host, roots]);
    let done = false;
    let resolve!: (value: TaskRenderOutcome) => void;
    this.settled = new Promise((r) => {
      resolve = r;
    });
    const cleanup = (): void => {
      this.host.removeEventListener('focusout', blur);
      options.baseTextHost?.removeEventListener('focusout', blur);
    };
    const finish = (result: TaskRenderOutcome): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };
    const commit = (): void => {
      if (!done && this.live && options.isCurrent() && this.commit(plan, commit))
        finish({ type: 'ready' });
    };
    const blur = (): void => {
      this.host.win.queueMicrotask(commit);
    };
    const cancel = (): void => {
      for (const update of plan.updates) update.cancel();
      for (const record of plan.created) this.release(record);
      for (const [record, key] of plan.added) {
        const field = record.fields.get(key);
        if (field !== undefined) this.releaseField(record, field);
        record.fields.delete(key);
      }
    };
    this.cancel = () => {
      if (!done) {
        cancel();
        finish({ type: 'cancelled' });
      }
    };
    this.host.addEventListener('focusout', blur);
    options.baseTextHost?.addEventListener('focusout', blur);
    void Promise.all(plan.updates.map((update) => update.ready)).then(
      (outcomes) => {
        if (done) return;
        const failure = outcomes.find((outcome) => outcome.type !== 'ready');
        if (failure !== undefined) {
          cancel();
          finish(failure);
        } else commit();
      },
      (error: unknown) => {
        if (done) return;
        cancel();
        finish({ type: 'failed', error });
        options.onRenderFailure?.(error);
      },
    );
    commit();
  }
  cancelPending(): void {
    this.motion?.cancel();
    this.cancel();
  }
  destroy(): void {
    this.motion?.cancel();
    this.live = false;
    this.cancel();
    for (const record of this.records.values()) this.release(record);
    this.records.clear();
    this.options.owner.removeChild(this.owner);
  }
}
export function mountTaskTreeDisplay(
  host: HTMLElement,
  options: TaskTreeDisplayOptions,
): TaskTreeDisplayMount {
  return new RetainedTaskTree(host, options);
}
