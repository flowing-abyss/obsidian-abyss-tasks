import { describe, expect, it } from 'vitest';
import {
  defaultShortcuts,
  parseShortcut,
  validateShortcuts,
  type ShortcutSettings,
} from '../src/settings/shortcuts';

const mac = { mod: 'meta' } as const;
const other = { mod: 'ctrl' } as const;

describe('shortcut defaults', () => {
  it('provides the documented unmodified bindings for every action', () => {
    expect(defaultShortcuts()).toEqual({
      openQuickCapture: 'Q',
      openTasks: 'L',
      openInbox: 'I',
      openToday: 'T',
      openUpcoming: 'U',
      openCalendar: 'C',
      openCalendarToday: 'D',
      openCalendarWeek: 'W',
      openCalendarMonth: 'M',
      openProjects: 'P',
      openSearch: 'S',
    });
  });
});

describe('parseShortcut', () => {
  it('normalizes letter and digit keys into physical keyboard codes', () => {
    expect(parseShortcut('openQuickCapture', 'q', mac)).toEqual({
      action: 'openQuickCapture',
      code: 'KeyQ',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    });
    expect(parseShortcut('openQuickCapture', '9', mac)).toEqual({
      action: 'openQuickCapture',
      code: 'Digit9',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    });
  });

  it('accepts modifiers case-insensitively and maps Mod for each platform', () => {
    expect(parseShortcut('openQuickCapture', 'shift q', mac)?.modifiers).toEqual({
      alt: false,
      ctrl: false,
      meta: false,
      shift: true,
    });
    expect(parseShortcut('openQuickCapture', 'mOd k', mac)?.modifiers).toEqual({
      alt: false,
      ctrl: false,
      meta: true,
      shift: false,
    });
    expect(parseShortcut('openQuickCapture', 'mOd k', other)?.modifiers).toEqual({
      alt: false,
      ctrl: true,
      meta: false,
      shift: false,
    });
  });

  it.each([
    ['Mod Ctrl Q', other, false],
    ['Mod Meta Q', mac, false],
    ['Mod Ctrl Q', mac, true],
    ['Mod Meta Q', other, true],
  ] as const)(
    'resolves modifier aliases before rejecting physical duplicates: %s',
    (value, platform, valid) => {
      const parsed = parseShortcut('openQuickCapture', value, platform);

      expect(parsed === undefined).toBe(!valid);
    },
  );

  it('treats blank input as a disabled shortcut', () => {
    expect(parseShortcut('openQuickCapture', '', mac)).toBeUndefined();
    expect(parseShortcut('openQuickCapture', '   ', mac)).toBeUndefined();
  });

  it.each(['Ctrl+Q', 'Shift-Q', 'Q, W', 'Shift Q W', 'ArrowUp', 'Cmd Q', 'Alt Shift'])(
    'rejects invalid key, modifier, separator, or multi-binding %s',
    (value) => {
      expect(parseShortcut('openQuickCapture', value, mac)).toBeUndefined();
    },
  );
});

