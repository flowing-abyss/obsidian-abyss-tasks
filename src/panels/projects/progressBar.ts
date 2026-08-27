/**
 * Renders a labelled progress bar (`done/total`). Guards against total=0 so the
 * fill width is a clean 0% rather than NaN.
 */
export function renderProgressBar(
  parent: HTMLElement,
  done: number,
  total: number,
  label = 'Task progress',
): void {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const wrap = parent.createDiv({
    cls: 'abyss-progress-wrap',
    attr: {
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': String(total > 0 ? total : 100),
      'aria-valuenow': String(total > 0 ? Math.min(total, Math.max(0, done)) : 0),
      ...(total > 0 ? {} : { 'aria-valuetext': 'No tasks' }),
    },
  });
  const bar = wrap.createDiv({ cls: 'abyss-progress' });
  const fill = bar.createDiv({ cls: 'abyss-progress-fill' });
  fill.style.width = `${pct}%`;
  wrap.createSpan({ cls: 'abyss-progress-label', text: `${done}/${total}` });
}
