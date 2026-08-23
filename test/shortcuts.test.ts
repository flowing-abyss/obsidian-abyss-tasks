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
        ['openQuickCapture', 'conflict'],
        ['openTasks', 'conflict'],
      ]),
    );
    expect(result.bindings.has('openQuickCapture')).toBe(false);
    expect(result.bindings.has('openTasks')).toBe(false);
    expect(result.bindings.get('openInbox')).toMatchObject({
      code: 'KeyQ',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    });
  });

  it('reports malformed nonblank input as invalid and leaves blanks unbound', () => {
    const values: ShortcutSettings = {
      ...defaultShortcuts(),
      openQuickCapture: 'Ctrl+Q',
      openTasks: '',
    };

    const result = validateShortcuts(values, mac);

    expect(result.issues).toEqual(new Map([['openQuickCapture', 'invalid']]));
    expect(result.bindings.has('openQuickCapture')).toBe(false);
    expect(result.bindings.has('openTasks')).toBe(false);
  });
});
