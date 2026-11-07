import {
  parseLinktext,
  prepareSimpleSearch,
  resolveSubpath,
  TFile,
  type App,
  type BlockCache,
  type CachedMetadata,
  type HeadingCache,
} from 'obsidian';
import { parseLinks } from '../markdown/links';
import type { AcceptedNoteSource, NoteSourceReadApi } from './NoteSourceApi';
import { NoteFailure, type NoteRange, type NoteSelection } from './noteApi';

export class NoteHostAdapter {
  readonly matcher = prepareSimpleSearch;
  constructor(
    private readonly app: App,
    private readonly sources: NoteSourceReadApi,
    private readonly structure: (source: AcceptedNoteSource) => CachedMetadata | undefined,
  ) {}
  file(source: AcceptedNoteSource): TFile {
    const file = this.app.vault.getAbstractFileByPath(source.path);
    if (!(file instanceof TFile) || !this.sources.matchesFile(source, file))
      throw new NoteFailure('STALE_TARGET');
    return file;
  }
  anchors(source: AcceptedNoteSource): readonly NoteRange[] {
    const cache = this.structure(source);
    if (cache === undefined) return [];
    return [
      ...(cache.headings ?? []).flatMap((heading) => this.headingRange(source, heading)),
      ...Object.values(cache.blocks ?? {}).flatMap((block) => this.blockRange(source, block)),
    ];
  }
  private headingRange(source: AcceptedNoteSource, heading: HeadingCache): NoteRange[] {
    const from = heading.position.start.offset;
    const lineEnd = source.content.indexOf('\n', from);
    const to = lineEnd < 0 ? source.content.length : lineEnd + 1;
    if (!this.validRange(source, from, to) || !this.headingAnchor(source, from, heading.heading))
      return [];
    return [{ from, to, kind: 'heading', label: heading.heading, editable: false }];
  }
  private blockRange(source: AcceptedNoteSource, block: BlockCache): NoteRange[] {
    const from = block.position.start.offset,
      to = block.position.end.offset;
    if (!this.validRange(source, from, to)) return [];
    const text = source.content.slice(from, to),
      anchor = text.lastIndexOf(`^${block.id}`);
    if (anchor < 0 || text.slice(anchor + block.id.length + 1).trim() !== '') return [];
    const marker = from + anchor;
    const separator = /(?:\r?\n|[ \t])$/u.exec(source.content.slice(0, marker))?.[0].length ?? 0;
    return [{ from: marker - separator, to, kind: 'block', label: block.id, editable: false }];
  }
  private validRange(source: AcceptedNoteSource, from: number, to: number): boolean {
    return (
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      from >= 0 &&
      to >= from &&
      to <= source.content.length
    );
  }
  private headingAnchor(source: AcceptedNoteSource, from: number, label: string): boolean {
    if (
      from !== 0 &&
      !(from === 1 && source.content.startsWith('\uFEFF')) &&
      source.content[from - 1] !== '\n'
    )
      return false;
    const line = source.content.slice(from).split('\n', 1)[0] ?? '';
    return /^ {0,3}#{1,6}[ \t]/u.test(line) && line.includes(label);
  }
  private parseLink(wikiLink: string): { path: string; subpath: string } {
    const links = parseLinks(wikiLink);
    const token = links[0];
    if (links.length !== 1 || token?.type !== 'wiki' || token.raw !== wikiLink || token.index !== 0)
      throw new NoteFailure('INVALID_ARGUMENT');
    const parsed = parseLinktext(token.target);
    if (/^[a-z][a-z0-9+.-]*:/iu.test(parsed.path)) throw new NoteFailure('INVALID_ARGUMENT');
    return parsed;
  }
  async resolve(from: AcceptedNoteSource, wikiLink: string): Promise<NoteSelection> {
    this.file(from);
    const parsed = this.parseLink(wikiLink);
    const native =
      parsed.path === ''
        ? this.file(from)
        : this.app.metadataCache.getFirstLinkpathDest(parsed.path, from.path);
    if (!(native instanceof TFile) || native.extension.toLowerCase() !== 'md')
      throw new NoteFailure('NOT_FOUND');
    const read = await this.sources.acquire(native.path);
    if (read.type === 'error') throw new NoteFailure('INCOMPLETE_READ');
    const source = read.value;
    if (source === undefined || !this.sources.matchesFile(source, native))
      throw new NoteFailure('TARGET_UNAVAILABLE');
    this.file(from);
    return this.subpath(source, parsed.subpath);
  }
  private subpath(source: AcceptedNoteSource, subpath: string): NoteSelection {
    if (subpath === '')
      return { source, selection: 'note', range: { from: 0, to: source.content.length } };
    const cache = this.structure(source);
    if (cache === undefined) throw new NoteFailure('INCOMPLETE_READ');
    const found = resolveSubpath(cache, subpath);
    if (found === null) throw new NoteFailure('SUBPATH_NOT_FOUND');
    if (found.type !== 'heading' && found.type !== 'block')
      throw new NoteFailure('UNSUPPORTED_SUBPATH');
    const { start, end } = this.selectedRange(source, found);
    return {
      source,
      range: { from: start, to: end },
      selection: found.type,
      subpath,
    };
  }
  private selectedRange(
    source: AcceptedNoteSource,
    found: Exclude<ReturnType<typeof resolveSubpath>, null>,
  ): { start: number; end: number } {
    const start = found.start.offset,
      end = found.end?.offset ?? source.content.length;
    if (!this.validRange(source, start, end)) throw new NoteFailure('INCOMPLETE_READ');
    if (found.type === 'heading' && !this.headingAnchor(source, start, found.current.heading))
      throw new NoteFailure('INCOMPLETE_READ');
    if (found.type === 'block' && !source.content.slice(start, end).includes(`^${found.block.id}`))
      throw new NoteFailure('INCOMPLETE_READ');
    return { start, end };
  }
  link(selection: NoteSelection, from: AcceptedNoteSource, alias?: string): string {
    this.file(from);
    return this.app.fileManager.generateMarkdownLink(
      this.file(selection.source),
      from.path,
      selection.subpath,
      alias,
    );
  }
}
