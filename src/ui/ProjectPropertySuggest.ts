import { AbstractInputSuggest, type App, type TFile } from 'obsidian';
import { VaultFileSuggestionSource } from './NoteSuggest';

export interface ProjectPropertySuggestion {
  readonly kind: 'value' | 'note';
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export interface ProjectPropertySuggestOptions {
  readonly app: App;
  readonly input: HTMLInputElement;
  readonly values: readonly string[];
  readonly onPick: (value: string) => void;
  readonly includeNotes?: boolean;
  readonly sourcePath?: string;
}

function matches(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/** One keyboard-aware suggester for prior property values and optional wiki-link targets. */
export class ProjectPropertySuggest extends AbstractInputSuggest<ProjectPropertySuggestion> {
  private readonly noteSource_abyssPrivate: VaultFileSuggestionSource | undefined;
  private readonly values_abyssPrivate: readonly string[];
  private readonly onPick_abyssPrivate: (value: string) => void;
  private readonly options_abyssPrivate: ProjectPropertySuggestOptions;

  constructor(options: ProjectPropertySuggestOptions) {
    super(options.app, options.input);
    this.values_abyssPrivate = options.values;
    this.onPick_abyssPrivate = options.onPick;
    this.options_abyssPrivate = options;
    this.noteSource_abyssPrivate =
      options.includeNotes === true ? new VaultFileSuggestionSource(options.app) : undefined;
  }

  getSuggestions(query: string): ProjectPropertySuggestion[] {
    const suggestions: ProjectPropertySuggestion[] = [];
    const seen = new Set<string>();
    for (const value of this.values_abyssPrivate) {
      if (!matches(value, query)) continue;
      const normalized = value.toLocaleLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      suggestions.push({ kind: 'value', value, label: value });
    }
    for (const file of this.noteSource_abyssPrivate?.list(query) ?? []) {
      const suggestion = this.noteSuggestion_abyssPrivate(file);
      const normalized = suggestion.value.toLocaleLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      suggestions.push(suggestion);
    }
    return suggestions;
  }

  renderSuggestion(suggestion: ProjectPropertySuggestion, element: HTMLElement): void {
    element.createDiv({ cls: 'abyss-suggest-title', text: suggestion.label });
    if (suggestion.detail !== undefined) {
      element.createDiv({ cls: 'abyss-suggest-path', text: suggestion.detail });
    }
  }

  override selectSuggestion(
    suggestion: ProjectPropertySuggestion,
    event?: MouseEvent | KeyboardEvent,
  ): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.onPick_abyssPrivate(suggestion.value);
    this.close();
  }

  private noteSuggestion_abyssPrivate(file: TFile): ProjectPropertySuggestion {
    const linktext = this.app.metadataCache.fileToLinktext(
      file,
      this.options_abyssPrivate.sourcePath ?? '',
      true,
    );
    return {
      kind: 'note',
      value: `[[${linktext}]]`,
      label: file.extension === 'md' ? file.basename : file.name,
      ...(file.parent?.path == null || file.parent.path === '/'
        ? {}
        : { detail: file.parent.path }),
    };
  }
}
