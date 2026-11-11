const control =
  '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n';
export const files = (source = '# Inbox\n', extra: Record<string, string> = {}) => ({
  'a.md': source,
  'control.md': control,
  ...extra,
});
export const tree = (markdownTitle: string, fields: Record<string, unknown> = {}) => ({
  markdownTitle,
  dates: {},
  time: undefined,
  durationMinutes: undefined,
  recurrence: undefined,
  description: undefined,
  priority: 'D',
  tags: [],
  statusSymbol: ' ',
  onCompletion: 'keep',
  onCompletionExplicit: false,
  children: [],
  comments: [],
  ...fields,
});
