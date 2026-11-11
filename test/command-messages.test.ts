import { afterEach, expect, it } from 'vitest';
import { commandMessage, configureCommandLocale } from '../src/ai/commandMessages';
import { ProviderFailure } from '../src/ai/providers/providerFailure';
afterEach(() => {
  configureCommandLocale('en');
});
it('uses the host-selected Russian vocabulary and explicit English fallback', () => {
  configureCommandLocale('ru-RU');
  expect(commandMessage('Saved.')).toBe('Сохранено.');
  expect(new ProviderFailure('missing-key')).toMatchObject({
    code: 'missing-key',
    message: 'Сохраните API-ключ выбранного провайдера.',
  });
  configureCommandLocale('de');
  expect(commandMessage('Saved.')).toBe('Saved.');
  expect(new ProviderFailure('missing-key').code).toBe('missing-key');
});
