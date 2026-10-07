/** Golden outputs generated from git archive 76c667a7697defa85529f2c2e2689fe8b659ab8e.
 * Task 2 intentionally updates only Upcoming start-only and own-tag destination membership.
 * The old implementation is an ignored, temporary oracle, never a production dependency.
 */
import { expect, it } from 'vitest';
import type { ListSelection } from '../src/app/AppState';
import { drainCollectionSteps } from '../src/collectionSteps';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ListViewState } from '../src/settings/types';
import { outgoingTaskLinkValues } from '../src/task-lists/taskLinkValues';
import {
  organizeTaskSearch as organizationSteps,
  type TaskSearchOrganizationInput,
} from '../src/task-lists/taskSearchOrganization';
import { localDate, type TaskOrganizationRecord } from '../src/tasks';
import { expectDefined } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
const organizeTaskSearch = (input: TaskSearchOrganizationInput) =>
  drainCollectionSteps(organizationSteps(input));

it('matches checkpoint ordering, groups, counts, scores, aliases and membership', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.tagGroups = [
    { id: 'work', name: 'Work', mode: 'manual', tags: ['#work', '#WORK', '#nested/child'] },
    { id: 'prefix', name: 'Prefix', mode: 'prefix', prefix: '#branch' },
    { id: 'discovered:tag:loose', name: 'Collision', mode: 'manual', tags: [] },
  ];
  settings.archivedTags = ['#loose'];
  settings.archivedTagPrefixes = ['archived'];
  settings.taskStatuses.push({
    ...expectDefined(settings.taskStatuses[0]),
    id: 'duplicate',
    symbol: 'x',
  });
  const h = await createCanonicalSearchHarness(
    {
      'a/Same.md':
        '- [ ] Éclair [[A|alias]] [[A#h]] [[B]] #work 📅 2026-10-04 ⏫\n  - [ ] child #nested/child\n    - 2026-10-04T10:00:00+07:00 →\n- [X] Same ➕ 2026-10-01\n- [?] éé #branch/one 🛫 2026-10-05\n- [ ] Same\n- [ ] éclair #loose',
      'b/Same.md':
        '- [ ] Same ➕ 2026-10-02\n- [ ] Same ➕ 2026-10-01\n- [/] 中文 [[Unknown]] #archived/one ⏳ 2026-10-03\n- [ ] العربية [[B]] #home\n- [ ] \u{1f600} [[A]]',
    },
    settings,
  );
  try {
    const source = h.index.searchSource().subscribe(() => {});
    const generation = source.state.generation;
    source.unsubscribe();
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    const output: Record<string, unknown> = {};
    const fields: Array<ListViewState['sortBy']['field']> = [
      'date',
      'priority',
      'title',
      'tag',
      'status',
      'tracked',
      'source-note',
      'outgoing-link',
    ];
    const groups: Array<ListViewState['groupBy']> = [
      'none',
      'date',
      'priority',
      'tag',
      'status',
      'source-note',
      'outgoing-link',
    ];
    const selections: Array<ListSelection | null> = [
      null,
      'inbox',
      'today',
      'upcoming',
      { type: 'project', path: 'a/Same.md' },
      { type: 'tag', tag: '#NESTED/child' },
      { type: 'group', groupId: 'work' },
      { type: 'group', groupId: 'prefix' },
      { type: 'group', groupId: 'discovered:prefix:ARCHIVED' },
      { type: 'group', groupId: 'discovered:tag:loose::1' },
    ];
    const run = (
      key: string,
      list: ListViewState,
      selection: ListSelection | null,
      options: { relevance?: boolean; context?: boolean; renamed?: boolean; nowMs?: number } = {},
    ): void => {
      const {
        relevance = false,
        context = false,
        renamed = false,
        nowMs = 1791084000000,
      } = options;
      const resolve = (target: string): string | undefined => {
        if (target === 'A') return renamed ? 'renamed/Same.md' : 'a/Same.md';
        return target === 'B' ? 'b/Same.md' : undefined;
      };
      const outgoingLinks = new Map(
        records.map((r) => [
          `${r.source.filePath}:${r.source.line}`,
          outgoingTaskLinkValues(r, resolve),
        ]),
      );
      const result = organizeTaskSearch({
        generation,
        records: [...records].reverse(),
        hits: context
          ? null
          : records.map((r, i) => ({ address: r.address, score: i % 3 })).reverse(),
        selection,
        view: { list, relevance },
        settings,
        today: localDate('2026-10-04'),
        nowMs,
        outgoingLinks,
      });
      output[key] = {
        total: result.rootTotal,
        counts: [...result.groupCounts],
        rows: result.occurrences.map((o) => [o.key, o.score, o.group]),
      };
    };
    for (const field of fields)
      for (const groupBy of groups)
        for (const dir of ['asc', 'desc'] as const)
          run(`${field}/${groupBy}/${dir}`, { sortBy: { field, dir }, groupBy, filters: [] }, null);
    const list: ListViewState = {
      sortBy: { field: 'tracked', dir: 'desc' },
      groupBy: 'outgoing-link',
      filters: [],
    };
    for (let i = 0; i < selections.length; i++)
      for (const context of [false, true])
        run(`membership/${i}/${context}`, list, selections[i] ?? null, {
          relevance: true,
          context,
        });
    const filters: ListViewState['filters'] = [
      { type: 'tag', value: '#work' },
      { type: 'file', filePath: 'b/Same.md' },
      { type: 'time', value: 'undefined' },
      { type: 'priority', value: 'B' },
      { type: 'status', value: 'X' },
      { type: 'date', value: '2026-10-04' },
    ];
    for (let i = 0; i < filters.length; i++)
      run(
        `filter/${i}`,
        { ...list, filters: [expectDefined(filters[i])], statusGroups: ['todo', 'in-progress'] },
        null,
      );
    run('renamed', list, null, { renamed: true });
    run('later-tracking', list, null, { nowMs: 1791087600000 });
    expect(output).toMatchSnapshot();
  } finally {
    h.close();
  }
});

it('uses compact record depth to keep untagged Inbox and project populations root-only', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.inbox.mode = 'untagged';
  const h = await createCanonicalSearchHarness(
    { 'depth.md': '- [ ] Root\n  - [ ] Child\n    - [ ] Deep' },
    settings,
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    expect(records).toHaveLength(3);
    for (const selection of ['inbox', { type: 'project', path: 'depth.md' }, null] as const) {
      const result = organizeTaskSearch({
        generation,
        records,
        hits: null,
        selection,
        settings,
        today: localDate('2026-10-08'),
        nowMs: 0,
        outgoingLinks: new Map(),
        view: {
          relevance: false,
          list: { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
        },
      });
      expect(result.occurrences.map(({ taskKey }) => taskKey)).toEqual(['depth.md:0']);
    }
  } finally {
    h.close();
  }
});
