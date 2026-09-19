import { describe, expect, it, vi } from 'vitest';
import type { ListSelection } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { discoveredPrefixGroupId, resolveEffectiveTagGroups } from '../src/tags/effectiveTagGroups';
import type { TaskNodeSnapshot } from '../src/tasks';
import type {
  CreateTaskCommandDestination,
  TaskCaptureApplicationApi,
  TaskCreateSession,
} from '../src/tasks/application/TaskApplicationApi';
import type { TaskDestination } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import {
  CaptureTargetResolver,
  commandBodyForCapture,
  type CaptureContext,
  type CaptureTarget,
} from '../src/ui/taskCapture/CaptureTargetResolver';
import { expectDefined, methodOf } from './helpers';

const configuredDestination: TaskDestination = {
  filePath: 'Daily/2026-08-22.md',
  insertion: { type: 'section', heading: '## Tasks', position: 'top' },
};

function readySession(destination: TaskDestination): TaskCreateSession {
  return {
    type: 'ready',
    destination: {
      filePath: destination.filePath,
      insertion: { ...destination.insertion },
    },
    execute: vi.fn(),
  };
}

function application(): TaskCaptureApplicationApi & {
  planCreate: ReturnType<typeof vi.fn<TaskCaptureApplicationApi['planCreate']>>;
} {
  const planCreate = vi.fn<TaskCaptureApplicationApi['planCreate']>(
    async (destination: CreateTaskCommandDestination) =>
      readySession(
        destination.type === 'configured-default' ? configuredDestination : destination.destination,
      ),
  );
  return { planCreate };
}

