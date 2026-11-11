import { expect, it, vi } from 'vitest';
import { CommandChangeViewport } from '../src/ui/commandMode/CommandChangeViewport';

it('scrolls only the changed iteration into its own viewport, keeping already visible content stable', () => {
  const host = createDiv();
  const task = host.createDiv({ attr: { 'data-change': 'changed' }, text: 'New description' });
  const scroll = vi.fn();
  host.scrollTo = scroll;
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 400 } as DOMRect);
  vi.spyOn(task, 'getBoundingClientRect').mockReturnValue({ top: 600, bottom: 630 } as DOMRect);
  const viewport = new CommandChangeViewport(host);
  viewport.update('session');
  expect(scroll).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith({ top: 238, behavior: 'smooth' });
  viewport.update('session');
  expect(scroll).toHaveBeenCalledOnce();
  task.textContent = 'Refined';
  vi.spyOn(task, 'getBoundingClientRect').mockReturnValue({ top: 120, bottom: 150 } as DOMRect);
  viewport.update('session');
  expect(scroll).toHaveBeenCalledOnce();
  task.dataset['change'] = '';
  viewport.update('session');
  expect(scroll).toHaveBeenCalledOnce();
});
