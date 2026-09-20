import { describe, expect, it, vi } from 'vitest';
import { nativeTaskIndentUnit } from '../../src/tasks/infrastructure/obsidian/nativeTaskIndentation';

describe('nativeTaskIndentUnit', () => {
  it.each([
    { value: true, expected: '\t' },
    { value: false, expected: '    ' },
    { value: undefined, expected: '\t' },
    { value: null, expected: '\t' },
    { value: 0, expected: '\t' },
    { value: 'false', expected: '\t' },
  ])('accepts only a boolean preference: $value', ({ value, expected }) => {
    const getConfig = vi.fn((_key: string): unknown => value);
    expect(nativeTaskIndentUnit({ getConfig })).toBe(expected);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledWith('useTab');
  });

  it.each([undefined, null, false, {}, { getConfig: true }])(
    'defaults unavailable shape %j to TAB',
    (vault) => {
      expect(nativeTaskIndentUnit(vault)).toBe('\t');
    },
  );

  it('retains method receiver and ignores visual tab size', () => {
    const vault = {
      useTab: false,
      tabSize: 8,
      getConfig(key: string): unknown {
        return key === 'useTab' ? this.useTab : this.tabSize;
      },
    };
    expect(nativeTaskIndentUnit(vault)).toBe('    ');
    vault.tabSize = 2;
    expect(nativeTaskIndentUnit(vault)).toBe('    ');
    vault.useTab = true;
    expect(nativeTaskIndentUnit(vault)).toBe('\t');
  });

  it('propagates unexpected host failures to the established command boundary', () => {
    expect(() =>
      nativeTaskIndentUnit({
        getConfig() {
          throw new Error('host failure');
        },
      }),
    ).toThrow('host failure');
  });
});
