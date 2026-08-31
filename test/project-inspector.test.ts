import { describe, expect, it, vi } from 'vitest';
import { renderProjectInspector } from '../src/panels/projects/ProjectInspector';
import { InspectorDraftRegistry } from '../src/ui/projectDraftContinuity';
import { deferred, freshContainer } from './helpers';

describe('ProjectInspector', () => {
  it('uses the shared inspector field-row contract for Project metadata', () => {
    const root = freshContainer();
    renderProjectInspector(root, {
      project: {
        path: 'Projects/Atlas.md',
        name: 'Atlas',
        frontmatter: {},
        tags: [],
        statusId: 'active',
        rawStatus: null,
        range: {},
        priority: 'B',
        description: 'Ship safely',
        comments: [],
        stats: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
      },
      taskRollup: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
      healthReason: 'One task is blocked',
      openNote: () => undefined,
      statuses: [{ id: 'active', label: 'Active' }],
      onSetStatus: vi.fn(),
    });

    expect(root.dataset['inspectorEntity']).toBe('project');
    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>('.abyss-inspector-field-row'),
        (field) => field.dataset['inspectorField'],
      ),
    ).toEqual([
      'status',
      'priority',
      'range-start',
      'range-end',
      'description',
      'comments',
      'progress',
      'health',
    ]);
  });

  it('routes priority, description, dates, and append-only comments through injected CAS commands', async () => {
    const root = freshContainer();
    const commands = {
      observeMetadata: vi.fn().mockReturnValue({ path: 'Projects/Atlas.md', priority: 'B' }),
      observeRange: vi
        .fn()
        .mockReturnValue({ path: 'Projects/Atlas.md', start: undefined, end: undefined }),
      observeComments: vi.fn().mockReturnValue({ path: 'Projects/Atlas.md', value: [] }),
      setPriority: vi.fn().mockResolvedValue({ type: 'ok' }),
      setDescription: vi.fn().mockResolvedValue({ type: 'ok' }),
      setRange: vi.fn().mockResolvedValue({ type: 'ok' }),
      appendComment: vi.fn().mockResolvedValue({ type: 'ok' }),
    };
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      priority: 'B' as const,
      description: 'Ship safely',
      comments: [],
      stats: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
    };
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      commands: commands as never,
    });
    const priority = root.querySelector<HTMLInputElement>('[aria-label="Project priority"]')!;
    priority.value = 'A';
    priority.dispatchEvent(new Event('change'));
    const description = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Project description"]',
    )!;
    description.value = 'Updated';
    description.dispatchEvent(new Event('blur'));
    const comment = root.querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!;
    comment.value = 'Note';
    comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(commands.setPriority).toHaveBeenCalled();
    expect(commands.setDescription).toHaveBeenCalled();
    expect(commands.appendComment).toHaveBeenCalled();
  });

  it('renders compact editable metadata alongside read-only progress and health', () => {
    const root = freshContainer();
    renderProjectInspector(root, {
      project: {
        path: 'Projects/Atlas.md',
        name: 'Atlas',
        frontmatter: {},
        tags: [],
        statusId: 'active',
        rawStatus: null,
        range: {},
        priority: 'B',
        description: 'Ship safely',
        comments: [],
        stats: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
      },
      taskRollup: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
      healthReason: 'One task is blocked',
      openNote: () => undefined,
    });

    expect(root.querySelector('[aria-label="Open project note"]')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('[aria-label="Project priority"]')?.value).toBe(
      'B',
    );
    expect(
      root.querySelector<HTMLTextAreaElement>('[aria-label="Project description"]')?.value,
    ).toBe('Ship safely');
    expect(root.textContent).toContain('2 of 4 tasks complete');
    expect(root.textContent).toContain('One task is blocked');
  });

  it('shows concise visible labels for the five Project planning fields', () => {
    const root = freshContainer();
    renderProjectInspector(root, {
      project: {
        path: 'Projects/Atlas.md',
        name: 'Atlas',
        frontmatter: {},
        tags: [],
        statusId: 'active',
        rawStatus: null,
        range: {},
        priority: 'B',
        description: 'Ship safely',
        comments: [],
        stats: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
      },
      taskRollup: { total: 4, done: 2, cancelled: 0, inProgress: 1, open: 1, progress: 0.5 },
      openNote: () => undefined,
      statuses: [{ id: 'active', label: 'Active' }],
      onSetStatus: vi.fn(),
    });

    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>('.abyss-project-inspector-field-label'),
        ({ textContent }) => textContent,
      ),
    ).toEqual(['Status', 'Priority', 'Start', 'End', 'Description']);
    for (const ariaLabel of [
      'Project status',
      'Project priority',
      'Project start',
      'Project end',
      'Project description',
    ]) {
      const control = root.querySelector<HTMLElement>(`[aria-label="${ariaLabel}"]`)!;
      expect(
        control
          .closest('.abyss-inspector-field-row')
          ?.querySelector('.abyss-project-inspector-field-label'),
      ).not.toBeNull();
    }
  });

  it('uses the status selector callback for project status changes', () => {
    const root = freshContainer();
    const onSetStatus = vi.fn();
    renderProjectInspector(root, {
      project: {
        path: 'Projects/Atlas.md',
        name: 'Atlas',
        frontmatter: {},
        tags: [],
        statusId: 'active',
        rawStatus: null,
        range: {},
        comments: [],
        stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      },
      taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      openNote: () => undefined,
      statuses: [
        { id: 'active', label: 'Active' },
        { id: 'done', label: 'Done' },
      ],
      onSetStatus,
    });

    const status = root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')!;
    status.value = 'done';
    status.dispatchEvent(new Event('change'));
    expect(onSetStatus).toHaveBeenCalledWith('done');
  });

  it('tracks Project status focus without leaving a stale focus request after blur', () => {
    const root = freshContainer();
    activeDocument.body.append(root);
    const registry = new InspectorDraftRegistry();
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      statuses: [
        { id: 'active', label: 'Active' },
        { id: 'done', label: 'Done' },
      ],
      onSetStatus: vi.fn(),
      draftRegistry: registry,
    });
    const status = root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')!;
    status.focus();
    expect(registry.get({ type: 'project', path: project.path }, 'status')?.hadFocus).toBe(true);
    status.blur();
    expect(registry.get({ type: 'project', path: project.path }, 'status')?.hadFocus).toBe(false);
    root.remove();
  });

  it('reverts a failed status visually while retaining its draft, focus, and inline result lifecycle', async () => {
    const root = freshContainer();
    activeDocument.body.append(root);
    const conflict = deferred<{ type: 'conflict' }>();
    const registry = new InspectorDraftRegistry();
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      statuses: [
        { id: 'active', label: 'Active' },
        { id: 'done', label: 'Done' },
      ],
      draftRegistry: registry,
      onSetStatus: () => conflict.promise,
    });
    const status = root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')!;
    const feedback = root.querySelector<HTMLElement>('[data-project-field-result="status"]')!;
    status.focus();
    status.value = 'done';
    status.dispatchEvent(new Event('change'));
    expect(status.disabled).toBe(true);
    expect(feedback.dataset['resultType']).toBe('pending');

    conflict.resolve({ type: 'conflict' });
    await vi.waitFor(() => expect(feedback.dataset['resultType']).toBe('conflict'));
    expect(status.value).toBe('active');
    expect(status.disabled).toBe(false);
    expect(activeDocument.activeElement).toBe(status);
    expect(registry.get({ type: 'project', path: project.path }, 'status')).toMatchObject({
      value: 'done',
      baseline: 'active',
      dirty: true,
      pending: false,
      result: 'conflict',
    });
    root.remove();
  });

  it('keeps a remounted pending status disabled and refreshes the settled result', async () => {
    const root = freshContainer();
    const conflict = deferred<{ type: 'conflict' }>();
    const registry = new InspectorDraftRegistry();
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const render = (): void =>
      renderProjectInspector(root, {
        project,
        taskRollup: project.stats,
        openNote: () => undefined,
        statuses: [
          { id: 'active', label: 'Active' },
          { id: 'done', label: 'Done' },
        ],
        draftRegistry: registry,
        onSetStatus: () => conflict.promise,
        onDraftSettled: render,
      });
    render();
    const status = root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')!;
    status.value = 'done';
    status.dispatchEvent(new Event('change'));

    render();
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')?.disabled).toBe(
      true,
    );
    expect(
      root.querySelector<HTMLElement>('[data-project-field-result="status"]')?.dataset[
        'resultType'
      ],
    ).toBe('pending');

    conflict.resolve({ type: 'conflict' });
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLElement>('[data-project-field-result="status"]')?.dataset[
          'resultType'
        ],
      ).toBe('conflict'),
    );
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')).toMatchObject({
      disabled: false,
      value: 'active',
    });
  });

  it('reconciles a successful status write without a false conflict on own-write refresh', async () => {
    const root = freshContainer();
    const registry = new InspectorDraftRegistry();
    const base = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      rawStatus: null,
      range: {},
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const options = {
      taskRollup: base.stats,
      openNote: () => undefined,
      statuses: [
        { id: 'active', label: 'Active' },
        { id: 'done', label: 'Done' },
      ],
      draftRegistry: registry,
      onSetStatus: vi.fn().mockResolvedValue({ type: 'ok' }),
    };
    renderProjectInspector(root, { ...options, project: { ...base, statusId: 'active' } });
    const status = root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')!;
    status.value = 'done';
    status.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLElement>('[data-project-field-result="status"]')?.dataset[
          'resultType'
        ],
      ).toBe('ok'),
    );

    renderProjectInspector(root, { ...options, project: { ...base, statusId: 'done' } });
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Project status"]')?.value).toBe(
      'done',
    );
    expect(registry.get({ type: 'project', path: base.path }, 'status')).toMatchObject({
      baseline: 'done',
      value: 'done',
      dirty: false,
      pending: false,
      result: 'ok',
    });
    expect(root.textContent).not.toContain('changed outside calendar');
  });

  it('restores Project description/comment values and text selection after another inspector identity', async () => {
    const root = freshContainer();
    activeDocument.body.append(root);
    const registry = new InspectorDraftRegistry();
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      description: 'Published',
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const render = () =>
      renderProjectInspector(root, {
        project,
        taskRollup: project.stats,
        openNote: () => undefined,
        draftRegistry: registry,
      });
    render();
    const description = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Project description"]',
    )!;
    description.value = 'My project draft';
    description.setSelectionRange(3, 8);
    description.focus();
    description.dispatchEvent(new Event('input'));
    description.setSelectionRange(4, 9);
    description.dispatchEvent(new Event('select'));
    const comment = root.querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!;
    comment.value = 'Append this later';
    comment.setSelectionRange(2, 5);
    comment.dispatchEvent(new Event('input'));
    registry.capture(
      {
        type: 'work-note',
        path: 'Work Notes/Brief.md',
        projectPath: project.path,
      },
      'status',
      {
        value: 'review',
        baseline: 'active',
        selectionStart: 0,
        selectionEnd: 0,
        hadFocus: true,
      },
    );

    root.empty();
    render();
    await Promise.resolve();

    const restoredDescription = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Project description"]',
    )!;
    const restoredComment = root.querySelector<HTMLInputElement>(
      '[aria-label="Add project comment"]',
    )!;
    expect(restoredDescription.value).toBe('My project draft');
    expect(restoredDescription.selectionStart).toBe(4);
    expect(restoredDescription.selectionEnd).toBe(9);
    expect(restoredComment.value).toBe('Append this later');
    expect(restoredComment.selectionStart).toBe(2);
    expect(restoredComment.selectionEnd).toBe(5);
    expect(activeDocument.activeElement).toBe(restoredDescription);
    expect(
      registry.get(
        {
          type: 'work-note',
          path: 'Work Notes/Brief.md',
          projectPath: project.path,
        },
        'status',
      )?.value,
    ).toBe('review');
    root.remove();
  });

  it('renders existing Project comments and retains a conflicted description draft', async () => {
    const root = freshContainer();
    const commands = {
      setDescription: vi.fn().mockResolvedValue({ type: 'conflict', current: 'External' }),
    };
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      priority: 'D' as const,
      description: 'Original',
      comments: [
        { kind: 'undated' as const, raw: 'Legacy note', text: 'Legacy note' },
        {
          kind: 'timestamp' as const,
          raw: '2026-08-28: Timestamped note',
          text: 'Timestamped note',
          timestamp: { precision: 'day' as const, value: '2026-08-28' as never, raw: '2026-08-28' },
        },
      ],
      metadataDiagnostics: [{ field: 'comments' as const, issue: 'malformed' as const, index: 1 }],
      stats: { total: 1, done: 0, cancelled: 0, inProgress: 0, open: 1, progress: 0 },
    };
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      commands: commands as never,
      commentTimeContext: () => ({
        nowEpochMs: Date.UTC(2026, 7, 28),
        today: '2026-08-28' as never,
        locale: 'en-US',
        timeZone: 'UTC',
      }),
    });
    expect(root.textContent).toContain('Legacy note');
    expect(root.textContent).toContain('Today');
    expect(root.textContent).toContain('Comment 2 has a malformed timestamp and is read-only.');
    expect(root.querySelector('time')?.title).toContain('Aug 28, 2026');
    expect(root.querySelector('time')?.title).not.toBe('2026-08-28');
    const description = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Project description"]',
    )!;
    description.focus();
    description.value = 'Mine';
    description.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    expect(description.value).toBe('Mine');
    expect(root.textContent).toContain('changed outside calendar');
  });

  it('keeps an unsupported comment draft but clears only the submitted successful comment', async () => {
    const root = freshContainer();
    const commands = {
      observeComments: vi.fn().mockReturnValue({ path: 'Projects/Atlas.md', value: [] }),
      appendComment: vi
        .fn()
        .mockResolvedValueOnce({ type: 'unsupported', field: 'comments' })
        .mockResolvedValueOnce({ type: 'ok' }),
    };
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      commands: commands as never,
    });
    const comment = root.querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!;
    comment.value = 'Keep me';
    comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(comment.value).toBe('Keep me');
    expect(root.textContent).toContain('not supported');

    comment.value = 'Saved';
    comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(comment.value).toBe(''));
  });

  it('retains original raw CAS observations across an external-edit remount', async () => {
    const root = freshContainer();
    const registry = new InspectorDraftRegistry();
    const commands = {
      observeRange: vi.fn((project: { frontmatter: Record<string, unknown> }) => ({
        path: 'Projects/Atlas.md',
        start: project.frontmatter['start'],
        end: project.frontmatter['end'],
      })),
      observeComments: vi.fn((project: { frontmatter: Record<string, unknown> }) => ({
        path: 'Projects/Atlas.md',
        value: project.frontmatter['comments'],
      })),
      setPriority: vi.fn().mockResolvedValue({ type: 'conflict', current: 'C' }),
      setDescription: vi.fn().mockResolvedValue({ type: 'conflict', current: 'External' }),
      setRange: vi.fn().mockResolvedValue({ type: 'conflict', current: {} }),
      appendComment: vi.fn().mockResolvedValue({ type: 'conflict', current: ['External'] }),
    };
    const base = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      tags: [],
      statusId: 'active',
      rawStatus: null,
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const original = {
      ...base,
      frontmatter: {
        priority: 'B',
        description: 'Original',
        start: '2026-08-28',
        comments: ['Original comment'],
      },
      observed: {
        priority: 'B',
        description: 'Original',
        start: '2026-08-28',
        comments: ['Original comment'],
      },
      priority: 'B' as const,
      description: 'Original',
      range: { start: { raw: '2026-08-28', precision: 'date' as const } },
    };
    renderProjectInspector(root, {
      project: original as never,
      taskRollup: base.stats,
      openNote: () => undefined,
      commands: commands as never,
      draftRegistry: registry,
    });
    const priority = root.querySelector<HTMLInputElement>('[aria-label="Project priority"]')!;
    const start = root.querySelector<HTMLInputElement>('[aria-label="Project start"]')!;
    const description = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Project description"]',
    )!;
    const comment = root.querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!;
    priority.value = 'A';
    priority.dispatchEvent(new Event('input'));
    start.value = '2026-08-29';
    start.dispatchEvent(new Event('input'));
    description.value = 'Mine';
    description.dispatchEvent(new Event('input'));
    comment.value = 'Mine too';
    comment.dispatchEvent(new Event('input'));

    const external = {
      ...original,
      frontmatter: {
        priority: 'C',
        description: 'External',
        start: '2026-08-30',
        comments: ['Original comment', 'External'],
      },
      observed: {
        priority: 'C',
        description: 'External',
        start: '2026-08-30',
        comments: ['Original comment', 'External'],
      },
      priority: 'C' as const,
      description: 'External',
      range: { start: { raw: '2026-08-30', precision: 'date' as const } },
    };
    renderProjectInspector(root, {
      project: external as never,
      taskRollup: base.stats,
      openNote: () => undefined,
      commands: commands as never,
      draftRegistry: registry,
    });
    root
      .querySelector<HTMLInputElement>('[aria-label="Project priority"]')!
      .dispatchEvent(new Event('change'));
    root
      .querySelector<HTMLInputElement>('[aria-label="Project start"]')!
      .dispatchEvent(new Event('blur'));
    root
      .querySelector<HTMLTextAreaElement>('[aria-label="Project description"]')!
      .dispatchEvent(new Event('blur'));
    root
      .querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();

    expect(commands.setPriority).toHaveBeenCalledWith({ path: original.path, value: 'B' }, 'A');
    expect(commands.setRange).toHaveBeenCalledWith(
      { path: original.path, start: '2026-08-28', end: undefined },
      expect.any(Object),
    );
    expect(commands.setDescription).toHaveBeenCalledWith(
      { path: original.path, value: 'Original' },
      'Mine',
    );
    expect(commands.appendComment).toHaveBeenCalledWith(
      { path: original.path, value: ['Original comment'] },
      'Mine too',
    );
    expect(
      registry.get({ type: 'project', path: original.path }, 'description')?.observation,
    ).toEqual({ path: original.path, value: 'Original' });
    expect(registry.get({ type: 'project', path: original.path }, 'comment')?.observation).toEqual({
      path: original.path,
      value: ['Original comment'],
    });

    renderProjectInspector(root, {
      project: external as never,
      taskRollup: base.stats,
      openNote: () => undefined,
      commands: commands as never,
      draftRegistry: registry,
    });
    root
      .querySelector<HTMLInputElement>('[aria-label="Project priority"]')!
      .dispatchEvent(new Event('change'));
    root
      .querySelector<HTMLInputElement>('[aria-label="Project start"]')!
      .dispatchEvent(new Event('blur'));
    root
      .querySelector<HTMLTextAreaElement>('[aria-label="Project description"]')!
      .dispatchEvent(new Event('blur'));
    root
      .querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(commands.setPriority).toHaveBeenLastCalledWith({ path: original.path, value: 'B' }, 'A');
    expect(commands.setRange).toHaveBeenLastCalledWith(
      { path: original.path, start: '2026-08-28', end: undefined },
      expect.any(Object),
    );
    expect(commands.setDescription).toHaveBeenLastCalledWith(
      { path: original.path, value: 'Original' },
      'Mine',
    );
    expect(commands.appendComment).toHaveBeenLastCalledWith(
      { path: original.path, value: ['Original comment'] },
      'Mine too',
    );
  });

  it('preserves invalid results, IME composition, blur focus recovery, and collision drafts', async () => {
    const root = freshContainer();
    activeDocument.body.append(root);
    const registry = new InspectorDraftRegistry();
    const commands = {
      observeRange: vi.fn().mockReturnValue({ path: 'Projects/Atlas.md' }),
      observeComments: vi.fn().mockReturnValue({ path: 'Projects/Atlas.md', value: [] }),
      setPriority: vi.fn(),
      setDescription: vi.fn().mockResolvedValue({ type: 'conflict', current: 'External' }),
      setRange: vi.fn(),
      appendComment: vi.fn(),
    };
    const project = {
      path: 'Projects/Atlas.md',
      name: 'Atlas',
      frontmatter: {},
      tags: [],
      statusId: 'active',
      rawStatus: null,
      range: {},
      priority: 'B' as const,
      description: 'Original',
      comments: [],
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    registry.capture({ type: 'project', path: project.path }, 'description', {
      value: 'Dormant collision draft',
      baseline: 'Dormant',
      selectionStart: 1,
      selectionEnd: 1,
      hadFocus: false,
    });
    registry.capture({ type: 'project', path: 'Projects/Source.md' }, 'description', {
      value: 'Live source draft',
      baseline: 'Source',
      selectionStart: 1,
      selectionEnd: 1,
      hadFocus: false,
    });
    registry.renamePath('Projects/Source.md', project.path);
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      commands: commands as never,
      draftRegistry: registry,
    });
    expect(
      Array.from(root.querySelectorAll<HTMLTextAreaElement>('[aria-label$="recovery draft"]')).map(
        ({ value }) => value,
      ),
    ).toContain('Dormant collision draft');

    const priority = root.querySelector<HTMLInputElement>('[aria-label="Project priority"]')!;
    priority.value = 'Z';
    priority.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-project-field-result="priority"]')?.textContent).toContain(
      'not valid',
    );
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      commands: commands as never,
      draftRegistry: registry,
    });
    expect(
      root.querySelector<HTMLElement>('[data-project-field-result="priority"]')?.dataset[
        'resultType'
      ],
    ).toBe('invalid');

    const comment = root.querySelector<HTMLInputElement>('[aria-label="Add project comment"]')!;
    comment.value = 'Do not submit';
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    comment.dispatchEvent(legacy);
    expect(commands.appendComment).not.toHaveBeenCalled();

    const description = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Project description"]',
    )!;
    description.value = 'Mine';
    description.dispatchEvent(new Event('input'));
    description.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(activeDocument.activeElement).toBe(description));
    renderProjectInspector(root, {
      project,
      taskRollup: project.stats,
      openNote: () => undefined,
      commands: commands as never,
      draftRegistry: registry,
    });
    expect(
      root.querySelector<HTMLElement>('[data-project-field-result="description"]')?.dataset[
        'resultType'
      ],
    ).toBe('conflict');
    root.remove();
  });
});
