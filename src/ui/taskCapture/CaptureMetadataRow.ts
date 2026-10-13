import { Menu, setIcon } from 'obsidian';
import {
  localDate,
  sameTag,
  taskOccupiedDates,
  type LocalDate,
  type TaskCreateContextPreview,
  type TaskCreateRequest,
  type TaskInputAction,
  type TaskPlanning,
} from '../../tasks';
import { showDatePickerPopover, type DatePickerPopoverHandle } from '../DatePickerPopover';
import { isImeOwnedEvent } from '../ime';
import type { InteractionOwnershipPort } from '../interactionOwnership';
import { showMenuAtMouseEventWithFocus } from '../nativeMenuFocus';
import { runAsyncAction } from '../runAsyncAction';
import { renderSourceNoteContent, renderTaskTagContent } from '../taskMetadataContent';
import type { CaptureInteractionBoundary } from './CaptureInteractionBoundary';
import type { CaptureMetadataSnapshot, TaskCaptureController } from './TaskCaptureController';

type DateRole = Extract<TaskInputAction, { type: 'select-date' }>['role'];
interface MetadataRowOptions {
  readonly boundary: CaptureInteractionBoundary;
  readonly controller: TaskCaptureController;
  readonly input: HTMLInputElement;
  readonly flushInput: () => 'ready' | 'blocked';
  readonly isLive: () => boolean;
  readonly getTagColor?: (tag: string) => string | undefined;
  readonly formatDate?: (value: string, referenceDate?: string) => string;
  readonly shouldShowSourceNote?: (path: string) => boolean;
  readonly getDateClass?: (value: string, referenceDate?: string) => string;
  readonly interactionOwnership?: InteractionOwnershipPort;
}
interface Chip {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly separator: HTMLElement;
  signature: string;
  activate?: (event: MouseEvent) => void;
  dismiss?: TaskInputAction;
  edit?: () => void;
}

function captureMetadata(
  metadata: CaptureMetadataSnapshot,
): Extract<TaskCreateContextPreview, { type: 'ready' }>['metadata'] | undefined {
  if (metadata.preview.type === 'valid') return metadata.preview.metadata;
  if (metadata.context?.type === 'ready') return metadata.context.metadata;
  return undefined;
}

function captureReferenceDate(metadata: CaptureMetadataSnapshot): string | undefined {
  if (metadata.referenceDate !== undefined) return metadata.referenceDate;
  return metadata.context?.type === 'ready' ? metadata.context.referenceDate : undefined;
}

