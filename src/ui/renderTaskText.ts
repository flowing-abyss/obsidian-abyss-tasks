import { Component, Keymap, MarkdownRenderer, Menu, type App, type MenuItem } from 'obsidian';
import {
  inlineTaskTitleMarkdown,
  pairAnchorsToTokens,
  parseLinks,
  type LinkToken,
} from '../markdown/links';
import { projectSearchText } from '../markdown/searchText';
import { renderedAnchorSources } from './markSearchText';
import { showMenuAtMouseEventWithFocus } from './nativeMenuFocus';
import { runAsyncAction } from './runAsyncAction';
import type { TaskRenderOutcome, TaskTextRender } from './taskRenderScope';

const activeRenders = new WeakMap<HTMLElement, TaskTextRender>();

export interface RenderTaskTextOptions {
  readonly presentation?: 'title' | 'markdown';
  readonly signal?: AbortSignal;
  readonly onRendered?: (element: HTMLElement) => void;
  app: App;
  sourcePath: string;
  component: Component;
  interactiveLinks?: boolean;
  onEditLink?: ((occurrenceIndex: number, token: LinkToken) => void) | undefined;
  beforeOpenLink?: (() => Promise<boolean>) | undefined;
  exactLinkLabel?: string | undefined;
}

export function renderTaskText(
  el: HTMLElement,
  markdownText: string,
  opts: RenderTaskTextOptions,
): TaskTextRender {
  activeRenders.get(el)?.cancel();
  el.empty();
  // Editable occurrences always come from the authored source, even when labels change length.
  const tokens = parseLinks(markdownText);
  const titleMode = opts.presentation === 'title';
  const presented = titleMode ? inlineTaskTitleMarkdown(markdownText) : markdownText;
  // Explicit text presentations keep plain text synchronous; formatting, escapes and paragraph
  // structure use the host even without links. Unspecified callers retain link-driven dispatch.
  if (
    opts.presentation !== undefined
      ? !needsMarkdown(markdownText, opts.presentation)
      : tokens.length === 0
  ) {
    el.setText(presented);
    if (opts.signal?.aborted === true)
      return { settled: Promise.resolve({ type: 'cancelled' }), cancel: () => {} };
    try {
      opts.onRendered?.(el);
      return { settled: Promise.resolve({ type: 'ready' }), cancel: () => {} };
    } catch (error) {
      return { settled: Promise.resolve({ type: 'failed', error }), cancel: () => {} };
    }
  }
  return renderMarkdownText(el, presented, tokens, opts);
}
function needsMarkdown(text: string, presentation: 'title' | 'markdown'): boolean {
  return (
    /[\\*_~`[\]<>&!\r\n]/u.test(text) ||
    (presentation === 'markdown' && /^\s*(?:#{1,6}\s|[-+]\s|\d+[.)]\s)/u.test(text))
  );
}
function renderMarkdownText(
  el: HTMLElement,
  presented: string,
  tokens: LinkToken[],
  opts: RenderTaskTextOptions,
): TaskTextRender {
  const holder = el.createSpan({ cls: 'abyss-md' });
  let resolve!: (outcome: TaskRenderOutcome) => void;
  let done = false;
  const settled = new Promise<TaskRenderOutcome>((r) => {
    resolve = r;
  });
  const wiring = opts.component.addChild(new Component());
  const ownerWindow = holder.ownerDocument.defaultView;
  const observer =
    ownerWindow === null
      ? undefined
      : new ownerWindow.MutationObserver(() => {
          if (!el.contains(holder) || !holder.isConnected) cancel();
        });
  const complete = (outcome: TaskRenderOutcome): void => {
    if (done) return;
    done = true;
    observer?.disconnect();
    opts.signal?.removeEventListener('abort', cancel);
    if (activeRenders.get(el) === receipt) activeRenders.delete(el);
    resolve(outcome);
    opts.component.removeChild(wiring);
  };
  const cancel = (): void => {
    complete({ type: 'cancelled' });
  };
  const receipt: TaskTextRender = { settled, cancel };
  activeRenders.set(el, receipt);
  wiring.register(cancel);
  opts.signal?.addEventListener('abort', cancel, { once: true });
  observer?.observe(holder.ownerDocument, { subtree: true, childList: true });
  if (opts.signal?.aborted === true) {
    cancel();
    return receipt;
  }
  // This Promise is the host renderer's actual completion, never a timer approximation.
  const work = (async () => {
    await MarkdownRenderer.render(opts.app, presented, holder, opts.sourcePath, opts.component);
    if (activeRenders.get(el) !== receipt) return;
    if (!holder.isConnected || !el.contains(holder)) {
      cancel();
      return;
    }
    const p = holder.querySelector(':scope > p');
    if (p !== null && holder.childElementCount === 1) {
      while (p.firstChild !== null) holder.appendChild(p.firstChild);
      p.remove();
    }
    wireLinks(holder, tokens, opts, presented);
    opts.onRendered?.(holder);
    complete({ type: 'ready' });
  })();
  runAsyncAction(
    work.catch((error: unknown) => {
      if (!done) complete({ type: 'failed', error });
      throw error;
    }),
    'Could not render task text',
  );
  return receipt;
}

function wireLinks(
  holder: HTMLElement,
  tokens: LinkToken[],
  opts: RenderTaskTextOptions,
  presented: string,
): void {
  const anchors = Array.from(holder.querySelectorAll('a'));
  // Prove identity before an explicitly supplied display label can replace rendered text.
  const occurrences =
    opts.onEditLink === undefined ? [] : editableOccurrences(holder, anchors, tokens, presented);
  if (opts.exactLinkLabel !== undefined && anchors.length === 1) {
    anchors[0]?.setText(opts.exactLinkLabel);
  }
  if (opts.interactiveLinks === false) return;
  // Link click navigates; never bubble to the card/row handler. Obsidian's global
  // internal-link handler is bypassed by stopPropagation, so open the note ourselves.
  anchors.forEach((a) => {
    a.addEventListener('click', (e) => {
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
    a.addEventListener('mouseover', (e) => {
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
  anchors.forEach((a, i) => {
    const occurrenceIndex = occurrences[i];
    if (occurrenceIndex === undefined || occurrenceIndex < 0) return;
    const token = tokens[occurrenceIndex];
    if (token === undefined) return;
    a.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem(buildEditLinkItem(occurrenceIndex, token, opts));
      showMenuAtMouseEventWithFocus(menu, e);
    });
  });
}

function editableOccurrences(
  holder: HTMLElement,
  anchors: HTMLAnchorElement[],
  tokens: LinkToken[],
  presented: string,
): number[] {
  // Title embed labels can change source offsets, but cannot create new editable occurrences.
  const presentedTokens = parseLinks(presented);
  if (
    presentedTokens.length !== tokens.length ||
    presentedTokens.some((token, index) => token.raw !== tokens[index]?.raw)
  )
    return [];
  const descriptors = anchors.map((anchor) => ({
    text: anchor.textContent,
    href: anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '',
  }));
  const candidates = pairAnchorsToTokens(descriptors, tokens);
  const labels = new Map<number, string>();
  for (const [index, occurrence] of candidates.entries()) {
    const token = presentedTokens[occurrence],
      anchor = anchors[index];
    if (token !== undefined && anchor !== undefined) labels.set(token.index, anchor.textContent);
  }
  const sources = renderedAnchorSources(holder, projectSearchText(presented, 'prose', labels));
  return candidates.map((occurrence, index) => {
    const token = presentedTokens[occurrence],
      anchor = anchors[index];
    const ranges = anchor === undefined ? undefined : sources.get(anchor);
    return token !== undefined &&
      ranges !== undefined &&
      ranges.length > 0 &&
      ranges.every(
        (range) => range.from >= token.index && range.to <= token.index + token.raw.length,
      )
      ? occurrence
      : -1;
  });
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
