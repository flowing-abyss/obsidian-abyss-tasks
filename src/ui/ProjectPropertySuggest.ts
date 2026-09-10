import { AbstractInputSuggest, Scope, type App } from 'obsidian';
import { exactLinkToken, linkValueLabel } from '../markdown/links';

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
  readonly browseOnOpen?: boolean;
}

function matches(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function suggestionsForValues(values: readonly string[]): ProjectPropertySuggestion[] {
  const suggestions: ProjectPropertySuggestion[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLocaleLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push({ kind: 'value', value, label: linkValueLabel(value) });
  }
  const labelCounts = new Map<string, number>();
  for (const { label } of suggestions) {
    const normalized = label.toLocaleLowerCase();
    labelCounts.set(normalized, (labelCounts.get(normalized) ?? 0) + 1);
  }
  return suggestions.map((suggestion) => {
    if ((labelCounts.get(suggestion.label.toLocaleLowerCase()) ?? 0) < 2) return suggestion;
    const target = exactLinkToken(suggestion.value)?.target;
    return target === undefined ? suggestion : { ...suggestion, detail: target };
  });
}

/** Keyboard-aware suggestions from values already used by the edited property. */
export class ProjectPropertySuggest extends AbstractInputSuggest<ProjectPropertySuggestion> {
  private readonly suggestions_abyssPrivate: readonly ProjectPropertySuggestion[];
  private readonly onPick_abyssPrivate: (value: string) => void;
  private readonly options_abyssPrivate: ProjectPropertySuggestOptions;
  private browse_abyssPrivate: boolean;
  private open_abyssPrivate = false;

  private readonly onInput_abyssPrivate = (): void => {
    this.browse_abyssPrivate = false;
  };

  private readonly onFocus_abyssPrivate = (): void => {
    this.browse_abyssPrivate = this.options_abyssPrivate.browseOnOpen === true;
  };

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
    this.suggestions_abyssPrivate = suggestionsForValues(options.values);
    this.onPick_abyssPrivate = options.onPick;
    this.options_abyssPrivate = options;
    this.browse_abyssPrivate = options.browseOnOpen === true;
    options.input.addEventListener('input', this.onInput_abyssPrivate, true);
    options.input.addEventListener('focus', this.onFocus_abyssPrivate, true);
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
    if (this.browse_abyssPrivate) return [...this.suggestions_abyssPrivate];
    return this.suggestions_abyssPrivate.filter(
      ({ value, label, detail }) =>
        matches(value, query) || matches(label, query) || matches(detail ?? '', query),
    );
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
