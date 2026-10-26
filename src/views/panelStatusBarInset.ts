import type { Workspace } from 'obsidian';

function bottomOverlap(pane: DOMRect, status: DOMRect): number {
  if (
    status.width <= 0 ||
    status.height <= 0 ||
    status.right <= pane.left ||
    status.left >= pane.right ||
    status.top >= pane.bottom ||
    status.bottom < pane.bottom
  )
    return 0;
  return Math.max(0, Math.min(pane.height, pane.bottom - status.top));
}

/** Reserve the host's floating status bar only where it overlaps this desktop center pane. */
export function mountPanelStatusBarInset(owner: HTMLElement, workspace?: Workspace): () => void {
  let releaseWindow = (): void => {};
  let refresh = (): void => {};
  const bind = (): void => {
    releaseWindow();
    releaseWindow = () => {};
    refresh = () => {};
    owner.style.removeProperty('--abyss-shell-bottom-inset');
    const document = owner.ownerDocument;
    const win = document.defaultView;
    if (win === null) return;
    let frame: number | undefined;
    let bar: HTMLElement | null = null;
    const measure = (): void => {
      frame = undefined;
      const next = document.querySelector<HTMLElement>('.status-bar');
      if (next !== bar) {
        if (bar !== null) observer?.unobserve(bar);
        bar = next;
        if (bar !== null) observer?.observe(bar, { box: 'border-box' });
      }
      const inset =
        bar === null || win.getComputedStyle(bar).visibility === 'hidden'
          ? 0
          : bottomOverlap(owner.getBoundingClientRect(), bar.getBoundingClientRect());
      const value = `${inset}px`;
      if (owner.style.getPropertyValue('--abyss-shell-bottom-inset') !== value)
        owner.style.setProperty('--abyss-shell-bottom-inset', value);
    };
    refresh = () => {
      frame ??= win.requestAnimationFrame(measure);
    };
    const observer =
      typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(refresh) : undefined;
    observer?.observe(owner, { box: 'border-box' });
    win.addEventListener('resize', refresh);
    releaseWindow = () => {
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      observer?.disconnect();
      win.removeEventListener('resize', refresh);
    };
    refresh();
  };
  bind();
  const migration = owner.onWindowMigrated(bind);
  const refs =
    workspace === undefined
      ? []
      : [
          workspace.on('layout-change', () => {
            refresh();
          }),
          workspace.on('css-change', () => {
            refresh();
          }),
        ];
  return () => {
    migration();
    for (const ref of refs) workspace?.offref(ref);
    releaseWindow();
    owner.style.removeProperty('--abyss-shell-bottom-inset');
  };
}
