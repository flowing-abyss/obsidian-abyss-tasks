import { Component, Keymap, MarkdownRenderer, Menu, type App, type MenuItem } from 'obsidian';
import {
  inlineTaskTitleMarkdown,
  pairAnchorsToTokens,
  parseLinks,
  type LinkToken,
} from '../markdown/links';
import { showMenuAtMouseEventWithFocus } from './nativeMenuFocus';
import { runAsyncAction } from './runAsyncAction';

export interface RenderTaskTextOptions {
  readonly presentation?: 'title';
  readonly isCurrent?: () => boolean;
  readonly onRenderFailure?: (error: unknown) => void;
  app: App;
  sourcePath: string;
  component: Component;
  /** Finite content-generation owner, removed from its parent when this text retires. */
  readonly linkEventOwner?: Component;
  interactiveLinks?: boolean;
  onEditLink?: ((occurrenceIndex: number, token: LinkToken) => void) | undefined;
  beforeOpenLink?: (() => Promise<boolean>) | undefined;
  exactLinkLabel?: string | undefined;
}

export function renderTaskText(
  el: HTMLElement,
  markdownText: string,
  opts: RenderTaskTextOptions,
): void {
  el.empty();
  // Editable occurrences always come from the authored source, even when labels change length.
  const tokens = parseLinks(markdownText);
  const titleMode = opts.presentation === 'title';
  const presented = titleMode ? inlineTaskTitleMarkdown(markdownText) : markdownText;
  // Plain titles retain the synchronous path; formatting and escapes need host Markdown even
  // without links. Non-title callers keep their existing link-driven dispatch contract.
  if (titleMode ? !/[\\*_~`[\]<>&!]/u.test(markdownText) : tokens.length === 0) {
    el.setText(presented);
    return;
  }
  const holder = el.createSpan({ cls: 'abyss-md' });
  const rendering = MarkdownRenderer.render(
    opts.app,
    presented,
    holder,
    opts.sourcePath,
    opts.component,
  );
  if (opts.onRenderFailure === undefined)
    runAsyncAction(
      opts.isCurrent === undefined
        ? rendering
        : rendering.catch((error: unknown) => {
            if (opts.isCurrent?.() !== false) throw error;
          }),
      'Could not render task text',
    );
  else
    void rendering.catch((error: unknown) => {
      if (opts.isCurrent?.() !== false) opts.onRenderFailure?.(error);
    });
  // Unwrap the single wrapping <p> MarkdownRenderer emits so titles stay inline.
  const ownerWindow = holder.ownerDocument.defaultView;
  if (ownerWindow === null) return;
  const wiring = opts.component.addChild(new Component());
  const timer = ownerWindow.setTimeout(() => {
    opts.component.removeChild(wiring);
    // The list may have re-rendered (filter keystroke, store update) and detached this
    // node before the macrotask ran — skip the wasted work in that case.
    if (!holder.isConnected || opts.isCurrent?.() === false) return;
    try {
      finishRender(holder, tokens, opts);
    } catch (error) {
      if (opts.onRenderFailure !== undefined) opts.onRenderFailure(error);
      else
        runAsyncAction(
          Promise.reject(error instanceof Error ? error : new Error(String(error))),
          'Could not render task text',
        );
    }
  }, 0);
  wiring.register(() => {
    ownerWindow.clearTimeout(timer);
  });
}

function finishRender(holder: HTMLElement, tokens: LinkToken[], opts: RenderTaskTextOptions): void {
  const p = holder.querySelector(':scope > p');
  if (p != null && holder.childElementCount === 1) {
    while (p.firstChild != null) holder.appendChild(p.firstChild);
    p.remove();
  }
  wireLinks(holder, tokens, opts);
}

function wireLinks(holder: HTMLElement, tokens: LinkToken[], opts: RenderTaskTextOptions): void {
  const anchors = Array.from(holder.querySelectorAll('a'));
  if (opts.exactLinkLabel !== undefined && anchors.length === 1) {
    anchors[0]?.setText(opts.exactLinkLabel);
  }
  if (opts.interactiveLinks === false) return;
  // Link click navigates; never bubble to the card/row handler. Obsidian's global
  // internal-link handler is bypassed by stopPropagation, so open the note ourselves.
  anchors.forEach((a) => {
    registerLinkEvent(opts, a, 'click', (e) => {
      e.stopPropagation();
      if (!a.hasClass('internal-link')) return; // external links keep their default nav
      e.preventDefault();
      const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
      if (href.length > 0) {
        const newLeaf = Keymap.isModEvent(e);
        runAsyncAction(
          (async () => {
            if ((await opts.beforeOpenLink?.()) === false) return;
            await opts.app.workspace.openLinkText(href, opts.sourcePath, newLeaf);
          })(),
          'Could not open task link',
        );
      }
    });
    // Arm Obsidian's page-preview (hover) popover for internal links.
    registerLinkEvent(opts, a, 'mouseover', (e) => {
      if (!a.hasClass('internal-link')) return;
      const href = a.getAttribute('data-href') ?? '';
      if (href.length > 0) {
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
  if (opts.onEditLink == null) return;
  const descriptors = anchors.map((a) => ({
    text: a.textContent,
    href: a.getAttribute('data-href') ?? a.getAttribute('href') ?? '',
  }));
  const occurrences = pairAnchorsToTokens(descriptors, tokens);
  anchors.forEach((a, i) => {
    const occurrenceIndex = occurrences[i];
    if (occurrenceIndex === undefined || occurrenceIndex < 0) return;
    const token = tokens[occurrenceIndex];
    if (token === undefined) return;
    registerLinkEvent(opts, a, 'contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem(buildEditLinkItem(occurrenceIndex, token, opts));
      showMenuAtMouseEventWithFocus(menu, e);
    });
  });
}

function registerLinkEvent<K extends keyof HTMLElementEventMap>(
  opts: RenderTaskTextOptions,
  anchor: HTMLAnchorElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  if (opts.linkEventOwner === undefined) anchor.addEventListener(type, handler);
  else opts.linkEventOwner.registerDomEvent(anchor, type, handler);
}

function buildEditLinkItem(
  occurrenceIndex: number,
  token: LinkToken,
  opts: RenderTaskTextOptions,
): (item: MenuItem) => void {
  const onEditLink = opts.onEditLink;
  if (onEditLink === undefined) return (): void => {};
  return (item: MenuItem) =>
    item
      .setTitle('Edit link…')
      .setIcon('pencil')
      .onClick(() => {
        onEditLink(occurrenceIndex, token);
      });
}
