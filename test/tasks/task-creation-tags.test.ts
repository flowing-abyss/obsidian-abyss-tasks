import { describe, expect, it } from 'vitest';
import { applyTaskCreationTagPolicy } from '../../src/tasks/domain/taskTags';

const inbox = { mode: 'tag' as const, tag: '#task/inbox', removeTagOnAssign: true };

describe('canonical creation fallback source preservation', () => {
  it.each([
    { prefix: '#base', body: 'Task', want: '#base Task' },
    { prefix: '#base #second', body: 'Task #specific', want: 'Task #specific' },
    { prefix: '#base', body: 'Task #BASE', want: 'Task #BASE' },
    {
      prefix: 'Plan `#literal` #base 📅 2026-10-15',
      body: 'Task #specific',
      want: 'Plan `#literal` 📅 2026-10-15 Task #specific',
    },
    {
      prefix: 'Root #fallback\n  - [ ] Child',
      body: 'Task #specific',
      want: 'Root #fallback\n  - [ ] Child Task #specific',
    },
    {
      prefix: '#fallback [',
      body: 'label #specific](note.md)',
      want: '#fallback [ label #specific](note.md)',
    },
    {
      prefix: '#base',
      body: 'Task\n  - [ ] Child #specific',
      want: '#base Task\n  - [ ] Child #specific',
    },
    {
      prefix: 'Root #base\r\n  - [ ] Child #child',
      body: 'Task',
      initial: { add: ['#specific'] },
      want: 'Root\r\n  - [ ] Child #child Task',
    },
    {
      prefix: '#base',
      body: 'Task #specific\n  - [ ] Child #base',
      want: 'Task #specific\n  - [ ] Child #base',
    },
    { prefix: '', body: '#specific Task', want: '#specific Task' },
    { prefix: '#base', body: 'Task #broken//tag', want: '#base Task #broken//tag' },
    { prefix: '#base', body: 'Task \\#specific', want: 'Task \\#specific' },
    { prefix: '#base', body: 'Task `#specific`', want: '#base Task `#specific`' },
    { prefix: '#base', body: 'Task [#specific](note.md)', want: '#base Task [#specific](note.md)' },
    { prefix: '#base', body: 'Task <span>#specific</span>', want: 'Task <span>#specific</span>' },
    {
      prefix: '#base',
      body: 'Task <span title="#specific">text</span>',
      want: '#base Task <span title="#specific">text</span>',
    },
    { prefix: '`#base`', body: 'Task #specific', want: '`#base` Task #specific' },
    { prefix: '#base [', body: '#base](note.md) #specific', want: '[ #base](note.md) #specific' },
  ])('preserves composed Markdown for $prefix and $body', ({ prefix, body, want, ...row }) => {
    expect(
      applyTaskCreationTagPolicy(prefix, body, inbox, 'initial' in row ? row.initial : undefined)
        .markdown,
    ).toBe(want);
  });
});
