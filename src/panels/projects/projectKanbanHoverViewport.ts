import type {
  KanbanInsertion,
  KanbanViewportRow,
  PlannedKanbanInsertion,
} from './projectKanbanRows';
import { ProjectKanbanColumnViewport } from './projectKanbanViewport';

/** Title-only forecast, sharing the column's native window and disposal semantics. */
export class ProjectKanbanHoverViewport {
  readonly #viewport: ProjectKanbanColumnViewport;
  constructor(
    host: HTMLElement,
    rows: readonly KanbanViewportRow[],
    render: (host: HTMLElement, row: KanbanViewportRow) => HTMLElement,
    reportFailure: (error: unknown) => void,
  ) {
    this.#viewport = new ProjectKanbanColumnViewport({
      host,
      scroll: host,
      reportFailure,
      mountedChanged() {},
      mount(parent, row) {
        const element = render(parent, row);
        return {
          element,
          update(next) {
            const staging = parent.cloneNode(false) as HTMLElement;
            const replacement = render(staging, next);
            for (const attribute of Array.from(element.attributes))
              element.removeAttribute(attribute.name);
            for (const attribute of Array.from(replacement.attributes))
              element.setAttribute(attribute.name, attribute.value);
            element.replaceChildren(...replacement.childNodes);
          },
          destroy() {
            element.remove();
          },
        };
      },
    });
    this.update(rows);
  }
  update(rows: readonly KanbanViewportRow[]): void {
    this.#viewport.update(rows, true);
  }
  hitTest(contentY: number, sourcePath: string): KanbanInsertion | undefined {
    return this.#viewport.insertion(contentY, sourcePath);
  }
  insertionTop(insertion: PlannedKanbanInsertion, proposedPath: string): number | undefined {
    return this.#viewport.insertionTop(insertion, proposedPath);
  }
  destroy(): void {
    this.#viewport.destroy();
  }
}