describe('validateShortcuts', () => {
  it('keeps valid alternatives around an invalid fragment', () => {
    const values = { ...defaultShortcuts(), openQuickCapture: 'Q | nope | shift 7' };
    const result = validateShortcuts(values, { mod: 'meta' });

    expect(result.bindings.get('openQuickCapture')).toMatchObject([
      { code: 'KeyQ', fragment: 'Q', fragmentIndex: 0 },
      { code: 'Digit7', fragment: 'shift 7', fragmentIndex: 2 },
    ]);
    expect(result.issues.get('openQuickCapture')).toEqual([
      { kind: 'invalid', fragment: 'nope', fragmentIndex: 1 },
    ]);
  });

  it('reports empty alternatives without disabling valid neighbors', () => {
    const values = { ...defaultShortcuts(), openQuickCapture: 'Q || shift 7 |' };
    const result = validateShortcuts(values, { mod: 'meta' });

    expect(result.bindings.get('openQuickCapture')).toHaveLength(2);
    expect(result.issues.get('openQuickCapture')).toEqual([
      { kind: 'empty', fragment: '', fragmentIndex: 1 },
      { kind: 'empty', fragment: '', fragmentIndex: 3 },
    ]);
  });

  it('deduplicates within an action before cross-action conflicts', () => {
    const values = {
      ...defaultShortcuts(),
      openQuickCapture: 'Q | q | shift 7',
      openSearch: 'q | S',
    };
    const result = validateShortcuts(values, { mod: 'meta' });

    expect(result.bindings.get('openQuickCapture')?.map((item) => item.fragment)).toEqual([
      'shift 7',
    ]);
    expect(result.bindings.get('openSearch')?.map((item) => item.fragment)).toEqual(['S']);
    expect(result.issues.get('openQuickCapture')?.map((issue) => issue.kind)).toEqual([
      'conflict',
      'duplicate',
    ]);
    expect(result.issues.get('openQuickCapture')).toContainEqual(
      expect.objectContaining({ kind: 'duplicate', fragment: 'q', duplicateOf: 'Q' }),
    );
    expect(result.issues.get('openSearch')).toEqual([
      expect.objectContaining({
        kind: 'conflict',
        fragment: 'q',
        conflictingActions: ['openQuickCapture'],
      }),
    ]);
  });

  it('matches duplicate alternatives case-insensitively and regardless of modifier order', () => {
    const values = {
      ...defaultShortcuts(),
      openQuickCapture: 'shift alt Q | ALT SHIFT q',
    };
    const result = validateShortcuts(values, { mod: 'meta' });

    expect(result.bindings.get('openQuickCapture')?.map((item) => item.fragment)).toEqual([
      'shift alt Q',
    ]);
    expect(result.issues.get('openQuickCapture')).toEqual([
      { kind: 'duplicate', fragment: 'ALT SHIFT q', fragmentIndex: 1, duplicateOf: 'shift alt Q' },
    ]);
  });

  it('treats a wholly blank value as disabled without an issue', () => {
    const values = { ...defaultShortcuts(), openQuickCapture: '   ' };
    const result = validateShortcuts(values, { mod: 'meta' });

    expect(result.bindings.has('openQuickCapture')).toBe(false);
    expect(result.issues.has('openQuickCapture')).toBe(false);
  });

  it('reports every empty fragment in a separator-only value', () => {
    const values = { ...defaultShortcuts(), openQuickCapture: '|' };
    const result = validateShortcuts(values, { mod: 'meta' });

    expect(result.bindings.has('openQuickCapture')).toBe(false);
    expect(result.issues.get('openQuickCapture')).toEqual([
      { kind: 'empty', fragment: '', fragmentIndex: 0 },
      { kind: 'empty', fragment: '', fragmentIndex: 1 },
    ]);
  });

  it('flags every duplicate and omits all conflicted bindings while keeping exact variants', () => {
    const values: ShortcutSettings = {
      ...defaultShortcuts(),
      openQuickCapture: 'Shift Q',
      openTasks: 'shift q',
      openInbox: 'Q',
    };

    const result = validateShortcuts(values, mac);

    expect(result.issues).toEqual(
      new Map([
        [
          'openQuickCapture',
          [
            {
              kind: 'conflict',
              fragment: 'Shift Q',
              fragmentIndex: 0,
              conflictingActions: ['openTasks'],
            },
          ],
        ],
        [
          'openTasks',
          [
            {
              kind: 'conflict',
              fragment: 'shift q',
              fragmentIndex: 0,
              conflictingActions: ['openQuickCapture'],
            },
          ],
        ],
      ]),
    );
    expect(result.bindings.has('openQuickCapture')).toBe(false);
    expect(result.bindings.has('openTasks')).toBe(false);
    expect(result.bindings.get('openInbox')).toMatchObject([
      {
        code: 'KeyQ',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      },
    ]);
  });

  it('reports malformed nonblank input as invalid and leaves blanks unbound', () => {
    const values: ShortcutSettings = {
      ...defaultShortcuts(),
      openQuickCapture: 'Ctrl+Q',
      openTasks: '',
    };

    const result = validateShortcuts(values, mac);

    expect(result.issues).toEqual(
      new Map([['openQuickCapture', [{ kind: 'invalid', fragment: 'Ctrl+Q', fragmentIndex: 0 }]]]),
    );
    expect(result.bindings.has('openQuickCapture')).toBe(false);
    expect(result.bindings.has('openTasks')).toBe(false);
  });
});
