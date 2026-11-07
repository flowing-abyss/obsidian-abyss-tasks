import type { NoteSearchPageV1, SearchNotesV1 } from '../../api';
import type { AcceptedNoteSource } from '../notes/NoteSourceApi';
import { NOTE_LIMITS, NoteFailure, noteBody, type NoteApplicationApi } from '../notes/noteApi';
import { noteBoundary } from './noteReadProjection';

interface Match {
  readonly source: AcceptedNoteSource;
  readonly matchedIn: Array<'name' | 'alias' | 'body'>;
  readonly snippet?: string;
  readonly snippetTruncated: boolean;
}
function aliases(source: AcceptedNoteSource): readonly string[] {
  const raw = source.metadata.frontmatter['aliases'] ?? source.metadata.frontmatter['alias'];
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}
function excerpt(body: string, offset: number): string {
  const start = noteBoundary(body, Math.max(0, offset - 128));
  return body.slice(
    start,
    noteBoundary(body, Math.min(body.length, start + NOTE_LIMITS.snippetCharacters)),
  );
}
function nameMatches(
  source: AcceptedNoteSource,
  match: ReturnType<NoteApplicationApi['matcher']>,
): Match['matchedIn'] {
  const matchedIn: Match['matchedIn'] = [];
  if (match(source.path) !== null) matchedIn.push('name');
  if (aliases(source).some((alias) => match(alias) !== null)) matchedIn.push('alias');
  return matchedIn;
}
function matchSource(
  source: AcceptedNoteSource,
  fields: SearchNotesV1['fields'],
  match: ReturnType<NoteApplicationApi['matcher']>,
): Match | undefined {
  const matchedIn: Match['matchedIn'] = [];
  if (fields !== 'body') matchedIn.push(...nameMatches(source, match));
  const body = noteBody(source),
    bodyMatch = fields === 'name' ? null : match(body);
  let snippet: string | undefined;
  if (bodyMatch !== null) {
    matchedIn.push('body');
    snippet = excerpt(body, bodyMatch.matches[0]?.[0] ?? 0);
  }
  if (matchedIn.length === 0) return undefined;
  return {
    source,
    matchedIn,
    ...(snippet === undefined ? {} : { snippet }),
    snippetTruncated: snippet !== undefined && snippet.length < body.length,
  };
}
interface ScanState {
  position: number;
  characters: number;
  scanned: number;
  readonly matches: Match[];
}
function within(state: ScanState, query: SearchNotesV1, paths: readonly string[]): boolean {
  return (
    state.position < paths.length &&
    state.matches.length < (query.limit ?? NOTE_LIMITS.defaultSearchMatches) &&
    state.scanned < NOTE_LIMITS.maxSearchSources &&
    state.characters < NOTE_LIMITS.searchSourceCharacterTarget
  );
}
function includes(query: SearchNotesV1, path: string): boolean {
  if (query.path !== undefined && query.path !== path) return false;
  return query.folder === undefined || query.folder === '' || path.startsWith(`${query.folder}/`);
}
function consume(source: AcceptedNoteSource | undefined, state: ScanState): boolean {
  if (source !== undefined) {
    if (source.content.length > NOTE_LIMITS.maxSingleSearchSourceCharacters)
      throw new NoteFailure('RESOURCE_LIMIT');
    if (
      state.scanned > 0 &&
      state.characters + source.content.length > NOTE_LIMITS.searchSourceCharacterTarget
    )
      return false;
    state.characters += source.content.length;
  }
  state.scanned++;
  state.position++;
  return true;
}
async function scanSource(
  operation: {
    port: NoteApplicationApi;
    query: SearchNotesV1;
    matcher: ReturnType<NoteApplicationApi['matcher']>;
    check(): void;
  },
  path: string,
  state: ScanState,
): Promise<boolean> {
  const read = await operation.port.sources.acquire(path);
  operation.check();
  if (read.type === 'error') throw new NoteFailure('INCOMPLETE_READ');
  if (!consume(read.value, state)) return false;
  if (read.value !== undefined) {
    const found = matchSource(read.value, operation.query.fields, operation.matcher);
    if (found !== undefined) state.matches.push(found);
  }
  return true;
}
function scanPath(
  paths: readonly string[],
  state: ScanState,
  query: SearchNotesV1,
): string | undefined {
  const path = paths[state.position];
  if (path === undefined) throw new NoteFailure('STALE_CURSOR');
  if (!includes(query, path)) {
    consume(undefined, state);
    return undefined;
  }
  return path;
}
export async function scanNotes(
  port: NoteApplicationApi,
  query: SearchNotesV1,
  position: number,
  check: () => void,
): Promise<{
  readonly matches: readonly Match[];
  readonly position: number;
  readonly complete: boolean;
}> {
  if (port.sources.coverage(query).type === 'error') throw new NoteFailure('INCOMPLETE_READ');
  const paths = port.sources.paths();
  const state: ScanState = { position, characters: 0, scanned: 0, matches: [] },
    matcher = port.matcher(query.query);
  while (within(state, query, paths)) {
    check();
    const path = scanPath(paths, state, query);
    if (path === undefined) continue;
    if (!(await scanSource({ port, query, matcher, check }, path, state))) break;
    if (state.scanned % 8 === 0)
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  check();
  if (port.sources.coverage(query).type === 'error') throw new NoteFailure('INCOMPLETE_READ');
  return {
    matches: state.matches,
    position: state.position,
    complete: state.position >= paths.length,
  };
}
export function searchItem(
  match: Match,
  note: NoteSearchPageV1['items'][number]['note'],
): NoteSearchPageV1['items'][number] {
  return {
    note,
    matchedIn: match.matchedIn,
    ...(match.snippet === undefined ? {} : { snippet: match.snippet }),
    snippetTruncated: match.snippetTruncated,
  };
}
