import type { StatisticsChartModel } from '../../statistics';
import { RowViewport } from '../virtualization/rowViewport';
import type { StatisticsChartHandle, StatisticsChartRenderer } from './StatisticsChart';

/** Native owner of a bounded aggregate row window; source/evidence remain in the pure model. */
export class StatisticsRowChart implements StatisticsChartHandle {
  private readonly viewport_abyssPrivate = new RowViewport(64);
  private readonly scroller_abyssPrivate: HTMLElement;
  private readonly canvas_abyssPrivate: HTMLElement;
  private readonly surface_abyssPrivate: HTMLElement;
  private readonly owner_abyssPrivate: Window;
  private handle_abyssPrivate: StatisticsChartHandle | undefined;
  private readonly observer_abyssPrivate: ResizeObserver | undefined;
  private frame_abyssPrivate: number | undefined;
  private destroyed_abyssPrivate = false;
  private failed_abyssPrivate = false;
  private model_abyssPrivate: StatisticsChartModel;
  constructor(
    host: HTMLElement,
    private readonly renderer_abyssPrivate: StatisticsChartRenderer,
    initial: StatisticsChartModel,
    private readonly options_abyssPrivate: {
      onSelect: (id: string) => void;
      positions: Map<string, number>;
      onFailure: (error: unknown) => void;
    },
  ) {
    const owner = host.ownerDocument.defaultView;
    if (owner === null) throw new Error('Statistics row charts require an owning window');
    this.owner_abyssPrivate = owner;
    this.model_abyssPrivate = initial;
    this.scroller_abyssPrivate = host.createDiv({
      cls: 'abyss-statistics-row-viewport',
      attr: { tabindex: '0', 'aria-label': initial.accessibleLabel },
    });
    this.canvas_abyssPrivate = this.scroller_abyssPrivate.createDiv({
      cls: 'abyss-statistics-row-canvas',
    });
    this.surface_abyssPrivate = this.canvas_abyssPrivate.createDiv({
      cls: 'abyss-statistics-row-content',
    });
    this.scroller_abyssPrivate.addEventListener('scroll', this.schedule_abyssPrivate);
    try {
      this.update(initial);
      const Observer = (owner as Window & { ResizeObserver?: typeof ResizeObserver })
        .ResizeObserver;
      if (Observer !== undefined) {
        this.observer_abyssPrivate = new Observer(this.schedule_abyssPrivate);
        this.observer_abyssPrivate.observe(this.scroller_abyssPrivate);
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  rememberScroll(): void {
    this.options_abyssPrivate.positions.set(
      this.model_abyssPrivate.id,
      this.scroller_abyssPrivate.scrollTop,
    );
  }
  private readonly schedule_abyssPrivate = (): void => {
    if (this.destroyed_abyssPrivate || this.failed_abyssPrivate) return;
    this.rememberScroll();
    if (this.frame_abyssPrivate !== undefined) return;
    this.frame_abyssPrivate = this.owner_abyssPrivate.requestAnimationFrame(() => {
      this.frame_abyssPrivate = undefined;
      if (this.destroyed_abyssPrivate || this.failed_abyssPrivate) return;
      try {
        this.render_abyssPrivate();
      } catch (error) {
        this.failed_abyssPrivate = true;
        this.options_abyssPrivate.onFailure(error);
      }
    });
  };
  update(model: StatisticsChartModel): void {
    if (this.destroyed_abyssPrivate) return;
    this.failed_abyssPrivate = false;
    if (model.y.type !== 'band' || model.x.type !== 'number')
      throw new Error('Statistics ranking requires a horizontal band chart');
    const top =
      this.options_abyssPrivate.positions.get(model.id) ?? this.scroller_abyssPrivate.scrollTop;
    const anchor = this.viewport_abyssPrivate.captureAnchor(top);
    this.model_abyssPrivate = model;
    this.viewport_abyssPrivate.replace(
      model.y.categories.map((key) => ({ key, estimatedHeight: 32, measurementRevision: '32' })),
    );
    this.canvas_abyssPrivate.style.setProperty(
      '--abyss-statistics-row-height',
      `${this.viewport_abyssPrivate.totalHeight}px`,
    );
    this.scroller_abyssPrivate.scrollTop = this.viewport_abyssPrivate.restoreAnchor(anchor, top);
    this.render_abyssPrivate();
  }
  private render_abyssPrivate(): void {
    const model = this.model_abyssPrivate;
    if (model.y.type !== 'band') return;
    const window = this.viewport_abyssPrivate.window(this.scroller_abyssPrivate.scrollTop, 288, []);
    this.scroller_abyssPrivate.scrollTop = window.scrollTop;
    this.rememberScroll();
    const categories = model.y.categories.slice(window.start, window.end);
    const sliced: StatisticsChartModel = {
      ...model,
      y: {
        ...model.y,
        categories,
        tickLabels: model.y.tickLabels?.slice(window.start, window.end),
      },
      marks: model.marks.slice(window.start, window.end),
    };
    this.surface_abyssPrivate.style.setProperty(
      '--abyss-statistics-row-offset',
      `${window.start * 32}px`,
    );
    if (this.handle_abyssPrivate === undefined)
      this.handle_abyssPrivate = this.renderer_abyssPrivate.mount(
        this.surface_abyssPrivate,
        sliced,
        this.options_abyssPrivate.onSelect,
      );
    else this.handle_abyssPrivate.update(sliced);
  }
  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    if (this.frame_abyssPrivate !== undefined)
      this.owner_abyssPrivate.cancelAnimationFrame(this.frame_abyssPrivate);
    this.observer_abyssPrivate?.disconnect();
    this.scroller_abyssPrivate.removeEventListener('scroll', this.schedule_abyssPrivate);
    this.handle_abyssPrivate?.destroy();
    this.scroller_abyssPrivate.remove();
  }
}
