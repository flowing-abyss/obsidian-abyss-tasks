import type { StatisticsChartModel } from '../../statistics';
import type { StatisticsChartHandle, StatisticsChartRenderer } from './StatisticsChart';

interface MountedChart {
  readonly element: HTMLElement;
  readonly handle: StatisticsChartHandle;
}
/** Owns one selected section. Suspending releases all native observers and retains only models. */
export class StatisticsCharts {
  private models: readonly StatisticsChartModel[] = [];
  private readonly mounted = new Map<string, MountedChart>();
  private document: Document;
  private suspended = false;
  private destroyed = false;
  constructor(
    private host: HTMLElement,
    private readonly renderer: StatisticsChartRenderer,
    private readonly onSelect: (selectionId: string) => void,
  ) {
    this.document = host.ownerDocument;
  }
  update(models: readonly StatisticsChartModel[]): void {
    if (this.destroyed) return;
    this.models = models;
    if (this.suspended) return;
    if (this.document !== this.host.ownerDocument) {
      this.release();
      this.document = this.host.ownerDocument;
    }
    const retained = new Set<string>();
    this.host.classList.add('abyss-statistics-charts');
    for (const model of models) {
      if (model.marks.length === 0) continue;
      if (retained.has(model.id))
        throw new Error(`Duplicate Statistics chart identity: ${model.id}`);
      retained.add(model.id);
      this.reconcile(model);
    }
    this.removeUnused(retained);
  }
  private removeUnused(retained: ReadonlySet<string>): void {
    for (const [id, chart] of this.mounted)
      if (!retained.has(id)) {
        chart.handle.destroy();
        chart.element.remove();
        this.mounted.delete(id);
      }
  }
  private reconcile(model: StatisticsChartModel): void {
    const existing = this.mounted.get(model.id);
    if (existing !== undefined) {
      existing.handle.update(model);
      this.caption(existing.element, model);
      this.host.append(existing.element);
      return;
    }
    const element = this.host.createEl('figure');
    element.className = 'abyss-statistics-chart';
    const surface = element.createDiv();
    surface.className = 'abyss-statistics-chart-surface';
    element.append(surface);
    this.caption(element, model);
    this.host.append(element);
    try {
      this.mounted.set(model.id, {
        element,
        handle: this.renderer.mount(surface, model, this.onSelect),
      });
    } catch (error) {
      element.remove();
      throw error;
    }
  }
  private caption(element: HTMLElement, model: StatisticsChartModel): void {
    element.classList.toggle('abyss-statistics-chart--facet', model.facet !== undefined);
    const existing = element.querySelector('figcaption');
    if (model.facet === undefined) {
      existing?.remove();
      return;
    }
    const caption = existing ?? element.createEl('figcaption');
    caption.className = 'abyss-statistics-chart-caption';
    caption.textContent = model.facet.label;
    element.prepend(caption);
  }
  private release(): void {
    for (const chart of this.mounted.values()) {
      chart.handle.destroy();
      chart.element.remove();
    }
    this.mounted.clear();
  }
  suspend(): void {
    if (this.destroyed) return;
    this.suspended = true;
    this.release();
  }
  resume(host = this.host): void {
    if (this.destroyed) return;
    if (host !== this.host || host.ownerDocument !== this.document) {
      this.release();
      this.host = host;
      this.document = host.ownerDocument;
    }
    this.suspended = false;
    this.update(this.models);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.release();
    this.models = [];
  }
}
