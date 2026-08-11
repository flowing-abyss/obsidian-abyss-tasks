import type { App } from 'obsidian';
import { Component, setIcon } from 'obsidian';
import type { AppState } from '../app/AppState';
import type { LinkToken } from '../parser/links';
import { formatDurationFromMinutes, parseDurationToMinutes } from '../parser/TaskParser';

import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { colorForTag } from '../tags/tagColor';
import {
  durationMinutes,
  localDate,
  localTime,
  type CommentRef,
  type PlanningTarget,
  type SubtaskPatch,
  type SubtaskRef,
  type SubtaskSnapshot,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskCommentSnapshot,
  type TaskNodeRef,
  type TaskPatch,
  type TaskPriority,
  type TaskRef,
  type TaskSnapshot,
  type TaskTextTarget,
} from '../tasks';
import { anchoredPlacement } from '../ui/anchoredPlacement';
import {
  enableAttachmentDrop,
  enableAttachmentPaste,
  insertAtCaret,
  whenPasteSettled,
} from '../ui/attachmentDrop';
import { LinkEditModal } from '../ui/LinkEditModal';
import { mountRecurrenceEditor } from '../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
import { renderStatusMarker } from '../ui/StatusMarker';
import { showStatusMenuAt } from '../ui/statusMenu';
import { showTagDropdown } from '../ui/tagDropdown';
import { presentTaskCommandResult, requestTaskCompletion } from '../ui/taskCommandResult';
import { openInFile } from '../ui/taskNavigation';
import { rebuildTaskSelection, rootTaskRef, taskNodeLine, taskNodeRef } from '../ui/taskSelection';

type TaskLike = TaskSnapshot | SubtaskSnapshot;

function rootRefForPlanningTarget(target: PlanningTarget): TaskRef {
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') node = node.ref.parent;
  return node.ref;
}

function sameTaskRef(left: TaskRef, right: TaskRef): boolean {
  return (
    left.filePath === right.filePath && left.line === right.line && left.revision === right.revision
  );
}

function planningChildChain(target: PlanningTarget): readonly SubtaskRef[] {
  const chain: SubtaskRef[] = [];
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') {
    chain.unshift(node.ref);
    node = node.ref.parent;
  }
  return chain;
}

function rebuildPlanningTargetStack(root: TaskSnapshot, target: PlanningTarget): TaskLike[] {
  const stack: TaskLike[] = [root];
  let current: TaskLike = root;
  for (const ref of planningChildChain(target)) {
    const child: SubtaskSnapshot | undefined = current.subtasks.find(
      (candidate) => candidate.ref.relativeLine === ref.relativeLine,
    );
    if (!child) break;
    stack.push(child);
    current = child;
  }
  return stack;
}

function commentRefOf(comment: TaskCommentSnapshot): CommentRef {
  return comment.ref;
}

export class RightPanel {
  private el!: HTMLElement;
  private off?: () => void;
  private draggingSub: SubtaskSnapshot | null = null;
  private md = new Component();
  private onSuccessfulMutation?: (ref?: TaskRef) => void;
  private anchoredSurfaceCleanups = new Map<HTMLElement, () => void>();

  constructor(
    private state: AppState,
    private app: App,
    private statusRegistry: StatusRegistry,
    private settings?: CalendarSettings,
    onSuccessfulMutation?: (ref?: TaskRef) => void,
    private tasks?: TaskApplicationApi,
    private onRenderHeaderActions?: (actions: HTMLElement) => void,
  ) {
    this.onSuccessfulMutation = onSuccessfulMutation;
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.off = this.state.on('taskStack', () => this.render());
    this.render();
  }

  destroy(): void {
    this.off?.();
    this.clearAnchoredSurfaces();
    this.el?.empty();
    this.md.unload();
  }

  private render(): void {
    this.md.unload();
    this.md = new Component();
    this.md.load();
    this.clearAnchoredSurfaces();
    this.el.empty();
    const stack = this.state.get('taskStack');
    if (stack.length === 0) {
      this.renderEmpty();
      return;
    }
    const task = stack[stack.length - 1]!;
    this.renderTask(task, stack);
  }

