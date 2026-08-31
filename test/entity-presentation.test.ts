import { describe, expect, it, vi } from 'vitest';
import { EntityPresentation } from '../src/ui/entity/EntityPresentation';
import { freshContainer } from './helpers';

describe('EntityPresentation', () => {
  it('uses compact shared identity and metadata slots', () => {
    const root = freshContainer();
    new EntityPresentation({ identity: 'Project', status: 'Active', priority: 'A' }).render(root);
    expect(root.textContent).toContain('Project');
    expect(root.querySelector('[data-entity-slot="priority"]')?.textContent).toBe('A');
  });

  it('keeps progress, date, health, and overflow actions in the same presentation hierarchy', () => {
    const root = freshContainer();
    const open = vi.fn();
    new EntityPresentation({
      identity: 'Project',
      progress: '50%',
      date: '2026-09-01',
      health: 'At risk',
      actions: [{ label: 'Project actions', icon: 'ellipsis', onClick: open }],
    }).render(root);
    expect(root.querySelectorAll('[data-entity-slot]')).toHaveLength(5);
    root.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')!.click();
    expect(open).toHaveBeenCalledOnce();
  });
});
