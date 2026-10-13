import type { TaskCreatePreview } from '../domain/taskInputTypes';
import type { LocalDate } from '../domain/types';
import type { TaskDraft } from './TaskRepository';

export interface TaskCreatePreviewPort {
  preview(
    draft: TaskDraft & { readonly today: LocalDate; readonly addCreatedDate: boolean },
  ): Exclude<TaskCreatePreview, { readonly type: 'unavailable' }>;
}
