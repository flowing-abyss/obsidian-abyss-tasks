import type { ResolvedConfig } from '../settings/types';
import type { TaskSnapshot } from '../tasks';

export abstract class BaseView {
  /**
   * `shouldScrollToNow` (Task 27): TodayView/WeekTimeGridView use this to decide whether to run
   * their one-time scroll-to-now on this render. It defaults to true so every other caller
   * (tests, BaseView.patch below, views that don't have a now-line at all) keeps prior behavior
   * unchanged; only CenterPanel — which owns the (calViewType, calDate) key across full mounts —
   * ever passes `false`, for an explicit same-date refresh it has already scrolled for.
   *
   * `preservedScrollTop` (Task 31): a full CenterPanel refresh recreates the view instance, so a
   * freshly-created `.abyss-tg-grid-row` starts at `scrollTop = 0`. When `shouldScrollToNow` is
   * false, TodayView/WeekTimeGridView restore this value onto the new grid-row. Query updates use
   * `patch()` and retain that grid node directly. Ignored when `shouldScrollToNow` is true — a
   * genuine fresh navigation takes the scroll-to-now path instead of inheriting stale position.
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