function settings(overrides: Partial<CalendarSettings> = {}): CalendarSettings {
  return {
    ...DEFAULT_SETTINGS,
    taskPrefix: '#base',
    inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
    tagGroups: [
      { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
      { id: 'manual', name: 'Manual', mode: 'manual', tags: ['#focus', '#later'] },
      { id: 'empty', name: 'Empty', mode: 'manual', tags: [] },
    ],
    projects: {
      ...DEFAULT_SETTINGS.projects,
      taskInsertionMode: 'section',
      taskInsertionSection: '## Project tasks',
    },
    ...overrides,
  };
}

interface Scenario {
  readonly name: string;
  readonly context: CaptureContext;
  readonly settings?: Partial<CalendarSettings>;
  readonly label: string;
  readonly prefix?: string;
  readonly suffixes?: readonly string[];
  readonly due?: string;
  readonly tags?: readonly string[];
  readonly destination?: TaskDestination;
  readonly unavailable?: boolean;
  readonly intent?: 'inbox';
}

const scenarios: readonly Scenario[] = [
  {
    name: 'inbox-tag',
    context: { type: 'list', selection: 'inbox' },
    label: 'Inbox · #task/inbox',
    tags: ['#task/inbox'],
    intent: 'inbox',
  },
  {
    name: 'normalized-inbox-tag',
    context: { type: 'list', selection: 'inbox' },
    settings: { inbox: { mode: 'tag', tag: '##work', removeTagOnAssign: true } },
    label: 'Inbox · #work',
    tags: ['#work'],
    intent: 'inbox',
  },
  {
    name: 'inbox-untagged',
    context: { type: 'list', selection: 'inbox' },
    settings: { inbox: { mode: 'untagged', tag: '#ignored', removeTagOnAssign: true } },
    label: 'Inbox · untagged',
    intent: 'inbox',
  },
  {
    name: 'today',
    context: { type: 'list', selection: 'today' },
    label: 'Today · today',
    due: '2026-08-24',
  },
  {
    name: 'upcoming-tomorrow',
    context: { type: 'list', selection: 'upcoming' },
    label: 'Upcoming · tomorrow',
    due: '2026-08-25',
  },
  {
    name: 'tag',
    context: { type: 'list', selection: { type: 'tag', tag: '#focus' } },
    label: '#focus',
    tags: ['#focus'],
  },
  {
    name: 'prefix-group',
    context: { type: 'list', selection: { type: 'group', groupId: 'prefix' } },
    label: 'Work · #work',
    tags: ['#work'],
  },
  {
    name: 'manual-group-first-tag',
    context: { type: 'list', selection: { type: 'group', groupId: 'manual' } },
    label: 'Manual · #focus',
    tags: ['#focus'],
  },
  {
    name: 'empty-manual-group',
    context: { type: 'list', selection: { type: 'group', groupId: 'empty' } },
    label: 'Empty · unavailable',
    unavailable: true,
  },
  {
    name: 'project-list',
    context: { type: 'list', selection: { type: 'project', path: 'Projects/Alpha.md' } },
    label: 'Projects/Alpha.md',
    destination: {
      filePath: 'Projects/Alpha.md',
      insertion: { type: 'section', heading: '## Project tasks', position: 'top' },
    },
  },
  {
    name: 'project-dashboard',
    context: { type: 'project-dashboard', path: 'Projects/Beta.md' },
    label: 'Projects/Beta.md',
    destination: {
      filePath: 'Projects/Beta.md',
      insertion: { type: 'section', heading: '## Project tasks', position: 'top' },
    },
  },
  {
    name: 'project-table',
    context: { type: 'project-table', path: 'Projects/Gamma.md' },
    label: 'Projects/Gamma.md',
    destination: {
      filePath: 'Projects/Gamma.md',
      insertion: { type: 'section', heading: '## Project tasks', position: 'top' },
    },
  },
  {
    name: 'projects-overview',
    context: { type: 'default', source: 'projects' },
    label: 'Default destination',
  },
  {
    name: 'calendar',
    context: { type: 'default', source: 'calendar' },
    label: 'Today · today',
    due: '2026-08-24',
  },
  {
    name: 'search',
    context: { type: 'default', source: 'search' },
    label: 'Default destination',
  },
];

function expectScenarioInitial(target: CaptureTarget, scenario: Scenario): void {
  if (scenario.due === undefined && scenario.tags === undefined) {
    expect(target.initial).toBeUndefined();
    return;
  }
  expect(target.initial).toEqual({
    ...(scenario.due === undefined ? {} : { due: { type: 'set', value: localDate(scenario.due) } }),
    ...(scenario.tags === undefined ? {} : { tags: { add: scenario.tags } }),
  });
}

async function expectScenarioPlan(
  target: CaptureTarget,
  captureApplication: ReturnType<typeof application>,
  scenario: Scenario,
): Promise<void> {
  if (scenario.unavailable === true) {
    expect(target.session.type).toBe('unavailable');
    expect(methodOf(captureApplication, 'planCreate')).not.toHaveBeenCalled();
    await expect(target.session.execute({ markdownBody: 'draft' })).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    return;
  }
  expect(target.session).toMatchObject({
    type: 'ready',
    destination: scenario.destination ?? configuredDestination,
  });
  expect(methodOf(captureApplication, 'planCreate')).toHaveBeenCalledWith(
    scenario.destination != null
      ? { type: 'explicit', destination: scenario.destination }
      : { type: 'configured-default' },
    ...(scenario.intent === undefined ? [] : [{ intent: scenario.intent }]),
  );
}

describe('CaptureTargetResolver', () => {
  it.each(scenarios)('resolves the frozen $name target', async (scenario) => {
    const captureApplication = application();
    const resolver = new CaptureTargetResolver(
      captureApplication,
      settings(scenario.settings),
      () => localDate('2026-08-24'),
    );

    const target = await resolver.resolve(scenario.context);

    expect(target).toMatchObject({
      label: scenario.label,
      context: scenario.context,
      markdownPrefix: scenario.prefix ?? '',
      markdownSuffixes: scenario.suffixes ?? [],
    });
    expectScenarioInitial(target, scenario);
    await expectScenarioPlan(target, captureApplication, scenario);
  });

  it.each(['tag', 'both'] as const)(
    'keeps a malformed loaded %s Inbox unavailable instead of silently capturing as untagged',
    async (mode) => {
      const captureApplication = application();
      const resolver = new CaptureTargetResolver(
        captureApplication,
        settings({ inbox: { mode, tag: 'not a valid tag', removeTagOnAssign: true } }),
      );

      const target = await resolver.resolve({ type: 'list', selection: 'inbox' });

      expect(target).toMatchObject({
        label: 'Inbox · unavailable',
        session: { type: 'unavailable' },
      });
      expect(methodOf(captureApplication, 'planCreate')).not.toHaveBeenCalled();
    },
  );

  it('keeps context, markdown transforms, date, and session destination frozen', async () => {
    const captureApplication = application();
    const mutableSettings = settings();
    let today = localDate('2026-08-22');
    const selection: Extract<ListSelection, { type: 'tag' }> = { type: 'tag', tag: '#focus' };
    const context: CaptureContext = { type: 'list', selection };
    const resolver = new CaptureTargetResolver(captureApplication, mutableSettings, () => today);

    const target = await resolver.resolve(context);
    const project = await resolver.resolve({
      type: 'project-dashboard',
      path: 'Projects/Frozen.md',
    });
    const upcoming = await resolver.resolve({ type: 'list', selection: 'upcoming' });
    selection.tag = '#changed';
    mutableSettings.taskPrefix = '#changed-prefix';
    mutableSettings.projects.taskInsertionSection = '## Changed';
    today = localDate('2026-09-01');

    expect(commandBodyForCapture(target, '  Draft text  ')).toBe('Draft text');
    expect(target.context).toEqual({ type: 'list', selection: { type: 'tag', tag: '#focus' } });
    expect(target.session).toMatchObject({
      type: 'ready',
      destination: configuredDestination,
    });
    expect(project.session).toMatchObject({
      type: 'ready',
      destination: {
        filePath: 'Projects/Frozen.md',
        insertion: { type: 'section', heading: '## Project tasks', position: 'top' },
      },
    });
    expect(commandBodyForCapture(upcoming, 'Draft text')).toBe('Draft text');
    expect(upcoming.initial).toEqual({
      due: { type: 'set', value: localDate('2026-08-23') },
    });
  });

  it('resolves a project prepend insertion policy', async () => {
    const captureApplication = application();
    const projectSettings = settings();
    projectSettings.projects.taskInsertionMode = 'prepend';
    const resolver = new CaptureTargetResolver(captureApplication, projectSettings);

    const target = await resolver.resolve({
      type: 'project-dashboard',
      path: 'Projects/Prepended.md',
    });

    expect(target.session).toMatchObject({
      type: 'ready',
      destination: {
        filePath: 'Projects/Prepended.md',
        insertion: { type: 'prepend' },
      },
    });
  });

  it('targets the prefix of a discovered group through the existing create operation', async () => {
    const captureApplication = application();
    const nodes = [{ node: { tags: ['#work/client'] } }] as unknown as TaskNodeSnapshot[];
    const resolver = new CaptureTargetResolver(
      captureApplication,
      settings({ tagGroups: [] }),
      () => localDate('2026-08-24'),
      () => nodes,
    );

    const target = await resolver.resolve({
      type: 'list',
      selection: { type: 'group', groupId: discoveredPrefixGroupId('work') },
    });

    expect(target.label).toBe('work · #work');
    expect(target.initial).toEqual({ tags: { add: ['#work'] } });
    expect(methodOf(captureApplication, 'planCreate')).toHaveBeenCalledWith({
      type: 'configured-default',
    });
  });

  it('targets a reused old prefix by its collision-free discovered identity', async () => {
    const captureApplication = application();
    const configured = settings({
      tagGroups: [
        {
          id: discoveredPrefixGroupId('work'),
          name: 'Focused work',
          mode: 'prefix',
          prefix: 'focus',
        },
      ],
    });
    const nodes = [
      { node: { tags: ['#focus/client'] } },
      { node: { tags: ['#work/new'] } },
    ] as unknown as TaskNodeSnapshot[];
    const reused = expectDefined(
      resolveEffectiveTagGroups(configured, ['#focus/client', '#work/new']).find(
        (group) => group.origin === 'discovered' && group.prefix === 'work',
      ),
    );
    const resolver = new CaptureTargetResolver(
      captureApplication,
      configured,
      () => localDate('2026-08-24'),
      () => nodes,
    );

    const target = await resolver.resolve({
      type: 'list',
      selection: { type: 'group', groupId: reused.id },
    });

    expect(target.label).toBe('work · #work');
    expect(target.initial).toEqual({ tags: { add: ['#work'] } });
  });
});
