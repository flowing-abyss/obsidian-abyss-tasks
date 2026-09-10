import { AbstractInputSuggest, Scope, type App } from 'obsidian';
import {
  projectPropertyValuePresentation,
  projectPropertyValuePresentations,
  projectTagLabel,
} from '../panels/projects/projectPropertyValuePresentation';

export interface ProjectPropertySuggestion {
  readonly kind: 'value';
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly appearance?: 'status' | 'tag';
  readonly color?: string;
}

export interface ProjectPropertySuggestOptions {
  readonly app: App;
  readonly input: HTMLInputElement;
  readonly values: readonly string[];
  readonly suggestions?: readonly ProjectPropertySuggestion[];
  readonly exclude?: (value: string) => boolean;
  readonly appearance?: 'tag';
  readonly onPick: (value: string) => void;
  readonly onEscape?: (event: KeyboardEvent) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  readonly browseOnOpen?: boolean;
}

function matches(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function suggestionsForValues(
  values: readonly string[],
  appearance: ProjectPropertySuggestOptions['appearance'],
): ProjectPropertySuggestion[] {
  return projectPropertyValuePresentations(values).map(({ value, label, detail }) => ({
    kind: 'value',
    value,
    label: appearance === 'tag' ? projectTagLabel(label) : label,
    ...(detail === undefined ? {} : { detail }),
    ...(appearance === undefined ? {} : { appearance }),
  }));
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
    this.suggestions_abyssPrivate =
      options.suggestions ?? suggestionsForValues(options.values, options.appearance);
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
    const available = this.suggestions_abyssPrivate.filter(
      ({ value }) => this.options_abyssPrivate.exclude?.(value) !== true,
    );
    if (this.browse_abyssPrivate) return available;
    return available.filter(
      ({ value, label, detail }) =>
        matches(value, query) || matches(label, query) || matches(detail ?? '', query),
    );
  }

  renderSuggestion(suggestion: ProjectPropertySuggestion, element: HTMLElement): void {
    const presentation = projectPropertyValuePresentation(suggestion.value);
    const title = element.createDiv({
      cls: `abyss-suggest-title${presentation.link === undefined ? '' : ' is-link'}${suggestion.appearance === 'status' ? ' abyss-suggest-status' : ''}`,
    });
    if (suggestion.appearance === 'tag') {
      title.createSpan({ cls: 'tag', text: suggestion.label });
    } else title.setText(suggestion.label);
    if (suggestion.color !== undefined) title.style.color = suggestion.color;
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
