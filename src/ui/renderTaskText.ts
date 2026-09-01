import { Component, Keymap, MarkdownRenderer, Menu, MenuItem, type App } from 'obsidian';
import { pairAnchorsToTokens, parseLinks, type LinkToken } from '../parser/links';
import { showMenuAtMouseEventWithFocus } from './nativeMenuFocus';

export interface RenderTaskTextOptions {
  app: App;
  sourcePath: string;
  component: Component;
  onEditLink?: (occurrenceIndex: number, token: LinkToken) => void;
}

export function renderTaskText(
  el: HTMLElement,
  markdownText: string,
  opts: RenderTaskTextOptions,
): void {
  el.empty();
  // Fast path: the vast majority of tasks have no links. Skip the whole Obsidian
  // MarkdownRenderer pipeline (+ its deferred wiring) and just set text — this keeps
  // large lists at roughly the old `textContent` cost so they don't jank.
  const tokens = parseLinks(markdownText);
  if (tokens.length === 0) {
    el.setText(markdownText);
    return;
  }
  const holder = el.createSpan({ cls: 'abyss-md' });
  void MarkdownRenderer.render(opts.app, markdownText, holder, opts.sourcePath, opts.component);
  // Unwrap the single wrapping <p> MarkdownRenderer emits so titles stay inline.
  window.setTimeout(() => {
    // The list may have re-rendered (filter keystroke, store update) and detached this
    // node before the macrotask ran — skip the wasted work in that case.
    if (!holder.isConnected) return;
    const p = holder.querySelector(':scope > p');
    if (p && holder.childElementCount === 1) {
      while (p.firstChild) holder.appendChild(p.firstChild);
      p.remove();
    }
    wireLinks(holder, tokens, opts);
  }, 0);
}

function wireLinks(holder: HTMLElement, tokens: LinkToken[], opts: RenderTaskTextOptions): void {
  const anchors = Array.from(holder.querySelectorAll('a'));
  // Link click navigates; never bubble to the card/row handler. Obsidian's global
  // internal-link handler is bypassed by stopPropagation, so open the note ourselves.
  anchors.forEach((a) => {
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!a.hasClass('internal-link')) return; // external links keep their default nav
      e.preventDefault();
      const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
      if (href) void opts.app.workspace.openLinkText(href, opts.sourcePath, Keymap.isModEvent(e));
    });
    // Arm Obsidian's page-preview (hover) popover for internal links.
    a.addEventListener('mouseover', (e) => {
      if (!a.hasClass('internal-link')) return;
      const href = a.getAttribute('data-href') ?? '';
      if (href) {
        opts.app.workspace.trigger('hover-link', {
          event: e,
          source: 'abyss-tasks',
          hoverParent: holder,
          targetEl: a,
          linktext: href,
          sourcePath: opts.sourcePath,
        });
      }
    });
  });
  if (!opts.onEditLink) return;
  const descriptors = anchors.map((a) => ({
    text: a.textContent ?? '',
    href: a.getAttribute('data-href') ?? a.getAttribute('href') ?? '',
  }));
  const occurrences = pairAnchorsToTokens(descriptors, tokens);
  anchors.forEach((a, i) => {
    const occurrenceIndex = occurrences[i]!;
    if (occurrenceIndex < 0) return;
    const token = tokens[occurrenceIndex]!;
    a.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem(buildEditLinkItem(occurrenceIndex, token, opts));
      showMenuAtMouseEventWithFocus(menu, e);
    });
  });
}

function buildEditLinkItem(
  occurrenceIndex: number,
  token: LinkToken,
  opts: RenderTaskTextOptions,
): (item: MenuItem) => void {
  return (item: MenuItem) =>
    item
      .setTitle('Edit link…')
      .setIcon('pencil')
      .onClick(() => opts.onEditLink!(occurrenceIndex, token));
}
