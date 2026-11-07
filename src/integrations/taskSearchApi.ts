import type {
  ApiResultV1,
  ListTaskTagsV1,
  SearchTasksV1,
  TaskDtoV1,
  TaskSearchPageV1,
  TaskTagPageV1,
} from '../../api';
import {
  observedTaskTags,
  sameTag,
  type TaskReadNode,
  type TaskSearchApi,
  type TaskSearchCursor,
} from '../tasks';
import type { TaskApiContext } from './TaskApiProvider';
import { readError, readFailure } from './taskApiReads';
import { validateSearch, validateTags } from './taskContentValidation';
import { toTaskDto } from './taskDto';
import { readNodeFor } from './taskTreeApi';
import { validateReadOptions } from './validation';
import { freezeValue } from './values';
interface Cursor {
  binding: string;
  offset: number;
  expires: number;
  native?: TaskSearchCursor;
  timer?: number;
}
/** Client-scoped outward cursor ownership; all text matching remains in native Search. */
export class TaskSearchReads {
  private readonly cursors_abyssPrivate = new Map<string, Cursor>();
  private readonly pending_abyssPrivate = new Set<AbortController>();
  private counter_abyssPrivate = 0;
  private disposed_abyssPrivate = false;
  constructor(
    private readonly ctx_abyssPrivate: TaskApiContext,
    private readonly search_abyssPrivate: TaskSearchApi | undefined,
    private readonly now_abyssPrivate: () => number,
    private readonly epoch_abyssPrivate: string,
  ) {}
  dispose(): void {
    this.disposed_abyssPrivate = true;
    for (const run of this.pending_abyssPrivate) run.abort();
    for (const key of this.cursors_abyssPrivate.keys()) this.drop_abyssPrivate(key);
  }
  private drop_abyssPrivate(key: string): void {
    const cursor = this.cursors_abyssPrivate.get(key);
    if (cursor === undefined) return;
    this.cursors_abyssPrivate.delete(key);
    if (cursor.timer !== undefined) window.clearTimeout(cursor.timer);
    if (
      cursor.native !== undefined &&
      ![...this.cursors_abyssPrivate.values()].some((c) => c.native === cursor.native)
    )
      this.search_abyssPrivate?.release(cursor.native);
  }
  private clean_abyssPrivate(): void {
    for (const [key, c] of this.cursors_abyssPrivate)
      if (c.expires <= this.now_abyssPrivate()) this.drop_abyssPrivate(key);
  }
  private cursor_abyssPrivate(
    query: SearchTasksV1 | ListTaskTagsV1,
  ): ApiResultV1<{ cursor?: Cursor; binding: string }> {
    this.clean_abyssPrivate();
    const binding = JSON.stringify({
      ...query,
      cursor: undefined,
      generation: this.ctx_abyssPrivate.reads.capture().generation,
    });
    if (query.cursor === undefined) return { ok: true, value: { binding } };
    const cursor = this.cursors_abyssPrivate.get(query.cursor);
    return cursor?.binding === binding
      ? { ok: true, value: { cursor, binding } }
      : readFailure('generation-changed');
  }
  private retain_abyssPrivate(cursor: Cursor): ApiResultV1<string> {
    if (this.cursors_abyssPrivate.size >= 1024)
      return readError('resource', 'RESOURCE_LIMIT', 'Search cursor capacity exhausted.');
    const key = `${this.epoch_abyssPrivate}:search:${++this.counter_abyssPrivate}:${crypto.randomUUID()}`;
    cursor.timer = window.setTimeout(() => {
      this.drop_abyssPrivate(key);
    }, 60000);
    this.cursors_abyssPrivate.set(key, cursor);
    return { ok: true, value: key };
  }
  async tags(query?: ListTaskTagsV1, options?: unknown): Promise<ApiResultV1<TaskTagPageV1>> {
    const parsed = validateTags(query),
      read = validateReadOptions(options);
    if (!parsed.ok) return parsed;
    if (!read.ok) return read;
    try {
      await Promise.resolve();
      const failed = this.ctx_abyssPrivate.check(read.value.signal);
      return failed ?? this.tagPage_abyssPrivate(parsed.value);
    } catch {
      return this.ctx_abyssPrivate.internal('tasks.tags');
    }
  }
  private tagPage_abyssPrivate(q: ListTaskTagsV1): ApiResultV1<TaskTagPageV1> {
    const ctx = this.ctx_abyssPrivate,
      resume = this.cursor_abyssPrivate(q);
    if (!resume.ok) return resume;
    const state = ctx.reads.capture(),
      tags = this.collectTags_abyssPrivate(q);
    if (!tags.ok) return tags;
    const all = this.tagValues_abyssPrivate(tags.value, q.prefix);
    const offset = resume.value.cursor?.offset ?? 0,
      limit = q.limit ?? 100;
    return this.finishTags_abyssPrivate(
      all,
      { binding: resume.value.binding, offset, limit },
      state,
    );
  }
  private tagValues_abyssPrivate(tags: readonly string[], prefixValue?: string): readonly string[] {
    const prefix = prefixValue?.toLowerCase();
    return observedTaskTags(tags)
      .filter((t) => prefix === undefined || t.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));
  }
  private finishTags_abyssPrivate(
    all: readonly string[],
    page: { binding: string; offset: number; limit: number },
    state: ReturnType<TaskApiContext['reads']['capture']>,
  ): ApiResultV1<TaskTagPageV1> {
    const { offset, limit } = page,
      ctx = this.ctx_abyssPrivate;
    const next =
      offset + limit < all.length
        ? this.retain_abyssPrivate({
            binding: page.binding,
            offset: offset + limit,
            expires: this.now_abyssPrivate() + 60000,
          })
        : undefined;
    if (next !== undefined && !next.ok) return next;
    return freezeValue({
      ok: true,
      value: {
        ...ctx.observation(state),
        items: all.slice(offset, offset + limit),
        complete: next === undefined,
        truncated: next !== undefined,
        ...(next?.ok === true ? { nextCursor: next.value } : {}),
      },
    });
  }
  private collectTags_abyssPrivate(q: ListTaskTagsV1): ApiResultV1<string[]> {
    const ctx = this.ctx_abyssPrivate,
      state = ctx.reads.capture(),
      tags: string[] = [];
    let after: { path: string; line: number } | undefined;
    do {
      const page = ctx.reads.page(q, 500, after, state.generation);
      if (page.type === 'error') return readFailure(page.reason);
      for (const n of page.value.nodes) tags.push(...n.value.node.tags);
      after = page.value.next;
    } while (after !== undefined);
    return { ok: true, value: tags };
  }
  async search(query: SearchTasksV1, options?: unknown): Promise<ApiResultV1<TaskSearchPageV1>> {
    const parsed = validateSearch(query),
      read = validateReadOptions(options);
    if (!parsed.ok) return parsed;
    if (!read.ok) return read;
    const ctx = this.ctx_abyssPrivate,
      run = new AbortController(),
      abort = (): void => {
        run.abort();
      };
    try {
      const failed = ctx.check(read.value.signal);
      if (failed !== undefined) return failed;
      read.value.signal?.addEventListener('abort', abort, { once: true });
      this.pending_abyssPrivate.add(run);
      if (this.disposed_abyssPrivate) run.abort();
      const result = await this.searchPage_abyssPrivate(parsed.value, run.signal);
      return ctx.check(read.value.signal) ?? result;
    } catch (error) {
      return this.searchError_abyssPrivate(error, run.signal);
    } finally {
      read.value.signal?.removeEventListener('abort', abort);
      this.pending_abyssPrivate.delete(run);
    }
  }
  private searchError_abyssPrivate(error: unknown, signal: AbortSignal): ApiResultV1<never> {
    if (signal.aborted) return readError('lifecycle', 'ABORTED', 'Search was aborted.');
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'stale')
      return readFailure('generation-changed');
    return this.ctx_abyssPrivate.internal('tasks.search');
  }
  private async searchPage_abyssPrivate(
    q: SearchTasksV1,
    signal: AbortSignal,
  ): Promise<ApiResultV1<TaskSearchPageV1>> {
    const ctx = this.ctx_abyssPrivate,
      port = this.search_abyssPrivate;
    if (port === undefined)
      return readError('unsupported', 'UNSUPPORTED_OPERATION', 'Search unavailable.');
    const resume = this.cursor_abyssPrivate(q);
    if (!resume.ok) return resume;
    const state = ctx.reads.capture(),
      health = ctx.reads.coverage(q);
    if (health.type === 'error') return readFailure(health.reason);
    const native = await this.nativeCursor_abyssPrivate(q, resume.value.cursor, signal);
    try {
      const rows = await this.collectSearch_abyssPrivate(
        q,
        { native, offset: resume.value.cursor?.offset ?? 0 },
        signal,
      );
      if (!rows.ok) return rows;
      const failed = ctx.check(signal);
      if (failed !== undefined) return failed;
      if (ctx.reads.capture().generation !== state.generation)
        return readFailure('generation-changed');
      return this.searchResult_abyssPrivate(
        { native, binding: resume.value.binding, ...rows.value },
        state,
      );
    } finally {
      if (![...this.cursors_abyssPrivate.values()].some((c) => c.native === native))
        port.release(native);
    }
  }
  private async nativeCursor_abyssPrivate(
    q: SearchTasksV1,
    cursor: Cursor | undefined,
    signal: AbortSignal,
  ): Promise<TaskSearchCursor> {
    if (cursor?.native !== undefined) return cursor.native;
    const port = this.search_abyssPrivate;
    if (port === undefined) throw new Error('Missing Search');
    return await port.open(
      {
        kind: 'nodes',
        query: q.query,
        fields: q.fields ?? 'all',
        matchScope: q.matchScope ?? 'node',
        ...(q.path === undefined ? {} : { filePath: q.path }),
      },
      signal,
    );
  }
  private async collectSearch_abyssPrivate(
    q: SearchTasksV1,
    position: { native: TaskSearchCursor; offset: number },
    signal: AbortSignal,
  ): Promise<ApiResultV1<{ items: TaskDtoV1[]; offset: number }>> {
    const port = this.search_abyssPrivate;
    if (port === undefined) throw new Error('Missing native Search');
    const items: TaskDtoV1[] = [],
      limit = q.limit ?? 100;
    let offset = position.offset;
    while (offset < position.native.total) {
      const batch = await port.read(
        position.native,
        offset,
        Math.min(50, position.native.total - offset),
        signal,
      );
      const hydrated = await port.resolveHits(batch.hits, signal);
      if (hydrated.length !== batch.hits.length) return readFailure('stale');
      if (batch.hits.length === 0) return readFailure('incomplete');
      const consumed = this.consume_abyssPrivate(q, { items, offset, limit }, hydrated);
      if (!consumed.ok) return consumed;
      offset = consumed.value.offset;
      if (consumed.value.full) return { ok: true, value: { items, offset } };
    }
    return { ok: true, value: { items, offset } };
  }
  private consume_abyssPrivate(
    q: SearchTasksV1,
    page: { items: TaskDtoV1[]; offset: number; limit: number },
    hydrated: Awaited<ReturnType<TaskSearchApi['resolveHits']>>,
  ): ApiResultV1<{ offset: number; full: boolean }> {
    const { items, limit } = page;
    let offset = page.offset;
    for (const hit of hydrated) {
      const n = readNodeFor(this.ctx_abyssPrivate, hit.task);
      offset++;
      if (!this.matches_abyssPrivate(n, q)) continue;
      if (items.length === limit) return { ok: true, value: { offset: offset - 1, full: true } };
      const dto = this.exact_abyssPrivate(n);
      if (!dto.ok) return dto;
      items.push(dto.value);
    }
    return { ok: true, value: { offset, full: false } };
  }
  private exact_abyssPrivate(n: TaskReadNode): ApiResultV1<TaskDtoV1> {
    const ctx = this.ctx_abyssPrivate,
      exact = ctx.reads.node(n.address);
    if (exact.type === 'error') return readFailure(exact.reason);
    if (!ctx.reads.canDisclose(n.address)) return readFailure('unavailable');
    const identity = ctx.identities.project(exact.value, exact.observation.semanticsRevision);
    if (!identity.ok) return identity;
    return { ok: true, value: toTaskDto(exact.value, identity.value) };
  }
  private searchResult_abyssPrivate(
    page: { native: TaskSearchCursor; binding: string; items: TaskDtoV1[]; offset: number },
    state: ReturnType<TaskApiContext['reads']['capture']>,
  ): ApiResultV1<TaskSearchPageV1> {
    const complete = page.offset >= page.native.total;
    const next = complete
      ? undefined
      : this.retain_abyssPrivate({
          binding: page.binding,
          offset: page.offset,
          native: page.native,
          expires: this.now_abyssPrivate() + 60000,
        });
    if (next !== undefined && !next.ok) return next;
    return freezeValue({
      ok: true,
      value: {
        ...this.ctx_abyssPrivate.observation(state),
        items: page.items,
        complete,
        truncated: !complete,
        ...(next?.ok === true ? { nextCursor: next.value } : {}),
      },
    });
  }
  private matches_abyssPrivate(n: TaskReadNode, q: SearchTasksV1): boolean {
    if (q.path !== undefined && n.address.filePath !== q.path) return false;
    if (!this.folderMatches_abyssPrivate(n, q.folder)) return false;
    if (q.statuses !== undefined && !q.statuses.includes(n.status)) return false;
    if (
      q.tagsAll !== undefined &&
      !q.tagsAll.every((t) => n.value.node.tags.some((a) => sameTag(t, a)))
    )
      return false;
    return q.dates === undefined || q.dates.every((d) => this.dateMatches_abyssPrivate(n, d));
  }
  private folderMatches_abyssPrivate(n: TaskReadNode, folder?: string): boolean {
    return folder === undefined || folder === '' || n.address.filePath.startsWith(`${folder}/`);
  }
  private dateMatches_abyssPrivate(
    n: TaskReadNode,
    d: NonNullable<SearchTasksV1['dates']>[number],
  ): boolean {
    const date = n.dates[d.field];
    return (
      date !== undefined &&
      (d.from === undefined || date >= d.from) &&
      (d.to === undefined || date <= d.to)
    );
  }
}
