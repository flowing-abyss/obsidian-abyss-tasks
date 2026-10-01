import type { App, Component } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { LinkToken } from '../../markdown/links';
import type { StatusRegistry } from '../../status/StatusRegistry';
import {
  formatCommentTimeLabel,
  type CommentTimeContext,
  type SubtaskSnapshot,
  type TaskCommentSnapshot,
  type TaskNodeRef,
  type TaskTextTarget,
} from '../../tasks';
import {
  enableAttachmentDrop,
  enableAttachmentPaste,
  insertAtCaret,
  whenPasteSettled,
} from '../../ui/attachmentDrop';
import { isImeOwnedEvent } from '../../ui/ime';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { LinkEditModal } from '../../ui/LinkEditModal';
import { renderTaskText } from '../../ui/renderTaskText';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { startTaskNodeDrag } from '../../ui/taskNodeDrag';
import { rootTaskRef, taskNodeRef } from '../../ui/taskSelection';
import { renderRowRemove } from './inspectorRowRemove';
import type { TaskLike } from './inspectorTypes';

interface InspectorSectionsOptions {
  readonly app: App;
  readonly state: AppState;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly host: {
    readonly root: () => HTMLElement;
    readonly component: () => Component;
    readonly renderTaskStatusMarker: (parent: HTMLElement, task: TaskLike) => void;
    readonly finishTaskDrag: () => void;
    readonly setTaskDragCleanup: (cleanup: () => void) => void;
    readonly dismissEntrySubmission: (
      kind: 'new-subtask' | 'new-comment',
      target: TaskNodeRef,
    ) => void;
    readonly cancelRestoredDraftFocus: (document: Document) => void;
  };
  readonly commands: {
    readonly saveTaskTitle: (task: TaskLike, newText: string) => Promise<boolean>;
    readonly appendToTitle: (task: TaskLike, text: string) => Promise<void>;
    readonly updateDescription: (task: TaskLike, newDesc: string) => Promise<boolean>;
    readonly addSubTask: (task: TaskLike, text: string) => Promise<boolean>;
    readonly addComment: (
      task: TaskLike,
      text: string,
      commentList: HTMLElement,
      inputEl: HTMLTextAreaElement,
    ) => Promise<boolean>;
    readonly updateComment: (
      task: TaskLike,
      comment: TaskCommentSnapshot,
      newText: string,
    ) => Promise<boolean>;
    readonly deleteComment: (task: TaskLike, comment: TaskCommentSnapshot) => Promise<boolean>;
    readonly deleteTask: (task: TaskLike) => Promise<void>;
    readonly reorderSubTask: (
      parentTask: TaskLike,
      moved: SubtaskSnapshot,
      target: SubtaskSnapshot,
      position: 'before' | 'after',
    ) => Promise<void>;
    readonly executeLinkEdit: (
      target: TaskTextTarget,
      occurrence: number,
      replacement: string,
    ) => Promise<void>;
  };
}

class AsyncEditLifecycle {
  #phase: 'idle' | 'saving' | 'closed' = 'idle';

  begin(): boolean {
    if (this.#phase !== 'idle') return false;
    this.#phase = 'saving';
    return true;
  }

  retry(): void {
    if (this.#phase === 'saving') this.#phase = 'idle';
  }

  close(): void {
    this.#phase = 'closed';
  }

  isClosed(): boolean {
    return this.#phase === 'closed';
  }
}

export class InspectorSections {
  readonly #app: App;
  readonly #state: AppState;
  readonly #interactionOwnership: InteractionOwnershipPort;
  readonly #host: InspectorSectionsOptions['host'];
  readonly #commands: InspectorSectionsOptions['commands'];
  #draggingSub: SubtaskSnapshot | null = null;

  constructor(options: InspectorSectionsOptions) {
    this.#app = options.app;
    this.#state = options.state;
    this.#interactionOwnership = options.interactionOwnership;
    this.#host = options.host;
    this.#commands = options.commands;
  }

  #enablePaste(el: HTMLTextAreaElement, task: TaskLike): void {
    enableAttachmentPaste(el, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      onInsert: (links) => {
        insertAtCaret(el, links);
      },
    });
  }

