import type { ResolvedConfig } from '../settings/types';
import type { TaskSnapshot } from '../tasks';

export abstract class BaseView {
  /**
   * `shouldScrollToNow` tells TodayView and WeekTimeGridView whether to run their one-time
   * scroll-to-now on this render. It defaults to true so every other caller (tests, `patch` below,
   * views without a now-line at all) scrolls to now; only `CalendarMode`, which owns the
   * `lastScrolledKey_abyssPrivate` pairing of view type and date across full mounts, passes
   * `false`, for an explicit same-date refresh it has already scrolled for.
   *
   * `preservedScrollTop` carries the outgoing scroll position across a full calendar render, which
   * recreates the view instance so a freshly created `.abyss-tg-grid-row` starts at
   * `scrollTop = 0`. `CalendarMode` reads it into `pendingScrollTop_abyssPrivate` before the render
   * and hands it back here. When `shouldScrollToNow` is false, TodayView and WeekTimeGridView
   * restore this value onto the new grid-row. Query updates use `patch()` and retain that grid node
   * directly. It is ignored when `shouldScrollToNow` is true, because a genuine fresh navigation
   * takes the scroll-to-now path instead of inheriting a stale position.
   */
  abstract render(
    container: HTMLElement,
    tasks: TaskSnapshot[],
    config: ResolvedConfig,
    shouldScrollToNow?: boolean,
    preservedScrollTop?: number,
  ): void;

  /**
   * Apply a task-query update to an already mounted view. The default remains a full render for
   * views without stable skeleton state. Calendar-grid overrides retain their static DOM when the
   * container and skeleton key match, and may delegate back to render when either changes.
   */
  patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.render(container, tasks, config);
  }

  abstract destroy(): void;
}
