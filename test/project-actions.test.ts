import { Notice, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import {
  changeProjectStatus,
  openProjectNote,
  projectStatusFailureNotice,
} from '../src/ui/projectActions';
import { createAppWithFiles } from './helpers';

const VALIDATION = 'Choose a project Status property in settings before changing statuses.';
const CHANGE = { path: 'Projects/A.md', statusId: 'active' } as const;

function spyOnNotices() {
  return vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
    'constructor__',
  );
}

function messages(notices: ReturnType<typeof spyOnNotices>): unknown[] {
  return notices.mock.calls.map(([message]) => message);
}

describe('projectStatusFailureNotice', () => {
  it('shows a validation message as it is and gives any other failure the status sentence', () => {
    expect(projectStatusFailureNotice(new ProjectEditValidationError(VALIDATION))).toBe(VALIDATION);
    expect(projectStatusFailureNotice(new Error('disk full'))).toBe(
      'Could not change the project status. disk full',
    );
    expect(projectStatusFailureNotice(new Error(''))).toBe('Could not change the project status.');
  });
});

describe('changeProjectStatus', () => {
  it('reports a failed write once with its cause and skips the change callback', async () => {
    const cause = new Error('disk full');
    const setStatus = vi.fn().mockRejectedValue(cause);
    const onChanged = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notices = spyOnNotices();

    await changeProjectStatus({ setStatus }, CHANGE, onChanged);

    expect(messages(notices)).toEqual(['Could not change the project status. disk full']);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not change the project status',
      { path: 'Projects/A.md', statusId: 'active', cause },
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a validation refusal as it is without a log', async () => {
    const setStatus = vi.fn().mockRejectedValue(new ProjectEditValidationError(VALIDATION));
    const onChanged = vi.fn();
    const log = vi.spyOn(console, 'error');
    const notices = spyOnNotices();

    await changeProjectStatus({ setStatus }, CHANGE, onChanged);

    expect(messages(notices)).toEqual([VALIDATION]);
    expect(log).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('runs the change callback once after a successful write, without a Notice', async () => {
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const notices = spyOnNotices();

    await changeProjectStatus({ setStatus }, CHANGE, onChanged);

    expect(setStatus).toHaveBeenCalledExactlyOnceWith('Projects/A.md', 'active');
    expect(onChanged).toHaveBeenCalledOnce();
    expect(notices).not.toHaveBeenCalled();
  });
});

describe('openProjectNote', () => {
  it('names a missing note without opening anything', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '' });
    const getLeaf = vi.spyOn(app.workspace, 'getLeaf');
    const notices = spyOnNotices();

    await openProjectNote(app, 'Projects/Missing.md');

    expect(messages(notices)).toEqual(['Could not find Projects/Missing.md.']);
    expect(getLeaf).not.toHaveBeenCalled();
  });

  it('reports a failed open once with its cause', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '' });
    const error = new Error('leaf closed');
    vi.spyOn(app.workspace, 'getLeaf').mockReturnValue({
      openFile: vi.fn().mockRejectedValue(error),
    } as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notices = spyOnNotices();

    await openProjectNote(app, 'Projects/A.md');

    expect(messages(notices)).toEqual(['Could not open Projects/A.md. leaf closed']);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not open the project note', {
      path: 'Projects/A.md',
      error,
    });
  });

  it('opens the note in the current leaf without a Notice', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '' });
    const openFile = vi.fn().mockResolvedValue(undefined);
    const getLeaf = vi.spyOn(app.workspace, 'getLeaf').mockReturnValue({ openFile } as never);
    const notices = spyOnNotices();

    await openProjectNote(app, 'Projects/A.md');

    expect(getLeaf).toHaveBeenCalledExactlyOnceWith(false);
    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile.mock.calls[0]?.[0]).toBeInstanceOf(TFile);
    expect(notices).not.toHaveBeenCalled();
  });
});
