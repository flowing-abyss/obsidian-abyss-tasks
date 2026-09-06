import { describe, expect, it, vi } from 'vitest';
import { runAsyncAction } from '../src/ui/runAsyncAction';

describe('asynchronous UI rejection boundary', () => {
  it.each([
    [undefined, '[abyss-tasks] Could not complete UI action'],
    ['Could not add dependency', '[abyss-tasks] Could not add dependency'],
    ['', '[abyss-tasks] '],
  ] as const)('logs the original rejection with context %j', async (context, prefix) => {
    const error = new Error('original rejection');
    const action = Promise.reject(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runAsyncAction(action, context);
    await expect(action).rejects.toBe(error);
    expect(log.mock.calls).toEqual([[prefix, error]]);
  });

  it('does not log fulfilled actions', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const action = Promise.resolve('completed');
    runAsyncAction(action, 'Could not complete UI action');
    expect(await action).toBe('completed');
    expect(log).not.toHaveBeenCalled();
  });
});
