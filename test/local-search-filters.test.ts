import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountProjectCellValuePicker } from '../src/panels/projects/projectCellValuePicker';
import * as policy from '../src/tasks';
import { NoteSuggest } from '../src/ui/NoteSuggest';
import { ProjectPropertySuggest } from '../src/ui/ProjectPropertySuggest';
import { TagPickerModal } from '../src/ui/TagPickerModal';
import { showTagDropdown } from '../src/ui/tagDropdown';
import { appWithFiles, expectDefined } from './helpers';

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((close) => {
    close();
  });
  document.body.empty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const candidates = ['Alpha', 'Beta', 'Тест', '東京大学'];
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('production local candidate searches', () => {
  it.each([
    ['Alhpa', 'Alpha'],
    ['Alxha', 'Alpha'],
    ['Btea', 'Beta'],
    ['Тсет', 'Тест'],
    ['Теск', 'Тест'],
    ['大学 東京', '東京大学'],
  ])('finds %s without replacing the accepted value %s', (query, expected) => {
    const app = appWithFiles(Object.fromEntries(candidates.map((value) => [`${value}.md`, ''])));
    const input = document.body.createEl('input');
    const pick = vi.fn();
    const notes = new NoteSuggest(app, input, pick);
    const found = notes.getSuggestions(query);
    expect(found.map(({ basename }) => basename)).toEqual([expected]);
    notes.selectSuggestion(expectDefined(found[0]));
    expect(pick).toHaveBeenCalledWith(found[0]);
    const properties = new ProjectPropertySuggest({ app, input, values: candidates, onPick: pick });
    expect(properties.getSuggestions(query).map(({ value }) => value)).toEqual([expected]);
    properties.selectSuggestion(expectDefined(properties.getSuggestions(query)[0]));
    expect(pick).toHaveBeenLastCalledWith(expected);
  });

  it('prepares once, retains note sorting/cap, and rejects a large paste before candidate segmentation', () => {
    const app = appWithFiles(
      Object.fromEntries(
        Array.from({ length: 70 }, (_, i) => [`Alpha ${String(i).padStart(2, '0')}.md`, '']),
      ),
    );
    const notes = new NoteSuggest(app, document.body.createEl('input'), vi.fn());
    const prepare = vi.spyOn(policy, 'prepareSearchQuery');
    expect(notes.getSuggestions('Alxha')).toHaveLength(50);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(notes.getSuggestions('')[0]?.basename).toBe('Alpha 00');
    expect(notes.getSuggestions('x'.repeat(1024 * 1024))).toEqual([]);
    const properties = new ProjectPropertySuggest({
      app,
      input: document.body.createEl('input'),
      values: candidates,
      onPick: vi.fn(),
    });
    prepare.mockClear();
    expect(properties.getSuggestions('Тсет').map(({ value }) => value)).toEqual(['Тест']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(properties.getSuggestions('')).toHaveLength(4);
    expect(properties.getSuggestions('x'.repeat(1024 * 1024))).toEqual([]);
  });

  it.each(['dropdown', 'modal', 'cell'] as const)(
    'prepares once in the actual %s and keeps exact typo creation/choices',
    (kind) => {
      const host = document.body.createDiv();
      const commit = vi.fn(() => 'committed' as const);
      const app = appWithFiles({});
      let input: HTMLInputElement;
      let values: () => string[];
      let selectedValue: (() => unknown) | undefined;
      if (kind === 'dropdown') {
        showTagDropdown(
          host,
          candidates.map((value) => `#${value}`),
          () => undefined,
          commit,
        );
        input = expectDefined(host.querySelector<HTMLInputElement>('input'));
        values = () =>
          Array.from(host.querySelectorAll('.abyss-tag-dropdown-opt')).map((el) => el.textContent);
      } else if (kind === 'modal') {
        const modal = new TagPickerModal(
          app,
          () => undefined,
          new Set(),
          new Set(),
          candidates.map((value) => `#${value}`),
          commit,
        );
        document.body.append(modal.containerEl);
        modal.onOpen();
        closers.push(() => {
          modal.onClose();
        });
        input = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
        values = () =>
          Array.from(modal.contentEl.querySelectorAll('[data-tag]')).map(
            (el) => el.getAttribute('data-tag') ?? '',
          );
      } else {
        const picker = mountProjectCellValuePicker({
          app,
          root: host,
          sourcePath: '',
          label: 'Value',
          multiple: true,
          value: [],
          suggestions: candidates.map((value) => ({ value, label: value })),
          equivalent: Object.is,
          literal: (value) => value,
          onChange: vi.fn(),
          onCommit: vi.fn(),
          onInvalid: vi.fn(),
        });
        closers.push(() => {
          picker.destroy();
        });
        input = picker.focusTarget;
        selectedValue = () => picker.value();
        values = () =>
          Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'))
            .filter((el) => el.hidden !== true)
            .map((el) => el.dataset['value'] ?? '');
      }
      const prepare = vi.spyOn(policy, 'prepareSearchQuery');
      type(input, 'Тсет');
      expect(values()).toEqual([kind === 'cell' ? 'Тест' : '#Тест']);
      expect(prepare).toHaveBeenCalledTimes(1);
      for (const [query, expected] of [
        ['Alxha', 'Alpha'],
        ['Btea', 'Beta'],
        ['Теск', 'Тест'],
        ['大学 東京', '東京大学'],
      ]) {
        type(input, expectDefined(query));
        expect(values()).toEqual([kind === 'cell' ? expected : `#${expected}`]);
      }
      type(input, 'x'.repeat(1024 * 1024));
      expect(values()).toEqual([]);
      type(input, '');
      expect(values()).toHaveLength(4);
      if (kind === 'cell') {
        prepare.mockClear();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(prepare).toHaveBeenCalledTimes(1);
        type(input, 'Alxha');
        expectDefined(
          host.querySelector<HTMLButtonElement>('.abyss-project-value-picker-action'),
        ).click();
        expect(selectedValue?.()).toEqual(['Alxha']);
      }
      if (kind === 'dropdown') {
        type(input, 'Alxha');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(commit).toHaveBeenCalledWith(['#Alxha']);
      }
    },
  );
});

it('uses the shared capability fallback only when Intl word segmentation is unavailable', () => {
  vi.stubGlobal('Intl', { Segmenter: undefined });
  const app = appWithFiles({ '東京大学.md': '' });
  const notes = new NoteSuggest(app, document.body.createEl('input'), vi.fn());
  expect(notes.getSuggestions('大学 東京').map(({ basename }) => basename)).toEqual(['東京大学']);
});

it('rejects oversized property queries before evaluating candidate exclusions, including browse-on-open', () => {
  const exclude = vi.fn(() => false);
  const app = appWithFiles({});
  const properties = new ProjectPropertySuggest({
    app,
    input: document.body.createEl('input'),
    values: candidates,
    exclude,
    browseOnOpen: true,
    onPick: vi.fn(),
  });
  expect(properties.getSuggestions('x'.repeat(1024 * 1024))).toEqual([]);
  expect(exclude).not.toHaveBeenCalled();
});
