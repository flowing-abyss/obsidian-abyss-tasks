import { taskReconciliationKey, type TaskRef } from '../tasks';

const TASK_REF_ATTRIBUTE = 'data-abyss-task-ref-key';
const TASK_REF_SELECTOR = `[${TASK_REF_ATTRIBUTE}]`;

export function taskPresentationKey(ref: TaskRef): string {
  return taskReconciliationKey(ref);
}

export function applyTaskPresentationIdentity(element: HTMLElement, ref: TaskRef): void {
  element.setAttribute(TASK_REF_ATTRIBUTE, taskPresentationKey(ref));
}

export function renderedTaskElements(root: HTMLElement, ref: TaskRef): readonly HTMLElement[] {
  const key = taskPresentationKey(ref);
  return Array.from(root.querySelectorAll<HTMLElement>(TASK_REF_SELECTOR)).filter(
    (element) => element.getAttribute(TASK_REF_ATTRIBUTE) === key,
  );
}
