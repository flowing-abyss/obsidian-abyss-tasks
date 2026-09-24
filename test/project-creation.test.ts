import { describe, expect, it } from 'vitest';
import {
  creationFailureMessage,
  ProjectCreationError,
  projectCreationFailureNotice,
  withCreationFailureCause,
} from '../src/projects/projectCreation';

function partial(phase: 'status' | 'template', cause: unknown): ProjectCreationError {
  return new ProjectCreationError('Could not finish Projects/A.md.', {
    createdPath: 'Projects/A.md',
    phase,
    statusId: 'active',
    cause,
  });
}

describe('project creation wording', () => {
  it('reads the underlying cause of a partial create and the message of any other error', () => {
    expect(
      creationFailureMessage(partial('status', new Error('Status property is missing.'))),
    ).toBe('Status property is missing.');
    expect(creationFailureMessage(new Error('Folder is read-only.'))).toBe('Folder is read-only.');
    expect(creationFailureMessage('plain text')).toBe('plain text');
  });

  it('appends a cause only when it has text', () => {
    expect(withCreationFailureCause('Could not add the tag group.', new Error('Disk full.'))).toBe(
      'Could not add the tag group. Disk full.',
    );
    expect(withCreationFailureCause('Could not add the tag group.', new Error('  '))).toBe(
      'Could not add the tag group.',
    );
  });

  it('names the created note and the failed step of a partial create', () => {
    expect(projectCreationFailureNotice(partial('status', new Error('disk full')))).toBe(
      'Created Projects/A.md, but could not set its status. disk full',
    );
    expect(projectCreationFailureNotice(partial('template', new Error('bad template')))).toBe(
      'Created Projects/A.md, but could not apply its template. bad template',
    );
    expect(projectCreationFailureNotice(new Error('Folder is read-only.'))).toBe(
      'Could not create the project. Folder is read-only.',
    );
    expect(projectCreationFailureNotice(new Error(''))).toBe('Could not create the project.');
  });
});