  editLink(task: TaskLike, occ: number, token: LinkToken): void {
    const target = taskNodeRef(task);
    new LinkEditModal(
      this.#app,
      token,
      (newRaw) => {
        runAsyncAction(this.#commands.executeLinkEdit({ type: 'title', target }, occ, newRaw));
      },
      rootTaskRef(task).filePath,
      this.#interactionOwnership,
    ).open();
  }

  /** Edit a target-scoped link through the same revision-confirming task API as title edits. */
  #editLinkInString(
    target: TaskTextTarget,
    occ: number,
    token: LinkToken,
    sourcePath: string,
  ): void {
    new LinkEditModal(
      this.#app,
      token,
      (newRaw) => {
        runAsyncAction(this.#commands.executeLinkEdit(target, occ, newRaw));
      },
      sourcePath,
      this.#interactionOwnership,
    ).open();
  }

  #renderDescriptionBlock(section: HTMLElement, task: TaskLike): void {
    const view = section.createDiv({ cls: 'abyss-right-desc abyss-right-desc-view' });
    enableAttachmentDrop(view, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        // The closure carries the observed revision; a concurrent edit is surfaced as a
        // structured conflict instead of overwriting the changed block.
        const current = task.description ?? '';
        runAsyncAction(
          this.#commands.updateDescription(
            task,
            current.trim().length > 0 ? `${current} ${links}` : links,
          ),
        );
      },
    });
    const showView = (): void => {
      this.#showDescription(view, task);
    };
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a') != null) return; // let links navigate
      this.#enterDescriptionEdit(section, view, task, showView);
    });
    showView();
  }

  #enterDescriptionEdit(
    section: HTMLElement,
    view: HTMLElement,
    task: TaskLike,
    showView: () => void,
  ): void {
    const start = view.offsetHeight;
    view.hide();
    const textarea = section.createEl('textarea', {
      cls: 'abyss-right-desc abyss-right-desc-edit',
    });
    view.insertAdjacentElement('afterend', textarea);
    textarea.value = task.description ?? '';
    this.#enablePaste(textarea, task);
    textarea.setCssStyles({ height: `${Math.max(start, 60)}px` });
    textarea.ownerDocument.defaultView?.setTimeout(() => {
      textarea.focus();
    }, 0);
    const lifecycle = new AsyncEditLifecycle();
    const finish = async (save: boolean): Promise<void> => {
      if (!lifecycle.begin()) return;
      await whenPasteSettled(textarea);
      const changed = textarea.value !== (task.description ?? '');
      if (save && changed && !(await this.#commands.updateDescription(task, textarea.value))) {
        lifecycle.retry();
        textarea.focus();
        return;
      }
      lifecycle.close();
      textarea.remove();
      view.show();
      showView();
    };
    textarea.addEventListener('blur', () => {
      runAsyncAction(finish(true));
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || isImeOwnedEvent(event)) return;
      event.preventDefault();
      runAsyncAction(finish(false));
    });
  }

  #showDescription(view: HTMLElement, task: TaskLike): void {
    const description = task.description ?? '';
    if (description.trim().length === 0) {
      view.empty();
      view.addClass('abyss-right-desc-empty');
      view.setText('Add a description…');
      return;
    }
    view.removeClass('abyss-right-desc-empty');
    renderTaskText(view, description, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      component: this.#host.component(),
      onEditLink: (occurrence, token) => {
        const target = taskNodeRef(task);
        this.#editLinkInString(
          { type: 'description', target },
          occurrence,
          token,
          rootTaskRef(task).filePath,
        );
      },
    });
  }

  renderDescriptionSection(task: TaskLike): void {
    const descSection = this.#host.root().createDiv({ cls: 'abyss-right-section' });
    const descHeader = descSection.createDiv({ cls: 'abyss-right-section-header' });
    descHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Description' });
    this.#renderDescriptionBlock(descSection, task);
  }

  renderSubtaskSection(task: TaskLike): void {
    const subSection = this.#host.root().createDiv({
      cls: 'abyss-right-section abyss-subtask-section',
    });
    const subHeader = subSection.createDiv({ cls: 'abyss-right-section-header' });
    subHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Sub-tasks' });
    const totalSubs = task.subtasks.length;
    if (totalSubs > 0) {
      const doneSubs = task.subtasks.filter((s) => s.status === 'done').length;
      subHeader.createSpan({
        cls: 'abyss-right-section-count',
        text: `${doneSubs}/${totalSubs}`,
      });
    }
    const subList = subSection.createDiv({ cls: 'abyss-subtask-list' });
    for (const sub of task.subtasks) this.#renderSubTask(subList, sub, task);
    this.#renderAddSubtaskControl(subSection, task);
  }

  #renderAddSubtaskControl(subSection: HTMLElement, task: TaskLike): void {
    const addSubRow = subSection.createDiv({ cls: 'abyss-subtask-add-row' });
    addSubRow.createSpan({ cls: 'abyss-subtask-add-icon', text: '+' });
    addSubRow.createSpan({ cls: 'abyss-subtask-add-label', text: 'Add sub-task' });
    addSubRow.addEventListener('click', () => {
      this.#openSubtaskInput(subSection, addSubRow, task);
    });
  }

  #openSubtaskInput(section: HTMLElement, trigger: HTMLElement, task: TaskLike): void {
    trigger.addClass('abyss-subtask-add-row--hidden');
    const input = section.createEl('input', {
      cls: 'abyss-subtask-new-input',
      attr: { type: 'text', placeholder: 'New sub-task…' },
    });
    const lifecycle = new AsyncEditLifecycle();
    const close = (): void => {
      if (lifecycle.isClosed()) return;
      lifecycle.close();
      removeDismissal();
      input.remove();
      trigger.removeClass('abyss-subtask-add-row--hidden');
    };
    const commit = async (): Promise<void> => {
      const text = input.value.trim();
      if (text === '' || !lifecycle.begin()) return;
      const succeeded = await this.#commands.addSubTask(task, text);
      if (lifecycle.isClosed() || !input.isConnected) return;
      lifecycle.retry();
      if (!succeeded && input.ownerDocument.activeElement === input) input.focus();
    };
    const removeDismissal = this.#registerEntryDismissal(input, task, 'new-subtask', close);
    this.#host.component().register(close);
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !isImeOwnedEvent(event)) {
        event.preventDefault();
        runAsyncAction(commit());
      }
    });
    input.focus();
  }

  #registerEntryDismissal(
    input: HTMLInputElement | HTMLTextAreaElement,
    task: TaskLike,
    kind: 'new-subtask' | 'new-comment',
    close: () => void,
  ): () => void {
    const document = input.ownerDocument;
    const dismiss = (): void => {
      this.#host.dismissEntrySubmission(kind, taskNodeRef(task));
      this.#host.cancelRestoredDraftFocus(document);
      close();
    };
    const outside = (event: Event): void => {
      if (
        input.isConnected &&
        event.target !== input &&
        (event.type === 'focusin' || kind === 'new-subtask' || document.activeElement === input)
      )
        dismiss();
    };
    const escape = (raw: Event): void => {
      const event = raw as KeyboardEvent;
      if (event.key !== 'Escape' || isImeOwnedEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    input.addEventListener('keydown', escape);
    let listening = true;
    const cleanup = (): void => {
      if (!listening) return;
      listening = false;
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      input.removeEventListener('keydown', escape);
    };
    this.#host.component().register(cleanup);
    return cleanup;
  }

  renderCommentSection(task: TaskLike, commentTimeContext?: CommentTimeContext): void {
    const commentSection = this.#host.root().createDiv({ cls: 'abyss-right-section' });
    const commentHeader = commentSection.createDiv({ cls: 'abyss-right-section-header' });
    commentHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Comments' });
    const commentCount = task.comments.length;
    if (commentCount > 0) {
      commentHeader.createSpan({
        cls: 'abyss-right-section-count',
        text: String(commentCount),
      });
    }
    const commentList = commentSection.createDiv({ cls: 'abyss-comment-list' });
    for (const comment of task.comments) {
      this.#renderComment(commentList, comment, task, commentTimeContext);
    }
    const commentInput = commentSection.createEl('textarea', {
      cls: 'abyss-comment-input',
      attr: { placeholder: 'Write a comment…', rows: '2' },
    });
    enableAttachmentDrop(commentInput, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        commentInput.value = commentInput.value === '' ? links : `${commentInput.value} ${links}`;
        commentInput.focus();
      },
    });
    this.#enablePaste(commentInput, task);
    this.#registerEntryDismissal(commentInput, task, 'new-comment', () => {
      commentInput.blur();
    });
    commentInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !isImeOwnedEvent(e)) {
        e.preventDefault();
        const text = commentInput.value.trim();
        if (text !== '') {
          runAsyncAction(this.#commands.addComment(task, text, commentList, commentInput));
        }
      }
    });
  }

  renderTitleBlock(header: HTMLElement, task: TaskLike): void {
    const view = header.createDiv({ cls: 'abyss-right-title abyss-right-title-view' });
    enableAttachmentDrop(view, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        runAsyncAction(this.#commands.appendToTitle(task, links));
      },
    });
    const renderView = (): void => {
      renderTaskText(view, task.markdownTitle, {
        app: this.#app,
        sourcePath: rootTaskRef(task).filePath,
        component: this.#host.component(),
        onEditLink: (occ, token) => {
          this.editLink(task, occ, token);
        },
      });
    };
    renderView();

    // Click on empty space / non-link text enters edit mode.
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a') != null) return; // let links navigate
      this.#enterTitleEdit(header, view, task, renderView);
    });
  }

  #enterTitleEdit(
    header: HTMLElement,
    view: HTMLElement,
    task: TaskLike,
    renderView: () => void,
  ): void {
    // Preserve the height the user stretched the read-mode block to (measure first).
    const startHeight = view.offsetHeight;
    view.hide();
    const ta = header.createEl('textarea', { cls: 'abyss-right-title abyss-right-title-edit' });
    // Keep the textarea in the title's slot so the ⋯/× action buttons stay on the right.
    view.insertAdjacentElement('afterend', ta);
    ta.value = task.markdownTitle;
    this.#enablePaste(ta, task);
    // Auto-grow to content, but never below the stretched height.
    let autoHeight = '';
    const grow = (): void => {
      ta.setCssStyles({ height: 'auto' });
      ta.setCssStyles({ height: `${Math.max(ta.scrollHeight, startHeight)}px` });
      autoHeight = ta.style.height;
    };
    ta.addEventListener('input', grow);
    ta.ownerDocument.defaultView?.setTimeout(() => {
      ta.focus();
      grow();
    }, 0);

    const lifecycle = new AsyncEditLifecycle();
    const finish = async (save: boolean): Promise<void> => {
      if (!lifecycle.begin()) return;
      // Let any in-flight paste insert its link into the value before we save/remove.
      await whenPasteSettled(ta);
      const resizedHeight = ta.style.height !== autoHeight ? ta.offsetHeight : undefined;
      if (save && ta.value !== task.markdownTitle) {
        const saved = await this.#commands.saveTaskTitle(task, ta.value.trim());
        if (!saved) {
          lifecycle.retry();
          ta.focus();
          return;
        }
      }
      lifecycle.close();
      if (resizedHeight !== undefined) view.setCssStyles({ height: `${resizedHeight}px` });
      ta.remove();
      view.show();
      renderView();
    };
    ta.addEventListener('blur', () => {
      runAsyncAction(finish(true));
    });
    ta.addEventListener('keydown', (e) => {
      if (isImeOwnedEvent(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAsyncAction(finish(true));
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        runAsyncAction(finish(false));
      }
    });
  }

  #renderSubTask(container: HTMLElement, sub: SubtaskSnapshot, parentTask: TaskLike): void {
    const row = container.createDiv({
      cls: 'abyss-subtask-row',
      attr: { draggable: 'true', tabindex: '-1' },
    });
    this.#bindSubtaskDragAndDrop(row, container, sub, parentTask);
    this.#host.renderTaskStatusMarker(row, sub);
    this.#renderSubtaskContent(row, sub);
  }

  #bindSubtaskDragAndDrop(
    row: HTMLElement,
    container: HTMLElement,
    sub: SubtaskSnapshot,
    parentTask: TaskLike,
  ): void {
    row.addEventListener('dragstart', (e) => {
      this.#startSubtaskDrag(row, container, sub, e);
    });

    row.addEventListener('dragover', (e) => {
      if (this.#draggingSub == null || this.#draggingSub.ref.relativeLine === sub.ref.relativeLine)
        return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      // Clear indicators on all siblings first
      container.querySelectorAll('.drop-above,.drop-below').forEach((el) => {
        el.removeClass('drop-above', 'drop-below');
      });
      row.addClass(isAbove ? 'drop-above' : 'drop-below');
    });

    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) {
        row.removeClass('drop-above', 'drop-below');
      }
    });

    row.addEventListener('drop', (e) => {
      const dragged = this.#draggingSub;
      if (dragged == null || dragged.ref.relativeLine === sub.ref.relativeLine) return;
      e.preventDefault();
      const position = row.hasClass('drop-above') ? 'before' : 'after';
      row.removeClass('drop-above', 'drop-below');
      runAsyncAction(this.#commands.reorderSubTask(parentTask, dragged, sub, position));
    });
  }

  #startSubtaskDrag(
    row: HTMLElement,
    container: HTMLElement,
    sub: SubtaskSnapshot,
    event: DragEvent,
  ): void {
    this.#host.finishTaskDrag();
    this.#draggingSub = sub;
    row.addClass('is-dragging');
    event.dataTransfer?.setData('text/plain', String(sub.ref.relativeLine));
    const stack = this.#state.get('taskStack');
    const root = stack[0];
    if (root !== undefined && 'source' in root) {
      this.#host.setTaskDragCleanup(
        startTaskNodeDrag(this.#state, this.#host.root(), row, {
          payload: {
            source: 'inspector-subtask',
            task: {
              root,
              path: [...stack.filter((node): node is SubtaskSnapshot => !('source' in node)), sub],
              node: sub,
              target: taskNodeRef(sub),
            },
          },
          onEnd: () => {
            this.#draggingSub = null;
            row.removeClass('is-dragging');
            container.querySelectorAll('.drop-above,.drop-below').forEach((element) => {
              element.removeClass('drop-above', 'drop-below');
            });
          },
        }),
      );
    }
  }

  #renderSubtaskContent(row: HTMLElement, sub: SubtaskSnapshot): void {
    const content = row.createDiv({ cls: 'abyss-subtask-content' });
    const titleRow = content.createDiv({ cls: 'abyss-subtask-title-row' });
    const label = titleRow.createSpan({
      cls: `abyss-subtask-label${sub.status === 'done' ? ' is-done' : ''}`,
    });
    renderTaskText(label, sub.markdownTitle, {
      app: this.#app,
      sourcePath: rootTaskRef(sub).filePath,
      component: this.#host.component(),
      onEditLink: (occ, token) => {
        this.editLink(sub, occ, token);
      },
    });
    label.addEventListener('click', () => {
      const stack = this.#state.get('taskStack');
      this.#state.updateInspectorSelection([...stack, sub]);
    });
    renderRowRemove(
      titleRow,
      'abyss-subtask-remove',
      { label: 'Delete sub-task', failure: 'Could not delete sub-task' },
      () => this.#commands.deleteTask(sub),
    );

    // Progress + comment count indicators
    const subCount = sub.subtasks.length;
    const commentCount = sub.comments.length;
    if (subCount > 0 || commentCount > 0) {
      const subMeta = content.createDiv({ cls: 'abyss-subtask-meta' });
      if (subCount > 0) {
        const done = sub.subtasks.filter((s) => s.status === 'done').length;
        subMeta.createSpan({ cls: 'abyss-subtask-progress', text: `${done}/${subCount}` });
      }
      if (commentCount > 0) {
        subMeta.createSpan({
          cls: 'abyss-subtask-comment-count',
          text: `💬 ${commentCount}`,
        });
      }
    }
  }

  #renderComment(
    container: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    commentTimeContext?: CommentTimeContext,
  ): void {
    const row = container.createDiv({ cls: 'abyss-comment-row' });
    enableAttachmentDrop(row, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        runAsyncAction(
          this.#commands.updateComment(task, comment, `${comment.text} ${links}`.trim()),
        );
      },
    });
    if (comment.timestamp != null && commentTimeContext != null) {
      row.createSpan({
        cls: 'abyss-comment-date',
        text: formatCommentTimeLabel({ timestamp: comment.timestamp, ...commentTimeContext }),
      });
    }
    const showText = (): void => {
      this.#renderCommentText(row, comment, task, showText);
    };
    showText();
  }

  #renderCommentText(
    row: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    showText: () => void,
  ): void {
    const textEl = row.createEl('p', { cls: 'abyss-comment-text' });
    renderTaskText(textEl, comment.text, {
      app: this.#app,
      sourcePath: rootTaskRef(task).filePath,
      component: this.#host.component(),
      onEditLink: (occurrence, token) => {
        this.#editLinkInString(
          { type: 'comment', ref: comment.ref },
          occurrence,
          token,
          rootTaskRef(task).filePath,
        );
      },
    });
    textEl.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('a') != null) return;
      this.#openCommentEditor(row, comment, task, showText);
    });
  }

  #openCommentEditor(
    row: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    showText: () => void,
  ): void {
    row.querySelector('.abyss-comment-text')?.remove();
    const textarea = row.createEl('textarea', { cls: 'abyss-comment-edit-input' });
    textarea.value = comment.text;
    this.#enablePaste(textarea, task);
    const lifecycle = new AsyncEditLifecycle();
    const finish = async (): Promise<void> => {
      if (!lifecycle.begin()) return;
      await whenPasteSettled(textarea);
      const value = textarea.value.trim();
      if (value === comment.text) {
        lifecycle.close();
        textarea.remove();
        showText();
        return;
      }
      const committed =
        value === ''
          ? await this.#commands.deleteComment(task, comment)
          : await this.#commands.updateComment(task, comment, value);
      if (!committed) {
        lifecycle.retry();
        textarea.focus();
        return;
      }
      lifecycle.close();
      textarea.remove();
    };
    textarea.addEventListener('blur', () => {
      textarea.ownerDocument.defaultView?.setTimeout(() => {
        runAsyncAction(finish());
      }, 150);
    });
    textarea.addEventListener('keydown', (event: KeyboardEvent) => {
      if (isImeOwnedEvent(event)) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        textarea.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        lifecycle.close();
        textarea.remove();
        showText();
      }
    });
    textarea.focus();
    textarea.select();
  }
}
