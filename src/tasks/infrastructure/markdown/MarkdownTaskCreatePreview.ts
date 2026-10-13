import type { TaskCreatePreviewPort } from '../../application/TaskCreatePreviewPort';
import type { TaskDraft } from '../../application/TaskRepository';
import type { TaskCreatePreview } from '../../domain/taskInputTypes';
import type { LocalDate, TaskPlanning } from '../../domain/types';
import { durationMinutes, localDate, localTime } from '../../domain/validation';
import { createTaskBlock } from './createTaskBlock';
import type { ParsedTaskLine, TaskMarkdownCodec } from './TaskMarkdownCodec';

function planning(parsed: ParsedTaskLine): TaskPlanning {
  const { due, scheduled, start, time, duration } = parsed.planning;
  return {
    ...(due === undefined ? {} : { due: localDate(due) }),
    ...(scheduled === undefined ? {} : { scheduled: localDate(scheduled) }),
    ...(start === undefined ? {} : { start: localDate(start) }),
    ...(time === undefined ? {} : { time: localTime(time) }),
    ...(duration === undefined ? {} : { duration: durationMinutes(duration) }),
  };
}

/** Runs the canonical create pipeline in memory; destination acquisition belongs to execution. */
export class MarkdownTaskCreatePreview implements TaskCreatePreviewPort {
  constructor(private readonly codec: TaskMarkdownCodec) {}

  preview(
    draft: TaskDraft & { readonly today: LocalDate; readonly addCreatedDate: boolean },
  ): Exclude<TaskCreatePreview, { readonly type: 'unavailable' }> {
    const source = { filePath: '', line: 0 };
    const raw = this.codec.parseLine(
      `- [ ] ${draft.markdownBody.split(/\r?\n/u)[0] ?? ''}`,
      source,
    );
    const block = createTaskBlock(this.codec, draft);
    if (block.type === 'invalid') return block;
    const root = this.codec.parseLine(block.content.split('\n')[0] ?? '', source);
    if (raw === null || root === null) throw new Error('Canonical create preview has no root');
    const { due, scheduled, start, time } = planning(raw);
    return {
      type: 'valid',
      sourcePlanning: {
        ...(due === undefined ? {} : { due }),
        ...(scheduled === undefined ? {} : { scheduled }),
        ...(start === undefined ? {} : { start }),
        ...(time === undefined ? {} : { time }),
      },
      metadata: {
        markdownTitle: root.markdownTitle,
        tags: root.tags,
        planning: planning(root),
        priority: root.priority,
      },
    };
  }
}
