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

it('keeps the native file handle inside TaskIndex', async () => {
  const h = await publicApiHarness({ 'project.md': 'project' });
  try {
    const source = h.index.projectSources().get('project.md');
    if (source.type !== 'ok' || source.value === undefined) throw new Error('Missing source');
    expect(source.value.identity).not.toBe(h.app.vault.getFileByPath('project.md'));
  } finally {
    h.dispose();
  }
});

it.each(['!!timestamp 2026-11-05', '!!binary SGVsbG8=', '!!set {one: null}'])(
  'does not treat non-mapping authored YAML %s as an empty project mapping',
  async (yaml) => {
    const h = await publicApiHarness({ 'project.md': `---\n${yaml}\n---\n` });
    try {
      expect(h.index.projectSources().get('project.md')).toMatchObject({
        type: 'error',
        reason: 'incomplete',
      });
    } finally {
      h.dispose();
    }
  },
);

it('scopes non-mapping YAML failures and skips sources excluded by path alone', async () => {
  const h = await publicApiHarness({
    'bad.md': '---\n!!timestamp 2026-11-05\n---\n',
    'good.md': '---\nkind: project\n---\n',
  });
  try {
    expect(h.index.projectSources().coverage()).toMatchObject({
      type: 'error',
      reason: 'incomplete',
    });
    expect(h.index.projectSources().get('good.md')).toMatchObject({ type: 'ok' });
    await h.index.refreshSourceExclusion(
      () => false,
      (path) => path === 'bad.md',
    );
    expect(h.index.projectSources().coverage()).toMatchObject({ type: 'ok' });
  } finally {
    h.dispose();
  }
});

it('checks the writer file against the opaque incarnation token', async () => {
  const h = await publicApiHarness({ 'project.md': 'project' });
  try {
    const sources = h.index.projectSources(),
      source = sources.get('project.md');
    if (source.type !== 'ok' || source.value === undefined) throw new Error('Missing source');
    const file = h.app.vault.getFileByPath('project.md');
    if (file === null) throw new Error('Missing file');
    expect(sources.matchesFile(source.value, file)).toBe(true);
    expect(sources.matchesFile(source.value, {})).toBe(false);
  } finally {
    h.dispose();
  }
});
