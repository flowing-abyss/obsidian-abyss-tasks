import type { TaskCommandResult } from '../tasks';
import { presentTaskCommandResult } from './taskCommandResult';

export interface InlineUndoPosition {
  readonly list: string;
  readonly index: number;
  readonly title: string;
  /** What the row says, for a list whose removal is neither a sub-task nor a dependency. */
  readonly label?: string;
}

/** What an undo row needs beyond its place, for the surfaces that do not take the defaults. */
interface InlineUndoPolicy {
  /** Proof that the row it offers to undo is still the one the note holds. */
  readonly validate?: () => boolean;
  /** Where a failed undo is reported, for a caller whose command boundary reports its own. */
  readonly report?: (result: TaskCommandResult) => void;
}

interface InlineTaskUndo {
  clear(): void;
  detach(): void;
  render(container: HTMLElement): void;
  show(
    container: HTMLElement,
    position: InlineUndoPosition,
    execute: () => Promise<TaskCommandResult>,
    policy?: InlineUndoPolicy,
  ): void;
}

/** One ephemeral action, owned and revoked by the mounted inspector. */
export function createInlineTaskUndo(): InlineTaskUndo {
  let dispose: (() => void) | undefined;
  let position: InlineUndoPosition | undefined;
  let row: HTMLElement | undefined;
  let validate: (() => boolean) | undefined;
  let focused = false;
  const clear = (): void => {
    dispose?.();
    dispose = undefined;
    row = undefined;
    position = undefined;
    validate = undefined;
    focused = false;
  };
  const isCurrent = (): boolean => {
    if (validate?.() === false) clear();
    return row !== undefined;
  };
  const render = (container: HTMLElement): void => {
    if (row === undefined || position === undefined) return;
    if (row.querySelector('button')?.disabled !== true && !isCurrent()) return;
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
    show(container, location, execute, policy): void {
      clear();
      validate = policy?.validate;
      const report = policy?.report ?? presentTaskCommandResult;
      const ownerWindow = container.ownerDocument.defaultView;
      const [element, button] = createUndoRow(container, location);
      const expire = (): number | undefined => ownerWindow?.setTimeout(clear, 5_000);
      let timer = expire();
      const settle = (result: TaskCommandResult | undefined): void => {
        if (result === undefined) return;
        if (result.type !== 'ok') {
          if (row === element && isCurrent()) {
            button.disabled = false;
            timer = expire();
          }
          report(result);
        } else if (row === element) {
          clear();
          restoreRowFocus(container, location);
        }
      };
      button.onclick = (event): void => {
        event.stopPropagation();
        if (button.disabled || !isCurrent()) return;
        button.disabled = true;
        ownerWindow?.clearTimeout(timer);
        Promise.resolve()
          .then(() => (row === element && isCurrent() ? execute() : undefined))
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

function createUndoRow(
  container: HTMLElement,
  location: InlineUndoPosition,
): readonly [HTMLElement, HTMLButtonElement] {
  const row = container.createDiv({ cls: 'abyss-subtask-row abyss-undo-row' });
  row.append(
    location.label ??
      (location.list.includes('subtask-section') ? 'Sub-task deleted' : 'Dependency removed'),
  );
  const button = row.createEl('button', {
    text: 'Undo',
    attr: { type: 'button', 'aria-label': `Undo: ${location.title}` },
  });
  row.createSpan({ text: '(5s)' });
  return [row, button];
}

function restoreRowFocus(container: HTMLElement, location: InlineUndoPosition): void {
  const restored = container.querySelector(location.list)?.children[location.index] as
    HTMLElement | undefined;
  if (restored !== undefined) {
    restored.tabIndex = -1;
    restored.focus({ preventScroll: true });
  }
}
