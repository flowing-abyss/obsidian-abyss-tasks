import { projectProgress } from '../../projects/projectTableModel';
import type { ProjectStats } from '../../projects/types';

/**
 * Renders a labelled progress bar (`done/total`). Guards against total=0 so the
 * fill width is a clean 0% rather than NaN.
 */
export function renderProgressBar(parent: HTMLElement, stats: ProjectStats): void {
  const progress = projectProgress(stats);
  const wrap = parent.createDiv({ cls: 'abyss-progress-wrap' });
  const bar = wrap.createDiv({ cls: 'abyss-progress' });
  const fill = bar.createDiv({ cls: 'abyss-progress-fill' });
  fill.style.width = `${progress.percent ?? 0}%`;
  wrap.createSpan({
    cls: 'abyss-progress-label',
    text: progress.percent === null ? '—' : `${progress.done}/${progress.total}`,
  });
}
