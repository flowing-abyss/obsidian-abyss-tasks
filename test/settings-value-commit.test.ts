import { describe, expect, it, vi } from 'vitest';
import { SettingsValueCommit } from '../src/settings/settingsValueCommit';
import { dispatchImeKey } from './helpers';

describe('SettingsValueCommit', () => {
  it.each(['composing', 'legacy'] as const)(
    'leaves an IME-owned Enter to the IME and commits the next plain Enter (%s)',
    (ime) => {
      const root = activeDocument.body.createDiv();
      const control = root.createEl('input', { attr: { type: 'text' } });
      const commit = vi.fn(() => true);
      const values = new SettingsValueCommit(root);
      try {
        values.register(control, commit);
        control.value = 'かな';

        // Checking only `isComposing` commits the legacy keyCode 229 Enter.
        const imeEnter = dispatchImeKey(control, 'Enter', ime);
        expect(imeEnter.defaultPrevented).toBe(false);
        expect(commit).not.toHaveBeenCalled();

        const enter = new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        });
        control.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        expect(commit).toHaveBeenCalledOnce();
      } finally {
        values.dispose();
        root.remove();
      }
    },
  );
});
