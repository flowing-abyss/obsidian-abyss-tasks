import { describe, expect, it } from 'vitest';
import { validateStatusSymbol } from '../src/settings/SettingsTab';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog } from './helpers';

const list = [
  { id: 'a', symbol: 'x' },
  { id: 'b', symbol: '!' },
];

describe('validateStatusSymbol', () => {
  it('uses the injected semantic status catalog for status edits', () => {
    const codec = new TaskMarkdownCodec(canonicalStatusCatalog());

    expect(
      codec.applyLineEdit('- [ ] Task 📅 2026-07-20', {
        type: 'set-status',
        symbol: '?',
        today: '2026-07-13',
      }),
    ).toEqual({ type: 'invalid', issues: [{ code: 'invalid-status', field: 'status' }] });
    expect(
      codec.applyLineEdit('- [ ] Task 📅 2026-07-20', {
        type: 'set-status',
        symbol: 'x',
        today: '2026-07-13',
      }),
    ).toEqual({
      type: 'changed',
      content: '- [x] Task 📅 2026-07-20 ✅ 2026-07-13',
    });
  });

  it('requires exactly one character', () => {
    expect(validateStatusSymbol('', list, 'c')).toMatch(/single character/i);
    expect(validateStatusSymbol('ab', list, 'c')).toMatch(/single character/i);
  });
  it('rejects duplicates against other statuses', () => {
    expect(validateStatusSymbol('x', list, 'c')).toMatch(/already/i);
  });
  it('allows keeping a status own symbol', () => {
    expect(validateStatusSymbol('x', list, 'a')).toBeNull();
  });
  it('accepts a fresh single char', () => {
    expect(validateStatusSymbol('>', list, 'c')).toBeNull();
  });
  it('rejects a surrogate-pair emoji (parser regexes lack the u flag)', () => {
    expect(validateStatusSymbol('😀', list, 'c')).toMatch(/single character/i);
  });
});
