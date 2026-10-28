export const TIME_TRACKING_REMINDER_INTERVALS = [0, 5, 10, 20, 30, 40, 50, 60] as const;
export type TimeTrackingReminderInterval = (typeof TIME_TRACKING_REMINDER_INTERVALS)[number];
export const DEFAULT_TIME_TRACKING_REMINDER_MINUTES: TimeTrackingReminderInterval = 30;

export function normalizeTimeTrackingReminderInterval(
  value: unknown,
): TimeTrackingReminderInterval {
  return (
    TIME_TRACKING_REMINDER_INTERVALS.find((interval) => interval === value) ??
    DEFAULT_TIME_TRACKING_REMINDER_MINUTES
  );
}
