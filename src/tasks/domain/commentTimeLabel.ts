import { epochDayForLocalDate, type CommentTimestamp } from './commentTimestamp';
import { daysBetweenLocalDates } from './localDateMath';
import type { LocalDate } from './types';

export interface CommentTimeContext {
  readonly nowEpochMs: number;
  readonly today: LocalDate;
  readonly locale: string;
  readonly timeZone: string;
}

export type CommentTimeContextProvider = () => CommentTimeContext;

interface CommentTimeLabelInput extends CommentTimeContext {
  readonly timestamp: CommentTimestamp;
}

function unit(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

function absoluteDay(value: LocalDate, locale: string): string {
  const instant = epochDayForLocalDate(value) * 86_400_000 + 12 * 3_600_000;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(instant);
}

function dayLabel(
  timestamp: Extract<CommentTimestamp, { precision: 'day' }>,
  input: CommentTimeLabelInput,
): string {
  const difference = daysBetweenLocalDates(input.today, timestamp.value);
  if (difference === 0) return 'Today';
  if (difference === -1) return 'Yesterday';
  if (difference === 1) return 'Tomorrow';
  if (difference >= -6 && difference < 0) return `${unit(-difference, 'day')} ago`;
  if (difference <= 6 && difference > 0) return `In ${unit(difference, 'day')}`;
  return absoluteDay(timestamp.value, input.locale);
}

function elapsedParts(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
}

function instantLabel(
  timestamp: Extract<CommentTimestamp, { precision: 'instant' }>,
  input: CommentTimeLabelInput,
): string {
  const delta = input.nowEpochMs - timestamp.epochMs;
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return 'Just now';
  if (absolute < 7 * 86_400_000) {
    const value = elapsedParts(absolute);
    return delta >= 0 ? `${value} ago` : `in ${value}`;
  }
  return new Intl.DateTimeFormat(input.locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: input.timeZone,
  }).format(timestamp.epochMs);
}

export function formatCommentTimeLabel(input: CommentTimeLabelInput): string {
  return input.timestamp.precision === 'day'
    ? dayLabel(input.timestamp, input)
    : instantLabel(input.timestamp, input);
}
