import { MarkdownRenderer, type TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultFileSuggestionSource } from '../src/ui/NoteSuggest';
import { WikiLinkSuggest } from '../src/ui/WikiLinkSuggest';
import { appWithFiles, expectDefined, methodOf } from './helpers';

vi.mock('../src/ui/textFieldAnchor', () => ({
  textFieldAnchor: () => new DOMRect(100, 100, 1, 20),
  textFieldViewport: () => new DOMRect(0, 0, 1000, 800),
}));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.empty();
});

describe('vault link candidates', () => {
  function fixture() {
    const app = appWithFiles({
      'notes/Alpha.md': '',
      'hidden/Alpha.md': '',
      'image.png': '',
      'other.xyz': '',
    });
    Object.assign(app.metadataCache, { isSupportedFile: undefined });
    let filters: string[] = ['hidden/'];
    Object.assign(app.vault, {
      getConfig: (key: string) => (key === 'userIgnoreFilters' ? filters : false),
    });
    const source = new VaultFileSuggestionSource(app);
    return {
      app,
      source,
      ignore: (value: string[]) => {
        filters = value;
      },
    };
  }
  it('hides excluded files on empty query, downranks matching files, and reads changed settings', async () => {
    const h = fixture();
    const list = (q: string) => h.source.links(q, new AbortController().signal, window);
    expect((await list('')).map((x) => x.file.path)).toEqual(
      expect.arrayContaining(['notes/Alpha.md', 'image.png']),
    );
    expect((await list('')).some((x) => x.file.path.startsWith('hidden/'))).toBe(false);
    expect((await list('Alpha')).map((x) => x.ignored)).toEqual([false, true]);
    h.ignore(['notes', '/HIDDEN/i']);
    expect((await list('')).some((x) => x.file.path.startsWith('notes/'))).toBe(false);
    h.ignore(['/HIDDEN/']);
    expect((await list('')).some((x) => x.file.path.startsWith('hidden/'))).toBe(false);
  });
  it('uses aliases and file paths without exposing unsupported extensions by default', async () => {
    const h = fixture();
    vi.spyOn(h.app.metadataCache, 'getFileCache').mockImplementation((file) =>
      file.path === 'notes/Alpha.md' ? { frontmatter: { aliases: ['Project Dawn'] } } : null,
    );
    const found = await h.source.links('PrD', new AbortController().signal, window);
    expect(found.map((x) => x.alias)).toEqual(['Project Dawn']);
    expect(
      (await h.source.links('', new AbortController().signal, window)).some(
        (x) => x.file.extension === 'xyz',
      ),
    ).toBe(false);
  });
  it('honours optional host supported-file capability, with safe fallback when config is absent', async () => {
    const h = fixture();
    Object.assign(h.app.metadataCache, {
      isSupportedFile: (file: TFile) => file.extension === 'xyz',
    });
    expect(
      (await h.source.links('', new AbortController().signal, window)).map((x) => x.file.path),
    ).toEqual(['other.xyz']);
    Object.assign(h.app.vault, { getConfig: undefined });
    expect(await h.source.links('', new AbortController().signal, window)).toHaveLength(1);
  });
  it('does not retain deleted or renamed candidates and cancels abandoned requests', async () => {
    const h = fixture();
    const found = expectDefined(
      (await h.source.links('Alpha', new AbortController().signal, window))[0],
    );
    await h.app.vault.rename(found.file, 'notes/Renamed.md');
    expect(h.source.isCurrent(found, 'Alpha')).toBe(false);
    const abort = new AbortController();
    abort.abort();
    expect(await h.source.links('', abort.signal, window)).toEqual([]);
    const current = expectDefined(
      (await h.source.links('Renamed', new AbortController().signal, window))[0],
    );
    vi.spyOn(h.app.vault, 'getAbstractFileByPath').mockReturnValue(null);
    expect(h.source.isCurrent(current, 'Renamed')).toBe(false);
  });
});

