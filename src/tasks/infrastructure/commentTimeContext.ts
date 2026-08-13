import type { CommentTimeContextProvider } from '../domain/commentTimeLabel';
import { localDate } from '../domain/validation';

/** Composition-owned wall-clock context shared by every comment surface. */
export const systemCommentTimeContext: CommentTimeContextProvider = () => {
  const nowEpochMs = Date.now();
  return {
    nowEpochMs,
    today: localDate(window.moment(nowEpochMs).format('YYYY-MM-DD')),
    locale: window.moment.locale(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
};
