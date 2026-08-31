import { describe, expect, it } from 'vitest';
import { EntityPresentation } from '../src/ui/entity/EntityPresentation';
import { freshContainer } from './helpers';

describe('EntityPresentation', () => {
  it('uses compact shared identity and metadata slots', () => {
    const root = freshContainer();
    new EntityPresentation({ identity: 'Project', status: 'Active', priority: 'A' }).render(root);
    expect(root.textContent).toContain('Project');
    expect(root.querySelector('[data-entity-slot="priority"]')?.textContent).toBe('A');
  });
});
