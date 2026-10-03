// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  projectGroupCollapseKey,
  setProjectGroupCollapsed,
} from '../src/projects/projectGroupCollapse';

describe('project group collapse', () => {
  it('namespaces identical group values without delimiter collisions', () => {
    expect(projectGroupCollapseKey('status', 'id:open')).toBe('["status","id:open"]');
    expect(projectGroupCollapseKey('property:Owner', 'id:open')).toBe(
      '["property:Owner","id:open"]',
    );
    expect(projectGroupCollapseKey('a,b', 'c')).not.toBe(projectGroupCollapseKey('a', 'b,c'));
  });
  it('deduplicates and toggles one key without changing the saved array or hidden keys', () => {
    const saved = ['hidden', 'active', 'active'];
    expect(setProjectGroupCollapsed(saved, 'active', true)).toEqual(['hidden', 'active']);
    expect(setProjectGroupCollapsed(saved, 'active', false)).toEqual(['hidden']);
    expect(saved).toEqual(['hidden', 'active', 'active']);
    expect(setProjectGroupCollapsed(undefined, 'active', false)).toEqual([]);
    expect(setProjectGroupCollapsed(undefined, 'active', true)).toEqual(['active']);
  });
});
