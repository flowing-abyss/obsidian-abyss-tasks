import { Component } from 'obsidian';
import { projectSearchText } from '../markdown/searchText';
import {
  sameTaskNodeRef,
  type PreparedSearchQuery,
  type SearchWordSegmenter,
  type TaskTextTarget,
} from '../tasks';
import { markSearchText } from './markSearchText';
import {
  renderTaskText,
  taskTextNeedsMarkdown,
  type RenderTaskTextOptions,
} from './renderTaskText';
import { compactTaskDescriptionExcerpt } from './taskDescriptionExcerpt';
import type { TaskRenderOutcome } from './taskRenderScope';

export interface RetainedTaskTextInput {
  readonly source: {
    readonly target: TaskTextTarget;
    readonly markdown: string;
    readonly path: string;
    readonly presentation: 'title' | 'markdown' | 'description';
  };
  readonly decoration: {
    readonly kind: 'complete' | 'preview' | 'excerpt';
    readonly continuation?: boolean;
    readonly query?: PreparedSearchQuery;
    readonly segment?: SearchWordSegmenter;
    readonly destinations?: string;
    readonly anchors?: (element: HTMLElement) => readonly HTMLAnchorElement[];
  };
  readonly callbacks: Pick<
    RenderTaskTextOptions,
    'app' | 'isCurrent' | 'onRenderFailure' | 'onEditLink' | 'beforeOpenLink'
  >;
}
export interface PreparedTaskTextUpdate {
  readonly ready: Promise<TaskRenderOutcome>;
  canCommit(): boolean;
  commit(): boolean;
  cancel(): void;
}
function samePreparedTaskQuery(
  a: PreparedSearchQuery | undefined,
  b: PreparedSearchQuery | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      a.tokens.length === b?.tokens.length &&
      a.tokens.every((token, i) => {
        const other = b.tokens[i];
        return (
          token.term === other?.term &&
          token.prefix === other.prefix &&
          token.edits === other.edits &&
          token.swaps.length === other.swaps.length &&
          token.swaps.every((swap, j) => swap === other.swaps[j])
        );
      }))
  );
}
function sameTarget(a: TaskTextTarget, b: TaskTextTarget): boolean {
  if (a.type === 'comment' && b.type === 'comment')
    return (
      a.ref.relativeLine === b.ref.relativeLine &&
      a.ref.originalMarkdown === b.ref.originalMarkdown &&
      sameTaskNodeRef(a.ref.parent, b.ref.parent)
    );
  return (
    a.type !== 'comment' &&
    b.type !== 'comment' &&
    a.type === b.type &&
    sameTaskNodeRef(a.target, b.target)
  );
}
function sameSource(
  a: RetainedTaskTextInput['source'],
  b: RetainedTaskTextInput['source'],
): boolean {
  return (
    a.markdown === b.markdown &&
    a.path === b.path &&
    a.presentation === b.presentation &&
    sameTarget(a.target, b.target)
  );
}
function sameDecoration(
  a: RetainedTaskTextInput['decoration'],
  b: RetainedTaskTextInput['decoration'],
): boolean {
  return (
    a.kind === b.kind &&
    a.continuation === b.continuation &&
    a.segment === b.segment &&
    a.destinations === b.destinations &&
    samePreparedTaskQuery(a.query, b.query)
  );
}
interface VisibleField {
  input: RetainedTaskTextInput;
  readonly owner: Component;
  readonly document: Document;
  readonly projection: ReturnType<typeof projectSearchText>;
}
function decorate(element: HTMLElement, field: VisibleField, input: RetainedTaskTextInput): void {
  const { query, segment, kind, continuation } = input.decoration;
  if (query !== undefined && segment !== undefined) {
    markSearchText(element, field.projection, query, segment);
    if (kind === 'excerpt')
      compactTaskDescriptionExcerpt(
        element,
        query,
        segment,
        input.decoration.anchors?.(element) ?? [],
      );
  } else
    for (const mark of element.querySelectorAll('mark.abyss-search-match'))
      mark.replaceWith(...mark.childNodes);
  if (continuation === true) {
    const blocks = element.querySelectorAll(
      'address, article, aside, blockquote, dd, details, dialog, div, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, legend, li, main, nav, p, pre, section, summary, td, th',
    );
    (blocks[blocks.length - 1] ?? element).append(' …');
  }
}
function inPlace(
  old: VisibleField | undefined,
  input: RetainedTaskTextInput,
  document: Document,
): old is VisibleField {
  if (old?.document !== document || !sameSource(old.input.source, input.source)) return false;
  return (
    sameDecoration(old.input.decoration, input.decoration) ||
    (old.input.decoration.kind === 'complete' && input.decoration.kind === 'complete')
  );
}
class PreparedField implements PreparedTaskTextUpdate {
  readonly ready: Promise<TaskRenderOutcome>;
  #resolve!: (outcome: TaskRenderOutcome) => void;
  #outcome: TaskRenderOutcome | undefined;
  #cancelled = false;
  #committed = false;
  #render: ReturnType<typeof renderTaskText> | undefined;
  readonly #staging: HTMLElement | undefined;
  readonly #direct: boolean;
  readonly #input: RetainedTaskTextInput;
  readonly #field: VisibleField;
  readonly #host: HTMLElement;
  readonly #publish: (field: VisibleField) => void;
  readonly #release: (field: VisibleField) => void;
  constructor(
    host: HTMLElement,
    input: RetainedTaskTextInput,
    field: VisibleField,
    options: {
      replace: boolean;
      direct: boolean;
      stagingHost: HTMLElement;
      publish: (field: VisibleField) => void;
      release: (field: VisibleField) => void;
    },
  ) {
    this.#host = host;
    this.#direct = options.direct;
    this.#input = input;
    this.#field = field;
    this.#publish = options.publish;
    this.#release = options.release;
    this.ready = new Promise((resolve) => {
      this.#resolve = resolve;
    });
    if (!options.replace) {
      this.#finish({ type: 'ready' });
      return;
    }
    if (this.#direct) {
      this.#renderReplacement(host);
      return;
    }
    this.#staging = host.createDiv();
    this.#staging.hidden = true;
    this.#staging.inert = true;
    this.#staging.setAttribute('aria-hidden', 'true');
    options.stagingHost.append(this.#staging);
    const staging = this.#staging;
    field.owner.register(() => {
      staging.remove();
    });
    this.#renderReplacement(staging);
  }
  #finish(outcome: TaskRenderOutcome): void {
    if (this.#outcome !== undefined) return;
    this.#outcome = outcome;
    this.#resolve(outcome);
  }
  #renderReplacement(staging: HTMLElement): void {
    const input = this.#input;
    try {
      this.#render = renderTaskText(staging, input.source.markdown, {
        ...input.callbacks,
        presentation: input.source.presentation,
        sourcePath: input.source.path,
        component: this.#field.owner,
        linkEventOwner: this.#field.owner,
        isCurrent: () => !this.#cancelled && this.#field.input.callbacks.isCurrent?.() !== false,
        beforeOpenLink: () =>
          this.#field.input.callbacks.beforeOpenLink?.() ?? Promise.resolve(true),
        onRendered: (element) => {
          decorate(element, this.#field, input);
          this.#finish({ type: 'ready' });
        },
      });
      void this.#render.settled.then(
        (outcome) => {
          this.#finish(outcome);
        },
        (error) => {
          this.#failed(error);
        },
      );
    } catch (error) {
      this.#failed(error);
    }
  }
  #failed(error: unknown): void {
    this.#finish({ type: 'failed', error });
    this.#input.callbacks.onRenderFailure?.(error);
  }
  canCommit(): boolean {
    if (this.#host.ownerDocument !== this.#field.document) return false;
    if (
      this.#cancelled ||
      this.#outcome?.type !== 'ready' ||
      this.#input.callbacks.isCurrent?.() === false
    )
      return false;
    return (
      this.#committed ||
      this.#staging === undefined ||
      !this.#host.contains(this.#host.ownerDocument.activeElement)
    );
  }
  commit(): boolean {
    if (!this.canCommit()) return false;
    if (this.#committed) return true;
    this.#apply();
    this.#committed = true;
    return true;
  }
  #apply(): void {
    if (this.#staging === undefined) {
      if (!sameDecoration(this.#field.input.decoration, this.#input.decoration))
        decorate(this.#host, this.#field, this.#input);
    } else {
      this.#host.replaceChildren(...this.#staging.childNodes);
      this.#staging.remove();
    }
    this.#field.input = this.#input;
    this.#publish(this.#field);
  }
  cancel(): void {
    if (this.#committed || this.#cancelled) return;
    this.#cancelled = true;
    this.#render?.cancel();
    this.#staging?.remove();
    if (this.#direct) this.#host.empty();
    if (this.#direct || this.#staging !== undefined) this.#release(this.#field);
    this.#finish({ type: 'cancelled' });
  }
}
/** One visible source binding and at most one connected replacement. */
export class RetainedTaskText {
  readonly #host: HTMLElement;
  readonly #parent: Component;
  readonly #stagingHost: HTMLElement;
  #visible: VisibleField | undefined;
  #pending: PreparedTaskTextUpdate | undefined;
  #live = true;
  constructor(
    host: HTMLElement,
    parent: Component,
    stagingHost = host.closest<HTMLElement>('.abyss-panel-view') ?? host.ownerDocument.body,
  ) {
    this.#host = host;
    this.#parent = parent;
    this.#stagingHost = stagingHost;
  }
  prepare(input: RetainedTaskTextInput): PreparedTaskTextUpdate {
    this.#pending?.cancel();
    if (!this.#live)
      return {
        ready: Promise.resolve({ type: 'cancelled' }),
        canCommit: () => false,
        commit: () => false,
        cancel: () => {},
      };
    const old = this.#visible;
    const reuse = inPlace(old, input, this.#host.ownerDocument);
    const field = reuse ? old : this.#create(input);
    if (reuse) field.input = { ...field.input, callbacks: input.callbacks };
    const update = new PreparedField(this.#host, input, field, {
      replace: !reuse,
      // Plain first fields settle synchronously without a replacement to preserve.
      // Markdown stays staged until its renderer and link wiring have finished.
      direct:
        old === undefined &&
        !this.#host.hasChildNodes() &&
        !taskTextNeedsMarkdown(input.source.markdown, input.source.presentation),
      stagingHost:
        this.#stagingHost.ownerDocument === this.#host.ownerDocument
          ? this.#stagingHost
          : this.#host.ownerDocument.body,
      publish: (next) => {
        this.#visible = next;
        if (old !== undefined && old !== next) this.#parent.removeChild(old.owner);
      },
      release: (next) => {
        this.#parent.removeChild(next.owner);
      },
    });
    this.#pending = update;
    return update;
  }
  #create(input: RetainedTaskTextInput): VisibleField {
    return {
      input,
      owner: this.#parent.addChild(new Component()),
      document: this.#host.ownerDocument,
      projection: projectSearchText(
        input.source.markdown,
        input.source.presentation === 'markdown' ? 'prose' : input.source.presentation,
      ),
    };
  }
  destroy(): void {
    this.#live = false;
    this.#pending?.cancel();
    if (this.#visible !== undefined) this.#parent.removeChild(this.#visible.owner);
    this.#visible = undefined;
  }
}
