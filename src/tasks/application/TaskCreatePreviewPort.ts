import type { TaskCreateContextPreview, TaskCreatePreview } from '../domain/taskInputTypes';
import type { LocalDate } from '../domain/types';
import type { TaskDraft } from './TaskRepository';

export type TaskCreateContextProjection =
  | Omit<Extract<TaskCreateContextPreview, { readonly type: 'ready' }>, 'referenceDate' | 'inbox'>
  | Extract<TaskCreateContextPreview, { readonly type: 'invalid' }>;

export interface TaskCreatePreviewPort {
  preview(
    draft: TaskDraft & { readonly today: LocalDate; readonly addCreatedDate: boolean },
  ): Exclude<TaskCreatePreview, { readonly type: 'unavailable' }>;
  previewContext?(draft: TaskDraft): TaskCreateContextProjection;
}
