import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteSuggest } from '../src/ui/NoteSuggest';
import { ProjectPropertySuggest } from '../src/ui/ProjectPropertySuggest';
import { createAppWithFiles, expectDefined } from './helpers';

afterEach(() => {
  document.body.empty();
});

describe('native suggestion scrollbar ownership', () => {
  it.each(['note', 'property'] as const)(
    'styles only the native host rendering a %s suggestion',
    async (kind) => {
      const app = await createAppWithFiles({ 'Note.md': '' });
      const input = document.body.createEl('input');
      const unrelated = document.body.createDiv({ cls: 'suggestion-container' });
      const owned = document.body.createDiv({ cls: 'suggestion-container' });
      const row = owned.createDiv({ cls: 'suggestion' }).createDiv({ cls: 'suggestion-item' });
      if (kind === 'note') {
        const suggest = new NoteSuggest(app, input, vi.fn());
        suggest.renderSuggestion(expectDefined(app.vault.getMarkdownFiles()[0]), row);
        suggest.close();
      } else {
        const suggest = new ProjectPropertySuggest({
          app,
          input,
          values: ['Selected value'],
          onPick: vi.fn(),
        });
        suggest.renderSuggestion(expectDefined(suggest.getSuggestions('')[0]), row);
        suggest.close();
      }
      expect(owned.matches('.abyss-scroll-surface')).toBe(true);
      expect(unrelated.matches('.abyss-scroll-surface')).toBe(false);
      expect(document.body.matches('.abyss-scroll-surface')).toBe(false);
    },
  );
});
