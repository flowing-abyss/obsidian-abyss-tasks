import type { App } from 'obsidian';
import type { ProjectManager } from '../projects/ProjectManager';
import type { TaskApplicationApi, TaskCommandResult, TaskRef } from '../tasks';
import { presentTaskMoveResult } from './taskCommandResult';

export async function moveTaskToProjectWithRecovery(
  ...args: [App, TaskApplicationApi, ProjectManager, TaskRef, string]
): Promise<TaskCommandResult> {
  const [app, tasks, projectManager, ref, projectPath] = args;
  // The caller's task API runs the move, so a panel's selection wrapper sees its own move.
  const result = await projectManager.moveTaskToProject(ref, projectPath, tasks);
  presentTaskMoveResult(app, tasks, result);
  return result;
}
