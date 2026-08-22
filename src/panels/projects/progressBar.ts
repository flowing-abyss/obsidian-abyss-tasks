/**
 * Renders a labelled progress bar (`done/total`). Guards against total=0 so the
 * fill width is a clean 0% rather than NaN.
 */
export function renderProgressBar(parent: HTMLElement, done: number, total: number): void {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const wrap = parent.createDiv({ cls: 'abyss-progress-wrap' });
  const bar = wrap.createDiv({ cls: 'abyss-progress' });
  const fill = bar.createDiv({ cls: 'abyss-progress-fill' });
  fill.style.width = `${pct}%`;
  wrap.createSpan({ cls: 'abyss-progress-label', text: `${done}/${total}` });
}
