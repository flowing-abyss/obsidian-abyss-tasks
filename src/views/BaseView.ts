import type { ResolvedConfig } from '../settings/types';
import type { TaskSnapshot } from '../tasks';

export abstract class BaseView {
  /**
   * `shouldScrollToNow` (Task 27): TodayView/WeekTimeGridView use this to decide whether to run
   * their one-time scroll-to-now on this render. It defaults to true so every other caller
   * (tests, BaseView.patch below, views that don't have a now-line at all) keeps prior behavior
   * unchanged; only CenterPanel — which owns the (calViewType, calDate) key that survives its
   * mountView() destroy/recreate cycle — ever passes `false`, and only for a reactive re-render
   * of a view/date it has already scrolled for.
   *
   * `preservedScrollTop` (Task 31): CenterPanel.mountView() destroys and recreates the view
   * instance on every render, including reactive ones, so a freshly-created `.tc-tg-grid-row`
   * naturally starts at `scrollTop = 0`. When `shouldScrollToNow` is false (a reactive
   * re-render, not a fresh navigation), TodayView/WeekTimeGridView restore this value onto the
   * new grid-row instead of leaving it at 0, so a task mutation elsewhere never silently resets
   * the user's scroll position. Ignored/unused when `shouldScrollToNow` is true — a genuine
   * fresh navigation always takes the scroll-to-now path instead of inheriting a stale position.
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
