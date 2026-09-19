import { taskReconciliationKey, type TaskNodeRef, type TaskRef } from '../tasks';

const TASK_REF_ATTRIBUTE = 'data-abyss-task-ref-key';
const TASK_REF_SELECTOR = `[${TASK_REF_ATTRIBUTE}]`;
const TASK_NODE_REF_ATTRIBUTE = 'data-abyss-task-node-ref-key';
const TASK_NODE_REF_SELECTOR = `[${TASK_NODE_REF_ATTRIBUTE}]`;

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

function taskNodePresentationKey(ref: TaskNodeRef): string {
  if (ref.type === 'task') return taskPresentationKey(ref.ref);
  return JSON.stringify([
    taskNodePresentationKey(ref.ref.parent),
    ref.ref.relativeLine,
    ref.ref.originalBlock,
  ]);
}

export function applyTaskNodePresentationIdentity(element: HTMLElement, ref: TaskNodeRef): void {
  element.setAttribute(TASK_NODE_REF_ATTRIBUTE, taskNodePresentationKey(ref));
}

export function clearTaskNodePresentationIdentity(element: HTMLElement): void {
  element.removeAttribute(TASK_NODE_REF_ATTRIBUTE);
}

export function renderedTaskNodeElements(
  root: HTMLElement,
  ref: TaskNodeRef,
): readonly HTMLElement[] {
  const key = taskNodePresentationKey(ref);
  return Array.from(root.querySelectorAll<HTMLElement>(TASK_NODE_REF_SELECTOR)).filter(
    (element) => element.getAttribute(TASK_NODE_REF_ATTRIBUTE) === key,
  );
}
