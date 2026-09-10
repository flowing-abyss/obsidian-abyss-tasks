import { describe, expect, it } from 'vitest';
import { migrateSettings } from '../src/settings/migration';
import { defaultShortcuts } from '../src/settings/shortcuts';
import { expectDefined } from './helpers';

describe('migrateSettings', () => {
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
  it('adds an empty property definition map to legacy project settings', () => {
    const raw: Record<string, unknown> = { projects: {} };

    migrateSettings(raw);

    expect((raw['projects'] as Record<string, unknown>)['propertyDefinitions']).toEqual({});
  });

  it('retains malformed and ambiguous definitions as exact recovery evidence', () => {
    const definitions = {
      'property:Effort': { type: 'bogus', future: { raw: true } },
      'property:Phase': { type: 'text' },
      'property:PHASE': { type: 'number' },
    };
    const raw: Record<string, unknown> = { projects: { propertyDefinitions: definitions } };

    const result = migrateSettings(raw);
    const projects = raw['projects'] as Record<string, unknown>;

    expect(projects['propertyDefinitions']).toEqual(definitions);
    expect(projects['propertyDefinitionMigration']).toEqual({
      issue: 'invalid-property-definitions',
      propertyDefinitions: definitions,
      invalidKeys: ['property:Effort'],
      ambiguousKeys: [['property:Phase', 'property:PHASE']],
    });
    expect(result.notices).toContain(
      'Some project property definitions could not be loaded. Repair or remove the conflicting definitions in Projects settings; their original values were preserved.',
    );
  });

  it('keeps a valid configured type active while retaining malformed preset evidence', () => {
    const definition = {
      type: 'text',
      presetsEnabled: true,
      presets: [{ value: ['invalid'], displayName: 7 }],
    };
    const raw: Record<string, unknown> = {
      projects: { propertyDefinitions: { 'property:Effort': definition } },
    };

    const result = migrateSettings(raw);
    const projects = raw['projects'] as Record<string, unknown>;

    expect(projects['propertyDefinitions']).toEqual({ 'property:Effort': definition });
    expect(projects['propertyDefinitionMigration']).toMatchObject({
      propertyDefinitions: { 'property:Effort': definition },
      invalidKeys: ['property:Effort'],
    });
    expect(result.notices).toHaveLength(1);
  });

  it('migrates one legacy property source using the persisted value as the literal name', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [
          {
            id: 'a',
            label: 'Active',
            match: { kind: 'property', property: 'status', value: 'active' },
            onLeftPanel: true,
          },
        ],
      },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as {
      statusProperty: string;
      statuses: Array<Record<string, unknown>>;
    };
    expect(projects.statusProperty).toBe('status');
    expect(projects.statuses[0]).toMatchObject({ id: 'a', name: 'active' });
    expect(projects.statuses[0]).not.toHaveProperty('label');
    expect(projects.statuses[0]).not.toHaveProperty('match');
  });

  it('normalizes the new project metadata shape idempotently', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statusProperty: 'Статус',
        startProperty: 'Начало',
        endProperty: 'Конец',
        statuses: [{ id: 'a', name: 'активный', onLeftPanel: true }],
        defaultStatusId: 'a',
      },
    };

    migrateSettings(raw);
    const once = structuredClone(raw);
    migrateSettings(raw);

    expect(raw).toEqual(once);
  });

  it('retains conflicting legacy source evidence instead of choosing or erasing definitions', () => {
    const legacyStatuses = [
      {
        id: 'a',
        label: 'Active',
        match: { kind: 'property', property: 'status', value: 'active' },
        onLeftPanel: true,
      },
      {
        id: 'q',
        label: 'Queued',
        match: { kind: 'property', property: 'phase', value: 'queued' },
        onLeftPanel: false,
      },
    ];
    const raw: Record<string, unknown> = { projects: { statuses: legacyStatuses } };

    migrateSettings(raw);

    const projects = raw['projects'] as Record<string, unknown>;
    expect(projects['statusMigration']).toEqual({
      issue: 'conflicting-properties',
      legacyStatuses,
      propertyCandidates: ['status', 'phase'],
    });
    expect(projects['statuses']).toEqual([
      { id: 'a', name: 'active', onLeftPanel: true },
      { id: 'q', name: 'queued', onLeftPanel: false },
    ]);
  });

  it('retains malformed legacy name evidence without binding or crashing', () => {
    const malformed = [
      {
        id: 'a',
        label: 'Active',
        match: { kind: 'property', property: 'status', value: '' },
        onLeftPanel: true,
      },
    ];
    const raw: Record<string, unknown> = { projects: { statuses: malformed } };

    migrateSettings(raw);

    const projects = raw['projects'] as Record<string, unknown>;
    expect(projects['statusProperty']).toBe('');
    expect(projects['statusMigration']).toEqual({
      issue: 'invalid-statuses',
      legacyStatuses: malformed,
      propertyCandidates: [],
    });
    expect(projects['statuses']).toEqual([
      { id: 'status-1', name: 'active', color: '#4caf50', onLeftPanel: true },
      { id: 'status-2', name: 'planned', color: '#2196f3', onLeftPanel: false },
      { id: 'status-3', name: 'done', color: '#888888', onLeftPanel: false },
    ]);
  });

  it('removes legacy tag definitions while retaining ordinary settings tags and reports one notice', () => {
    const raw: Record<string, unknown> = {
      pinnedTags: ['#keep'],
      projects: {
        statuses: [
          {
            id: 'tag',
            label: 'Tagged',
            match: { kind: 'tag', tag: '#project/active' },
            onLeftPanel: true,
          },
          {
            id: 'done',
            label: 'Done',
            match: { kind: 'property', property: 'status', value: 'done' },
            onLeftPanel: false,
          },
        ],
      },
    };

    const result = migrateSettings(raw);

    const projects = raw['projects'] as { statuses: Array<{ id: string }> };
    expect(projects.statuses.map(({ id }) => id)).toEqual(['done']);
    expect(raw['pinnedTags']).toEqual(['#keep']);
    expect(result.notices).toEqual([
      'Project tag statuses were removed. Their note tags are unchanged; choose a Status property in Projects settings.',
    ]);
  });

  it('adds projects + sectionCollapse when missing', () => {
    const raw: Record<string, unknown> = {};
    migrateSettings(raw);
    const projects = raw['projects'] as { statuses: unknown[]; defaultStatusId: string };
    expect(Array.isArray(projects.statuses)).toBe(true);
    expect(projects.statuses.length).toBeGreaterThan(0);
    const ids = (projects.statuses as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(projects.defaultStatusId);
    expect(raw['sectionCollapse']).toEqual({ pinned: false, projects: false, tags: false });
  });
  it('repoints a dangling defaultStatusId to the first status', () => {
    const raw: Record<string, unknown> = {};
    migrateSettings(raw);
    const projects = raw['projects'] as {
      statuses: Array<{ id: string }>;
      defaultStatusId: string;
    };
    projects.defaultStatusId = 'nonexistent';
    migrateSettings(raw);
    expect(projects.defaultStatusId).toBe(expectDefined(projects.statuses[0]).id);
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

  it('adds table defaults to old project settings without discarding sibling settings', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [{ id: 'a' }],
        defaultStatusId: 'a',
        view: 'external-build-value',
        workNoteCompatibility: { enabled: true },
      },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as Record<string, unknown>;
    expect(projects['table']).toEqual({
      columns: [
        { id: 'name', visible: true },
        { id: 'status', visible: true },
        { id: 'progress', visible: true },
        { id: 'start', visible: true },
        { id: 'end', visible: true },
      ],
      showDescription: true,
      groupBy: 'status',
      sortBy: { field: 'start', dir: 'asc' },
      hiddenStatuses: [],
    });
    expect(projects['view']).toBe('external-build-value');
    expect(projects['workNoteCompatibility']).toEqual({ enabled: true });
  });

  it('deep-fills table defaults while preserving column aliases, widths and order', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statuses: [{ id: 'a' }],
        defaultStatusId: 'a',
        table: {
          columns: [
            { id: 'property:Budget', label: 'Cost', width: 240, visible: false },
            { id: 'name', visible: true },
          ],
          groupBy: 'property:Budget',
          sortBy: { field: 'property:Budget', dir: 'desc' },
          hiddenStatuses: ['id:a'],
        },
      },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as { table: Record<string, unknown> };
    expect(projects.table['columns']).toEqual([
      { id: 'name', visible: true },
      { id: 'property:Budget', label: 'Cost', width: 240, visible: false },
      { id: 'status', visible: true },
      { id: 'progress', visible: true },
      { id: 'start', visible: true },
      { id: 'end', visible: true },
    ]);
    expect(projects.table['groupBy']).toBe('property:Budget');
    expect(projects.table['sortBy']).toEqual({ field: 'property:Budget', dir: 'desc' });
    expect(projects.table['hiddenStatuses']).toEqual(['id:a']);
  });

  it('restores all five curated columns and keeps Name first and visible', () => {
    const raw: Record<string, unknown> = {
      projects: {
        statusProperty: 'status',
        startProperty: 'start',
        endProperty: 'end',
        statuses: [{ id: 'a', name: 'active', onLeftPanel: true }],
        defaultStatusId: 'a',
        table: { columns: [{ id: 'name', visible: false }] },
      },
    };

    migrateSettings(raw);

    const projects = raw['projects'] as {
      table: { columns: Array<{ id: string; visible: boolean }> };
    };
    expect(projects.table.columns).toEqual([
      { id: 'name', visible: true },
      { id: 'status', visible: true },
      { id: 'progress', visible: true },
      { id: 'start', visible: true },
      { id: 'end', visible: true },
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
    expect(expectDefined((raw['taskStatuses'] as Array<{ symbol: string }>)[0]).symbol).toBe('q');
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
    const entry = expectDefined((raw['taskStatuses'] as Array<Record<string, unknown>>)[0]);
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
    const entry = expectDefined((raw['taskStatuses'] as Array<Record<string, unknown>>)[0]);
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
    const entry = expectDefined((raw['taskStatuses'] as Array<Record<string, unknown>>)[0]);
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
    const entry = expectDefined((raw['taskStatuses'] as Array<Record<string, unknown>>)[0]);
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
    const state = expectDefined(
      (raw['listViewStates'] as Record<string, Record<string, unknown>>)['today'],
    );
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
    const state = expectDefined(
      (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox'],
    );
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
    const state = expectDefined(
      (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox'],
    );
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
    const state = expectDefined(
      (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox'],
    );
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
    const state = expectDefined(
      (raw['listViewStates'] as Record<string, Record<string, unknown>>)['inbox'],
    );
    expect(state['statusGroups']).toEqual(['todo', 'in-progress']);
  });

  it('does nothing when listViewStates is absent', () => {
    const raw: Record<string, unknown> = {};
    expect(() => {
      migrateSettings(raw);
    }).not.toThrow();
    expect(raw['listViewStates']).toBeUndefined();
  });
});
