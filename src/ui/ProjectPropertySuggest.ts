import { AbstractInputSuggest, Scope, type App } from 'obsidian';

export interface ProjectPropertySuggestion {
  readonly kind: 'value';
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export interface ProjectPropertySuggestOptions {
  readonly app: App;
  readonly input: HTMLInputElement;
  readonly values: readonly string[];
  readonly onPick: (value: string) => void;
  readonly onEscape?: (event: KeyboardEvent) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

function matches(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/** Keyboard-aware suggestions from values already used by the edited property. */
export class ProjectPropertySuggest extends AbstractInputSuggest<ProjectPropertySuggestion> {
  private readonly values_abyssPrivate: readonly string[];
  private readonly onPick_abyssPrivate: (value: string) => void;
  private readonly options_abyssPrivate: ProjectPropertySuggestOptions;
  private open_abyssPrivate = false;

  constructor(options: ProjectPropertySuggestOptions) {
    super(options.app, options.input);
    if (options.onEscape !== undefined) {
      this.scope = new Scope(this.scope);
      this.scope.register([], 'Escape', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onEscape?.(event);
        return false;
      });
    }
    this.values_abyssPrivate = options.values;
    this.onPick_abyssPrivate = options.onPick;
    this.options_abyssPrivate = options;
  }

  override open(): void {
    super.open();
    if (this.open_abyssPrivate) return;
    this.open_abyssPrivate = true;
    this.options_abyssPrivate.onOpen?.();
  }

  override close(): void {
    super.close();
    if (!this.open_abyssPrivate) return;
    this.open_abyssPrivate = false;
    this.options_abyssPrivate.onClose?.();
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
}
