import { expect, it } from 'vitest';
import { publicApiHarness } from './support/publicApiHarness';

it('reads accepted empty and nested-task files and refuses malformed metadata without blocking a healthy exact path', async () => {
  const h = await publicApiHarness({
    'empty.md': '---\nkind: project\n---\n# Empty\n',
    'nested.md': '- [ ] Root\n  - [x] Child\n',
    'broken.md': '---\nkind: [\n',
  });
  try {
    const sources = h.index.projectSources();
    expect(sources.coverage()).toMatchObject({ type: 'error', reason: 'incomplete' });
    expect(sources.get('empty.md')).toMatchObject({
      type: 'ok',
      value: { path: 'empty.md', metadata: { frontmatter: { kind: 'project' } }, roots: [] },
    });
    expect(sources.get('nested.md')).toMatchObject({
      type: 'ok',
      value: { roots: [{ source: { line: 0 } }] },
    });
    expect(sources.get('broken.md')).toMatchObject({ type: 'error', reason: 'incomplete' });
  } finally {
    h.dispose();
  }
});

it('publishes project settings changes without changing the task semantic revision', async () => {
  const h = await publicApiHarness({ 'task.md': '- [ ] Task\n' });
  try {
    const taskPage = await h.client().tasks.list();
    if (!taskPage.ok || taskPage.value.items[0] === undefined) throw new Error('Missing task');
    const task = taskPage.value.items[0];
    const before = h.reads.capture();
    const events: number[] = [];
    const subscription = h.reads.subscribe((event) => events.push(event.observation.generation));
    h.index.updateProjectIntegrationSemantics('first');
    const after = h.reads.capture();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(after.semanticsRevision).toBe(before.semanticsRevision);
    expect(events).toEqual([after.generation]);
    expect(
      await h.client().tasks.complete({
        target: task.target,
        expectedRevision: task.revision,
        requestId: 'after-project-settings',
        expiresAt: Date.UTC(2026, 7, 1, 12, 5),
      }),
    ).toMatchObject({ ok: true });
    subscription.unsubscribe();
  } finally {
    h.dispose();
  }
});
