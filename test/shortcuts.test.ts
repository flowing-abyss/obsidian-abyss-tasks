import { describe, expect, it } from 'vitest';
import {
  defaultShortcuts,
  parseShortcut,
  validateShortcuts,
  type ShortcutActionId,
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
  it.each([
    {
      name: 'keeps valid alternatives around an invalid fragment',
      value: 'Q | nope | shift 7',
      expectedBindings: [
        { code: 'KeyQ', fragment: 'Q', fragmentIndex: 0 },
        { code: 'Digit7', fragment: 'shift 7', fragmentIndex: 2 },
      ],
      expectedIssues: [{ kind: 'invalid', fragment: 'nope', fragmentIndex: 1 }],
    },
    {
      name: 'reports empty alternatives without disabling valid neighbors',
      value: 'Q || shift 7 |',
      expectedBindings: [
        { code: 'KeyQ', fragment: 'Q', fragmentIndex: 0 },
        { code: 'Digit7', fragment: 'shift 7', fragmentIndex: 2 },
      ],
      expectedIssues: [
        { kind: 'empty', fragment: '', fragmentIndex: 1 },
        { kind: 'empty', fragment: '', fragmentIndex: 3 },
      ],
    },
    {
      name: 'treats a wholly blank value as disabled without an issue',
      value: '   ',
      expectedBindings: undefined,
      expectedIssues: undefined,
    },
    {
      name: 'reports every empty fragment in a separator-only value',
      value: '|',
      expectedBindings: undefined,
      expectedIssues: [
        { kind: 'empty', fragment: '', fragmentIndex: 0 },
        { kind: 'empty', fragment: '', fragmentIndex: 1 },
      ],
    },
  ])('$name', ({ value, expectedBindings, expectedIssues }) => {
    const values = { ...defaultShortcuts(), openQuickCapture: value };
    const result = validateShortcuts(values, { mod: 'meta' });

    if (expectedBindings != null) {
      expect(result.bindings.get('openQuickCapture')).toHaveLength(expectedBindings.length);
      expect(result.bindings.get('openQuickCapture')).toMatchObject(expectedBindings);
    } else {
      expect(result.bindings.has('openQuickCapture')).toBe(false);
    }
    if (expectedIssues != null) {
      expect(result.issues.get('openQuickCapture')).toEqual(expectedIssues);
    } else {
      expect(result.issues.has('openQuickCapture')).toBe(false);
    }
  });

  it.each([
    {
      name: 'deduplicates within an action before cross-action conflicts',
      overrides: {
        openQuickCapture: 'Q | q | shift 7',
        openSearch: 'q | S',
      },
      expectedBindings: {
        openQuickCapture: ['shift 7'],
        openSearch: ['S'],
      },
      expectedIssues: {
        openQuickCapture: [
          {
            kind: 'conflict',
            fragment: 'Q',
            fragmentIndex: 0,
            conflictingActions: ['openSearch'],
          },
          { kind: 'duplicate', fragment: 'q', fragmentIndex: 1, duplicateOf: 'Q' },
        ],
        openSearch: [
          {
            kind: 'conflict',
            fragment: 'q',
            fragmentIndex: 0,
            conflictingActions: ['openQuickCapture'],
          },
        ],
      },
    },
    {
      name: 'matches duplicate alternatives case-insensitively and regardless of modifier order',
      overrides: { openQuickCapture: 'shift alt Q | ALT SHIFT q' },
      expectedBindings: { openQuickCapture: ['shift alt Q'] },
      expectedIssues: {
        openQuickCapture: [
          {
            kind: 'duplicate',
            fragment: 'ALT SHIFT q',
            fragmentIndex: 1,
            duplicateOf: 'shift alt Q',
          },
        ],
      },
    },
  ])('$name', ({ overrides, expectedBindings, expectedIssues }) => {
    const values = { ...defaultShortcuts(), ...overrides };
    const result = validateShortcuts(values, { mod: 'meta' });

    for (const [action, fragments] of Object.entries(expectedBindings)) {
      expect(result.bindings.get(action as ShortcutActionId)?.map((item) => item.fragment)).toEqual(
        fragments,
      );
    }
    for (const [action, issues] of Object.entries(expectedIssues)) {
      expect(result.issues.get(action as ShortcutActionId)).toEqual(issues);
    }
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
