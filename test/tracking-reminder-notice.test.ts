import { expect, it } from 'vitest';
import { createTrackingReminderMessage } from '../src/ui/timeTracking/trackingReminderNotice';

it('keeps timing separate from an untrusted long title without interpreting title HTML', () => {
  const title = `<img src=x onerror=alert(1)> ${'Long task title '.repeat(30)}`;
  const fragment = createTrackingReminderMessage(document, title, 30);
  const parent = createDiv();
  parent.append(fragment);
  expect(parent.querySelector('.abyss-tracking-reminder-time')?.textContent).toBe(
    'Tracking for 30 minutes',
  );
  const task = parent.querySelector('.abyss-tracking-reminder-title');
  expect(task?.textContent).toBe(title.trim());
  expect(parent.querySelector('img')).toBeNull();
  expect(task?.getAttribute('title')).toBe(title.trim());
});