  /** Wire clipboard paste-to-attach onto an editable textarea, inserting links at the caret. */
  private enablePaste(el: HTMLTextAreaElement, task: TaskLike): void {
    enableAttachmentPaste(el, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onInsert: (links) => insertAtCaret(el, links),
    });
  }

  private editLink(task: TaskLike, occ: number, token: LinkToken): void {
    const target = this.planningTarget(task);
    if (!target) return;
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        void this.executeLinkEdit({ type: 'title', target }, occ, newRaw);
      },
      rootTaskRef(task).filePath,
    ).open();
  }

  /** Edit a target-scoped link through the same revision-confirming task API as title edits. */
  private editLinkInString(
    target: TaskTextTarget,
    occ: number,
    token: LinkToken,
    sourcePath: string,
  ): void {
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => void this.executeLinkEdit(target, occ, newRaw),
      sourcePath,
    ).open();
  }

  private async executeLinkEdit(
    target: TaskTextTarget,
    occurrence: number,
    replacement: string,
  ): Promise<void> {
    if (!this.tasks) return;
    const result = await this.tasks.execute({ type: 'edit-link', target, occurrence, replacement });
    const node = target.type === 'comment' ? target.ref.parent : target.target;
    this.applyPlanningResult(result, node);
  }

  /** Description block: rendered markdown (clickable links) that becomes a textarea on click. */
  private renderDescriptionBlock(section: HTMLElement, task: TaskLike): void {
    const view = section.createDiv({ cls: 'tc-right-desc tc-right-desc-view' });
    enableAttachmentDrop(view, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        // The closure carries the observed revision; a concurrent edit is surfaced as a
        // structured conflict instead of overwriting the changed block.
        const cur = task.description ?? '';
        void this.updateDescription(task, cur.trim() ? `${cur} ${links}` : links);
      },
    });
    let showView: () => void = () => {};

    const enterEdit = (): void => {
      const start = view.offsetHeight;
      view.hide();
      const ta = section.createEl('textarea', { cls: 'tc-right-desc tc-right-desc-edit' });
      view.insertAdjacentElement('afterend', ta);
      ta.value = task.description ?? '';
      this.enablePaste(ta, task);
      ta.setCssStyles({ height: `${Math.max(start, 60)}px` });
      window.setTimeout(() => ta.focus(), 0);
      let done = false;
      const finish = async (save: boolean): Promise<void> => {
        if (done) return;
        // Let any in-flight paste insert its link into the value before we save/remove.
        await whenPasteSettled(ta);
        if (done) return;
        if (save && ta.value !== (task.description ?? '')) {
          const saved = await this.updateDescription(task, ta.value);
          if (!saved) {
            ta.focus();
            return;
          }
        }
        done = true;
        ta.remove();
        view.show();
        showView();
      };
      ta.addEventListener('blur', () => void finish(true));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          void finish(false);
        }
      });
    };

    showView = (): void => {
      const desc = task.description ?? '';
      if (desc.trim()) {
        view.removeClass('tc-right-desc-empty');
        renderTaskText(view, desc, {
          app: this.app,
          sourcePath: rootTaskRef(task).filePath,
          component: this.md,
          onEditLink: (occ, token) => {
            const target = this.planningTarget(task);
            if (target) {
              this.editLinkInString(
                { type: 'description', target },
                occ,
                token,
                rootTaskRef(task).filePath,
              );
            }
          },
        });
      } else {
        view.empty();
        view.addClass('tc-right-desc-empty');
        view.setText('Add a description…');
      }
    };

    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return; // let links navigate
      enterEdit();
    });
    showView();
  }

  private renderEmpty(): void {
    const empty = this.el.createDiv({ cls: 'tc-right-empty' });
    const icon = empty.createDiv({ cls: 'tc-right-empty-icon' });
    setIcon(icon, 'mouse-pointer-click');
    empty.createEl('p', { cls: 'tc-right-empty-title', text: 'No task selected' });
    empty.createEl('p', {
      cls: 'tc-right-empty-hint',
      text: 'Click a task to view and edit details',
    });
  }

  private renderTask(task: TaskLike, stack: TaskLike[]): void {
    // Breadcrumb — shows only the parent path (current task is in the title input)
    if (stack.length > 1) {
      const breadcrumb = this.el.createDiv({ cls: 'tc-breadcrumb' });
      const parents = stack.slice(0, -1);
      parents.forEach((item, idx) => {
        if (idx > 0) breadcrumb.createEl('span', { cls: 'tc-breadcrumb-sep', text: ' › ' });
        const crumb = breadcrumb.createEl('span', { cls: 'tc-breadcrumb-item' });
        renderTaskText(crumb, item.markdownTitle, {
          app: this.app,
          sourcePath: rootTaskRef(item).filePath,
          component: this.md,
          onEditLink: (occ, token) => this.editLink(item, occ, token),
        });
        crumb.addEventListener('click', () => {
          this.state.set('taskStack', stack.slice(0, idx + 1));
        });
      });
    }

    // Header
    const header = this.el.createDiv({ cls: 'tc-right-header' });
    renderStatusMarker(header, {
      task,
      registry: this.statusRegistry,
      onLeftClick: () => void this.toggleTaskLike(task),
      onContextMenu: (event) => {
        event.stopPropagation();
        const anchor = event.currentTarget instanceof HTMLElement ? event.currentTarget : header;
        showStatusMenuAt(event, {
          task,
          registry: this.statusRegistry,
          owner: this.md,
          onPickStatus: (symbol) => void this.setStatus(task, symbol),
          onPickPriority: (priority) => void this.updatePriority(task, priority),
          onEditRepeat: () =>
            this.showRecurrencePopover(anchor, task, this.recurrenceStackFor(task)),
        });
      },
    });
    this.renderTitleBlock(header, task);

    const headerActions = header.createDiv({ cls: 'tc-right-header-actions' });

    // More actions menu button
    const currentTask = task;
    const menuBtn = headerActions.createEl('button', {
      cls: 'tc-right-action-btn',
      text: '⋯',
      attr: {
        title: 'More actions',
        'aria-label': 'More actions',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.renderContextMenu(currentTask, menuBtn);
    });
    this.onRenderHeaderActions?.(headerActions);

    // Metadata chips — available for both TaskSnapshot and SubtaskSnapshot
    {
      const chips = this.el.createDiv({ cls: 'tc-chips-row' });

      // Date chip (due-first display; if scheduled is set, prefer showing scheduled as the
      // "when this sits on the calendar" chip, matching the due-centric anchor-priority rule)
      this.renderDateChip(chips, task);

      // Combined time + duration chip (duration only applies to top-level TaskSnapshot, not SubtaskSnapshot)
      const duration = 'source' in task ? task.planning.duration : undefined;
      let timeChipText = '⏰';
      if (task.planning.time) {
        timeChipText = duration
          ? `⏰ ${task.planning.time} · ${formatDurationFromMinutes(duration)}`
          : `⏰ ${task.planning.time}`;
      }
      const timeChip = chips.createEl('button', {
        cls: `tc-chip tc-chip-time${task.planning.time ? '' : ' tc-chip-empty'}`,
        text: timeChipText,
        attr: {
          title: 'Set time & duration',
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false',
        },
      });
      timeChip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTimePopover(timeChip, task);
      });

      // Priority chip
      this.renderPriorityChip(chips, task);

      // Repeat chip and its one shared editor. TaskModal inherits this through RightPanel reuse.
      this.renderRecurrenceChip(chips, task, stack);

      // Scheduled ("Plan") and Start chips — once SET, rendered as a normal round-pill,
      // same style as the date/time/priority chips above; clicking it opens the same small
      // date-picker popover used for the due-date chip (showDatePopover, generalized with a
      // `field` param below). While UNSET, no placeholder pill clutters the main row —
      // instead a compact "+" control (mirroring the "+ tag" button's pattern) offers to
      // add whichever of Start/Plan are currently unset; picking one opens the exact same
      // popover. This intentionally reverses the "always-visible placeholder pill" unset
      // treatment from the previous round after live testing showed it cluttered the row.
      if (task.planning.scheduled) this.renderScheduledChip(chips, task);
      if (task.planning.start) this.renderStartChip(chips, task);
      this.renderAddDateMenu(chips, task);

      // Tag chips
      const tags = task.tags ?? [];
      for (const tag of tags) {
        this.renderTagChip(chips, task, tag);
      }
      // Add tag
      const addTagBtn = chips.createEl('button', {
        cls: 'tc-chip tc-chip-add',
        text: '+ tag',
        attr: {
          'aria-label': 'Add tag',
          'aria-haspopup': 'listbox',
          'aria-expanded': 'false',
        },
      });
      addTagBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.showTagInput(chips, task, addTagBtn);
      });
    }

    // Description
    const descSection = this.el.createDiv({ cls: 'tc-right-section' });
    const descHeader = descSection.createDiv({ cls: 'tc-right-section-header' });
    descHeader.createEl('span', { cls: 'tc-right-section-label', text: 'Description' });
    this.renderDescriptionBlock(descSection, task);

    // Sub-tasks
    const subSection = this.el.createDiv({ cls: 'tc-right-section' });
    const subHeader = subSection.createDiv({ cls: 'tc-right-section-header' });
    subHeader.createEl('span', { cls: 'tc-right-section-label', text: 'Sub-tasks' });
    const totalSubs = task.subtasks?.length ?? 0;
    if (totalSubs > 0) {
      const doneSubs = task.subtasks.filter((s) => s.status === 'done').length;
      subHeader.createEl('span', {
        cls: 'tc-right-section-count',
        text: `${doneSubs}/${totalSubs}`,
      });
    }

    const subList = subSection.createDiv({ cls: 'tc-subtask-list' });
    for (const sub of task.subtasks ?? []) {
      this.renderSubTask(subList, sub, task);
    }

    // Inline add-subtask row at the bottom of the subtask list
    const addSubRow = subSection.createDiv({ cls: 'tc-subtask-add-row' });
    addSubRow.createEl('span', { cls: 'tc-subtask-add-icon', text: '+' });
    addSubRow.createEl('span', { cls: 'tc-subtask-add-label', text: 'Add sub-task' });
    addSubRow.addEventListener('click', () => {
      addSubRow.addClass('tc-subtask-add-row--hidden');
      const input = subSection.createEl('input', {
        cls: 'tc-subtask-new-input',
        attr: { type: 'text', placeholder: 'New sub-task…' },
      });
      input.focus();
      let closed = false;
      let saving = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        input.remove();
        addSubRow.removeClass('tc-subtask-add-row--hidden');
      };
      const commit = async (): Promise<void> => {
        if (closed || saving) return;
        const text = input.value.trim();
        if (!text) {
          close();
          return;
        }
        saving = true;
        const succeeded = await this.addSubTask(task, text);
        saving = false;
        if (closed) return;
        if (succeeded) close();
        else input.focus();
      };
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });
      // Delay to allow click on commit button before blur fires
      input.addEventListener('blur', () => window.setTimeout(() => void commit(), 150));
    });

    // Comments
    const commentSection = this.el.createDiv({ cls: 'tc-right-section' });
    const commentHeader = commentSection.createDiv({ cls: 'tc-right-section-header' });
    commentHeader.createEl('span', { cls: 'tc-right-section-label', text: 'Comments' });
    const commentCount = task.comments?.length ?? 0;
    if (commentCount > 0) {
      commentHeader.createEl('span', {
        cls: 'tc-right-section-count',
        text: String(commentCount),
      });
    }

    const commentList = commentSection.createDiv({ cls: 'tc-comment-list' });
    for (const comment of task.comments ?? []) {
      this.renderComment(commentList, comment, task);
    }

    // Always-visible textarea — Enter submits, Shift+Enter inserts newline
    const commentInput = commentSection.createEl('textarea', {
      cls: 'tc-comment-input',
      attr: { placeholder: 'Write a comment…', rows: '2' },
    });
    enableAttachmentDrop(commentInput, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        commentInput.value = commentInput.value ? `${commentInput.value} ${links}` : links;
        commentInput.focus();
      },
    });
    this.enablePaste(commentInput, task);
    commentInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = commentInput.value.trim();
        if (text) {
          void this.addComment(task, text, commentList, commentInput);
        }
      }
    });
  }

  private renderTitleBlock(header: HTMLElement, task: TaskLike): void {
    const view = header.createDiv({ cls: 'tc-right-title tc-right-title-view' });
    enableAttachmentDrop(view, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => void this.appendToTitle(task, links),
    });
    const renderView = (): void => {
      renderTaskText(view, task.markdownTitle, {
        app: this.app,
        sourcePath: rootTaskRef(task).filePath,
        component: this.md,
        onEditLink: (occ, token) => this.editLink(task, occ, token),
      });
    };
    renderView();

    // Click on empty space / non-link text enters edit mode.
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return; // let links navigate
      this.enterTitleEdit(header, view, task, renderView);
    });
  }

  private enterTitleEdit(
    header: HTMLElement,
    view: HTMLElement,
    task: TaskLike,
    renderView: () => void,
  ): void {
    // Preserve the height the user stretched the read-mode block to (measure first).
    const startHeight = view.offsetHeight;
    view.hide();
    const ta = header.createEl('textarea', { cls: 'tc-right-title tc-right-title-edit' });
    // Keep the textarea in the title's slot so the ⋯/× action buttons stay on the right.
    view.insertAdjacentElement('afterend', ta);
    ta.value = task.markdownTitle;
    this.enablePaste(ta, task);
    // Auto-grow to content, but never below the stretched height.
    const grow = (): void => {
      ta.setCssStyles({ height: 'auto' });
      ta.setCssStyles({ height: `${Math.max(ta.scrollHeight, startHeight)}px` });
    };
    ta.addEventListener('input', grow);
    window.setTimeout(() => {
      ta.focus();
      grow();
    }, 0);

    let done = false;
    const finish = async (save: boolean): Promise<void> => {
      if (done) return;
      // Let any in-flight paste insert its link into the value before we save/remove.
      await whenPasteSettled(ta);
      if (done) return;
      done = true;
      // Carry the current height back to the read-mode block so the stretch persists.
      view.setCssStyles({ height: `${ta.offsetHeight}px` });
      if (save && ta.value !== task.markdownTitle) {
        void this.updateTaskTitle(task, ta.value.trim());
      }
      ta.remove();
      view.show();
      renderView();
    };
    ta.addEventListener('blur', () => void finish(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void finish(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        void finish(false);
      }
    });
  }

  private renderSubTask(container: HTMLElement, sub: SubtaskSnapshot, parentTask: TaskLike): void {
    const row = container.createDiv({ cls: 'tc-subtask-row', attr: { draggable: 'true' } });

    // ── Drag-and-drop ─────────────────────────────────────────
    row.addEventListener('dragstart', (e) => {
      this.draggingSub = sub;
      row.addClass('is-dragging');
      e.dataTransfer?.setData('text/plain', String(sub.ref.relativeLine));
    });

    row.addEventListener('dragend', () => {
      this.draggingSub = null;
      row.removeClass('is-dragging');
      // Clean up any lingering indicators across all rows
      container.querySelectorAll('.drop-above,.drop-below').forEach((el) => {
        el.removeClass('drop-above');
        el.removeClass('drop-below');
      });
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!this.draggingSub || this.draggingSub.ref.relativeLine === sub.ref.relativeLine) return;
      const rect = row.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      // Clear indicators on all siblings first
      container.querySelectorAll('.drop-above,.drop-below').forEach((el) => {
        el.removeClass('drop-above');
        el.removeClass('drop-below');
      });
      row.addClass(isAbove ? 'drop-above' : 'drop-below');
    });

    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) {
        row.removeClass('drop-above');
        row.removeClass('drop-below');
      }
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const dragged = this.draggingSub;
      if (!dragged || dragged.ref.relativeLine === sub.ref.relativeLine) return;
      const position = row.hasClass('drop-above') ? 'before' : 'after';
      row.removeClass('drop-above');
      row.removeClass('drop-below');
      void this.reorderSubTask(parentTask, dragged, sub, position);
    });

    // ── Status marker ─────────────────────────────────────────
    renderStatusMarker(row, {
      task: sub,
      registry: this.statusRegistry,
      onLeftClick: () => void this.toggleSubTask(sub),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        const anchor = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : row;
        showStatusMenuAt(ev, {
          task: sub,
          registry: this.statusRegistry,
          owner: this.md,
          onPickStatus: (c) => void this.setStatus(sub, c),
          onPickPriority: (p) => void this.updatePriority(sub, p),
          onEditRepeat: () => this.showRecurrencePopover(anchor, sub, this.recurrenceStackFor(sub)),
        });
      },
    });

    // ── Content ───────────────────────────────────────────────
    const content = row.createDiv({ cls: 'tc-subtask-content' });
    const label = content.createEl('span', {
      cls: `tc-subtask-label${sub.status === 'done' ? ' is-done' : ''}`,
    });
    renderTaskText(label, sub.markdownTitle, {
      app: this.app,
      sourcePath: rootTaskRef(sub).filePath,
      component: this.md,
      onEditLink: (occ, token) => this.editLink(sub, occ, token),
    });
    label.addEventListener('click', () => {
      const stack = this.state.get('taskStack');
      this.state.set('taskStack', [...stack, sub]);
    });

    // Progress + comment count indicators
    const subCount = sub.subtasks?.length ?? 0;
    const commentCount = sub.comments?.length ?? 0;
    if (subCount > 0 || commentCount > 0) {
      const subMeta = content.createDiv({ cls: 'tc-subtask-meta' });
      if (subCount > 0) {
        const done = sub.subtasks.filter((s) => s.status === 'done').length;
        subMeta.createEl('span', { cls: 'tc-subtask-progress', text: `${done}/${subCount}` });
      }
      if (commentCount > 0) {
        subMeta.createEl('span', { cls: 'tc-subtask-comment-count', text: `💬 ${commentCount}` });
      }
    }
  }

  private renderComment(
    container: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
  ): void {
    const row = container.createDiv({ cls: 'tc-comment-row' });
    enableAttachmentDrop(row, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => void this.updateComment(task, comment, `${comment.text} ${links}`.trim()),
    });
    if (comment.date) {
      const m = window.moment(comment.date, 'YYYY-MM-DD');
      const diff = m.diff(window.moment(), 'days');
      const label = Math.abs(diff) < 7 ? m.fromNow() : m.format('D MMM YYYY');
      row.createEl('span', { cls: 'tc-comment-date', text: label });
    }
    let showText: () => void = () => {};

    const enterEdit = (): void => {
      row.querySelector('.tc-comment-text')?.remove();
      const textarea = row.createEl('textarea', { cls: 'tc-comment-edit-input' });
      textarea.value = comment.text;
      this.enablePaste(textarea, task);
      textarea.focus();
      textarea.select();
      let saved = false;
      const finish = async (): Promise<void> => {
        if (saved) return;
        // Let any in-flight paste insert its link into the value before we save/remove.
        await whenPasteSettled(textarea);
        if (saved) return;
        const val = textarea.value.trim();
        if (val === comment.text) {
          saved = true;
          textarea.remove();
          showText();
          return;
        }
        let committed: boolean;
        if (val === '') {
          committed = await this.deleteComment(task, comment);
        } else {
          committed = await this.updateComment(task, comment, val);
        }
        if (!committed) {
          textarea.focus();
          return;
        }
        saved = true;
        textarea.remove();
      };
      textarea.addEventListener('blur', () => window.setTimeout(() => void finish(), 150));
      textarea.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          textarea.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          saved = true;
          textarea.remove();
          showText();
        }
      });
    };

    showText = (): void => {
      const textEl = row.createEl('p', { cls: 'tc-comment-text' });
      renderTaskText(textEl, comment.text, {
        app: this.app,
        sourcePath: rootTaskRef(task).filePath,
        component: this.md,
        onEditLink: (occ, token) => {
          const ref = commentRefOf(comment);
          if (ref)
            this.editLinkInString({ type: 'comment', ref }, occ, token, rootTaskRef(task).filePath);
        },
      });
      textEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a')) return; // let links navigate
        enterEdit();
      });
    };

    showText();
  }

  private renderDateChip(container: HTMLElement, task: TaskLike): void {
    const d = task.planning.due ?? task.planning.scheduled;
    let field: 'due' | 'scheduled' = 'due';
    if (!task.planning.due && task.planning.scheduled) field = 'scheduled';
    const chip = container.createEl('button', {
      cls: `tc-chip${d ? '' : ' tc-chip-empty'}`,
      text: d ? `📅 ${this.formatDate(d)}` : '📅 Date',
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, field);
    });
  }

  /** "Plan" (⏳/`scheduled`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderScheduledChip(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.scheduled;
    const chip = container.createEl('button', {
      cls: `tc-chip tc-chip-scheduled${value ? '' : ' tc-chip-empty'}`,
      text: value ? `⏳ ${this.formatDate(value)}` : '⏳ Plan',
      attr: { title: 'Set plan date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, 'scheduled');
    });
  }

  /** "Start" (🛫/`start`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderStartChip(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.start;
    const chip = container.createEl('button', {
      cls: `tc-chip tc-chip-start${value ? '' : ' tc-chip-empty'}`,
      text: value ? `🛫 ${this.formatDate(value)}` : '🛫 Start',
      attr: { title: 'Set start date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, 'start');
    });
  }

  /**
   * Compact "+"-style control offering to add whichever of Start/Plan are currently unset —
   * mirrors the "+ tag" button's pattern (small affordance that reveals a chooser) rather than
   * an always-visible placeholder pill. Renders nothing once both are already set (nothing left
   * to offer), and remains extensible for future addable properties (e.g. recurrence).
   */
  private renderAddDateMenu(container: HTMLElement, task: TaskLike): void {
    const options: Array<{ field: 'start' | 'scheduled'; label: string }> = [];
    if (!task.planning.start) options.push({ field: 'start', label: '🛫 Start' });
    if (!task.planning.scheduled) options.push({ field: 'scheduled', label: '⏳ Plan' });
    if (options.length === 0) return;

    const addBtn = container.createEl('button', {
      cls: 'tc-chip tc-chip-add tc-chip-add-date',
      text: '+ date',
      attr: {
        title: 'Add start or plan date',
        'aria-label': 'Add start or plan date',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    });
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showAddDateMenu(addBtn, task, options);
    });
  }

  /** Small menu anchored to the "+ date" button — clicking an option opens showDatePopover. */
  private showAddDateMenu(
    anchor: HTMLElement,
    task: TaskLike,
    options: Array<{ field: 'start' | 'scheduled'; label: string }>,
  ): void {
    const existing = this.el.querySelector('.tc-add-date-menu');
    if (existing) {
      this.removeAnchoredSurface(existing as HTMLElement);
      return;
    }
    this.el
      .querySelectorAll<HTMLElement>('.tc-add-date-menu')
      .forEach((element) => this.removeAnchoredSurface(element));
    this.el
      .querySelectorAll<HTMLElement>('.tc-context-menu')
      .forEach((element) => this.removeAnchoredSurface(element));

    const menu = this.el.createDiv({
      cls: 'tc-context-menu tc-add-date-menu tc-add-date-menu--compact tc-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Add date' },
    });
    for (const opt of options) {
      this.createContextMenuItem(menu, 'tc-context-item tc-add-date-menu-item', opt.label, () => {
        this.removeAnchoredSurface(menu);
        this.showDatePopover(anchor, task, opt.field);
      });
    }

    this.positionAnchoredSurface(menu, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(menu, anchor);
    menu.querySelector<HTMLElement>('.tc-context-item')?.focus({ preventScroll: true });
  }

  private createContextMenuItem(
    menu: HTMLElement,
    className: string,
    text: string,
    action: () => void,
  ): HTMLElement {
    const item = menu.createDiv({
      cls: className,
      text,
      attr: { role: 'menuitem', tabindex: '0' },
    });
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      action();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return item;
  }

  private renderPriorityChip(container: HTMLElement, task: TaskLike): void {
    const labels: Record<string, string> = {
      A: '🚩 Highest',
      B: '🚩 High',
      C: '🚩 Medium',
      D: 'Priority',
      E: '🚩 Low',
      F: '🚩 Lowest',
    };
    const chip = container.createEl('button', {
      cls: `tc-chip tc-priority-chip tc-priority-chip--${task.priority ?? 'D'}${task.priority === 'D' ? ' tc-chip-empty' : ''}`,
      text: labels[task.priority] ?? 'Priority',
      attr: {
        'data-priority': task.priority ?? 'D',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showPriorityPopover(chip, task);
    });
  }

  private renderRecurrenceChip(
    container: HTMLElement,
    task: TaskLike,
    stack: readonly TaskLike[],
  ): void {
    const chip = container.createEl('button', {
      cls: `tc-chip tc-repeat-chip${task.recurrence ? '' : ' tc-chip-add tc-chip-empty'}`,
      attr: { title: task.recurrence ? 'Edit repeat' : 'Add repeat' },
    });
    if (task.recurrence) {
      renderRecurrenceBadge(chip, recurrenceBadgeInput(task.recurrence));
      chip.createSpan({ cls: 'tc-repeat-chip-label', text: task.recurrence });
    } else {
      chip.setText('+ repeat');
    }
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showRecurrencePopover(chip, task, stack);
    });
  }

  private showRecurrencePopover(
    anchor: HTMLElement,
    task: TaskLike,
    stack: readonly TaskLike[],
  ): void {
    const existing = this.el.querySelector<HTMLElement>('.tc-recurrence-popover');
    this.clearPopovers();
    if (existing) return;
    anchor.focus();
    const root = stack[0];
    const target = this.planningTarget(task);
    if (!root || !('source' in root) || !target) return;

    const popover = this.el.createDiv({
      cls: 'tc-popover tc-recurrence-popover tc-popover-anchored',
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
    const handle = mountRecurrenceEditor({
      container: popover,
      source: { root, target },
      policy: {
        removeScheduledDate: this.settings?.recurrence.removeScheduledDate ?? false,
      },
      ownershipConflict: this.hasRecurrenceOwnershipConflict(task, stack),
      onSubmit: (patch) => this.executePlanningPatch(task, patch),
      onClose: () => this.removeAnchoredSurface(popover),
    });
    const title = popover.querySelector<HTMLElement>('.tc-recurrence-title');
    if (title?.id) popover.setAttribute('aria-labelledby', title.id);
    this.positionAnchoredSurface(popover, anchor, 'below-start');
    const placementCleanup = this.anchoredSurfaceCleanups.get(popover);
    const editorCleanup = (): void => {
      handle.destroy();
      placementCleanup?.();
      if (this.anchoredSurfaceCleanups.get(popover) === editorCleanup) {
        this.anchoredSurfaceCleanups.delete(popover);
      }
    };
    this.anchoredSurfaceCleanups.set(popover, editorCleanup);
    this.dismissMenuOnOutsideClick(popover, anchor, () => handle.dismiss());
    this.el.ownerDocument.defaultView?.setTimeout(() => handle.focus(), 0);
  }

  private hasRecurrenceOwnershipConflict(task: TaskLike, stack: readonly TaskLike[]): boolean {
    if (stack.slice(0, -1).some((ancestor) => ancestor.recurrence !== undefined)) return true;
    const queue = [...task.subtasks];
    while (queue.length > 0) {
      const descendant = queue.shift()!;
      if (descendant.recurrence !== undefined) return true;
      queue.push(...descendant.subtasks);
    }
    return false;
  }

  private renderTagChip(container: HTMLElement, task: TaskLike, tag: string): void {
    const chip = container.createEl('span', { cls: 'tc-chip tc-chip-tag' });
    const color = this.getTagColor(tag);
    if (color) chip.setCssProps({ '--tc-chip-tag-color': color });
    chip.createEl('span', { text: tag });
    const x = chip.createEl('button', { cls: 'tc-chip-remove', text: '×' });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.removeTag(task, tag);
    });
  }

  private getTagColor(tag: string): string | undefined {
    if (!this.settings) return undefined;
    return colorForTag(tag, this.settings.tagGroups);
  }

  private clearPopovers(): void {
    this.el
      .querySelectorAll<HTMLElement>('.tc-popover')
      .forEach((element) => this.removeAnchoredSurface(element));
  }

  private removeAnchoredSurface(surface: HTMLElement): void {
    this.anchoredSurfaceCleanups.get(surface)?.();
    surface.remove();
  }

  private clearAnchoredSurfaces(): void {
    for (const [surface, cleanup] of this.anchoredSurfaceCleanups) {
      cleanup();
      surface.remove();
    }
    this.anchoredSurfaceCleanups.clear();
  }

  /**
   * Small date-picker popover shared by the due/plan/start chips. `field` selects which
   * metadata date is being edited — the popover markup, positioning, and clear-button
   * behavior are identical for all three; only the read/write pair differs.
   */
  private showDatePopover(
    anchor: HTMLElement,
    task: TaskLike,
    field: 'due' | 'scheduled' | 'start' = 'due',
  ): void {
    const already = this.el.querySelector('.tc-date-popover');
    this.clearPopovers();
    if (already) return;

    const previousPopupRole = anchor.getAttribute('aria-haspopup');
    anchor.setAttribute('aria-haspopup', 'dialog');
    const pop = this.el.createDiv({
      cls: 'tc-popover tc-date-popover tc-popover-anchored',
      attr: { role: 'dialog', 'aria-label': `Set ${field === 'scheduled' ? 'plan' : field} date` },
    });

    let currentValue: string | undefined;
    if (field === 'due') currentValue = task.planning.due ?? task.planning.scheduled;
    else if (field === 'scheduled') currentValue = task.planning.scheduled;
    else currentValue = task.planning.start;

    const inputRow = pop.createDiv({ cls: 'tc-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'tc-date-input',
      attr: { type: 'date', value: currentValue ?? '' },
    });
    input.addEventListener('change', () => {
      if (field === 'due') void this.updateDue(task, input.value);
      else if (field === 'scheduled') void this.updateScheduled(task, input.value);
      else void this.updateStart(task, input.value);
      this.removeAnchoredSurface(pop);
    });
    this.el.ownerDocument.defaultView?.setTimeout(() => input.focus(), 0);

    const clearBtn = inputRow.createEl('button', {
      cls: 'tc-popover-clear-icon-btn',
      attr: { title: 'Clear date', 'aria-label': 'Clear date' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => {
      if (field === 'due') void this.clearDate(task);
      else if (field === 'scheduled') void this.clearScheduled(task);
      else void this.clearStart(task);
      this.removeAnchoredSurface(pop);
    });
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor, undefined, {
      focusLeaveDelay: 200,
      onCleanup: () => {
        if (previousPopupRole) anchor.setAttribute('aria-haspopup', previousPopupRole);
        else anchor.removeAttribute('aria-haspopup');
      },
    });
  }

  private showPriorityPopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el.querySelector('.tc-priority-popover');
    this.clearPopovers();
    if (already) return;

    const pop = this.el.createDiv({
      cls: 'tc-popover tc-priority-popover tc-popover-anchored',
      attr: { role: 'listbox', 'aria-label': 'Priority' },
    });

    const currentPriority = anchor.getAttribute('data-priority') ?? task.priority ?? 'D';
    const options: Array<{ value: string; label: string }> = [
      { value: 'A', label: 'Highest' },
      { value: 'B', label: 'High' },
      { value: 'C', label: 'Medium' },
      { value: 'D', label: 'None' },
      { value: 'E', label: 'Low' },
      { value: 'F', label: 'Lowest' },
    ];
    let selectedOption: HTMLButtonElement | undefined;
    for (const opt of options) {
      const isActive = currentPriority === opt.value;
      const btn = pop.createEl('button', {
        cls: `tc-priority-option${isActive ? ' is-active' : ''}`,
        attr: {
          'data-priority': opt.value,
          role: 'option',
          'aria-selected': String(isActive),
        },
      });
      if (isActive) selectedOption = btn;
      const checkEl = btn.createEl('span', { cls: 'tc-priority-option-check' });
      if (isActive) setIcon(checkEl, 'check');
      const flagEl = btn.createEl('span', { cls: 'tc-priority-option-flag' });
      setIcon(flagEl, 'flag');
      btn.createEl('span', { cls: 'tc-priority-option-label', text: opt.label });
      btn.addEventListener('click', () => {
        // Optimistic update on the chip
        const chipLabels: Record<string, string> = {
          A: '🚩 Highest',
          B: '🚩 High',
          C: '🚩 Medium',
          D: 'Priority',
          E: '🚩 Low',
          F: '🚩 Lowest',
        };
        anchor.textContent = chipLabels[opt.value] ?? 'Priority';
        anchor.setAttribute('data-priority', opt.value);
        anchor.className = `tc-chip tc-priority-chip tc-priority-chip--${opt.value}${opt.value === 'D' ? ' tc-chip-empty' : ''}`;
        this.removeAnchoredSurface(pop);
        anchor.focus({ preventScroll: true });
        void this.updatePriority(task, opt.value);
      });
    }
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor);
    selectedOption?.focus({ preventScroll: true });
  }

  private positionAnchoredSurface(
    popover: HTMLElement,
    anchor: HTMLElement,
    preferred: 'below-start' | 'below-end',
  ): void {
    this.anchoredSurfaceCleanups.get(popover)?.();
    const ownerDocument = this.el.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const position = (): void => {
      const boundary = this.el.getBoundingClientRect();
      const floatingRect = popover.getBoundingClientRect();
      const computed = ownerWindow?.getComputedStyle(popover);
      const minWidth = parseFloat(computed?.minWidth ?? '');
      const floatingWidth =
        floatingRect.width || popover.offsetWidth || (Number.isFinite(minWidth) ? minWidth : 160);
      const floatingHeight = floatingRect.height || popover.offsetHeight;
      const edgeGap = this.cssLengthToPx(
        computed?.getPropertyValue('--tc-popover-edge-gap') ?? '',
        popover,
        8,
      );
      const anchorGap = this.cssLengthToPx(
        computed?.getPropertyValue('--tc-popover-anchor-gap') ?? '',
        popover,
        4,
      );
      const placement = anchoredPlacement({
        anchor: anchor.getBoundingClientRect(),
        floating: { width: floatingWidth, height: floatingHeight },
        boundary,
        gap: anchorGap,
        edgeGap,
        preferred,
      });
      popover.style.setProperty(
        '--tc-pop-top',
        `${placement.top - boundary.top - this.el.clientTop + this.el.scrollTop}px`,
      );
      popover.style.setProperty(
        '--tc-pop-left',
        `${placement.left - boundary.left - this.el.clientLeft + this.el.scrollLeft}px`,
      );
      popover.dataset['side'] = placement.side;
    };
    position();
    ownerWindow?.addEventListener('resize', position);
    ownerDocument.addEventListener('scroll', position, true);
    const cleanup = (): void => {
      ownerWindow?.removeEventListener('resize', position);
      ownerDocument.removeEventListener('scroll', position, true);
      if (this.anchoredSurfaceCleanups.get(popover) === cleanup) {
        this.anchoredSurfaceCleanups.delete(popover);
      }
    };
    this.anchoredSurfaceCleanups.set(popover, cleanup);
  }

  private cssLengthToPx(value: string, relativeTo: HTMLElement, fallback: number): number {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.endsWith('px')) return parseFloat(trimmed);
    if (trimmed.endsWith('rem')) {
      const rootFontSize =
        parseFloat(
          relativeTo.ownerDocument.defaultView?.getComputedStyle(
            relativeTo.ownerDocument.documentElement,
          ).fontSize ?? '',
        ) || 16;
      return parseFloat(trimmed) * rootFontSize;
    }
    if (trimmed.endsWith('em')) {
      const fontSize =
        parseFloat(
          relativeTo.ownerDocument.defaultView?.getComputedStyle(relativeTo).fontSize ?? '',
        ) || 16;
      return parseFloat(trimmed) * fontSize;
    }
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private showTagInput(container: HTMLElement, task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el.querySelector<HTMLElement>('.tc-tag-dropdown-wrap');
    if (existing) {
      this.removeAnchoredSurface(existing);
      return;
    }
    let surface!: HTMLElement;
    surface = showTagDropdown(
      container,
      this.app,
      (tag) => this.getTagColor(tag),
      (tag) => void this.addTag(task, tag),
      () => this.removeAnchoredSurface(surface),
    );
    anchor.addClass('tc-chip-add--hidden');
    this.dismissMenuOnOutsideClick(surface, anchor, () => this.removeAnchoredSurface(surface), {
      focusLeaveDelay: 200,
      onCleanup: () => anchor.removeClass('tc-chip-add--hidden'),
    });
  }

  // ---- Write-back helpers ----

  private async updateTaskTitle(task: TaskLike, newText: string): Promise<void> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return;
    const patch = { markdownTitle: { type: 'set' as const, value: newText } };
    const command = { type: 'patch', target, patch } as TaskCommand;
    const result = await this.tasks.execute(command);
    this.applyPlanningResult(result, target);
  }

  private async appendToTitle(task: TaskLike, text: string): Promise<void> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return;
    const result = await this.tasks.execute({ type: 'append-title', target, markdown: text });
    this.applyPlanningResult(result, target);
  }

  private async updateDescription(task: TaskLike, newDesc: string): Promise<boolean> {
    const target = this.planningTarget(task);
    if (!target) return false;
    return this.executeBlockCommand(
      {
        type: 'set-description',
        target,
        text: newDesc.trim().length > 0 ? newDesc.replace(/\r\n/gu, '\n') : null,
      },
      target,
    );
  }

  private async addSubTask(task: TaskLike, text: string): Promise<boolean> {
    const parent = this.planningTarget(task);
    if (!parent) return false;
    return this.executeBlockCommand({ type: 'add-subtask', parent, text }, parent);
  }

  private toggleSubTask(sub: SubtaskSnapshot): Promise<void> {
    return this.toggleTaskLike(sub);
  }

  private toggleTaskLike(task: TaskLike): Promise<void> {
    return requestTaskCompletion(task, () => this.commitTaskToggle(task));
  }

  private async commitTaskToggle(task: TaskLike): Promise<void> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return;
    const result = await this.tasks.execute({ type: 'toggle-completion', target });
    this.applyPlanningResult(result, target);
  }

  private async addComment(
    task: TaskLike,
    text: string,
    _commentList: HTMLElement,
    inputEl: HTMLTextAreaElement,
  ): Promise<boolean> {
    const parent = this.planningTarget(task);
    if (!parent) return false;
    const committed = await this.executeBlockCommand({ type: 'add-comment', parent, text }, parent);
    if (committed) {
      inputEl.value = '';
      inputEl.focus();
    }
    return committed;
  }

  private async updateComment(
    _task: TaskLike,
    comment: TaskCommentSnapshot,
    newText: string,
  ): Promise<boolean> {
    const ref = commentRefOf(comment);
    if (!ref) return false;
    return this.executeBlockCommand(
      { type: 'update-comment', comment: ref, text: newText },
      ref.parent,
    );
  }

  private async deleteComment(_task: TaskLike, comment: TaskCommentSnapshot): Promise<boolean> {
    const ref = commentRefOf(comment);
    if (!ref) return false;
    return this.executeBlockCommand({ type: 'delete-comment', comment: ref }, ref.parent);
  }

  private async executeBlockCommand(
    command: Extract<
      TaskCommand,
      {
        readonly type:
          | 'set-description'
          | 'add-subtask'
          | 'delete-subtask'
          | 'reorder-subtask'
          | 'add-comment'
          | 'update-comment'
          | 'delete-comment';
      }
    >,
    target: PlanningTarget,
  ): Promise<boolean> {
    if (!this.tasks) return false;
    const initiatingStack = this.state.get('taskStack');
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute(command);
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult(result, target, initiatingStack);
    return result.type === 'ok';
  }

  private async updateDue(task: TaskLike, date: string): Promise<void> {
    await this.executePlanningPatch(task, { due: { type: 'set', value: localDate(date) } });
  }

  private async clearDate(task: TaskLike): Promise<void> {
    await this.executePlanningPatch(
      task,
      task.planning.due || !task.planning.scheduled
        ? { due: { type: 'clear' } }
        : { scheduled: { type: 'clear' } },
    );
  }

  private async updateScheduled(task: TaskLike, date: string): Promise<void> {
    await this.executePlanningPatch(task, {
      scheduled: { type: 'set', value: localDate(date) },
    });
  }

  private async clearScheduled(task: TaskLike): Promise<void> {
    await this.executePlanningPatch(task, { scheduled: { type: 'clear' } });
  }

  private async updateStart(task: TaskLike, date: string): Promise<void> {
    await this.executePlanningPatch(task, { start: { type: 'set', value: localDate(date) } });
  }

  private async clearStart(task: TaskLike): Promise<void> {
    await this.executePlanningPatch(task, { start: { type: 'clear' } });
  }

  private planningTarget(task: TaskLike): PlanningTarget | undefined {
    return taskNodeRef(task);
  }

  private async executePlanningPatch(task: TaskLike, patch: TaskPatch): Promise<TaskCommandResult> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) {
      return { type: 'io-error', cause: 'application-unavailable', contentState: 'unchanged' };
    }
    let result: TaskCommandResult;
    try {
      if (target.type === 'task') {
        result = await this.tasks.execute({ type: 'patch', target, patch });
      } else {
        if (patch.duration !== undefined) {
          return { type: 'io-error', cause: 'unsupported-field', contentState: 'unchanged' };
        }
        const subtaskPatch: SubtaskPatch = patch;
        result = await this.tasks.execute({ type: 'patch', target, patch: subtaskPatch });
      }
    } catch {
      return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult(result, target);
    return result;
  }

  private applyPlanningResult(
    result: TaskCommandResult,
    target: PlanningTarget,
    initiatingStack?: readonly TaskLike[],
  ): void {
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'task') return;
    const stack = this.state.get('taskStack');
    const initiatingRoot = rootRefForPlanningTarget(target);
    const selectedRoot = stack[0] ? rootTaskRef(stack[0]) : undefined;
    if (
      selectedRoot &&
      sameTaskRef(selectedRoot, initiatingRoot) &&
      (initiatingStack === undefined || stack === initiatingStack)
    ) {
      const root = result.outcome.task;
      this.state.set(
        'taskStack',
        target.type === 'subtask'
          ? rebuildPlanningTargetStack(root, target)
          : rebuildTaskSelection(root, stack),
      );
    }
    if (result.changed) this.onSuccessfulMutation?.(result.outcome.task.ref);
  }

  private async updateDuration(task: TaskSnapshot, minutes: number): Promise<void> {
    try {
      await this.executePlanningPatch(task, {
        duration: { type: 'set', value: durationMinutes(minutes) },
      });
    } catch {
      // Invalid input leaves the existing duration unchanged.
    }
  }

  private async clearDuration(task: TaskSnapshot): Promise<void> {
    await this.executePlanningPatch(task, { duration: { type: 'clear' } });
  }

  private setStatus(task: TaskLike, symbol: string): Promise<void> {
    if (this.statusRegistry.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(task, () => this.commitStatus(task, symbol));
    }
    return this.commitStatus(task, symbol);
  }

  private async commitStatus(task: TaskLike, symbol: string): Promise<void> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return;
    const result = await this.tasks.execute({ type: 'set-status', target, symbol });
    this.applyPlanningResult(result, target);
  }

  private async updatePriority(task: TaskLike, priority: string): Promise<void> {
    if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(priority)) return;
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return;
    const patch: TaskPatch = {
      priority: { type: 'set', value: priority as TaskPriority },
    };
    await this.executePlanningPatch(task, patch);
  }

  private async removeTag(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch(task, { tags: { remove: [tag] } });
  }

  private async addTag(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch(task, { tags: { add: [tag] } });
  }

  private showTimePopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el.querySelector('.tc-time-popover');
    this.clearPopovers();
    if (already) return;

    const pop = this.el.createDiv({
      cls: 'tc-popover tc-time-popover tc-popover-anchored',
      attr: { role: 'dialog', 'aria-label': 'Set time and duration' },
    });

    const inputRow = pop.createDiv({ cls: 'tc-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'tc-time-input',
      attr: { type: 'time', value: task.planning.time ?? '' },
    });
    this.el.ownerDocument.defaultView?.setTimeout(() => input.focus(), 0);
    input.addEventListener('change', () => {
      void this.updateTime(task, input.value).then(() => this.removeAnchoredSurface(pop));
    });

    const clearBtn = inputRow.createEl('button', {
      cls: 'tc-popover-clear-icon-btn',
      attr: { title: 'Clear time', 'aria-label': 'Clear time' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => {
      void this.updateTime(task, '').then(() => this.removeAnchoredSurface(pop));
    });

    // Duration only applies to top-level TaskSnapshot (SubtaskSnapshot has no duration field) —
    // same 'duration' in task discriminator used for the Planning section gate.
    if ('source' in task) {
      const durationRow = pop.createDiv({ cls: 'tc-popover-input-row' });
      const durationInput = durationRow.createEl('input', {
        cls: 'tc-duration-input',
        attr: {
          type: 'text',
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          placeholder: 'Duration, e.g. 1h30m',
          value: task.planning.duration ? formatDurationFromMinutes(task.planning.duration) : '',
        },
      });
      durationInput.addEventListener('change', () => {
        const minutes = parseDurationToMinutes(durationInput.value);
        const done = minutes ? this.updateDuration(task, minutes) : this.clearDuration(task);
        void done.then(() => this.removeAnchoredSurface(pop));
      });
      const clearDurationBtn = durationRow.createEl('button', {
        cls: 'tc-popover-clear-icon-btn',
        attr: { title: 'Clear duration', 'aria-label': 'Clear duration' },
      });
      setIcon(clearDurationBtn, 'x');
      clearDurationBtn.addEventListener('mousedown', (e) => e.preventDefault());
      clearDurationBtn.addEventListener('click', () => {
        void this.clearDuration(task).then(() => this.removeAnchoredSurface(pop));
      });
    }

    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor, undefined, { focusLeaveDelay: 200 });
  }

  private async updateTime(task: TaskLike, time: string): Promise<void> {
    try {
      await this.executePlanningPatch(task, {
        time: time ? { type: 'set', value: localTime(time) } : { type: 'clear' },
      });
    } catch {
      // Invalid input leaves the existing time unchanged.
    }
  }

  private renderContextMenu(task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el.querySelector<HTMLElement>('.tc-task-context-menu');
    if (existing) {
      this.removeAnchoredSurface(existing);
      return;
    }
    // Close any other open context menus
    this.el
      .querySelectorAll<HTMLElement>('.tc-context-menu')
      .forEach((element) => this.removeAnchoredSurface(element));

    const menu = this.el.createDiv({
      cls: 'tc-context-menu tc-task-context-menu tc-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Task actions' },
    });

    const editRepeat = this.createContextMenuItem(menu, 'tc-context-item', 'Edit repeat…', () => {
      this.removeAnchoredSurface(menu);
      this.showRecurrencePopover(anchor, task, this.recurrenceStackFor(task));
    });

    this.createContextMenuItem(
      menu,
      'tc-context-item tc-context-danger',
      this.planningTarget(task)?.type === 'subtask' ? 'Delete sub-task' : 'Delete task',
      () => {
        this.removeAnchoredSurface(menu);
        void this.deleteTask(task);
      },
    );

    this.createContextMenuItem(menu, 'tc-context-item', 'Open in file', () => {
      this.removeAnchoredSurface(menu);
      const root = this.state.get('taskStack')[0];
      if (root && 'source' in root) void openInFile(this.app, root, taskNodeLine(root, task));
    });

    this.positionAnchoredSurface(menu, anchor, 'below-end');
    this.dismissMenuOnOutsideClick(menu, anchor);
    editRepeat.focus({ preventScroll: true });
  }

  private recurrenceStackFor(task: TaskLike): readonly TaskLike[] {
    const root = this.state.get('taskStack')[0];
    const target = this.planningTarget(task);
    if (!root || !('source' in root) || !target) return [];
    return rebuildPlanningTargetStack(root, target);
  }

  /** Shared outside-click dismissal for small anchored menus (context menu, add-date menu). */
  private dismissMenuOnOutsideClick(
    menu: HTMLElement,
    anchor: HTMLElement,
    dismissSurface: () => void = () => this.removeAnchoredSurface(menu),
    options: { focusLeaveDelay?: number; onCleanup?: () => void } = {},
  ): void {
    const ownerDocument = this.el.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placementCleanup = this.anchoredSurfaceCleanups.get(menu);
    let listening = false;
    let focusLeaveTimer: number | undefined;
    anchor.setAttribute('aria-expanded', 'true');
    const dismiss = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) {
        dismissSurface();
      }
    };
    const dismissOnEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dismissSurface();
      anchor.focus({ preventScroll: true });
    };
    const dismissAfterFocusLeaves = (): void => {
      if (options.focusLeaveDelay === undefined) return;
      if (focusLeaveTimer !== undefined) ownerWindow?.clearTimeout(focusLeaveTimer);
      focusLeaveTimer = ownerWindow?.setTimeout(() => {
        focusLeaveTimer = undefined;
        const activeElement = ownerDocument.activeElement;
        if (!menu.contains(activeElement) && activeElement !== anchor) dismissSurface();
      }, options.focusLeaveDelay);
    };
    ownerDocument.addEventListener('keydown', dismissOnEscape, true);
    if (options.focusLeaveDelay !== undefined) {
      menu.addEventListener('focusout', dismissAfterFocusLeaves);
    }
    let registrationTimer = ownerWindow?.setTimeout(() => {
      registrationTimer = undefined;
      ownerDocument.addEventListener('click', dismiss, true);
      listening = true;
    }, 0);
    const cleanup = (): void => {
      placementCleanup?.();
      if (registrationTimer !== undefined) ownerWindow?.clearTimeout(registrationTimer);
      if (focusLeaveTimer !== undefined) ownerWindow?.clearTimeout(focusLeaveTimer);
      if (listening) ownerDocument.removeEventListener('click', dismiss, true);
      ownerDocument.removeEventListener('keydown', dismissOnEscape, true);
      if (options.focusLeaveDelay !== undefined) {
        menu.removeEventListener('focusout', dismissAfterFocusLeaves);
      }
      anchor.setAttribute('aria-expanded', 'false');
      options.onCleanup?.();
      if (this.anchoredSurfaceCleanups.get(menu) === cleanup) {
        this.anchoredSurfaceCleanups.delete(menu);
      }
    };
    this.anchoredSurfaceCleanups.set(menu, cleanup);
  }

  private async deleteTask(task: TaskLike): Promise<void> {
    const target = this.planningTarget(task);
    if (target?.type === 'subtask') {
      await this.executeBlockCommand(
        { type: 'delete-subtask', subtask: target.ref },
        target.ref.parent,
      );
      return;
    }
    if (target?.type !== 'task' || !this.tasks) return;
    const initiatingStack = this.state.get('taskStack');
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute({ type: 'delete', ref: target.ref });
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    presentTaskCommandResult(result);
    const selectedRoot = this.state.get('taskStack')[0];
    const selectedRef = selectedRoot ? rootTaskRef(selectedRoot) : undefined;
    if (
      result.type === 'ok' &&
      result.outcome.type === 'deleted' &&
      this.state.get('taskStack') === initiatingStack &&
      selectedRef &&
      sameTaskRef(selectedRef, target.ref)
    ) {
      this.state.set('taskStack', []);
    }
  }

  private async reorderSubTask(
    parentTask: TaskLike,
    moved: SubtaskSnapshot,
    target: SubtaskSnapshot,
    position: 'before' | 'after',
  ): Promise<void> {
    const parent = this.planningTarget(parentTask);
    const movedTarget = this.planningTarget(moved);
    const targetNode = this.planningTarget(target);
    if (!parent || movedTarget?.type !== 'subtask' || targetNode?.type !== 'subtask') return;
    await this.executeBlockCommand(
      {
        type: 'reorder-subtask',
        subtask: movedTarget.ref,
        target: targetNode.ref,
        placement: position,
      },
      parent,
    );
  }

  private formatDate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    return window.moment(d, 'YYYY-MM-DD').format('D MMM');
  }
}
