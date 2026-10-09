import { Component, MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import {
  renderSubtaskTitleText,
  renderTaskCommentText,
  renderTaskDescriptionText,
} from '../src/ui/taskNodeText';
import { createAppWithFiles } from './helpers';

afterEach(() => vi.restoreAllMocks());
it('keeps the caller-owned Inspector description DOM and renders full Markdown inside it', async () => {
  const component = new Component();
  component.load();
  const host = createDiv();
  document.body.append(host);
  host.className = 'abyss-right-desc abyss-right-desc-view';
  const app = await createAppWithFiles({});
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    expect(source).toBe('first **needle**\n\nlast paragraph');
    holder.createEl('p').appendText('first needle');
    holder.createEl('p').appendText('last paragraph');
  });
  const receipt = renderTaskDescriptionText(host, 'first **needle**\n\nlast paragraph', {
    app,
    sourcePath: 'a.md',
    component,
  });
  expect(await receipt.settled).toEqual({ type: 'ready' });
  expect(host.className).toBe('abyss-right-desc abyss-right-desc-view');
  expect(host.querySelector('.abyss-task-desc')).toBeNull();
  expect(host.querySelector(':scope > .abyss-md')?.textContent).toBe('first needlelast paragraph');
  component.unload();
  host.remove();
});
it('mounts ordinary done child title and comment text with finite cancellation receipts', async () => {
  const host = createDiv();
  const component = new Component();
  component.load();
  const options = { app: await createAppWithFiles({}), sourcePath: 'a.md', component };
  const title = renderSubtaskTitleText(
    host,
    { markdownTitle: 'same child', status: 'done' },
    options,
  );
  const comment = renderTaskCommentText(host, 'whole comment', options);
  expect(title.element.className).toBe('abyss-subtask-label is-done');
  expect(title.element.textContent).toBe('same child');
  expect(comment.element.tagName).toBe('P');
  expect(comment.element.className).toBe('abyss-comment-text');
  expect(comment.element.textContent).toBe('whole comment');
  expect(await title.render.settled).toEqual({ type: 'ready' });
  expect(await comment.render.settled).toEqual({ type: 'ready' });
  title.render.cancel();
  comment.render.cancel();
  component.unload();
});
