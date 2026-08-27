import type { WorkNoteCommandResult } from '../../projects/work-notes/types';

export interface WorkNoteResultPresenter {
  run(
    command: () => Promise<WorkNoteCommandResult> | WorkNoteCommandResult,
    initiator: HTMLElement,
  ): Promise<WorkNoteCommandResult>;
}

function failureText(result: WorkNoteCommandResult): string {
  if (result.type === 'compatibility-conflict') {
    return 'Work note status was not changed because the compatibility audit changed.';
  }
  if (result.type === 'conflict') {
    return `Work note status was not changed because ${result.field} changed.`;
  }
  if (result.type === 'invalid') {
    return `Work note status was not changed because ${result.field} is invalid.`;
  }
  if (result.type === 'partial') {
    return `Work note update is incomplete. The file was preserved at ${result.path}.`;
  }
  if (result.type === 'ok' || result.type === 'unchanged') return '';
  return 'Work note status could not be changed because of an I/O error.';
}

/** Shared accessible presentation for every guarded Work Note mutation surface. */
export function createWorkNoteResultPresenter(container: HTMLElement): WorkNoteResultPresenter {
  let feedback: HTMLElement | null = null;
  const feedbackElement = (): HTMLElement => {
    feedback ??= container.createDiv({
      cls: 'abyss-work-note-feedback',
      attr: {
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'data-work-note-feedback': '',
      },
    });
    return feedback;
  };
  return {
    async run(command, initiator) {
      let result: WorkNoteCommandResult;
      try {
        result = await command();
      } catch {
        result = { type: 'io-error' };
      }
      if (result.type === 'ok' || result.type === 'unchanged') {
        feedback?.empty();
        if (feedback) delete feedback.dataset['resultType'];
        return result;
      }
      const target = feedbackElement();
      target.dataset['resultType'] = result.type;
      target.setText(failureText(result));
      if (initiator.isConnected) initiator.focus({ preventScroll: true });
      return result;
    },
  };
}
