import { describe, expect, it } from 'vitest';
import { mountInspectorShell } from '../src/ui/inspector/InspectorShell';
import { freshContainer } from './helpers';

describe('InspectorShell semantic contract', () => {
  it.each(['Task', 'Project', 'Work Note'])(
    '%s uses the same shell role and close affordance',
    (kind) => {
      const host = freshContainer();
      const shell = mountInspectorShell(host, {
        label: `${kind} details`,
        narrow: false,
        render: (content) => content.createEl('input', { attr: { 'aria-label': `${kind} value` } }),
      });

      expect(shell.element.dataset['inspectorShell']).toBe('entity');
      expect(shell.element.getAttribute('role')).toBe('region');
      expect(shell.element.querySelectorAll('.abyss-inspector-shell-close')).toHaveLength(1);
      expect(
        shell.element.querySelectorAll('button:not(.abyss-inspector-shell-close)'),
      ).toHaveLength(0);
    },
  );
});
