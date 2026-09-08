import { AbstractInputSuggest, type App, type TFile } from 'obsidian';

interface VaultWithConfig {
  getConfig(key: string): unknown;
}

function matcherForIgnoreFilter(filter: string): ((path: string) => boolean) | undefined {
  if (filter.length > 2 && filter.startsWith('/') && filter.endsWith('/')) {
    try {
      const expression = new RegExp(filter.slice(1, -1));
      return (path) => expression.test(path);
    } catch {
      return undefined;
    }
  }
  const prefix = (filter.endsWith('/') ? filter : `${filter}/`).toLowerCase();
  return (path) => path === filter || path.toLowerCase().startsWith(prefix);
}

/**
 * Autocomplete for a vault note over a text input. Suggests markdown files,
 * honouring Obsidian's "Excluded files" setting (`userIgnoreFilters`), and
 * reports the picked file back to the caller.
 */
export class NoteSuggest extends AbstractInputSuggest<TFile> {
  private readonly source_abyssPrivate: VaultFileSuggestionSource;

  constructor(
    app: App,
    inputElement: HTMLInputElement,
    private readonly onPick_abyssPrivate: (file: TFile) => void,
  ) {
    super(app, inputElement);
    this.source_abyssPrivate = new VaultFileSuggestionSource(app);
  }

  getSuggestions(query: string): TFile[] {
    return this.source_abyssPrivate.list(query);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    // Show the extension for non-note files (e.g. 001.png) so attachments are recognizable.
    el.createDiv({
      cls: 'abyss-suggest-title',
      text: file.extension === 'md' ? file.basename : file.name,
    });
    const parent = file.parent?.path;
    if (parent !== undefined && parent.length > 0 && parent !== '/') {
      el.createDiv({ cls: 'abyss-suggest-path', text: parent });
    }
  }

  override selectSuggestion(file: TFile): void {
    this.onPick_abyssPrivate(file);
    this.close();
  }
}

/** Shared vault-file filtering for inputs that combine note targets with other suggestions. */
export class VaultFileSuggestionSource {
  private readonly ignoreMatchers_abyssPrivate: Array<(path: string) => boolean>;

  constructor(private readonly app_abyssPrivate: App) {
    const raw = (app_abyssPrivate.vault as unknown as VaultWithConfig).getConfig(
      'userIgnoreFilters',
    );
    const filters = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    this.ignoreMatchers_abyssPrivate = filters.flatMap((filter) => {
      const matcher = matcherForIgnoreFilter(filter);
      return matcher === undefined ? [] : [matcher];
    });
  }

  list(query: string): TFile[] {
    const normalized = query.toLocaleLowerCase();
    return this.app_abyssPrivate.vault
      .getFiles()
      .filter((file) => !this.ignoreMatchers_abyssPrivate.some((match) => match(file.path)))
      .filter(
        (file) =>
          normalized.length === 0 ||
          file.name.toLocaleLowerCase().includes(normalized) ||
          file.path.toLocaleLowerCase().includes(normalized),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 50);
  }
}
