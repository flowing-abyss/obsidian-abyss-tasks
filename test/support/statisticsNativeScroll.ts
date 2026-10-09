import { vi } from 'vitest';

/** Exercise native scroll loss that JSDOM's freely writable scrollTop does not model. */
export function resetStatisticsScrollAtCommit(): void {
  const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (scrollDescriptor?.set === undefined) throw new Error('Missing native scrollTop setter');
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    top: number,
  ) {
    scrollDescriptor.set?.call(this, this.closest('.abyss-statistics-staging') === null ? top : 0);
  });
  const append = Object.getOwnPropertyDescriptor(Element.prototype, 'append')
    ?.value as HTMLElement['append'];
  vi.spyOn(HTMLElement.prototype, 'append').mockImplementation(function (
    this: HTMLElement,
    ...nodes: Array<Node | string>
  ) {
    const scrollers = nodes.flatMap((node) =>
      node instanceof HTMLElement &&
      node.parentElement?.classList.contains('abyss-statistics-staging') === true
        ? [...node.querySelectorAll<HTMLElement>('.abyss-statistics-row-viewport')]
        : [],
    );
    append.apply(this, nodes);
    for (const scroller of scrollers) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    }
  });
}
