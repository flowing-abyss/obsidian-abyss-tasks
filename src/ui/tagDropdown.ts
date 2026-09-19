import { normalizeTaskTagInput } from '../tasks';
import { runAsyncAction } from './runAsyncAction';

let nextTagDropdownId = 0;
type TagCommitOutcome = 'committed' | 'failed';

interface TagDropdownContext {
  readonly sortedTags: readonly string[];
  readonly dropdownId: string;
  readonly input: HTMLInputElement;
  readonly dropdown: HTMLElement;
  readonly feedback: HTMLElement;
  readonly getTagColor: (tag: string) => string | undefined;
  readonly commit: (input: string) => void;
  activeTag: string | undefined;
}

function sortedCandidates(candidates: readonly string[]): readonly string[] {
  return [...new Set(candidates)].sort((left, right) => {
    const leftClean = left.slice(1);
    const rightClean = right.slice(1);
    const leftRoot = leftClean.split('/')[0] ?? '';
    const rightRoot = rightClean.split('/')[0] ?? '';
    if (leftRoot !== rightRoot) return leftRoot.localeCompare(rightRoot);
    const leftDepth = (leftClean.match(/\//gu) ?? []).length;
    const rightDepth = (rightClean.match(/\//gu) ?? []).length;
    return leftDepth === rightDepth ? leftClean.localeCompare(rightClean) : leftDepth - rightDepth;
  });
}

function matchingTags(tags: readonly string[], query: string): readonly string[] {
  const normalized = query.toLowerCase().replace(/^#+/u, '');
  return normalized.length === 0
    ? tags
    : tags.filter((tag) => tag.slice(1).toLowerCase().includes(normalized));
}

function renderOptions(context: TagDropdownContext, query: string): void {
  const { dropdown, input } = context;
  dropdown.empty();
  const filtered = matchingTags(context.sortedTags, query);
  if (context.activeTag !== undefined && !filtered.includes(context.activeTag)) {
    context.activeTag = undefined;
  }
  dropdown.toggleClass('abyss-tag-dropdown--hidden', filtered.length === 0);
  input.setAttribute('aria-expanded', String(filtered.length > 0));
  if (filtered.length === 0) {
    input.removeAttribute('aria-activedescendant');
    return;
  }
  for (const tag of filtered) renderOption(context, tag);
  const active = dropdown.querySelector<HTMLElement>('.abyss-tag-dropdown-opt.is-active');
  if (active == null) input.removeAttribute('aria-activedescendant');
  else input.setAttribute('aria-activedescendant', active.id);
}

function renderOption(context: TagDropdownContext, tag: string): void {
  const active = tag === context.activeTag;
  const option = context.dropdown.createDiv({
    cls: `abyss-tag-dropdown-opt${active ? ' is-active' : ''}`,
    text: tag,
    attr: {
      id: `${context.dropdownId}-option-${context.sortedTags.indexOf(tag)}`,
      role: 'option',
      'aria-selected': String(active),
    },
  });
  const color = context.getTagColor(tag);
  if (color !== undefined && color.length > 0) {
    option.setCssProps({ '--abyss-tag-opt-color': color });
  }
  option.addEventListener('mousedown', (event) => {
    event.preventDefault();
    context.commit(tag);
  });
}

function updateActive(context: TagDropdownContext, delta: number): void {
  const options = Array.from(
    context.dropdown.querySelectorAll<HTMLElement>('.abyss-tag-dropdown-opt'),
  );
  if (options.length === 0) return;
  const activeIndex = options.findIndex(
    (option) => option.getAttribute('aria-selected') === 'true',
  );
  const nextIndex = Math.max(0, Math.min(options.length - 1, activeIndex + delta));
  context.activeTag = options[nextIndex]?.textContent ?? undefined;
  renderOptions(context, context.input.value);
  const active = context.dropdown.querySelector<HTMLElement>('.abyss-tag-dropdown-opt.is-active');
  if (active != null && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function bindInput(context: TagDropdownContext, close: () => void): void {
  context.input.addEventListener('input', () => {
    context.input.removeAttribute('aria-invalid');
    context.feedback.setText('');
    renderOptions(context, context.input.value);
  });
  context.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      updateActive(context, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      context.commit(context.activeTag ?? context.input.value);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
}

function tagCommitHandler(options: {
  readonly input: HTMLInputElement;
  readonly feedback: HTMLElement;
  readonly onCommit: (tags: readonly string[]) => TagCommitOutcome | Promise<TagCommitOutcome>;
  readonly close: () => void;
}): (value: string) => void {
  const { input, feedback, onCommit, close } = options;
  const rejectDraft = (message: string): void => {
    input.setAttribute('aria-invalid', 'true');
    feedback.setText(message);
    input.focus();
  };
  const settle = (outcome: TagCommitOutcome): void => {
    if (outcome === 'committed') close();
    else rejectDraft('Could not add tags. Try again.');
  };
  return (value): void => {
    const tags = normalizeTaskTagInput(value);
    if (tags === undefined || tags.length === 0) {
      rejectDraft('Enter one or more valid task tags.');
      return;
    }
    input.removeAttribute('aria-invalid');
    feedback.setText('');
    const result = onCommit(tags);
    if (!(result instanceof Promise)) {
      settle(result);
      return;
    }
    runAsyncAction(
      result.then(settle).catch((error: unknown) => {
        rejectDraft('Could not add tags. Try again.');
        throw error;
      }),
      'Could not assign task tags',
    );
  };
}

export function showTagDropdown(
  ...args: [
    container: HTMLElement,
    candidates: readonly string[],
    getTagColor: (tag: string) => string | undefined,
    onCommit: (tags: readonly string[]) => TagCommitOutcome | Promise<TagCommitOutcome>,
    onClose?: () => void,
  ]
): HTMLElement {
  const [container, candidates, getTagColor, onCommit, onClose] = args;
  container.querySelector('.abyss-tag-dropdown-wrap')?.remove();
  const wrap = container.createDiv({ cls: 'abyss-tag-dropdown-wrap' });
  const dropdownId = `abyss-tag-dropdown-${nextTagDropdownId++}`;
  const input = wrap.createEl('input', {
    cls: 'abyss-tag-input',
    attr: {
      type: 'text',
      placeholder: '#Tag',
      autocomplete: 'off',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-controls': dropdownId,
      'aria-expanded': 'false',
    },
  });
  const dropdown = wrap.createDiv({
    cls: 'abyss-tag-dropdown',
    attr: { id: dropdownId, role: 'listbox', 'aria-label': 'Available tags' },
  });
  const feedback = wrap.createDiv({
    cls: 'abyss-tag-input-feedback',
    attr: { role: 'status', 'aria-live': 'polite' },
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    onClose?.();
    wrap.remove();
  };
  const commit = tagCommitHandler({ input, feedback, onCommit, close });
  const context: TagDropdownContext = {
    sortedTags: sortedCandidates(candidates),
    dropdownId,
    input,
    dropdown,
    feedback,
    getTagColor,
    commit,
    activeTag: undefined,
  };
  bindInput(context, close);
  renderOptions(context, '');
  input.focus();
  return wrap;
}
