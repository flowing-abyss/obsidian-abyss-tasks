import { describe, expect, it, vi } from 'vitest';
import TaskCalendarPlugin from '../src/main';
import { acceptWorkNoteAudit } from '../src/projects/work-notes/compatibility';
import type { WorkNoteCompatibilityPreset } from '../src/projects/work-notes/types';
import { migrateSettings } from '../src/settings/migration';
import { defaultShortcuts } from '../src/settings/shortcuts';

describe('migrateSettings', () => {
  it('adds versioned Project board and scope-specific timeline preferences', () => {
    const raw: Record<string, unknown> = {};

    migrateSettings(raw);

    const projects = raw['projects'] as {
      statuses: Array<{ id: string }>;
      view: Record<string, unknown>;
    };
    expect(projects.view['board']).toEqual({
      version: 1,
      columnOrder: projects.statuses.map(({ id }) => id),
      collapsedColumnIds: [],
      hiddenColumnIds: [],
    });
    expect(projects.view['timeline']).toEqual({
      version: 1,
      portfolio: { scale: 'quarter', identityWidth: 240 },
      tasks: { scale: 'week', identityWidth: 240 },
      workNotes: { dateRange: 'month', identityWidth: 240 },
    });
  });

  it('reconciles Project board IDs and clamps invalid timeline preferences', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [
          { id: 'active', label: 'Active', behavior: 'regular' },
          { id: 'planned', label: 'Planned', behavior: 'regular' },
          { id: 'done', label: 'Done', behavior: 'completed' },
        ],
        defaultStatusId: 'active',
        view: {
          board: {
            version: 1,
            statusIds: ['planned', 'retired', 'planned', 'active'],
            dormantStatusIds: ['legacy', 'retired'],
          },
          timeline: {
            version: 1,
            portfolio: { scale: 'day', identityWidth: 999 },
            tasks: { scale: 'quarter', identityWidth: 10 },
            workNotes: { dateRange: 'century', identityWidth: 999 },
          },
        },
      },
    };

    migrateSettings(raw);

    const view = (raw['projects'] as { view: Record<string, unknown> }).view;
    expect(view['board']).toEqual({
      version: 1,
      columnOrder: ['planned', 'active', 'done', 'retired', 'legacy'],
      collapsedColumnIds: [],
      hiddenColumnIds: [],
    });
    expect(view['timeline']).toEqual({
      version: 1,
      portfolio: { scale: 'quarter', identityWidth: 360 },
      tasks: { scale: 'week', identityWidth: 160 },
      workNotes: { dateRange: 'month', identityWidth: 360 },
    });
  });

  it('adds Table preferences without discarding unknown columns, dormant statuses, or Board/Timeline values', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [{ id: 'active', label: 'Active', behavior: 'regular' }],
        defaultStatusId: 'active',
        view: {
          portfolioLayout: 'board',
          visibleStatusIds: ['active', 'retired'],
          includeUnmapped: false,
          board: {
            version: 1,
            columnOrder: ['retired', 'active'],
            collapsedColumnIds: ['retired'],
            hiddenColumnIds: [],
          },
          timeline: {
            version: 1,
            portfolio: { scale: 'month', identityWidth: 280 },
            tasks: { scale: 'day', identityWidth: 220 },
            workNotes: { dateRange: 'year', identityWidth: 300 },
          },
          table: {
            version: 1,
            columns: [
              { propertyId: 'project', visible: true, width: 260 },
              { propertyId: 'legacy-property', visible: false },
            ],
            collapsedGroups: ['retired'],
          },
          tasks: {
            groupBy: 'priority',
            sortBy: { field: 'title', dir: 'desc' },
            filters: [],
            table: {
              version: 1,
              columns: [
                { propertyId: 'task', visible: true, width: 300 },
                { propertyId: 'legacy-column', visible: true },
              ],
              collapsedGroups: ['legacy-group'],
            },
          },
        },
      },
    };

    migrateSettings(raw);
    const once = structuredClone(raw);
    migrateSettings(raw);

    expect(raw).toEqual(once);
    const view = (raw['projects'] as { view: Record<string, unknown> }).view;
    expect(view['visibleStatusIds']).toEqual(['active', 'retired']);
    expect(view['board']).toEqual({
      version: 1,
      columnOrder: ['active', 'retired'],
      collapsedColumnIds: ['retired'],
      hiddenColumnIds: [],
    });
    expect(view['timeline']).toEqual({
      version: 1,
      portfolio: { scale: 'month', identityWidth: 280 },
      tasks: { scale: 'day', identityWidth: 220 },
      workNotes: { dateRange: 'year', identityWidth: 300 },
    });
    expect(view['table']).toEqual({
      version: 1,
      columns: [
        { propertyId: 'project', visible: true, width: 260 },
        { propertyId: 'legacy-property', visible: false },
      ],
      collapsedGroups: ['retired'],
    });
    expect((view['tasks'] as Record<string, unknown>)['table']).toEqual({
      version: 1,
      columns: [
        { propertyId: 'task', visible: true, width: 300 },
        { propertyId: 'legacy-column', visible: true },
      ],
      collapsedGroups: ['legacy-group'],
    });
  });

  it('defaults Project and Project Task Table columns for legacy settings', () => {
    const raw: Record<string, unknown> = {};

    migrateSettings(raw);

    const view = (raw['projects'] as { view: Record<string, unknown> }).view;
    expect(view['table']).toEqual({
      version: 1,
      columns: [
        { propertyId: 'project', visible: true },
        { propertyId: 'status', visible: true },
        { propertyId: 'priority', visible: true },
        { propertyId: 'progress', visible: true },
        { propertyId: 'nextAction', visible: true },
        { propertyId: 'start', visible: true },
        { propertyId: 'end', visible: true },
      ],
      collapsedGroups: [],
    });
    expect((view['tasks'] as Record<string, unknown>)['table']).toEqual({
      version: 1,
      columns: [
        { propertyId: 'task', visible: true },
        { propertyId: 'status', visible: true },
        { propertyId: 'priority', visible: true },
        { propertyId: 'due', visible: true },
        { propertyId: 'nextAction', visible: true },
      ],
      collapsedGroups: [],
    });
  });

  it('creates a complete shortcut collection when legacy settings have none', () => {
    const raw: Record<string, unknown> = {};

    migrateSettings(raw);

    expect(raw['shortcuts']).toEqual(defaultShortcuts());
  });

  it('deep-fills missing shortcut actions while preserving raw shortcut strings', () => {
    const raw: Record<string, unknown> = {
      shortcuts: {
        openQuickCapture: 'Q | shift 7',
        openTasks: 'Ctrl+L',
        openInbox: 'Shift I',
      },
    };

    migrateSettings(raw);

    expect(raw['shortcuts']).toEqual({
      ...defaultShortcuts(),
      openQuickCapture: 'Q | shift 7',
      openTasks: 'Ctrl+L',
      openInbox: 'Shift I',
    });
  });

  it('heals malformed shortcut values, drops unknown actions, and is idempotent', () => {
    const raw: Record<string, unknown> = {
      shortcuts: {
        openQuickCapture: 9,
        openTasks: 'not a supported binding',
        unknownAction: 'Q',
      },
    };

    migrateSettings(raw);
    const once = structuredClone(raw);
    migrateSettings(raw);

    expect(raw).toEqual(once);
    expect(raw['shortcuts']).toEqual({
      ...defaultShortcuts(),
      openTasks: 'not a supported binding',
    });
  });

  it('replaces a malformed shortcut collection with fresh defaults', () => {
    const raw: Record<string, unknown> = { shortcuts: ['Q'] };

    migrateSettings(raw);

    expect(raw['shortcuts']).toEqual(defaultShortcuts());
  });

  it('adds lifecycle and recurrence defaults without persisting during migration', () => {
    const raw: Record<string, unknown> = {};

    migrateSettings(raw);

    expect(raw['taskLifecycle']).toEqual({ addCreatedDate: true, addCompletionDate: true });
    expect(raw['recurrence']).toEqual({
      newOccurrencePlacement: 'before',
      removeScheduledDate: false,
    });
  });

  it('preserves lifecycle and recurrence preferences and is idempotent', () => {
    const raw: Record<string, unknown> = {
      taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
      recurrence: { newOccurrencePlacement: 'after', removeScheduledDate: true },
    };

    migrateSettings(raw);
    const once = structuredClone(raw);
    migrateSettings(raw);

    expect(raw).toEqual(once);
    expect(raw['taskLifecycle']).toEqual({ addCreatedDate: false, addCompletionDate: false });
    expect(raw['recurrence']).toEqual({
      newOccurrencePlacement: 'after',
      removeScheduledDate: true,
    });
  });

  it('loads migrated lifecycle settings without saving them back', async () => {
    const plugin = Object.create(TaskCalendarPlugin.prototype) as TaskCalendarPlugin & {
      loadData: ReturnType<typeof vi.fn>;
      saveData: ReturnType<typeof vi.fn>;
    };
    plugin.loadData = vi.fn().mockResolvedValue({});
    plugin.saveData = vi.fn().mockResolvedValue(undefined);

    await plugin.loadSettings();

    expect(plugin.settings.taskLifecycle).toEqual({
      addCreatedDate: true,
      addCompletionDate: true,
    });
    expect(plugin.settings.recurrence).toEqual({
      newOccurrencePlacement: 'before',
      removeScheduledDate: false,
    });
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it('adds missing pinnedTags and archivedTags arrays', () => {
    const raw: Record<string, unknown> = {};
    migrateSettings(raw);
    expect(raw['pinnedTags']).toEqual([]);
    expect(raw['archivedTags']).toEqual([]);
  });

  it('converts old inboxMode=tag + inboxTag to inbox object', () => {
    const raw: Record<string, unknown> = { inboxMode: 'tag', inboxTag: '#inbox' };
    migrateSettings(raw);
    expect(raw['inbox']).toEqual({
      mode: 'tag',
      tag: '#inbox',
      removeTagOnAssign: true,
    });
    expect(raw['inboxMode']).toBeUndefined();
    expect(raw['inboxTag']).toBeUndefined();
  });

  it('converts old inboxMode=untagged to inbox with untagged mode', () => {
    const raw: Record<string, unknown> = { inboxMode: 'untagged', inboxTag: '#inbox' };
    migrateSettings(raw);
    expect((raw['inbox'] as Record<string, unknown>)['mode']).toBe('untagged');
    expect((raw['inbox'] as Record<string, unknown>)['showUntagged']).toBeUndefined();
    expect(raw['inboxMode']).toBeUndefined();
  });

  it('folds legacy showUntagged=true on tag mode into both mode and strips the flag', () => {
    const raw: Record<string, unknown> = {
      inbox: { mode: 'tag', tag: '#inbox', showUntagged: true, removeTagOnAssign: true },
    };
    migrateSettings(raw);
    const inbox = raw['inbox'] as Record<string, unknown>;
    expect(inbox['mode']).toBe('both');
    expect(inbox['showUntagged']).toBeUndefined();
  });

  it('strips legacy showUntagged without changing a non-tag mode', () => {
    const existing = {
      mode: 'both',
      tag: '#task/inbox',
      showUntagged: true,
      removeTagOnAssign: false,
    };
    const raw: Record<string, unknown> = { inbox: existing };
    migrateSettings(raw);
    expect(raw['inbox']).toBe(existing);
    expect((raw['inbox'] as Record<string, unknown>)['mode']).toBe('both');
    expect((raw['inbox'] as Record<string, unknown>)['showUntagged']).toBeUndefined();
  });

  it('preserves existing pinnedTags if already present', () => {
    const raw: Record<string, unknown> = { pinnedTags: ['#task/next'] };
    migrateSettings(raw);
    expect(raw['pinnedTags']).toEqual(['#task/next']);
  });
});

