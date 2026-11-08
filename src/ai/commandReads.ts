import type {
  ApiEventV1,
  ApiResultV1,
  ContentPlanV1,
  TaskTreePageV1,
  TaskTreeV1,
  TasksApiV1,
} from '../../api';
import { CommandFailure, required } from './commandTypes';
interface ReadTiming {
  readonly deadline: number;
  readonly now: () => number;
}
interface TreeReadTiming extends ReadTiming {
  readonly readCharacters?: number;
  readonly plan?: Pick<ContentPlanV1, 'target' | 'revision'>;
  readonly side?: 'before' | 'after';
}
/** Subscribe before the attempt so a publication cannot be missed. Never wraps writes. */
export async function commandRead<T>(
  api: TasksApiV1,
  read: () => Promise<ApiResultV1<T>>,
  signal: AbortSignal,
  timing: ReadTiming,
): Promise<T> {
  const owner = new CoverageWait(signal, timing);
  const subscription = api.subscribe((event) => {
    owner.observe(event);
  });
  if (!subscription.ok)
    throw new CommandFailure(subscription.error.code, subscription.error.message);
  try {
    return await owner.run(api, read);
  } finally {
    subscription.value();
  }
}
class CoverageWait {
  private epoch = '';
  private version = 0;
  private wake: (() => void) | undefined;
  private readonly until: number;
  constructor(
    private readonly signal: AbortSignal,
    private readonly timing: ReadTiming,
  ) {
    this.until = Math.min(timing.deadline, timing.now() + 5000);
  }
  observe(event: ApiEventV1): void {
    const next = JSON.stringify([
      event.providerEpoch,
      event.revision,
      event.generation,
      event.scopeRevision,
      event.semanticsRevision,
    ]);
    if (next !== this.epoch) {
      this.epoch = next;
      this.version++;
      this.wake?.();
    }
  }
  private checkAbort(): void {
    if (this.signal.aborted) throw new CommandFailure('CANCELLED', 'The request was stopped.');
  }
  private check(): void {
    this.checkAbort();
    if (this.timing.now() >= this.until)
      throw new CommandFailure(
        'INCOMPLETE_READ',
        'The vault is still updating. Try again shortly.',
      );
  }
  async run<T>(api: TasksApiV1, read: () => Promise<ApiResultV1<T>>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check();
      const before = this.version;
      const result = await this.bounded(read());
      this.checkAbort();
      if (result.ok) return result.value;
      if (result.error.code === 'NOT_READY') {
        await this.ready(api);
        continue;
      }
      if (result.error.code !== 'INCOMPLETE_READ' || attempt === 2)
        throw new CommandFailure(result.error.code, result.error.message);
      if (this.version === before) await this.wait(before);
    }
    throw new CommandFailure('INCOMPLETE_READ', 'The vault is still updating. Try again shortly.');
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    let abort = (): void => {};
    let timer: number | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = (): void => {
        reject(new CommandFailure('CANCELLED', 'The request was stopped.'));
      };
      this.signal.addEventListener('abort', abort, { once: true });
      timer = window.setTimeout(
        () => {
          reject(
            new CommandFailure(
              'INCOMPLETE_READ',
              'The vault is still updating. Try again shortly.',
            ),
          );
        },
        Math.max(0, this.until - this.timing.now()),
      );
      if (this.signal.aborted) abort();
    });
    try {
      return await Promise.race([work, stopped]);
    } finally {
      window.clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
    }
  }
  private async ready(api: TasksApiV1): Promise<void> {
    const result = await this.bounded(api.ready({ signal: this.signal }));
    if (!result.ok) throw new CommandFailure(result.error.code, result.error.message);
  }
  private async wait(before: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        window.clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
        this.wake = undefined;
      };
      const finish = (): void => {
        cleanup();
        resolve();
      };
      const abort = (): void => {
        cleanup();
        reject(new CommandFailure('CANCELLED', 'The request was stopped.'));
      };
      const timer = window.setTimeout(finish, Math.max(0, this.until - this.timing.now()));
      this.wake = finish;
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
      else if (this.version !== before) finish();
    });
  }
}

