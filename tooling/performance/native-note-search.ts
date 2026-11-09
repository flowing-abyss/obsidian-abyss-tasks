import type {
  ApiResultV1,
  NoteReadPageV1,
  NoteSearchPageV1,
  ObservationV1,
  SearchNotesV1,
  TasksApiV1,
} from '../../api';
import { assertMatchingObservation, connect } from './native-api.ts';
import type { HiddenWindowObservation } from './native-observation.ts';
import type { Measure } from './native-scenarios.ts';
import type { Host, NativeOptions } from './native-types.ts';
import type { Sample } from './types.ts';

export interface SearchCallSample {
  scenario: string;
  page: number;
  durationMs: number;
  results: number;
  complete: boolean;
  errorCode?: string;
}
type RecordCall = (sample: SearchCallSample) => void;
export async function noteScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
  observers: { record: RecordCall; hidden?: HiddenWindowObservation },
): Promise<void> {
  const client = connect(host),
    controller = new AbortController();
  let off: (() => void) | undefined;
  try {
    for (const capability of ['notes.read', 'notes.search'])
      if (!client.info.capabilities.includes(capability))
        throw new Error(`Note profile capability missing: ${capability}`);
    const ready = await client.ready({ signal: controller.signal });
    if (!ready.ok) throw new Error(`Note profile readiness: ${ready.error.code}`);
    const subscription = client.subscribe(() => {});
    if (!subscription.ok) throw new Error(`Note profile subscription: ${subscription.error.code}`);
    off = subscription.value;
    await notePagingScenario(client, options, measure, controller.signal);
    const context = { signal: controller.signal, ...observers };
    await noteSearchScenarios(client, options, measure, context);
    await noteProjectSearchScenario(client, options, measure, context);
  } finally {
    controller.abort();
    try {
      off?.();
    } finally {
      client.dispose();
    }
  }
}
function sizes(
  options: NativeOptions,
  paths: readonly string[],
): { characters: number; bytes: number } {
  let characters = 0,
    bytes = 0;
  for (const path of paths) {
    const size = options.sourceSizes?.[path];
    if (size === undefined) throw new Error(`Missing exact source size: ${path}`);
    characters += size.characters;
    bytes += size.bytes;
  }
  return { characters, bytes };
}
function assertPage(
  client: TasksApiV1,
  page: NoteSearchPageV1,
  expected: readonly string[],
  found: Set<string>,
): void {
  if (page.coverage !== 'complete' || page.complete !== (page.nextCursor === undefined))
    throw new Error('Search coverage or continuation invalid');
  for (const item of page.items) {
    if (
      !expected.includes(item.note.path) ||
      found.has(item.note.path) ||
      !validMatch(client, item)
    )
      throw new Error('Search identity, body match or snippet invalid');
    found.add(item.note.path);
  }
}
function validMatch(client: TasksApiV1, item: NoteSearchPageV1['items'][number]): boolean {
  return (
    item.matchedIn.length === 1 &&
    item.matchedIn[0] === 'body' &&
    item.snippet !== undefined &&
    item.snippet.length <= (client.info.noteLimits?.snippetCharacters ?? 0)
  );
}
interface SearchContext {
  signal: AbortSignal;
  record?: RecordCall;
  hidden?: HiddenWindowObservation;
}
export async function noteProjectSearchScenario(
  client: TasksApiV1,
  options: NativeOptions,
  measure: Measure,
  context: SearchContext,
): Promise<void> {
  const folder = `${options.fixtureFolder}/projects`;
  const paths = Object.keys(options.sourceSizes ?? {}).filter((path) =>
    path.startsWith(`${folder}/`),
  );
  if (paths.length !== 100) throw new Error('Project search requires all 100 fixture sources');
  const query: SearchNotesV1 = { folder, fields: 'body', query: 'neverpresentneedle', limit: 100 };
  const run = async (id: string, signal: AbortSignal): Promise<Sample['facts']> => ({
    ...(await new SearchWorkload(client, { ...context, signal }).drain(query, [], id)),
    sources: paths.length,
    zeroTaskSources: 99,
  });
  await measure('notes.search.projects.absent', () =>
    run('notes.search.projects.absent', context.signal),
  );
  const hidden = context.hidden;
  if (hidden !== undefined)
    await measure('notes.search.projects.hidden', () =>
      hidden.run((signal) => run('notes.search.projects.hidden', signal)),
    );
}
class SearchWorkload {
  constructor(
    readonly client: TasksApiV1,
    readonly context: SearchContext,
  ) {}
  async page(input: SearchNotesV1, scenario: string, page: number): Promise<NoteSearchPageV1> {
    const result = await this.request(input, scenario, page);
    if (!result.ok) throw new Error(`Note search failed: ${result.error.code}`);
    return result.value;
  }
  async request(
    input: SearchNotesV1,
    scenario: string,
    page: number,
  ): Promise<ApiResultV1<NoteSearchPageV1>> {
    if (this.client.notes === undefined) throw new Error('Notes capability missing');
    const start = performance.now();
    const result = await this.client.notes.search(input, { signal: this.context.signal });
    const durationMs = performance.now() - start;
    this.context.record?.({
      scenario,
      page,
      durationMs,
      results: result.ok ? result.value.items.length : 0,
      complete: result.ok && result.value.complete,
      ...(result.ok ? {} : { errorCode: result.error.code }),
    });
    return result;
  }
  async firstMatch(
    query: SearchNotesV1,
    path: string,
    scenario: string,
  ): Promise<{ page: NoteSearchPageV1; pages: number }> {
    let cursor: string | undefined,
      observation: ObservationV1 | undefined,
      pages = 0;
    const found = new Set<string>();
    for (;;) {
      const page = await this.page(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        scenario,
        pages++,
      );
      observation ??= page;
      assertMatchingObservation(observation, page);
      assertPage(this.client, page, [path], found);
      if (page.complete || page.nextCursor === undefined)
        throw new Error('Oversized source was not deferred after preceding source');
      if (page.items.length === 1) return { page, pages };
      cursor = page.nextCursor;
    }
  }
  async refuse(query: SearchNotesV1, scenario: string): Promise<number> {
    let cursor: string | undefined,
      observation: ObservationV1 | undefined,
      pages = 0;
    for (;;) {
      const result = await this.request(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        scenario,
        pages++,
      );
      if (!result.ok) {
        if (result.error.code !== 'RESOURCE_LIMIT')
          throw new Error('Above-ceiling search returned wrong refusal');
        return pages;
      }
      const page = result.value;
      observation ??= page;
      assertMatchingObservation(observation, page);
      assertPage(this.client, page, [], new Set());
      if (page.complete || page.nextCursor === undefined)
        throw new Error('Above-ceiling search falsely certified coverage');
      cursor = page.nextCursor;
    }
  }
  async drain(
    query: SearchNotesV1,
    expected: readonly string[],
    scenario: string,
    initial?: NoteSearchPageV1,
  ): Promise<{ pages: number; results: number; complete: boolean; coverage: string }> {
    const found = new Set<string>();
    let observation: ObservationV1 | undefined = initial;
    let cursor = initial?.nextCursor;
    let pages = 0;
    do {
      const page = await this.page(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        scenario,
        pages,
      );
      observation ??= page;
      assertMatchingObservation(observation, page);
      assertPage(this.client, page, expected, found);
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== undefined);
    if (found.size !== expected.length) throw new Error('Search missed an expected source');
    return { pages, results: found.size, complete: true, coverage: 'complete' };
  }
}
export async function noteSearchScenarios(
  client: TasksApiV1,
  options: NativeOptions,
  measure: Measure,
  context: SearchContext,
): Promise<void> {
  const limits = client.info.noteLimits,
    work = new SearchWorkload(client, context);
  if (
    client.notes === undefined ||
    limits?.searchSourceCharacterTarget !== 262144 ||
    limits.maxSingleSearchSourceCharacters !== 4194304
  )
    throw new Error('Note search capability or policy missing');
  for (const name of ['target', 'over-target', 'ceiling']) {
    const path = `${options.fixtureFolder}/search/${name}/body.md`;
    for (const hit of [true, false]) {
      const id = `notes.search.${name}.${hit ? 'hit' : 'absent'}`;
      await measure(id, async () => ({
        ...(await work.drain(
          {
            fields: 'body',
            path,
            query: hit ? 'quartzneedle amberneedle' : 'neverpresentneedle',
            limit: 100,
          },
          hit ? [path] : [],
          id,
        )),
        ...sizes(options, [path]),
        sources: 1,
        target: limits.searchSourceCharacterTarget,
        ceiling: limits.maxSingleSearchSourceCharacters,
      }));
    }
  }
  const folder = `${options.fixtureFolder}/search/continuation`,
    paths = [`${folder}/00.md`, `${folder}/01.md`];
  const query: SearchNotesV1 = {
    fields: 'body',
    folder,
    query: 'quartzneedle amberneedle',
    limit: 100,
  };
  let first: NoteSearchPageV1 | undefined;
  await measure('notes.search.continuation.first', async () => {
    const found = await work.firstMatch(query, paths[0] ?? '', 'notes.search.continuation.first');
    first = found.page;
    return {
      pages: found.pages,
      emptyPrefixPages: found.pages - 1,
      sources: 1,
      results: 1,
      complete: false,
      coverage: first.coverage,
      ...sizes(options, paths.slice(0, 1)),
    };
  });
  await measure('notes.search.continuation.next', async () => {
    if (first?.nextCursor === undefined) throw new Error('Continuation missing');
    return {
      ...(await work.drain(query, paths.slice(1), 'notes.search.continuation.next', first)),
      sources: 1,
      ...sizes(options, paths.slice(1)),
    };
  });
  await measure('notes.search.continuation.complete', async () => ({
    ...(await work.drain(query, paths, 'notes.search.continuation.complete')),
    sources: 2,
    ...sizes(options, paths),
  }));
  await ceilingRefusal(work, options, measure);
}

