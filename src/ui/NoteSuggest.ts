import { AbstractInputSuggest, type App, TFile } from 'obsidian';

interface VaultWithConfig {
  getConfig(key: string): unknown;
}

/**
 * Autocomplete for a vault note over a text input. Suggests markdown files,
 * honouring Obsidian's "Excluded files" setting (`userIgnoreFilters`), and
 * reports the picked file back to the caller.
 */
export class NoteSuggest extends AbstractInputSuggest<TFile> {
  // Compiled once per suggester (the modal lifetime) rather than per keystroke per file.
  private readonly ignoreMatchers: Array<(path: string) => boolean>;

  constructor(
    app: App,
    private readonly inputElement: HTMLInputElement,
    private readonly onPick: (file: TFile) => void,
  ) {
    super(app, inputElement);
    this.ignoreMatchers = this.buildIgnoreMatchers();
  }

  /** Mirrors Obsidian's Excluded-files matching: `/regex/` entries or folder-path prefixes. */
  private buildIgnoreMatchers(): Array<(path: string) => boolean> {
    const raw = (this.app.vault as unknown as VaultWithConfig).getConfig('userIgnoreFilters');
    const filters = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    const matchers: Array<(path: string) => boolean> = [];
    for (const filter of filters) {
      if (filter.length > 2 && filter.startsWith('/') && filter.endsWith('/')) {
        try {
          const re = new RegExp(filter.slice(1, -1));
          matchers.push((p) => re.test(p));
        } catch {
          // Skip a malformed regex filter rather than breaking the whole suggester.
        }
      } else {
        const prefix = (filter.endsWith('/') ? filter : `${filter}/`).toLowerCase();
        matchers.push((p) => p === filter || p.toLowerCase().startsWith(prefix));
      }
    }
    return matchers;
  }

  private isIgnored(path: string): boolean {
    return this.ignoreMatchers.some((match) => match(path));
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    // All files (not just markdown) so a wiki link can target attachments/images too,
    // honouring Obsidian's excluded-files setting.
    return this.app.vault
      .getFiles()
      .filter((file) => !this.isIgnored(file.path))
      .filter(
        (file) => !q || file.name.toLowerCase().includes(q) || file.path.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    // Show the extension for non-note files (e.g. 001.png) so attachments are recognizable.
    el.createDiv({
      cls: 'abyss-suggest-title',
      text: file.extension === 'md' ? file.basename : file.name,
    });
    const parent = file.parent?.path;
    if (parent && parent !== '/') {
      el.createDiv({ cls: 'abyss-suggest-path', text: parent });
    }
  }

  selectSuggestion(file: TFile): void {
    this.onPick(file);
    this.close();
  }
}
