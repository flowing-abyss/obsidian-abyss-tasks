import type { SubtaskSnapshot } from '../tasks';
import { renderTaskText, type RenderTaskTextOptions } from './renderTaskText';
import type { TaskTextRender } from './taskRenderScope';

export interface TaskNodeTextMount {
  readonly element: HTMLElement;
  readonly render: TaskTextRender;
}
export function renderTaskDescriptionText(
  element: HTMLElement,
  markdown: string,
  options: Omit<RenderTaskTextOptions, 'presentation'>,
): TaskTextRender {
  return renderTaskText(element, markdown, { ...options, presentation: 'markdown' });
}
export function renderSubtaskTitleText(
  host: HTMLElement,
  task: Pick<SubtaskSnapshot, 'markdownTitle' | 'status'>,
  options: RenderTaskTextOptions,
): TaskNodeTextMount {
  const element = host.createSpan({
    cls: `abyss-subtask-label${task.status === 'done' ? ' is-done' : ''}`,
  });
  return {
    element,
    render: renderTaskText(element, task.markdownTitle, { ...options, presentation: 'title' }),
  };
}
export function renderTaskCommentText(
  host: HTMLElement,
  markdown: string,
  options: RenderTaskTextOptions,
): TaskNodeTextMount {
  const element = host.createEl('p', { cls: 'abyss-comment-text' });
  return {
    element,
    render: renderTaskText(element, markdown, { ...options, presentation: 'markdown' }),
  };
}
