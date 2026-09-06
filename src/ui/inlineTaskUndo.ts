import type { TaskCommandResult } from '../tasks';
import { presentTaskCommandResult } from './taskCommandResult';

export interface InlineUndoPosition {
  readonly list: string;
  readonly index: number;
  readonly title: string;
}

interface InlineTaskUndo {
  clear(): void;
  detach(): void;
  render(container: HTMLElement): void;
  show(
    container: HTMLElement,
    position: InlineUndoPosition,
    execute: () => Promise<TaskCommandResult>,
  ): void;
}

/** One ephemeral action, owned and revoked by the mounted inspector. */
export function createInlineTaskUndo(): InlineTaskUndo {
  let dispose: (() => void) | undefined;
  let position: InlineUndoPosition | undefined;
  let row: HTMLElement | undefined;
  let focused = false;
  const clear = (): void => {
    dispose?.();
    dispose = undefined;
    row = undefined;
    position = undefined;
    focused = false;
  };
  const render = (container: HTMLElement): void => {
    if (row === undefined || position === undefined) return;
    const list = container.querySelector(position.list);
    list?.insertBefore(row, list.children[position.index] ?? null);
    if (focused) row.querySelector('button')?.focus();
    focused = false;
  };
  return {
    clear,
    render,
    detach(): void {
      focused = row?.contains(row.ownerDocument.activeElement) ?? false;
      row?.remove();
    },
    show(container, location, execute): void {
      clear();
      const ownerWindow = container.ownerDocument.defaultView;
      const element = container.createDiv({ cls: 'abyss-subtask-row abyss-undo-row' });
      element.append(
        `${location.list.includes('subtask-section') ? 'Sub-task deleted' : 'Dependency removed'} · `,
      );
      const button = element.createEl('button', {
        text: 'Undo',
        attr: { type: 'button', 'aria-label': `Undo: ${location.title}` },
      });
      const expire = (): number | undefined => ownerWindow?.setTimeout(clear, 8_000);
      let timer = expire();
      const settle = (result: TaskCommandResult): void => {
        if (result.type !== 'ok') {
          button.disabled = false;
          if (row === element) timer = expire();
          presentTaskCommandResult(result);
        } else if (row === element) {
          clear();
          const restored = container.querySelector(location.list)?.children[location.index] as
            HTMLElement | undefined;
          if (restored !== undefined) {
            restored.tabIndex = -1;
            restored.focus({ preventScroll: true });
          }
        }
      };
      button.onclick = (event): void => {
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        ownerWindow?.clearTimeout(timer);
        Promise.resolve()
          .then(execute)
          .then(settle, (error: unknown) => {
            console.error('[abyss-tasks] Undo failed', error);
            settle({ type: 'io-error', cause: 'undo-error', contentState: 'unknown' });
          });
      };
      dispose = () => {
        ownerWindow?.clearTimeout(timer);
        button.onclick = null;
        element.remove();
      };
      row = element;
      position = location;
      render(container);
      button.focus({ preventScroll: true });
    },
  };
}