describe('inline task link completion', () => {
  const controllers: WikiLinkSuggest[] = [];
  afterEach(() => {
    controllers.splice(0).forEach((x) => {
      x.destroy();
    });
  });
  it('does not acquire vault settings until the input actually requests a link', () => {
    const app = appWithFiles({});
    const config = vi.fn(() => {
      throw new Error('Unexpected early settings acquisition');
    });
    Object.assign(app.vault, { getConfig: config });
    const input = document.body.createEl('input');
    expect(() => {
      const controller = new WikiLinkSuggest({ app, input, sourcePath: () => 'tasks.md' });
      controllers.push(controller);
      input.focus();
      input.value = 'Plain task';
      input.dispatchEvent(new Event('input'));
    }).not.toThrow();
    expect(config).not.toHaveBeenCalled();
  });
  async function setup(
    tag: 'input' | 'textarea' = 'textarea',
    value = 'Before [[Al]] after',
    cursor = 11,
  ) {
    const app = appWithFiles({ 'Alpha.md': '', 'Alpine.md': '' });
    vi.spyOn(app.fileManager, 'generateMarkdownLink').mockImplementation(
      (file, _source, _subpath, alias) => {
        const display = alias === undefined ? '' : `|${alias}`;
        return `[[${file.basename}${display}]]`;
      },
    );
    const input = document.body.createEl(tag);
    input.value = value;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    const controller = new WikiLinkSuggest({ app, input, sourcePath: () => 'tasks/Inbox.md' });
    controllers.push(controller);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.abyss-link-suggest [role="option"]')).toHaveLength(2);
    });
    return { app, input, controller };
  }
  function key(input: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    input.dispatchEvent(event);
    return event;
  }
  it('keeps host link decorations on selectable suggestion labels', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      const target = markdown === '[[Alpha]]' ? 'Alpha' : 'Alpine';
      holder.createEl('a', {
        cls: 'internal-link data-link-icon',
        text: target,
        attr: { href: target, 'data-href': target, 'data-link-icon': '📝' },
      });
    });
    const h = await setup();
    const open = vi.spyOn(h.app.workspace, 'openLinkText');
    const label = expectDefined(
      document.querySelector<HTMLAnchorElement>('.abyss-link-suggest-option a.internal-link'),
    );
    expect(label.getAttribute('data-link-icon')).toBe('📝');
    expect(label.classList.contains('data-link-icon')).toBe(true);
    expect(label.getAttribute('data-href')).toBe('Alpha');
    expect(label.tabIndex).toBe(-1);
    const auxiliary = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    label.dispatchEvent(auxiliary);
    expect(auxiliary.defaultPrevented).toBe(true);
    expect(h.input.value).toBe('Before [[Al]] after');
    label.click();
    expect(h.input.value).toBe('Before [[Alpha]] after');
    expect(h.input.selectionStart).toBe(16);
    expect(document.activeElement).toBe(h.input);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['replace', 'dismiss', 'destroy'] as const)(
    'releases host postprocessor resources when suggestions %s',
    async (action) => {
      const released: string[] = [];
      const pending: Array<() => void> = [];
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
        async (...[, markdown, holder, , component]) => {
          component.register(() => {
            released.push(markdown);
          });
          await new Promise<void>((resolve) => {
            pending.push(resolve);
          });
          holder.createEl('a', { cls: 'internal-link', text: markdown });
        },
      );
      const h = await setup();
      if (action === 'replace') {
        h.input.value = 'Plain task';
        h.input.dispatchEvent(new Event('input'));
      } else if (action === 'dismiss') key(h.input, 'Escape');
      else h.controller.destroy();
      released.sort((left, right) => left.localeCompare(right));
      expect(released).toEqual(['[[Alpha]]', '[[Alpine]]']);
      pending.forEach((resolve) => {
        resolve();
      });
      await Promise.resolve();
      expect(document.querySelector('.abyss-link-suggest')).toBeNull();
    },
  );
  it.each(['input', 'textarea'] as const)(
    'selects with arrows in %s, preserves suffix and leaves the caret after the link',
    async (tag) => {
      const h = await setup(tag);
      const submit = vi.fn();
      h.input.addEventListener('keydown', submit);
      key(h.input, 'ArrowDown');
      expect(key(h.input, 'Enter').defaultPrevented).toBe(true);
      expect(h.input.value).toBe('Before [[Alpine]] after');
      expect(h.input.selectionStart).toBe(17);
      expect(h.input.selectionEnd).toBe(17);
      expect(document.activeElement).toBe(h.input);
      expect(submit).not.toHaveBeenCalled();
      expect(methodOf(h.app.fileManager, 'generateMarkdownLink')).toHaveBeenCalledWith(
        expect.anything(),
        'tasks/Inbox.md',
        undefined,
        undefined,
      );
      expect(document.querySelector('.abyss-link-suggest')).toBeNull();
      key(h.input, 'Enter');
      expect(submit).toHaveBeenCalledOnce();
    },
  );
  it('Escape dismisses only suggestions and restores original ARIA at disposal', async () => {
    const h = await setup();
    const parent = vi.fn();
    h.input.addEventListener('keydown', parent);
    key(h.input, 'Escape');
    expect(parent).not.toHaveBeenCalled();
    expect(h.input.value).toBe('Before [[Al]] after');
    key(h.input, 'Escape');
    expect(parent).toHaveBeenCalledOnce();
    h.controller.destroy();
    expect(h.input.hasAttribute('aria-controls')).toBe(false);
    expect(h.input.hasAttribute('role')).toBe(false);
  });
  it('reopens on keyboard caret re-entry while preserving Escape at the same selection', async () => {
    const h = await setup('textarea', '[[Alpha]] tail', 4);
    h.input.setSelectionRange(h.input.value.length, h.input.value.length);
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('.abyss-link-suggest')).toBeNull();
    h.input.setSelectionRange(4, 4);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    });
    key(h.input, 'Escape');
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    expect(document.querySelector('.abyss-link-suggest')).toBeNull();
    h.input.setSelectionRange(5, 5);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    });
  });

  it('opens on keyboard navigation into an existing link without a previous draft', async () => {
    const app = appWithFiles({ 'Alpha.md': '', 'Alpine.md': '' });
    const input = document.body.createEl('input');
    input.value = '[[Alpha]] tail';
    input.setSelectionRange(input.value.length, input.value.length);
    const controller = new WikiLinkSuggest({ app, input, sourcePath: () => 'tasks.md' });
    controllers.push(controller);
    input.focus();
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('.abyss-link-suggest')).toBeNull();
    input.setSelectionRange(4, 4);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    });
  });

  it('pointer selection belongs to the controller and keeps input focus', async () => {
    const h = await setup();
    const option = expectDefined(
      document.querySelector<HTMLElement>('.abyss-link-suggest [role="option"]'),
    );
    expect(h.controller.owns(option)).toBe(true);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    option.click();
    expect(h.input.value).toBe('Before [[Alpha]] after');
    expect(document.activeElement).toBe(h.input);
  });
  it('does not select during IME or after a changed range, deleted file, or missing destination', async () => {
    const h = await setup();
    expect(key(h.input, 'Enter', { isComposing: true }).defaultPrevented).toBe(false);
    h.input.setSelectionRange(0, 0);
    key(h.input, 'Enter');
    expect(h.input.value).toBe('Before [[Al]] after');
    h.input.setSelectionRange(11, 11);
    h.input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    });
    const file = expectDefined(h.app.vault.getFileByPath('Alpha.md'));
    vi.spyOn(h.app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
      path === file.path ? null : file,
    );
    key(h.input, 'Enter');
    expect(h.input.value).toBe('Before [[Al]] after');
  });
  it('discards delayed results after newer input or disposal', async () => {
    const h = await setup();
    let resolve:
      ((value: Awaited<ReturnType<VaultFileSuggestionSource['links']>>) => void) | undefined;
    const delayed = vi.spyOn(VaultFileSuggestionSource.prototype, 'links').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.input.value = '[[late';
    h.input.setSelectionRange(6, 6);
    h.input.dispatchEvent(new Event('input'));
    h.controller.destroy();
    resolve?.([]);
    await Promise.resolve();
    expect(document.querySelector('.abyss-link-suggest')).toBeNull();
    expect(delayed).toHaveBeenCalledOnce();
  });

  it('preserves the draft and reports one sanitized diagnostic when an active query fails', async () => {
    const h = await setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(VaultFileSuggestionSource.prototype, 'links').mockRejectedValue(
      new Error('private vault path'),
    );
    h.input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledOnce();
    });
    expect(error.mock.calls.flat().join(' ')).not.toContain('private vault path');
    expect(h.input.value).toBe('Before [[Al]] after');
    expect(document.querySelector('.abyss-link-suggest')).toBeNull();
  });

  it('uses native undo insertion when available and dispatches input only once', async () => {
    const h = await setup();
    const changed = vi.fn();
    h.input.addEventListener('input', changed);
    const native = vi.fn((_command: string, _ui: boolean, text: string) => {
      h.input.setRangeText(text, h.input.selectionStart ?? 0, h.input.selectionEnd ?? 0, 'end');
      h.input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: native });
    try {
      key(h.input, 'Enter');
      expect(native).toHaveBeenCalledWith('insertText', false, '[[Alpha]]');
      expect(changed).toHaveBeenCalledOnce();
      expect(h.input.selectionStart).toBe(16);
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });
});
