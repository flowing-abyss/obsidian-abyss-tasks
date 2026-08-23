export const SHORTCUT_ACTIONS = [
  { id: 'openQuickCapture', label: 'Quick capture', defaultValue: 'Q' },
  { id: 'openTasks', label: 'Tasks', defaultValue: 'L' },
  { id: 'openInbox', label: 'Inbox', defaultValue: 'I' },
  { id: 'openToday', label: 'Today', defaultValue: 'T' },
  { id: 'openUpcoming', label: 'Upcoming', defaultValue: 'U' },
  { id: 'openCalendar', label: 'Calendar', defaultValue: 'C' },
  { id: 'openCalendarToday', label: 'Calendar: today', defaultValue: 'D' },
  { id: 'openCalendarWeek', label: 'Calendar: week', defaultValue: 'W' },
  { id: 'openCalendarMonth', label: 'Calendar: month', defaultValue: 'M' },
  { id: 'openProjects', label: 'Projects', defaultValue: 'P' },
  { id: 'openSearch', label: 'Search', defaultValue: 'S' },
] as const;

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id'];

export const SHORTCUT_ACTION_IDS = SHORTCUT_ACTIONS.map(
  (action) => action.id,
) as readonly ShortcutActionId[];

export type ShortcutSettings = Record<ShortcutActionId, string>;

export interface ShortcutPlatform {
  readonly mod: 'meta' | 'ctrl';
}

export interface ParsedShortcut {
  readonly action: ShortcutActionId;
  readonly code: `Key${Uppercase<string>}` | `Digit${number}`;
  readonly modifiers: Readonly<{ alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }>;
}

type ShortcutModifiers = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };

const MODIFIER_NAMES = new Set(['alt', 'ctrl', 'meta', 'shift', 'mod']);

function emptyModifiers(): ShortcutModifiers {
  return { alt: false, ctrl: false, meta: false, shift: false };
}

function parsePhysicalCode(value: string): ParsedShortcut['code'] | undefined {
  if (/^[a-z]$/i.test(value)) return `Key${value.toUpperCase()}` as `Key${Uppercase<string>}`;
  if (/^\d$/.test(value)) return `Digit${value}` as `Digit${number}`;
  return undefined;
}

export function defaultShortcuts(): ShortcutSettings {
  return Object.fromEntries(
    SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultValue]),
  ) as ShortcutSettings;
}

/**
 * Parses one physical alphanumeric key with optional named modifiers. Blank
 * values deliberately produce no binding, so a shortcut can be disabled.
 */
export function parseShortcut(
  action: ShortcutActionId,
  value: string,
  platform: ShortcutPlatform,
): ParsedShortcut | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const tokens = trimmed.split(/\s+/);
  const key = tokens.pop();
  if (!key) return undefined;
  const code = parsePhysicalCode(key);
  if (!code) return undefined;

  const modifiers = emptyModifiers();
  const seen = new Set<keyof ShortcutModifiers>();
  for (const token of tokens) {
    const modifier = token.toLowerCase();
    if (!MODIFIER_NAMES.has(modifier)) return undefined;
    const physicalModifier =
      modifier === 'mod' ? platform.mod : (modifier as keyof ShortcutModifiers);
    if (seen.has(physicalModifier)) return undefined;
    seen.add(physicalModifier);
    modifiers[physicalModifier] = true;
  }

  return { action, code, modifiers };
}

function shortcutSignature(parsed: ParsedShortcut): string {
  const { modifiers } = parsed;
  return [parsed.code, modifiers.alt, modifiers.ctrl, modifiers.meta, modifiers.shift].join('|');
}

export function validateShortcuts(
  values: ShortcutSettings,
  platform: ShortcutPlatform,
): {
  readonly bindings: ReadonlyMap<ShortcutActionId, ParsedShortcut>;
  readonly issues: ReadonlyMap<ShortcutActionId, 'invalid' | 'conflict'>;
} {
  const candidates = new Map<ShortcutActionId, ParsedShortcut>();
  const issues = new Map<ShortcutActionId, 'invalid' | 'conflict'>();
  const actionsBySignature = new Map<string, ShortcutActionId[]>();

  for (const action of SHORTCUT_ACTION_IDS) {
    const value = values[action];
    const parsed = parseShortcut(action, value, platform);
    if (!parsed) {
      if (value.trim()) issues.set(action, 'invalid');
      continue;
    }
    candidates.set(action, parsed);
    const signature = shortcutSignature(parsed);
    const actions = actionsBySignature.get(signature) ?? [];
    actions.push(action);
    actionsBySignature.set(signature, actions);
  }

  const bindings = new Map<ShortcutActionId, ParsedShortcut>();
  for (const actions of actionsBySignature.values()) {
    if (actions.length > 1) {
      for (const action of actions) issues.set(action, 'conflict');
      continue;
    }
    const action = actions[0]!;
    const parsed = candidates.get(action);
    if (parsed) bindings.set(action, parsed);
  }

  return { bindings, issues };
}

/** Completes persisted shortcut settings without normalizing user-entered strings. */
export function migrateShortcuts(raw: Record<string, unknown>): void {
  const stored = raw['shortcuts'];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    raw['shortcuts'] = defaultShortcuts();
    return;
  }

  const shortcuts = stored as Record<string, unknown>;
  const defaults = defaultShortcuts();
  for (const action of SHORTCUT_ACTION_IDS) {
    if (typeof shortcuts[action] !== 'string') shortcuts[action] = defaults[action];
  }
  for (const action of Object.keys(shortcuts)) {
    if (!SHORTCUT_ACTION_IDS.includes(action as ShortcutActionId)) delete shortcuts[action];
  }
}
