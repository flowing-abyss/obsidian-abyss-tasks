import {
  AbstractInputSuggest,
  parseFrontMatterAliases,
  prepareFuzzySearch,
  type App,
  type TFile,
} from 'obsidian';

import {
  createSearchWordSegmenter,
  matchesSearchText,
  prepareSearchQuery,
  TaskSearchError,
} from '../tasks';

interface VaultWithConfig {
  getConfig?(key: string): unknown;
}
export interface VaultLinkSuggestion {
  readonly file: TFile;
  readonly path: string;
  readonly alias?: string;
  readonly label: string;
  readonly ignored: boolean;
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
    inputElement.setAttribute('enterkeyhint', 'enter');
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
  async links(
    query: string,
    signal: AbortSignal,
    ownerWindow: Window,
  ): Promise<VaultLinkSuggestion[]> {
    if (isCancelled(signal) || query.length > 1024) return [];
    const scan: LinkScan = {
      app: this.app_abyssPrivate,
      query,
      search: prepareFuzzySearch(query),
      preferences: linkPreferences(this.app_abyssPrivate),
      found: [],
    };
    const files = this.app_abyssPrivate.vault.getFiles();
    for (let index = 0; index < files.length; index += 256) {
      if (index > 0) await yieldLinkSearch(ownerWindow, signal);
      if (isCancelled(signal)) return [];
      for (const file of files.slice(index, index + 256)) collectLinks(scan, file);
    }
    return scan.found
      .filter(
        (x) =>
          this.app_abyssPrivate.vault.getAbstractFileByPath(x.candidate.path) === x.candidate.file,
      )
      .map((x) => x.candidate);
  }

  isCurrent(candidate: VaultLinkSuggestion, query: string): boolean {
    const { file, path, alias } = candidate;
    const preferences = linkPreferences(this.app_abyssPrivate);
    return (
      file.path === path &&
      this.app_abyssPrivate.vault.getAbstractFileByPath(path) === file &&
      preferences.supports(file) &&
      (query.length > 0 || !preferences.ignored(path)) &&
      (alias === undefined ||
        (
          parseFrontMatterAliases(
            this.app_abyssPrivate.metadataCache.getFileCache(file)?.frontmatter,
          ) ?? []
        ).includes(alias))
    );
  }
  private readonly segment_abyssPrivate = createSearchWordSegmenter();
  private readonly ignoreMatchers_abyssPrivate: Array<(path: string) => boolean>;

  constructor(private readonly app_abyssPrivate: App) {
    const raw = (app_abyssPrivate.vault as unknown as VaultWithConfig).getConfig?.(
      'userIgnoreFilters',
    );
    const filters = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    this.ignoreMatchers_abyssPrivate = filters.flatMap((filter) => {
      const matcher = matcherForIgnoreFilter(filter);
      return matcher === undefined ? [] : [matcher];
    });
  }

  list(query: string): TFile[] {
    try {
      const prepared = prepareSearchQuery(query, this.segment_abyssPrivate);
      const normalized = query.toLocaleLowerCase();
      return this.app_abyssPrivate.vault
        .getFiles()
        .filter((file) => !this.ignoreMatchers_abyssPrivate.some((match) => match(file.path)))
        .filter(
          (file) =>
            normalized.length === 0 ||
            file.name.toLocaleLowerCase().includes(normalized) ||
            file.path.toLocaleLowerCase().includes(normalized) ||
            matchesSearchText(
              [file.basename, file.path].join(' '),
              prepared,
              this.segment_abyssPrivate,
            ),
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 50);
    } catch (error) {
      if (error instanceof TaskSearchError && error.code === 'invalid-query') return [];
      throw error;
    }
  }
}