describe('projects migration', () => {
  it('adds a disabled Work Note compatibility preset without accepting an audit', () => {
    const raw: Record<string, unknown> = {};

    migrateSettings(raw);

    const projects = raw['projects'] as Record<string, unknown>;
    expect(projects['workNoteCompatibility']).toMatchObject({
      revision: 1,
      enabled: false,
    });
    expect(projects['workNoteCompatibility']).not.toHaveProperty('acceptedAudit');
  });

  it('preserves unchanged accepted Work Note settings and clears stale acceptance', () => {
    const accepted = {
      revision: 1,
      enabled: true,
      membershipQuery: '#work-note',
      ordinaryKindQuery: '#work-note/task',
      milestoneKindQuery: '#work-note/milestone',
      folder: 'Tasks',
      fields: {
        project: 'Project',
        status: 'Status',
        priority: 'Priority',
        description: 'Description',
        start: 'Start',
        end: 'End',
        created: 'Created',
        updated: 'Updated',
        id: 'ID',
        milestone: 'Milestone',
        blockedBy: 'Blocked by',
        related: 'Related',
      },
      rawStatusByStatusId: { active: 'Active' },
      acceptedAudit: {
        presetFingerprint: 'stale',
        acceptedRevision: 1,
        acceptedAt: '2026-08-26T00:00:00.000Z',
        capabilities: { update: true, create: false },
      },
    };
    const raw: Record<string, unknown> = {
      projects: { statuses: [], workNoteCompatibility: accepted },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as { workNoteCompatibility: typeof accepted };
    expect(projects.workNoteCompatibility).toBe(accepted);
    expect(projects.workNoteCompatibility.acceptedAudit).toBeUndefined();
  });

  it('round-trips a structurally valid accepted preset without semantic mutation', () => {
    const candidate: WorkNoteCompatibilityPreset = {
      revision: 14,
      enabled: true,
      membershipQuery: 'Work Notes/ AND #work-note',
      ordinaryKindQuery: '#work-note/task',
      milestoneKindQuery: '#work-note/milestone',
      folder: 'Work Notes',
      fields: {
        project: 'Project',
        status: 'Status',
        priority: 'Priority',
        description: 'Description',
        start: 'Start',
        end: 'End',
        created: 'Created',
        updated: 'Updated',
        id: 'ID',
        milestone: 'Milestone',
        blockedBy: 'Blocked by',
        related: 'Related',
      },
      rawStatusByStatusId: { active: 'Active', done: 'Done' },
      creation: {
        folder: 'Work Notes',
        templatePath: 'Templates/Work note.md',
        defaultKind: 'ordinary',
        defaultStatusId: 'active',
        kindMarkers: {
          ordinary: { kind: 'frontmatter-tag', value: 'work-note/task' },
          milestone: { kind: 'frontmatter-tag', value: 'work-note/milestone' },
        },
      },
    };
    const accepted = Object.assign(
      acceptWorkNoteAudit(candidate, { update: true, create: true }, '2026-08-28T00:00:00.000Z'),
      { futureCompatibilityOption: { preserve: ['exactly'] } },
    );
    const raw: Record<string, unknown> = {
      projects: { statuses: [], workNoteCompatibility: accepted },
    };
    const before = structuredClone(accepted);

    migrateSettings(raw);

    const migrated = (raw['projects'] as { workNoteCompatibility: unknown }).workNoteCompatibility;
    expect(migrated).toEqual(before);
    expect(migrated).toBe(accepted);
  });

  it('replaces a malformed persisted creation contract with a disabled preset', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [],
        workNoteCompatibility: {
          revision: 1,
          enabled: true,
          membershipQuery: '#work-note',
          ordinaryKindQuery: '#work-note/task',
          milestoneKindQuery: '#work-note/milestone',
          folder: 'Tasks',
          fields: {
            project: 'Project',
            status: 'Status',
            priority: 'Priority',
            description: 'Description',
            start: 'Start',
            end: 'End',
            created: 'Created',
            updated: 'Updated',
            id: 'ID',
            milestone: 'Milestone',
            blockedBy: 'Blocked by',
            related: 'Related',
          },
          rawStatusByStatusId: { active: 'Active' },
          creation: { folder: '../outside', defaultKind: 'ordinary' },
        },
      },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as Record<string, Record<string, unknown>>;
    expect(projects['workNoteCompatibility']).toMatchObject({ enabled: false, revision: 1 });
  });

  it('migrates separate persisted Task and Work Note view states without changing the fresh route', () => {
    const raw: Record<string, unknown> = {};

    migrateSettings(raw);

    const projects = raw['projects'] as {
      statuses: Array<{ id: string }>;
      view: {
        portfolioLayout: string;
        visibleStatusIds: string[];
        includeUnmapped: boolean;
        tasks: { groupBy: string; sortBy: unknown; filters: unknown[] };
        workNotes: { groupBy: string; sortBy: unknown; statusIds: string[] };
      };
    };
    expect(projects.view.portfolioLayout).toBe('overview');
    expect(projects.view.visibleStatusIds).toEqual(projects.statuses.map(({ id }) => id));
    expect(projects.view.includeUnmapped).toBe(true);
    expect(projects.view.tasks.groupBy).toBe('none');
    expect(projects.view.workNotes.groupBy).toBe('none');
    expect(projects.view.workNotes.statusIds).toEqual(projects.statuses.map(({ id }) => id));
    expect(projects.view.tasks).not.toBe(projects.view.workNotes);
  });

  it('preserves independent Task and Work Note view state and migrates idempotently', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [{ id: 'active', label: 'Active', behavior: 'regular' }],
        defaultStatusId: 'active',
        view: {
          portfolioLayout: 'board',
          visibleStatusIds: [],
          includeUnmapped: false,
          tasks: {
            groupBy: 'priority',
            sortBy: { field: 'title', dir: 'desc' },
            filters: [{ type: 'priority', value: 'A' }],
            statusGroups: ['todo'],
          },
          workNotes: {
            groupBy: 'milestone',
            sortBy: { field: 'updated', dir: 'asc' },
            statusIds: [],
          },
        },
      },
    };

    migrateSettings(raw);
    const once = structuredClone(raw);
    migrateSettings(raw);

    expect(raw).toEqual(once);
    const view = (raw['projects'] as { view: Record<string, unknown> }).view;
    expect(view['portfolioLayout']).toBe('board');
    expect(view['visibleStatusIds']).toEqual([]);
    expect(view['includeUnmapped']).toBe(false);
    expect(view['tasks']).toMatchObject({
      groupBy: 'priority',
      sortBy: { field: 'title', dir: 'desc' },
      statusGroups: ['todo'],
    });
    expect(view['workNotes']).toMatchObject({
      groupBy: 'milestone',
      sortBy: { field: 'updated', dir: 'asc' },
      statusIds: [],
    });
  });

  it('adds projects + sectionCollapse when missing', () => {
    const raw: Record<string, unknown> = {};
    migrateSettings(raw);
    const projects = raw['projects'] as { statuses: unknown[]; defaultStatusId: string };
    expect(Array.isArray(projects.statuses)).toBe(true);
    expect(projects.statuses.length).toBeGreaterThan(0);
    const ids = (projects.statuses as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(projects.defaultStatusId);
    expect(raw['sectionCollapse']).toEqual({ pinned: false, projects: false, tags: false });
  });
  it('repoints a dangling defaultStatusId to the first status', () => {
    const raw: Record<string, unknown> = {};
    migrateSettings(raw);
    const projects = raw['projects'] as { statuses: { id: string }[]; defaultStatusId: string };
    projects.defaultStatusId = 'nonexistent';
    migrateSettings(raw);
    expect(projects.defaultStatusId).toBe(projects.statuses[0]!.id);
  });
  it('backfills project task-insertion settings on a pre-existing projects config', () => {
    const raw: Record<string, unknown> = {
      projects: { statuses: [{ id: 'a' }], defaultStatusId: 'a' },
    };
    migrateSettings(raw);
    const projects = raw['projects'] as {
      taskInsertionMode: string;
      taskInsertionSection: string;
    };
    expect(projects.taskInsertionMode).toBe('append');
    expect(projects.taskInsertionSection).toBe('## Tasks');
  });
  it('preserves an already-set project task-insertion mode', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [{ id: 'a' }],
        defaultStatusId: 'a',
        taskInsertionMode: 'section',
        taskInsertionSection: '## Todo',
      },
    };
    migrateSettings(raw);
    const projects = raw['projects'] as {
      taskInsertionMode: string;
      taskInsertionSection: string;
    };
    expect(projects.taskInsertionMode).toBe('section');
    expect(projects.taskInsertionSection).toBe('## Todo');
  });

  it('infers only unambiguous normalized English lifecycle labels', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [
          { id: 'a', label: '✅ Done' },
          { id: 'b', label: '🗑 Drop' },
          { id: 'c', label: '🚀 Published' },
          { id: 'd', label: 'Ready to publish' },
          { id: 'e', label: 'Done someday', behavior: 'regular' },
        ],
        defaultStatusId: 'a',
      },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as { statuses: Array<{ behavior: string }> };
    expect(projects.statuses.map((status) => status.behavior)).toEqual([
      'completed',
      'dropped',
      'published',
      'regular',
      'regular',
    ]);
  });
});

