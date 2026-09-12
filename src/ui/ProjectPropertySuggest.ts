import { AbstractInputSuggest, Scope, type App } from 'obsidian';
import type { ProjectValuePresentation } from '../projects/projectPropertyDefinitions';
import {
  projectPropertyValuePresentation,
  projectPropertyValuePresentations,
  projectTagLabel,
} from './projectPropertyValuePresentation';

export interface ProjectPropertySuggestion {
  readonly kind?: 'value';
  readonly value: string | number;
  readonly label: string;
  readonly detail?: string;
  readonly appearance?: 'status' | 'tag';
  readonly color?: string;
  readonly display?: ProjectValuePresentation['display'];
}

export interface ProjectPropertySuggestOptions {
  readonly app: App;
  readonly input: HTMLInputElement;
  readonly values: readonly string[];
  readonly suggestions?: readonly ProjectPropertySuggestion[];
  readonly exclude?: (value: string | number) => boolean;
  readonly appearance?: 'tag';
  readonly onPick: (value: string | number) => void;
  readonly onEscape?: (event: KeyboardEvent) => void;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
  readonly browseOnOpen?: boolean;
}

function matches(value: string | number, query: string): boolean {
  return String(value).toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function suggestionTitleClass(
  suggestion: ProjectPropertySuggestion,
  isLink: boolean,
  isTag: boolean,
): string {
  let className = 'abyss-suggest-title';
  if (isLink) className += ' is-link';
  if (suggestion.appearance === 'status') className += ' abyss-suggest-status';
  if (suggestion.display === 'badge' && !isTag) className += ' abyss-project-preset-suggestion';
  return className;
}

function applySuggestionColor(
  element: HTMLElement,
  suggestion: ProjectPropertySuggestion,
  isDot: boolean,
): void {
  if (suggestion.color === undefined) return;
  element.style.setProperty(
    suggestion.appearance === 'status'
      ? '--abyss-project-status-color'
      : '--abyss-project-property-color',
    suggestion.color,
  );
  if (!isDot) element.style.color = suggestion.color;
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

/** Renders the shared project-property value presentation into one suggestion row. */
export function renderProjectPropertySuggestion(
  suggestion: ProjectPropertySuggestion,
  element: HTMLElement,
): void {
  const presentation = projectPropertyValuePresentation(String(suggestion.value));
  const isTag = suggestion.appearance === 'tag';
  const isDot = suggestion.display === 'dot';
  const title = element.createDiv({
    cls: suggestionTitleClass(suggestion, presentation.link !== undefined, isTag),
  });
  const valueElement = isTag ? title.createSpan({ cls: 'tag', text: suggestion.label }) : title;
  if (!isTag) title.setText(suggestion.label);
  if (isDot) valueElement.addClass('is-dot');
  applySuggestionColor(valueElement, suggestion, isDot);
  if (suggestion.detail !== undefined) {
    element.createDiv({ cls: 'abyss-suggest-path', text: suggestion.detail });
  }
}

/** Keyboard-aware suggestions from values already used by the edited property. */
export class ProjectPropertySuggest extends AbstractInputSuggest<ProjectPropertySuggestion> {
  private readonly suggestions_abyssPrivate: readonly ProjectPropertySuggestion[];
  private readonly onPick_abyssPrivate: (value: string | number) => void;
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
    renderProjectPropertySuggestion(suggestion, element);
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
