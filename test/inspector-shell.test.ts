import { describe, expect, it } from 'vitest';
import { createInspectorFieldPresenter } from '../src/ui/inspector/InspectorFields';
import { bindInspectorShell, mountInspectorShell } from '../src/ui/inspector/InspectorShell';
import { freshContainer } from './helpers';

describe('InspectorShell semantic contract', () => {
  it('presents pending, conflict, and I/O results through one field lifecycle', async () => {
    const root = freshContainer();
    const control = root.createEl('button', { text: 'Save' });
    const feedback = root.createDiv();
    const presenter = createInspectorFieldPresenter(feedback);

    const conflict = await presenter.run({ field: 'status', control }, async () => ({
      type: 'conflict',
    }));
    expect(conflict.type).toBe('conflict');
    expect(feedback.dataset['resultType']).toBe('conflict');
    expect(feedback.textContent).toContain('Draft kept');

    await presenter.run({ field: 'status', control }, async () => {
      throw new Error('I/O');
    });
    expect(feedback.dataset['resultType']).toBe('io-error');
  });
  it.each(['Task', 'Project', 'Work Note'])(
    '%s uses the same desktop shell role without a duplicate close affordance',
    (kind) => {
      const host = freshContainer();
      const shell = mountInspectorShell(host, {
        label: `${kind} details`,
        narrow: false,
        render: (content) => content.createEl('input', { attr: { 'aria-label': `${kind} value` } }),
      });

      expect(shell.element.dataset['inspectorShell']).toBe('entity');
      expect(shell.element.getAttribute('role')).toBe('region');
      expect(shell.element.querySelectorAll('.abyss-inspector-shell-close')).toHaveLength(0);
      expect(shell.element.querySelectorAll('button')).toHaveLength(0);
    },
  );

  it('binds a persistent task pane to the same narrow dialog interaction contract', async () => {
    const host = freshContainer();
    document.body.append(host);
    const trigger = host.createEl('button', { text: 'Open task' });
    const pane = host.createDiv();
    const field = pane.createEl('input', { attr: { 'aria-label': 'Task title' } });
    let closeRequests = 0;
    const cleanup = bindInspectorShell(pane, {
      label: 'Task details',
      narrow: true,
      returnFocus: trigger,
      onRequestClose: () => closeRequests++,
    });

    await Promise.resolve();
    expect(pane.getAttribute('role')).toBe('dialog');
    expect(pane.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closeRequests).toBe(1);
    expect(document.activeElement).toBe(trigger);
    cleanup();
    host.remove();
  });
});