describe('task statuses migration', () => {
  it('seeds taskStatuses when missing', () => {
    const raw: Record<string, unknown> = {}; // legacy settings without taskStatuses
    migrateSettings(raw);
    const seeded = raw['taskStatuses'] as unknown[];
    expect(Array.isArray(seeded)).toBe(true);
    expect(seeded).toHaveLength(4);
  });

  it('reseeds to the 4 defaults when taskStatuses is an empty array', () => {
    const raw: Record<string, unknown> = { taskStatuses: [] };
    migrateSettings(raw);
    const seeded = raw['taskStatuses'] as unknown[];
    expect(Array.isArray(seeded)).toBe(true);
    expect(seeded).toHaveLength(4);
  });

  it('never overwrites an existing taskStatuses list', () => {
    const existing = [
      {
        id: 'x',
        symbol: 'q',
        name: 'Q',
        type: 'todo',
        color: '',
        icon: '',
        iconKind: 'glyph',
        core: false,
      },
    ];
    const raw: Record<string, unknown> = { taskStatuses: existing };
    migrateSettings(raw);
    expect(raw['taskStatuses']).toHaveLength(1);
    expect((raw['taskStatuses'] as Array<{ symbol: string }>)[0]!.symbol).toBe('q');
  });

  it('strips legacy color and iconKind fields from every status entry', () => {
    const raw: Record<string, unknown> = {
      taskStatuses: [
        {
          id: 'x',
          symbol: 'q',
          name: 'Q',
          type: 'todo',
          color: '#abc',
          icon: 'star',
          iconKind: 'lucide',
          core: false,
        },
      ],
    };
    migrateSettings(raw);
    const entry = (raw['taskStatuses'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['color']).toBeUndefined();
    expect(entry['iconKind']).toBeUndefined();
    expect(entry['icon']).toBe('star');
  });

  it('clears the icon of a legacy glyph-kind status (glyphs are no longer supported)', () => {
    const raw: Record<string, unknown> = {
      taskStatuses: [
        {
          id: 'x',
          symbol: 'q',
          name: 'Q',
          type: 'todo',
          color: '',
          icon: '*',
          iconKind: 'glyph',
          core: false,
        },
      ],
    };
    migrateSettings(raw);
    const entry = (raw['taskStatuses'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['icon']).toBe('');
    expect(entry['iconKind']).toBeUndefined();
  });

  it('heals a legacy core in-progress status back to the canonical symbol/icon', () => {
    const raw: Record<string, unknown> = {
      taskStatuses: [
        {
          id: 'status-2',
          symbol: '/',
          name: 'In progress',
          type: 'in-progress',
          icon: 'contrast', // drifted from an older build
          core: true,
        },
      ],
    };
    migrateSettings(raw);
    const entry = (raw['taskStatuses'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['icon']).toBe('');
    expect(entry['symbol']).toBe('/');
    expect(entry['type']).toBe('in-progress');
  });

  it('leaves non-core statuses untouched by the core-heal pass', () => {
    const raw: Record<string, unknown> = {
      taskStatuses: [
        {
          id: 'status-5',
          symbol: '!',
          name: 'Important',
          type: 'todo',
          icon: 'alert-triangle',
          core: false,
        },
      ],
    };
    migrateSettings(raw);
    const entry = (raw['taskStatuses'] as Array<Record<string, unknown>>)[0]!;
    expect(entry['icon']).toBe('alert-triangle');
    expect(entry['symbol']).toBe('!');
    expect(entry['type']).toBe('todo');
  });
});

describe('list view state show → statusGroups migration', () => {
  it('migrates show=active to statusGroups=[todo, in-progress] and drops show', () => {
    const raw: Record<string, unknown> = {
      listViewStates: {
        today: {
          groupBy: 'date',
          sortBy: { field: 'date', dir: 'asc' },
          show: 'active',
          filters: [],
        },
      },
    };
    migrateSettings(raw);
    const state = (raw['listViewStates'] as Record<string, Record<string, unknown>>)['today']!;
    expect(state['statusGroups']).toEqual(['todo', 'in-progress']);
    expect(state['show']).toBeUndefined();
  });

  it('migrates show=completed to statusGroups=[done, cancelled]', () => {
    const raw: Record<string, unknown> = {
      listViewStates: {
        inbox: {
          groupBy: 'none',
          sortBy: { field: 'date', dir: 'asc' },
          show: 'completed',
          filters: [],
        },
      },
    };
    migrateSettings(raw);
    const state = (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox']!;
    expect(state['statusGroups']).toEqual(['done', 'cancelled']);
    expect(state['show']).toBeUndefined();
  });

  it('migrates show=all to statusGroups=undefined', () => {
    const raw: Record<string, unknown> = {
      listViewStates: {
        inbox: { groupBy: 'none', sortBy: { field: 'date', dir: 'asc' }, show: 'all', filters: [] },
      },
    };
    migrateSettings(raw);
    const state = (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox']!;
    expect(state['statusGroups']).toBeUndefined();
    expect(state['show']).toBeUndefined();
  });

  it('leaves an already-set statusGroups untouched and still drops show', () => {
    const raw: Record<string, unknown> = {
      listViewStates: {
        inbox: {
          groupBy: 'none',
          sortBy: { field: 'date', dir: 'asc' },
          show: 'active',
          statusGroups: ['done'],
          filters: [],
        },
      },
    };
    migrateSettings(raw);
    const state = (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox']!;
    expect(state['statusGroups']).toEqual(['done']);
    expect(state['show']).toBeUndefined();
  });

  it('leaves state without a show key untouched', () => {
    const raw: Record<string, unknown> = {
      listViewStates: {
        inbox: {
          groupBy: 'none',
          sortBy: { field: 'date', dir: 'asc' },
          statusGroups: ['todo', 'in-progress'],
          filters: [],
        },
      },
    };
    migrateSettings(raw);
    const state = (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox']!;
    expect(state['statusGroups']).toEqual(['todo', 'in-progress']);
  });

  it('does nothing when listViewStates is absent', () => {
    const raw: Record<string, unknown> = {};
    expect(() => migrateSettings(raw)).not.toThrow();
    expect(raw['listViewStates']).toBeUndefined();
  });
});
