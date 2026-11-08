import type { TaskTreeV1 } from '../../../api';
import type { CommandSessionOwner } from '../../ai/CommandSessionOwner';
/** Read-only bounded expansion. Ownership stays with the public session client. */
export class CommandTreeReader {
  private count = 0;
  constructor(
    private readonly owner: CommandSessionOwner,
    private readonly current: () => boolean,
  ) {}
  private check(): void {
    if (!this.current() || ++this.count > 512) throw new Error('Tree expansion stopped.');
  }
  async tree(node: TaskTreeV1): Promise<TaskTreeV1> {
    this.check();
    const current = node.complete ? node : await this.entries(node);
    const children: TaskTreeV1[] = [];
    for (const child of current.children) children.push(await this.tree(child));
    return { ...current, children, complete: true, truncated: false };
  }
  private async entries(node: TaskTreeV1): Promise<TaskTreeV1> {
    let cursor: string | undefined;
    const children: TaskTreeV1[] = [],
      comments: Array<TaskTreeV1['comments'][number]> = [],
      entries: Array<TaskTreeV1['entries'][number]> = [],
      timeEntries: Array<TaskTreeV1['timeEntries'][number]> = [];
    do {
      this.check();
      const page = await this.owner.readTreePage({
        target: node.target,
        expectedRevision: node.revision,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.tree.target !== node.target || page.tree.revision !== node.revision)
        throw new Error('Task changed.');
      children.push(...page.tree.children);
      comments.push(...page.tree.comments);
      entries.push(...page.tree.entries);
      timeEntries.push(...page.tree.timeEntries);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    if (
      children.length !== node.childCount ||
      comments.length !== node.commentCount ||
      timeEntries.length !== node.timeEntryCount
    )
      throw new Error('Incomplete tree.');
    return { ...node, children, comments, entries, timeEntries };
  }
}
