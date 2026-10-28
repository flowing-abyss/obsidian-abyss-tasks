export function createTrackingReminderMessage(
  doc: Document,
  title: string,
  minutes: number,
): DocumentFragment {
  const fragment = doc.adoptNode(createFragment());
  const content = fragment.createDiv({ cls: 'abyss-tracking-reminder' });
  content.createDiv({
    cls: 'abyss-tracking-reminder-time',
    text: `Tracking for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
  });
  const text = title.replace(/\s+/gu, ' ').trim();
  content.createDiv({ cls: 'abyss-tracking-reminder-title', text, attr: { title: text } });
  return fragment;
}
