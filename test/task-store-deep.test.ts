import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  seedTaskCache,
  useRealMoment,
} from './helpers';

useRealMoment();

describe('TaskApplicationApi command edge cases', () => {
  it('sets a configured in-progress status symbol', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] task' });
    seedTaskCache(app, 't.md', [{ task: ' ', parent: -1, line: 0 }]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const task = expectDefined(stack.tasks.queries.list()[0]);
    await stack.tasks.execute({
      type: 'set-status',
      target: { type: 'task', ref: task.ref },
      symbol: '/',
    });
    expect(await app.vault.cachedRead(expectDefined(app.vault.getMarkdownFiles()[0]))).toContain(
      '- [/] task',
    );
    stack.index.destroy();
  });

  it('does not let a stale repeated priority command overwrite the first change', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] task' });
    seedTaskCache(app, 't.md', [{ task: ' ', parent: -1, line: 0 }]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const target = expectDefined(stack.tasks.queries.list()[0]);
    await stack.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: target.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    await stack.tasks.execute({
      type: 'patch',
      target: { type: 'task', ref: target.ref },
      patch: { priority: { type: 'set', value: 'D' } },
    });
    expect(await app.vault.cachedRead(expectDefined(app.vault.getMarkdownFiles()[0]))).toBe(
      '- [ ] task 🔺',
    );
    stack.index.destroy();
  });

  it('rebuilds status command semantics after settings mutation', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const app = await createAppWithFiles({});
    const stack = configuredTaskApplication(app, settings);
    settings.taskStatuses = settings.taskStatuses.map((status) =>
      status.type === 'done' ? { ...status, symbol: 'X' } : status,
    );
    stack.statusCatalog.replace(
      settings.taskStatuses.map((status) => ({
        id: status.id,
        symbol: status.symbol,
        type: status.type,
        defaultForType: status.core,
      })),
    );
    stack.statusRegistry.replace(settings.taskStatuses);
    stack.index.setStatusCatalog(stack.statusCatalog);
    expect(stack.statusRegistry.defaultDone().symbol).toBe('X');
    stack.index.destroy();
  });
});
