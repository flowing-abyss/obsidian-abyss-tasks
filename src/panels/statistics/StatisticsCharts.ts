import type { StatisticsChartModel } from '../../statistics';
import type { StatisticsChartHandle, StatisticsChartRenderer } from './StatisticsChart';
import { StatisticsRowChart } from './StatisticsRowChart';

interface MountedChart {
  readonly element: HTMLElement;
  readonly handle: StatisticsChartHandle;
}
/** Owns one selected section. Suspending releases all native observers and retains only models. */
export class StatisticsCharts {
  private readonly rowPositions_abyssPrivate: Map<string, number>;
  private models_abyssPrivate: readonly StatisticsChartModel[] = [];
  private readonly mounted_abyssPrivate = new Map<string, MountedChart>();
  private document_abyssPrivate: Document;
  private suspended_abyssPrivate = false;
  private destroyed_abyssPrivate = false;
  constructor(
    private host: HTMLElement,
    private readonly renderer: StatisticsChartRenderer,
    private readonly onSelect: (selectionId: string) => void,
    private readonly rowOptions_abyssPrivate: {
      positions?: Map<string, number>;
      onFailure?: (error: unknown) => void;
      decorate?: (figure: HTMLElement, chart: StatisticsChartModel) => void;
    } = {},
  ) {
    this.document_abyssPrivate = host.ownerDocument;
    this.rowPositions_abyssPrivate =
      this.rowOptions_abyssPrivate.positions ?? new Map<string, number>();
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
      if (model.marks.length === 0 && model.kind !== 'timeline' && model.emptyMessage === undefined)
        continue;
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
      existing.element.querySelector('.abyss-statistics-intensity')?.remove();
      this.rowOptions_abyssPrivate.decorate?.(existing.element, model);
      if (model.rowViewport !== true || existing.element.parentElement !== this.host)
        this.host.append(existing.element);
      return;
    }
    const element = this.host.createEl('figure');
    element.className = 'abyss-statistics-chart';
    const surface = element.createDiv();
    surface.className = 'abyss-statistics-chart-surface';
    element.append(surface);
    this.caption_abyssPrivate(element, model);
    this.rowOptions_abyssPrivate.decorate?.(element, model);
    this.host.append(element);
    try {
      this.mounted_abyssPrivate.set(model.id, {
        element,
        handle: this.mount_abyssPrivate(surface, model, (id) => {
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
  rememberRowScroll(): void {
    for (const { handle } of this.mounted_abyssPrivate.values())
      if (handle instanceof StatisticsRowChart) handle.rememberScroll();
  }
  restoreRowScroll(): void {
    for (const { handle } of this.mounted_abyssPrivate.values())
      if (handle instanceof StatisticsRowChart) handle.restoreScroll();
  }
  private mount_abyssPrivate(
    surface: HTMLElement,
    model: StatisticsChartModel,
    select: (id: string) => void,
  ): StatisticsChartHandle {
    if (model.rowViewport === true)
      return new StatisticsRowChart(surface, this.renderer, model, {
        onSelect: select,
        positions: this.rowPositions_abyssPrivate,
        onFailure:
          this.rowOptions_abyssPrivate.onFailure ??
          ((error) => {
            throw error;
          }),
      });
    let current: StatisticsChartHandle | undefined;
    const update = (next: StatisticsChartModel): void => {
      if (next.marks.length === 0 && next.emptyMessage !== undefined) {
        current?.destroy();
        current = undefined;
        surface.replaceChildren();
        surface.createEl('p', { cls: 'abyss-statistics-context', text: next.emptyMessage });
      } else if (current === undefined) {
        surface.replaceChildren();
        current = this.renderer.mount(surface, next, select);
      } else current.update(next);
    };
    update(model);
    return {
      update,
      destroy: () => {
        current?.destroy();
        surface.replaceChildren();
      },
    };
  }

  private caption_abyssPrivate(element: HTMLElement, model: StatisticsChartModel): void {
    element.classList.toggle('abyss-statistics-chart--facet', model.layout === 'facets');
    element.querySelector('.abyss-statistics-chart-coverage')?.remove();
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
    if (model.facet.description !== undefined)
      (model.layout === 'facets' ? element : caption).createDiv({
        text: model.facet.description,
        cls: 'abyss-statistics-context abyss-statistics-chart-coverage',
      });
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
    this.rememberRowScroll();
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
