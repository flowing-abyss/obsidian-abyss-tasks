import type { StatisticsChartModel } from '../../statistics';
import type { StatisticsChartHandle, StatisticsChartRenderer } from './StatisticsChart';

interface MountedChart {
  readonly element: HTMLElement;
  readonly handle: StatisticsChartHandle;
}
/** Owns one selected section. Suspending releases all native observers and retains only models. */
export class StatisticsCharts {
  private models_abyssPrivate: readonly StatisticsChartModel[] = [];
  private readonly mounted_abyssPrivate = new Map<string, MountedChart>();
  private document_abyssPrivate: Document;
  private suspended_abyssPrivate = false;
  private destroyed_abyssPrivate = false;
  constructor(
    private host: HTMLElement,
    private readonly renderer: StatisticsChartRenderer,
    private readonly onSelect: (selectionId: string) => void,
  ) {
    this.document_abyssPrivate = host.ownerDocument;
  }
  update(models: readonly StatisticsChartModel[]): void {
    if (this.destroyed_abyssPrivate) return;
    this.models_abyssPrivate = models;
    if (this.suspended_abyssPrivate) return;
    if (this.document_abyssPrivate !== this.host.ownerDocument) {
      this.release_abyssPrivate();
      this.document_abyssPrivate = this.host.ownerDocument;
    }
    const retained = new Set<string>();
    this.host.classList.add('abyss-statistics-charts');
    for (const model of models) {
      if (model.marks.length === 0) continue;
      if (retained.has(model.id))
        throw new Error(`Duplicate Statistics chart identity: ${model.id}`);
      retained.add(model.id);
      this.reconcile_abyssPrivate(model);
    }
    this.removeUnused_abyssPrivate(retained);
  }
  private removeUnused_abyssPrivate(retained: ReadonlySet<string>): void {
    for (const [id, chart] of this.mounted_abyssPrivate)
      if (!retained.has(id)) {
        chart.handle.destroy();
        chart.element.remove();
        this.mounted_abyssPrivate.delete(id);
      }
  }
  private reconcile_abyssPrivate(model: StatisticsChartModel): void {
    const existing = this.mounted_abyssPrivate.get(model.id);
    if (existing !== undefined) {
      existing.handle.update(model);
      this.caption_abyssPrivate(existing.element, model);
      this.host.append(existing.element);
      return;
    }
    const element = this.host.createEl('figure');
    element.className = 'abyss-statistics-chart';
    const surface = element.createDiv();
    surface.className = 'abyss-statistics-chart-surface';
    element.append(surface);
    this.caption_abyssPrivate(element, model);
    this.host.append(element);
    try {
      this.mounted_abyssPrivate.set(model.id, {
        element,
        handle: this.renderer.mount(surface, model, (id) => {
          if (
            !this.destroyed_abyssPrivate &&
            !this.suspended_abyssPrivate &&
            surface.isConnected &&
            surface.closest('[inert]') === null
          )
            this.onSelect(id);
        }),
      });
    } catch (error) {
      element.remove();
      throw error;
    }
  }
  private caption_abyssPrivate(element: HTMLElement, model: StatisticsChartModel): void {
    element.classList.toggle('abyss-statistics-chart--facet', model.facet !== undefined);
    const existing = element.querySelector('figcaption');
    if (model.facet === undefined) {
      existing?.remove();
      return;
    }
    const caption = existing ?? element.createEl('figcaption');
    caption.className = 'abyss-statistics-chart-caption';
    caption.replaceChildren();
    const id = model.facet.actionId;
    if (id === undefined) caption.textContent = model.facet.label;
    else {
      const button = caption.createEl('button', {
        text: model.facet.label,
        attr: { type: 'button' },
      });
      button.addEventListener('click', () => {
        this.onSelect(id);
      });
    }
    element.prepend(caption);
  }
  private release_abyssPrivate(): void {
    for (const chart of this.mounted_abyssPrivate.values()) {
      chart.handle.destroy();
      chart.element.remove();
    }
    this.mounted_abyssPrivate.clear();
  }
  suspend(): void {
    if (this.destroyed_abyssPrivate) return;
    this.suspended_abyssPrivate = true;
    this.release_abyssPrivate();
  }
  resume(host = this.host): void {
    if (this.destroyed_abyssPrivate) return;
    if (host !== this.host || host.ownerDocument !== this.document_abyssPrivate) {
      this.release_abyssPrivate();
      this.host = host;
      this.document_abyssPrivate = host.ownerDocument;
    }
    this.suspended_abyssPrivate = false;
    this.update(this.models_abyssPrivate);
  }
  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.release_abyssPrivate();
    this.models_abyssPrivate = [];
  }
}
