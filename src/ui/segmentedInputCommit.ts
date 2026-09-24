import { isImeOwnedEvent } from './ime';

/** Why a segmented field commits: its own change, Enter, focus leaving it, or its owner closing. */
export type SegmentedCommitReason = 'change' | 'enter' | 'departure' | 'flush';

export interface SegmentedInputCommitHandle {
  /** Commits a keyboard draft now; without one it does nothing. */
  flush(): void;
  /** Drops the draft and disarms the field for good. */
  cancel(): void;
}

interface SegmentedInputCommitOptions {
  readonly input: HTMLInputElement;
  /** The element whose focus departure commits a draft. */
  readonly boundary: HTMLElement;
  /** Owns validity: a commit it refuses leaves the draft in place. */
  readonly commit: (reason: SegmentedCommitReason) => void;
}

/** Keys that move, confirm, or cancel rather than edit a segment. */
const NON_EDITING_KEYS: readonly string[] = [
  'Alt',
  'Control',
  'Enter',
  'Escape',
  'Meta',
  'Shift',
  'Tab',
];

function isNodeInside(boundary: HTMLElement, target: EventTarget | null): boolean {
  return (
    target !== null &&
    typeof (target as { nodeType?: unknown }).nodeType === 'number' &&
    boundary.contains(target as Node)
  );
}

/**
 * Keeps a native date or time field from committing a value the keyboard is still typing.
 * Chromium fires `change` after every segment, so a typed value commits only on Enter or when
 * focus leaves the boundary; a pointer choice from the native picker still commits at once.
 */
export function bindSegmentedInputCommit(
  options: SegmentedInputCommitOptions,
): SegmentedInputCommitHandle {
  const { input, boundary, commit } = options;
  let draft = false;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !isImeOwnedEvent(event)) {
      if (!draft) return;
      event.preventDefault();
      event.stopPropagation();
      commit('enter');
      return;
    }
    // An IME can stay on over a native field, so its keys still type into the segments.
    if (!NON_EDITING_KEYS.includes(event.key)) draft = true;
  };
  const onPointerDown = (): void => {
    draft = false;
  };
  const onChange = (): void => {
    if (!draft) commit('change');
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (!draft || !boundary.isConnected || isNodeInside(boundary, event.relatedTarget)) return;
    // A window switch keeps the field as the document's active element; a departure does not.
    if (event.relatedTarget === null && boundary.contains(boundary.ownerDocument.activeElement))
      return;
    commit('departure');
  };
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('pointerdown', onPointerDown);
  input.addEventListener('change', onChange);
  boundary.addEventListener('focusout', onFocusOut);
  return {
    flush: () => {
      if (draft) commit('flush');
    },
    cancel: () => {
      draft = false;
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('pointerdown', onPointerDown);
      input.removeEventListener('change', onChange);
      boundary.removeEventListener('focusout', onFocusOut);
    },
  };
}
