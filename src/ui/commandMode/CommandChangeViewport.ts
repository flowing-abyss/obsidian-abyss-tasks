import { prefersReducedMotion } from '../reducedMotion';

const differences = '[data-change="added"], [data-change="changed"], [data-change="removed"]';

/** Reveal changed content inside Q without moving the workspace or taking keyboard focus. */
export class CommandChangeViewport {
  private session = '';
  private previous = new Map<HTMLElement, string>();
  constructor(private readonly host: HTMLElement) {}
  update(session: string): void {
    if (session !== this.session) this.previous.clear();
    this.session = session;
    const target = this.collect();
    if (target !== undefined) this.reveal(target);
  }
  private collect(): HTMLElement | undefined {
    const next = new Map<HTMLElement, string>();
    let target: HTMLElement | undefined;
    for (const element of this.host.querySelectorAll<HTMLElement>(differences)) {
      // A removed subtree carries the same paint on its descendants; reveal the actual field.
      if (element.querySelector(differences) !== null) continue;
      const signature = `${element.dataset['change']}:${element.textContent}`;
      next.set(element, signature);
      if (this.previous.get(element) !== signature) target = element;
    }
    this.previous = next;
    return target;
  }
  private reveal(target: HTMLElement): void {
    const collapsed = target.closest<HTMLDetailsElement>('details:not([open])');
    const visible = collapsed?.querySelector<HTMLElement>('summary') ?? target;
    const rect = visible.getBoundingClientRect(),
      viewport = this.host.getBoundingClientRect();
    if (rect.bottom <= viewport.bottom && rect.top >= viewport.top) return;
    const delta =
      rect.top < viewport.top || rect.bottom - rect.top > viewport.bottom - viewport.top
        ? rect.top - viewport.top - 8
        : rect.bottom - viewport.bottom + 8;
    const reduced = prefersReducedMotion(this.host.win);
    this.host.scrollTo({
      top: Math.max(0, this.host.scrollTop + delta),
      behavior: reduced ? 'instant' : 'smooth',
    });
  }
}