export class CaptureMetadataRow {
  readonly element: HTMLElement;
  private readonly chips = new Map<string, Chip>();
  private picker: DatePickerPopoverHandle | undefined;
  private menu: Menu | undefined;
  private destroyed = false;
  private invalidDraft = false;
  private readonly feedback: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly options: MetadataRowOptions,
  ) {
    this.element = host.createDiv({ cls: 'abyss-capture-metadata' });
    this.feedback = host.createDiv({ cls: 'abyss-capture-error', attr: { role: 'status' } });
    this.feedback.hidden = true;
  }

  render(metadata: CaptureMetadataSnapshot, disabled: boolean): void {
    if (this.destroyed) return;
    this.renderFeedback();
    const keys = new Set<string>();
    this.renderDestination(keys, disabled, metadata);
    this.renderPlanning(keys, disabled, metadata);
    this.renderTags(keys, disabled, metadata);
    this.renderActions(keys, disabled, metadata);
    for (const [key, chip] of this.chips)
      if (!keys.has(key)) {
        chip.element.remove();
        this.chips.delete(key);
      }
    this.reconcileOrder(keys);
  }

  private reconcileOrder(keys: Set<string>): void {
    const ordered = [...keys].flatMap((key, index) => {
      const chip = this.chips.get(key);
      if (chip === undefined) return [];
      chip.separator.hidden = index === 0;
      return [chip.element];
    });
    const active = this.element.ownerDocument.activeElement;
    const focused = ordered.find((element) => element.contains(active));
    const pivot = focused === undefined ? ordered.length : ordered.indexOf(focused);
    // Move siblings around the focused chip; detaching it would dispatch blur into capture.
    let anchor = focused ?? null;
    for (const element of ordered.slice(0, pivot).reverse()) {
      if (element.nextSibling !== anchor) this.element.insertBefore(element, anchor);
      anchor = element;
    }
    let previous = focused;
    for (const element of ordered.slice(pivot + 1)) {
      if (previous !== undefined && previous.nextSibling !== element)
        this.element.insertBefore(element, previous.nextSibling);
      previous = element;
    }
  }

  private renderDestination(
    keys: Set<string>,
    disabled: boolean,
    metadata: CaptureMetadataSnapshot,
  ): void {
    const destination = metadata.destination;
    if (destination !== undefined && this.showDestination(destination)) {
      const chip = this.use(keys, disabled, 'destination');
      this.content(chip, `${destination.filePath}:${String(destination.inbox)}`, () => {
        renderSourceNoteContent(
          chip.body,
          destination.filePath,
          destination.inbox ? 'inbox' : 'file-text',
          destination.inbox ? 'Inbox' : undefined,
        );
      });
    }
  }
  private showDestination(
    destination: NonNullable<CaptureMetadataSnapshot['destination']>,
  ): boolean {
    if (destination.inbox) return true;
    const context = this.options.controller.target.context;
    if (context.type === 'project-dashboard' || context.type === 'project-table') return true;
    if (
      context.type === 'list' &&
      typeof context.selection === 'object' &&
      context.selection.type === 'project'
    )
      return true;
    return this.options.shouldShowSourceNote?.(destination.filePath) ?? true;
  }
  destinationDescription(): string {
    return this.chips.get('destination')?.body.textContent ?? '';
  }
  private renderTags(
    keys: Set<string>,
    disabled: boolean,
    metadata: CaptureMetadataSnapshot,
  ): void {
    const value = captureMetadata(metadata);
    if (value !== undefined) {
      for (const tag of value.tags) {
        const represented = metadata.destination?.representedInboxTag;
        if (represented !== undefined && sameTag(tag, represented)) continue;
        const chip = this.use(keys, disabled, `tag:${tag.toLowerCase()}`, { removable: true });
        const color = this.options.getTagColor?.(tag);
        this.content(chip, `${tag}:${color ?? ''}`, () => {
          renderTaskTagContent(chip.body, tag, color);
        });
        chip.body.setAttribute('aria-label', `Remove ${tag}`);
        chip.body.setAttribute('title', `Remove ${tag}`);
        chip.dismiss = { type: 'remove-tag', tag };
      }
    }
  }
  private renderPlanning(
    keys: Set<string>,
    disabled: boolean,
    metadata: CaptureMetadataSnapshot,
  ): void {
    const planning = this.planning(metadata);
    const interval = taskOccupiedDates(planning).kind === 'interval';
    const referenceDate = captureReferenceDate(metadata);
    for (const role of ['due', 'scheduled', 'start'] as const) {
      const value = planning[role];
      if (value === undefined) continue;
      const chip = this.use(keys, disabled, `date:${role}`, { removable: true, actionable: true });
      const description = this.dateDescription(metadata, role, value);
      chip.body.setAttribute('aria-label', description);
      chip.body.setAttribute('title', description);
      const label = this.dateLabel(value, referenceDate);
      const dateClass = this.dateClass(value, referenceDate, interval);
      this.content(chip, `${label}:${dateClass}`, () => {
        const content = chip.body.createSpan({ cls: `abyss-task-date ${dateClass}`.trim() });
        setIcon(content.createSpan({ cls: 'abyss-date-icon' }), 'calendar');
        content.createSpan({ text: label });
      });
      chip.edit = () => {
        this.openDate(chip.body, role, value);
      };
      chip.dismiss = { type: 'dismiss', role };
    }
    const timeClass = this.dateClass(
      planning.due ?? planning.scheduled ?? planning.start,
      referenceDate,
      interval,
    );
    this.renderTime(keys, disabled, planning.time, timeClass);
  }
  private dateClass(
    value: LocalDate | undefined,
    referenceDate: string | undefined,
    interval: boolean,
  ): string {
    return value === undefined || interval
      ? ''
      : (this.options.getDateClass?.(value, referenceDate) ?? '');
  }
  private planning(metadata: CaptureMetadataSnapshot): Pick<TaskPlanning, DateRole | 'time'> {
    const value = captureMetadata(metadata);
    if (value !== undefined) return value.planning;
    if (!this.showLegacyPlanning(metadata)) return {};
    const planning: Pick<TaskPlanning, DateRole | 'time'> = {};
    const initial = this.planningInitial(metadata);
    for (const role of ['due', 'scheduled', 'start', 'time'] as const) {
      const patch = initial?.[role];
      if (patch?.type === 'set') Object.assign(planning, { [role]: patch.value });
    }
    return planning;
  }
  private showLegacyPlanning(metadata: CaptureMetadataSnapshot): boolean {
    if (
      metadata.context !== undefined &&
      (metadata.context.type !== 'unavailable' || metadata.context.cause !== 'preview-capability')
    )
      return false;
    if (this.options.controller.snapshot().draft.trim().length > 0) return false;
    return (
      metadata.preview.type === 'invalid' &&
      metadata.preview.issues.every((issue) => issue.code === 'invalid-title')
    );
  }
  private planningInitial(metadata: CaptureMetadataSnapshot): TaskCreateRequest['initial'] {
    // Before the first edit, real context dates can render without freezing the draft clock.
    return metadata.projection === undefined &&
      metadata.referenceDate === undefined &&
      this.options.controller.target.session.type === 'ready'
      ? this.options.controller.target.initial
      : metadata.projection?.initial;
  }
  private dateDescription(
    metadata: CaptureMetadataSnapshot,
    role: DateRole,
    value: LocalDate,
  ): string {
    const projection = metadata.projection;
    const binding = projection?.bindings.find((item) => item.role === role);
    const source =
      binding !== undefined &&
      projection?.candidates.some(
        (candidate) =>
          (candidate.date === value ||
            (binding.dateRanges.length === 0 &&
              candidate.date === undefined &&
              candidate.time !== undefined)) &&
          JSON.stringify(candidate.ranges) === JSON.stringify(binding.ranges),
      ) === true
        ? binding.slices.join(' ')
        : undefined;
    const phrase = source === undefined ? '' : ` (${source})`;
    return `Remove ${role} date: ${value}${phrase}. Right-click or Shift+F10 to edit.`;
  }
  private dateLabel(value: string, referenceDate?: string): string {
    return this.options.formatDate?.(value, referenceDate) ?? value;
  }
  private renderTime(
    keys: Set<string>,
    disabled: boolean,
    value: string | undefined,
    dateClass: string,
  ): void {
    if (value !== undefined) {
      const time = value;
      const chip = this.use(keys, disabled, 'time', { removable: true });
      this.content(chip, `${value}:${dateClass}`, () => {
        const content = chip.body.createSpan({ cls: `abyss-task-date ${dateClass}`.trim() });
        setIcon(content.createSpan({ cls: 'abyss-date-icon' }), 'clock');
        content.createSpan({ text: time });
      });
      chip.body.setAttribute('aria-label', `Remove time: ${value}`);
      chip.body.setAttribute('title', `Remove time: ${value}`);
      chip.dismiss = { type: 'dismiss', role: 'time' };
    }
  }
  private renderActions(
    keys: Set<string>,
    disabled: boolean,
    metadata: CaptureMetadataSnapshot,
  ): void {
    if (metadata.projection?.ambiguity === true) {
      const chip = this.use(keys, disabled, 'ambiguity', { actionable: true });
      this.content(chip, 'Choose date', () => {
        chip.body.setText('Choose date');
      });
      chip.activate = (event) => {
        this.openChoices(event, chip.body);
      };
      chip.body.setAttribute('aria-label', 'Choose date');
    }
    if (metadata.canRestore) {
      const chip = this.use(keys, disabled, 'restore', { actionable: true });
      chip.body.setAttribute('aria-label', 'Restore');
      this.content(chip, 'Restore', () => {
        chip.body.setText('Restore');
      });
      chip.body.onmousedown = (event) => {
        this.preserveInputFocus(event);
      };
      chip.activate = () => {
        this.act({ type: 'restore' });
      };
    }
    if (metadata.needsCheckedRetry) {
      const chip = this.use(keys, disabled, 'retry', { actionable: true });
      this.content(chip, 'Checked the note; retry', () => {
        chip.body.setText('Checked the note; retry');
      });
      chip.activate = () => {
        runAsyncAction(this.options.controller.confirmCheckedRetry(), 'Could not add task');
      };
    }
  }
  private use(
    keys: Set<string>,
    disabled: boolean,
    key: string,
    options: { removable?: boolean; actionable?: boolean } = {},
  ): Chip {
    keys.add(key);
    const { removable = false, actionable = false } = options;
    let chip = this.chips.get(key);
    chip ??= this.createChip(key, removable, actionable);
    if (removable || actionable) chip.body.toggleAttribute('disabled', disabled);
    return chip;
  }
  private createChip(key: string, removable: boolean, actionable: boolean): Chip {
    const element = this.element.createSpan({ cls: 'abyss-capture-chip' });
    const separator = element.createSpan({
      cls: 'abyss-capture-separator',
      text: '·',
      attr: { 'aria-hidden': 'true' },
    });
    const body = element.createEl(removable || actionable ? 'button' : 'span', {
      cls: `abyss-capture-chip-body${removable ? ' is-removable' : ''}`,
    });
    if (removable || actionable) body.setAttribute('type', 'button');
    const chip: Chip = { element, body, separator, signature: '' };
    this.chips.set(key, chip);
    body.addEventListener('click', (event) => {
      if (!this.ready(body)) return;
      const current = this.chips.get(key);
      if (removable) {
        if (current?.dismiss !== undefined) this.act(current.dismiss);
      } else current?.activate?.(event as MouseEvent);
    });
    if (removable) {
      body.addEventListener('mousedown', (event) => {
        this.preserveInputFocus(event as MouseEvent);
      });
    }
    if (removable && actionable) {
      const edit = (event: Event): void => {
        if (event.type === 'keydown') {
          const keyboard = event as KeyboardEvent;
          if (keyboard.key !== 'F10' || !keyboard.shiftKey || isImeOwnedEvent(keyboard)) return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (this.ready(body)) this.chips.get(key)?.edit?.();
      };
      body.addEventListener('contextmenu', edit);
      body.addEventListener('keydown', edit);
    }
    return chip;
  }
  destroy(): void {
    this.destroyed = true;
    this.picker?.(false);
    this.menu?.hide();
    this.element.remove();
    this.feedback.remove();
    this.chips.clear();
  }
  private live(): boolean {
    const snapshot = this.options.controller.snapshot();
    return (
      !this.destroyed && this.options.isLive() && !snapshot.readonly && snapshot.phase !== 'closed'
    );
  }
  private ready(body: HTMLElement): boolean {
    return (
      this.live() &&
      !body.hasAttribute('disabled') &&
      body.isConnected &&
      this.options.flushInput() === 'ready' &&
      this.live() &&
      body.isConnected
    );
  }
  private content(chip: Chip, signature: string, render: () => void): void {
    if (chip.signature === signature) return;
    chip.signature = signature;
    chip.body.empty();
    render();
  }
  private preserveInputFocus(event: MouseEvent): void {
    if (this.element.ownerDocument.activeElement === this.options.input) event.preventDefault();
  }
  private act(action: TaskInputAction): void {
    if (!this.live() || this.options.flushInput() === 'blocked') return;
    const active = this.element.ownerDocument.activeElement;
    const owned = this.options.boundary.owns(active);
    this.options.controller.applyMetadataAction(action);
    if (
      owned &&
      active !== null &&
      (!active.isConnected || active.closest('[hidden]') !== null) &&
      this.live()
    ) {
      const restore = this.chips.get('restore')?.body;
      (restore ?? this.options.input).focus({ preventScroll: true });
    }
  }
  private renderFeedback(): void {
    const message = this.invalidDraft
      ? 'Enter a complete date or clear the field.'
      : this.options.controller.snapshot().metadata?.recognitionError;
    this.feedback.setText(message ?? '');
    this.feedback.hidden = message === undefined;
  }
  private openDate(anchor: HTMLElement, role: DateRole, initialValue?: string): void {
    if (!this.live() || this.options.flushInput() === 'blocked') return;
    this.picker?.(false);
    this.feedback.hidden = true;
    let release = (): void => {};
    const handle = showDatePickerPopover({
      owner: this.element,
      boundary:
        this.element.closest<HTMLElement>('.abyss-panel-view') ??
        this.element.parentElement ??
        this.element,
      anchor,
      ...(initialValue === undefined ? {} : { initialValue }),
      ...(this.options.interactionOwnership === undefined
        ? {}
        : { interactionOwnership: this.options.interactionOwnership }),
      onPick: (value) => {
        if (!this.live()) return;
        this.act(
          value === ''
            ? { type: 'dismiss', role }
            : { type: 'select-date', role, value: localDate(value) },
        );
      },
      onInvalidDraft: () => {
        this.invalidDraft = true;
        this.renderFeedback();
      },
      onClose: () => {
        release();
        if (this.picker === handle) {
          this.picker = undefined;
        }
        this.invalidDraft = false;
        this.renderFeedback();
      },
    });
    this.picker = handle;
    release = this.options.boundary.register(handle.element, {
      flush: (trigger) => {
        const result = handle.flush();
        if (result === 'blocked' && trigger === 'enter' && this.live())
          handle.element.querySelector<HTMLInputElement>('input[type="date"]')?.focus();
        return result;
      },
      cancel: () => {
        handle(false);
      },
    });
  }
  private openChoices(event: MouseEvent, anchor: HTMLElement): void {
    if (this.options.flushInput() === 'blocked') return;
    this.menu?.hide();
    const menu = new Menu();
    this.menu = menu;
    const token = this.options.interactionOwnership?.acquire({ blocksShortcuts: true });
    let release = (): void => {};
    const metadata = this.options.controller.snapshot().metadata;
    const projection = metadata?.projection;
    for (const candidate of projection?.candidates ?? []) {
      const value = candidate.date;
      if (candidate.status !== 'point' || value === undefined) continue;
      menu.addItem((item) =>
        item.setTitle(this.dateLabel(value, metadata?.referenceDate)).onClick(() => {
          this.act({ type: 'select-date', role: 'due', value, candidate });
        }),
      );
    }
    menu.addItem((item) =>
      item.setTitle('Choose date…').onClick(() => {
        this.openDate(anchor, 'due');
      }),
    );
    menu.addItem((item) =>
      item.setTitle('Ignore date suggestions').onClick(() => {
        this.act({ type: 'dismiss-ambiguity' });
      }),
    );
    menu.onHide(() => {
      release();
      token?.release();
      if (this.menu === menu) this.menu = undefined;
    });
    showMenuAtMouseEventWithFocus(menu, event, (surface) => {
      surface.addEventListener('keydown', (key) => {
        if (key.key !== 'Escape' || isImeOwnedEvent(key)) return;
        key.preventDefault();
        key.stopPropagation();
        menu.hide();
        if (this.live() && anchor.isConnected) anchor.focus({ preventScroll: true });
      });
      release = this.options.boundary.register(surface, { cancel: () => menu.hide() });
    });
  }
}