// Optional host capabilities are confined here. The fallback uses the documented formats and
// the native exclusion grammar observed in Obsidian 1.14.4; no editor/suggestManager internals.
// https://obsidian.md/help/file-formats
const LINK_EXTENSIONS = new Set(
  'md base canvas avif bmp gif jpeg jpg png svg webp flac m4a mp3 ogg wav webm 3gp mkv mov mp4 ogv pdf'.split(
    ' ',
  ),
);

function linkPreferences(app: App): {
  supports(file: TFile): boolean;
  ignored(path: string): boolean;
} {
  const vault = app.vault as unknown as VaultWithConfig;
  const cache = app.metadataCache as typeof app.metadataCache & {
    isSupportedFile?: (file: TFile) => boolean;
  };
  const raw = vault.getConfig?.('userIgnoreFilters');
  const filters = (Array.isArray(raw) ? raw : []).flatMap((entry: unknown) => {
    const match = linkIgnoreMatcher(entry);
    return match === undefined ? [] : [match];
  });
  return {
    supports: (file) =>
      cache.isSupportedFile?.(file) ??
      (vault.getConfig?.('showUnsupportedFiles') === true ||
        LINK_EXTENSIONS.has(file.extension.toLowerCase())),
    ignored: (path) => filters.some((test) => test(path)),
  };
}

function yieldLinkSearch(ownerWindow: Window, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      ownerWindow.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = ownerWindow.setTimeout(finish, 0);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function linkIgnoreMatcher(entry: unknown): ((path: string) => boolean) | undefined {
  if (typeof entry !== 'string' || entry.trim().length === 0) return undefined;
  const filter = entry.trim();
  if (!filter.startsWith('/') || !filter.endsWith('/') || filter.length <= 2)
    return (path) => path.toLowerCase().startsWith(filter.toLowerCase());
  try {
    const regex = new RegExp(filter.slice(1, -1), 'i');
    return (path) => regex.test(path);
  } catch {
    console.warn('[abyss-tasks] Skipped an invalid Obsidian exclusion expression');
    return undefined;
  }
}

interface RankedLink {
  candidate: VaultLinkSuggestion;
  score: number;
}
interface LinkScan {
  readonly app: App;
  readonly query: string;
  readonly search: ReturnType<typeof prepareFuzzySearch>;
  readonly preferences: ReturnType<typeof linkPreferences>;
  readonly found: RankedLink[];
}
function collectLinks(scan: LinkScan, file: TFile): void {
  if (!scan.preferences.supports(file)) return;
  const ignored = scan.preferences.ignored(file.path);
  if (scan.query.length === 0 && ignored) return;
  addLink(scan, file, undefined, ignored);
  if (scan.query.length === 0) return;
  const aliases =
    parseFrontMatterAliases(scan.app.metadataCache.getFileCache(file)?.frontmatter) ?? [];
  for (const alias of aliases) addLink(scan, file, alias, ignored);
}
function addLink(scan: LinkScan, file: TFile, alias: string | undefined, ignored: boolean): void {
  const match = scan.search(alias ?? file.path);
  if (scan.query.length !== 0 && match === null) return;
  const title = file.extension === 'md' ? file.basename : file.name;
  const penalty = ignored ? 10 : 0;
  const score = scan.query.length === 0 ? file.stat.mtime : linkMatchScore(match) - penalty;
  scan.found.push({
    candidate: {
      file,
      path: file.path,
      label: alias ?? title,
      ignored,
      ...(alias === undefined ? {} : { alias }),
    },
    score,
  });
  scan.found.sort(compareLinks);
  if (scan.found.length > 50) scan.found.pop();
}
function linkMatchScore(match: ReturnType<ReturnType<typeof prepareFuzzySearch>>): number {
  return match?.score ?? 0;
}

function compareLinks(a: RankedLink, b: RankedLink): number {
  const score = b.score - a.score;
  if (score !== 0) return score;
  const label = a.candidate.label.localeCompare(b.candidate.label);
  return label !== 0 ? label : a.candidate.path.localeCompare(b.candidate.path);
}
function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}
