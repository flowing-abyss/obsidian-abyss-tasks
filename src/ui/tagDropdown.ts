import type { App } from 'obsidian';

let nextTagDropdownId = 0;

export function showTagDropdown(
  container: HTMLElement,
  app: App,
  getTagColor: (tag: string) => string | undefined,
  onCommit: (tag: string) => void,
  onClose?: () => void,
): HTMLElement {
  container.querySelector('.abyss-tag-dropdown-wrap')?.remove();

  const rawTags = Object.keys(
    (app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags(),
  );
  const sortedTags = rawTags
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .sort((a, b) => {
      const aClean = a.slice(1);
      const bClean = b.slice(1);
      const aRoot = aClean.split('/')[0] ?? '';
      const bRoot = bClean.split('/')[0] ?? '';
      if (aRoot !== bRoot) return aRoot.localeCompare(bRoot);
      const da = (aClean.match(/\//g) ?? []).length;
      const db = (bClean.match(/\//g) ?? []).length;
      if (da !== db) return da - db;
      return aClean.localeCompare(bClean);
    });

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
  let activeTag: string | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    onClose?.();
    wrap.remove();
  };

  const commit = (value: string): void => {
    const v = value.trim();
    if (v) onCommit(v);
    close();
  };

  const renderOptions = (query: string): void => {
    dropdown.empty();
    const q = query.toLowerCase().replace(/^#/, '');
    const filtered = q
      ? sortedTags.filter((t) => t.slice(1).toLowerCase().includes(q))
      : sortedTags;
    if (activeTag !== undefined && !filtered.includes(activeTag)) activeTag = undefined;
    if (filtered.length === 0) {
      dropdown.addClass('abyss-tag-dropdown--hidden');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    dropdown.removeClass('abyss-tag-dropdown--hidden');
    input.setAttribute('aria-expanded', 'true');
    for (const tag of filtered) {
      const optionId = `${dropdownId}-option-${sortedTags.indexOf(tag)}`;
      const active = tag === activeTag;
      const opt = dropdown.createDiv({
        cls: `abyss-tag-dropdown-opt${active ? ' is-active' : ''}`,
        text: tag,
        attr: { id: optionId, role: 'option', 'aria-selected': String(active) },
      });
      const color = getTagColor(tag);
      if (color) opt.setCssProps({ '--abyss-tag-opt-color': color });
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        commit(tag);
      });
    }
    const active = dropdown.querySelector<HTMLElement>('.abyss-tag-dropdown-opt.is-active');
    if (active) input.setAttribute('aria-activedescendant', active.id);
    else input.removeAttribute('aria-activedescendant');
  };

  const updateActive = (delta: number): void => {
    const opts = Array.from(dropdown.querySelectorAll<HTMLElement>('.abyss-tag-dropdown-opt'));
    if (opts.length === 0) return;
    const activeIdx = opts.findIndex((option) => option.getAttribute('aria-selected') === 'true');
    const nextIdx = Math.max(0, Math.min(opts.length - 1, activeIdx + delta));
    activeTag = opts[nextIdx]?.textContent ?? undefined;
    renderOptions(input.value);
    dropdown
      .querySelector<HTMLElement>('.abyss-tag-dropdown-opt.is-active')
      ?.scrollIntoView?.({ block: 'nearest' });
  };

  input.addEventListener('input', () => renderOptions(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateActive(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateActive(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeTag ?? input.value);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  renderOptions('');
  input.focus();
  return wrap;
}