/** Bounded canonical capture for reviewed values/accounting; it never changes a native plan. */
export async function canonicalCommandPlan(
  api: TasksApiV1,
  plan: ContentPlanV1,
  signal: AbortSignal,
  timing: ReadTiming,
): Promise<ContentPlanV1> {
  const reader = new CanonicalPlanReader(api, plan, signal, {
    now: timing.now,
    deadline: Math.min(timing.deadline, timing.now() + 5000),
  });
  const before = await reader.tree(plan.before, 'before'),
    after = await reader.tree(plan.after, 'after');
  if (plan.affected === undefined) return { ...plan, before, after };
  const roots = async (side: 'before' | 'after'): Promise<TaskTreeV1[]> => {
    const result: TaskTreeV1[] = [];
    for (const root of plan.affected?.[side] ?? []) {
      const tree = await reader.tree(root, side);
      if (tree !== null) result.push(tree);
    }
    return result;
  };
  return {
    ...plan,
    before,
    after,
    affected: { before: await roots('before'), after: await roots('after') },
  };
}
class CanonicalPlanReader {
  private nodes = 0;
  private pages = 0;
  private characters = 0;
  constructor(
    private readonly api: TasksApiV1,
    private readonly plan: Pick<ContentPlanV1, 'target' | 'revision'> | undefined,
    private readonly signal: AbortSignal,
    private readonly timing: TreeReadTiming,
  ) {}
  private check(): void {
    this.signal.throwIfAborted();
    if (this.timing.readCharacters !== undefined && this.characters > this.timing.readCharacters)
      throw new CommandFailure('TREE_READ_LIMIT', 'More task content remains.');
    if (
      this.timing.now() >= this.timing.deadline ||
      this.nodes > 4000 ||
      this.pages > 512 ||
      this.characters > 4 * 1024 * 1024
    )
      throw new CommandFailure(
        'INCOMPLETE_PLAN',
        'The complete task proposal could not be read within its limits. The earlier draft is retained.',
      );
  }
  async tree(seed: TaskTreeV1 | null, side: 'before' | 'after'): Promise<TaskTreeV1 | null> {
    if (seed === null) return null;
    this.nodes++;
    this.check();
    const node = seed.complete ? seed : await this.ownEntries(seed, side);
    this.characters += JSON.stringify({ ...node, children: [] }).length;
    this.check();
    const children: TaskTreeV1[] = [];
    for (const child of node.children)
      children.push(required((await this.tree(child, side)) ?? undefined));
    return { ...node, children, complete: true, truncated: false };
  }
  private async ownEntries(seed: TaskTreeV1, side: 'before' | 'after'): Promise<TaskTreeV1> {
    let cursor: string | undefined;
    const children: TaskTreeV1[] = [],
      comments: Array<TaskTreeV1['comments'][number]> = [],
      timeEntries: Array<TaskTreeV1['timeEntries'][number]> = [],
      entries: Array<TaskTreeV1['entries'][number]> = [];
    do {
      this.pages++;
      this.check();
      const page = await commandRead(
        this.api,
        () =>
          required(this.api.tasks.tree)({
            target: seed.target,
            ...(this.plan === undefined
              ? { expectedRevision: seed.revision }
              : {
                  plan: this.plan.target,
                  expectedPlanRevision: this.plan.revision,
                  side,
                }),
            limit: 500,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        this.signal,
        this.timing,
      );
      if (page.tree.target !== seed.target || page.tree.revision !== seed.revision)
        throw new CommandFailure(
          'INCOMPLETE_PLAN',
          'The task plan changed while it was being read.',
        );
      children.push(...page.tree.children);
      comments.push(...page.tree.comments);
      timeEntries.push(...page.tree.timeEntries);
      entries.push(...page.tree.entries);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    if (
      children.length !== seed.childCount ||
      comments.length !== seed.commentCount ||
      timeEntries.length !== seed.timeEntryCount
    )
      throw new CommandFailure('INCOMPLETE_PLAN', 'The task plan was not completely read.');
    return { ...seed, children, comments, timeEntries, entries };
  }
}

export async function canonicalCommandTree(
  api: TasksApiV1,
  page: TaskTreePageV1,
  signal: AbortSignal,
  timing: TreeReadTiming,
): Promise<TaskTreePageV1> {
  const reader = new CanonicalPlanReader(api, timing.plan, signal, {
    ...timing,
    deadline: Math.min(timing.deadline, timing.now() + 5000),
  });
  const base = { ...page };
  Reflect.deleteProperty(base, 'nextCursor');
  try {
    return {
      ...base,
      complete: true,
      truncated: false,
      tree: required((await reader.tree(page.tree, timing.side ?? 'after')) ?? undefined),
    };
  } catch (cause) {
    if (cause instanceof CommandFailure && cause.code === 'TREE_READ_LIMIT') return page;
    throw cause;
  }
}
