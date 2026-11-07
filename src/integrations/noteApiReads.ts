import type {
  ApiAbortSignalV1,
  NoteReadPageV1,
  NoteSearchPageV1,
  ReadNoteV1,
  SearchNotesV1,
} from '../../api';
import type { AcceptedNoteSource } from '../notes/NoteSourceApi';
import { NOTE_LIMITS, NoteFailure, type NoteSelection } from '../notes/noteApi';
import type { NoteReadRegistry } from './NoteReadRegistry';
import type { TaskApiContext } from './TaskApiProvider';
import { noteSegments } from './noteReadProjection';
import { scanNotes, searchItem } from './noteSearchScan';

interface Cursor {
  readonly binding: string;
  readonly observation: string;
  readonly position: number;
  readonly expiresAt: number;
}
export class NoteApiReads {
  private readonly cursors = new Map<string, Cursor>();
  constructor(
    private readonly context: TaskApiContext,
    private readonly registry: NoteReadRegistry,
    private readonly now: () => number,
  ) {}
  private observation(): string {
    const state = this.context.reads.capture();
    return JSON.stringify([
      state.revision,
      state.generation,
      state.scopeRevision,
      state.semanticsRevision,
    ]);
  }
  private position(query: ReadNoteV1 | SearchNotesV1): {
    position: number;
    binding: string;
    observation: string;
  } {
    for (const [token, cursor] of this.cursors)
      if (cursor.expiresAt <= this.now()) this.cursors.delete(token);
    const { cursor: token, ...normalized } = query;
    const binding = JSON.stringify(normalized),
      observation = this.observation();
    if (token === undefined) return { position: 0, binding, observation };
    const cursor = this.cursors.get(token);
    if (cursor?.binding !== binding || cursor.observation !== observation)
      throw new NoteFailure('STALE_CURSOR');
    return { position: cursor.position, binding, observation };
  }
  private cursor(state: { binding: string; observation: string }, position: number): string {
    if (this.cursors.size >= NOTE_LIMITS.maxCursors) throw new NoteFailure('RESOURCE_LIMIT');
    const token = this.registry.token('note-cursor');
    this.cursors.set(token, {
      ...state,
      position,
      expiresAt: this.now() + NOTE_LIMITS.cursorTtlMs,
    });
    return token;
  }
  private stable(observation: string): void {
    if (observation !== this.observation()) throw new NoteFailure('STALE_CURSOR');
  }
  validateOrigins(query: ReadNoteV1): void {
    const origins = [query.linkFor, 'link' in query.selector ? query.selector.link : undefined];
    for (const origin of origins)
      if (
        origin !== undefined &&
        !this.registry.available(origin.from, origin.expectedFromRevision)
      )
        throw new NoteFailure('TARGET_UNAVAILABLE');
  }
  async selection(query: ReadNoteV1): Promise<NoteSelection> {
    const selector = query.selector;
    if ('section' in selector) {
      const selected = await this.registry.selected(selector.section);
      return { ...selected, selection: 'section' };
    }
    if ('link' in selector) {
      const from = await this.registry.acquire(
        selector.link.from,
        selector.link.expectedFromRevision,
      );
      return await this.registry.port.resolve(from, selector.link.wikiLink);
    }
    let source: AcceptedNoteSource;
    if ('target' in selector)
      source = await this.registry.acquire(selector.target, selector.expectedRevision);
    else {
      const read = await this.registry.port.sources.acquire(selector.path);
      if (read.type === 'error') throw new NoteFailure('INCOMPLETE_READ');
      if (read.value === undefined) throw new NoteFailure('NOT_FOUND');
      source = read.value;
    }
    return { source, selection: 'note', range: { from: 0, to: source.content.length } };
  }
  async read(query: ReadNoteV1): Promise<NoteReadPageV1> {
    const selected = await this.selection(query);
    let markdownLink: string | undefined;
    if (query.linkFor !== undefined) {
      const origin = await this.registry.acquire(
        query.linkFor.from,
        query.linkFor.expectedFromRevision,
      );
      markdownLink = this.registry.port.link(selected, origin, query.linkFor.alias);
    }
    const state = this.position(query);
    const page = noteSegments(this.registry, selected, {
      position: state.position,
      characters: query.limitCharacters ?? NOTE_LIMITS.defaultPageCharacters,
      sections: query.limitSections ?? NOTE_LIMITS.maxSectionsPerPage,
    });
    const complete = page.complete;
    return {
      ...this.context.observation(this.context.reads.capture()),
      note: this.registry.summary(selected.source),
      selection: selected.selection,
      ...(selected.subpath === undefined ? {} : { resolvedSubpath: selected.subpath }),
      segments: page.segments,
      complete,
      truncated: !complete,
      ...(complete ? {} : { nextCursor: this.cursor(state, page.position) }),
      ...(markdownLink === undefined ? {} : { markdownLink }),
    };
  }
  async search(query: SearchNotesV1, signal?: ApiAbortSignalV1): Promise<NoteSearchPageV1> {
    const state = this.position(query);
    const scan = await scanNotes(this.registry.port, query, state.position, () => {
      const failure = this.context.check(signal);
      if (failure !== undefined && !failure.ok) throw new NoteFailure(failure.error.code);
      this.stable(state.observation);
    });
    this.stable(state.observation);
    const items = scan.matches.map((match) =>
      searchItem(match, this.registry.summary(match.source)),
    );
    return {
      ...this.context.observation(this.context.reads.capture()),
      items,
      coverage: 'complete',
      complete: scan.complete,
      truncated: !scan.complete,
      ...(scan.complete ? {} : { nextCursor: this.cursor(state, scan.position) }),
    };
  }
  dispose(): void {
    this.cursors.clear();
  }
}