export async function notePagingScenario(
  client: TasksApiV1,
  options: NativeOptions,
  measure: Measure,
  signal: AbortSignal,
): Promise<void> {
  const path = `${options.fixtureFolder}/paging.md`;
  await measure('notes.read-pages', async () => {
    if (client.notes === undefined) throw new Error('Notes capability missing');
    let cursor: string | undefined,
      observation: ObservationV1 | undefined,
      text = '',
      pages = 0;
    do {
      const result = await client.notes.read(
        { selector: { path }, limitCharacters: 127, ...(cursor === undefined ? {} : { cursor }) },
        { signal },
      );
      if (!result.ok) throw new Error(`Note pagination: ${result.error.code}`);
      const page = result.value;
      observation ??= page;
      assertMatchingObservation(observation, page);
      text += readText(page, path);
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== undefined);
    if (
      text !== `\uFEFF---\r\naliases: [Ada]\r\n---\r\n${'Contact 🙂\r\n'.repeat(10000)}` ||
      text.length !== sizes(options, [path]).characters
    )
      throw new Error('Note pagination lost authored characters');
    return { ...sizes(options, [path]), pages, complete: true, pageCharacters: 127 };
  });
}

function readText(page: NoteReadPageV1, path: string): string {
  if (page.note.path !== path || page.complete !== (page.nextCursor === undefined))
    throw new Error('Note pagination scope or completeness changed');
  return page.segments
    .map((part) => {
      if (/\r$|[\uD800-\uDBFF]$/u.test(part.text))
        throw new Error('Note page splits an authored character');
      return part.text;
    })
    .join('');
}

async function ceilingRefusal(
  work: SearchWorkload,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const notes = work.client.notes;
  if (notes === undefined) throw new Error('Notes capability missing');
  await measure('notes.search.over-ceiling', async () => {
    const path = `${options.fixtureFolder}/search/over-ceiling/body.md`;
    const pages = await work.refuse(
      { fields: 'body', path, query: 'quartzneedle amberneedle', limit: 100 },
      'notes.search.over-ceiling',
    );
    const read = await notes.read(
      { selector: { path }, limitCharacters: 127 },
      { signal: work.context.signal },
    );
    if (
      !read.ok ||
      read.value.complete ||
      read.value.nextCursor === undefined ||
      read.value.note.path !== path ||
      read.value.segments[0]?.text.startsWith('quartzneedle') !== true
    )
      throw new Error('Above-ceiling source is not normally readable');
    return {
      ...sizes(options, [path]),
      code: 'RESOURCE_LIMIT',
      pages,
      emptyPrefixPages: pages - 1,
      certifiedComplete: false,
      readable: true,
    };
  });
}
