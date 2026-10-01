import { setIcon } from 'obsidian';
import { runAsyncAction } from '../../ui/runAsyncAction';

export function renderRowRemove(
  container: HTMLElement,
  cls: string,
  { label, title, failure }: { label: string; title?: string; failure: string },
  action: () => Promise<unknown>,
): void {
  const remove = container.createEl('button', {
    cls,
    attr: { type: 'button', 'aria-label': label, ...(title === undefined ? {} : { title }) },
  });
  setIcon(remove, 'x');
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    if (remove.disabled) return;
    remove.disabled = true;
    runAsyncAction(
      action().finally(() => {
        remove.disabled = false;
      }),
      failure,
    );
  });
}
