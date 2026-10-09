import { beforeEach, vi } from 'vitest';

/** Normal visible Table geometry; individual tests retain their own zero-size/adoption overrides. */
export function useProjectTableViewport(): void {
  beforeEach(() => {
    for (const [property, size] of [
      ['clientHeight', 340],
      ['clientWidth', 900],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, property);
      vi.spyOn(Element.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('abyss-project-table-scroll'))
          return this.isConnected && this.closest('[hidden]') === null ? size : 0;
        return Number(original?.get?.call(this) ?? 0);
      });
    }
  });
}
