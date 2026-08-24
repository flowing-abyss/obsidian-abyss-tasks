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

export interface ParsedShortcutAlternative extends ParsedShortcut {
  readonly fragment: string;
  readonly fragmentIndex: number;
}

export type ShortcutIssue =
  | {
      readonly kind: 'empty' | 'invalid';
      readonly fragment: string;
      readonly fragmentIndex: number;
    }
  | {
      readonly kind: 'duplicate';
      readonly fragment: string;
      readonly fragmentIndex: number;
      readonly duplicateOf: string;
    }
  | {
      readonly kind: 'conflict';
      readonly fragment: string;
      readonly fragmentIndex: number;
      readonly conflictingActions: readonly ShortcutActionId[];
    };

export interface ShortcutValidation {
  readonly bindings: ReadonlyMap<ShortcutActionId, readonly ParsedShortcutAlternative[]>;
  readonly issues: ReadonlyMap<ShortcutActionId, readonly ShortcutIssue[]>;
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

function parseAlternatives(
  action: ShortcutActionId,
  value: string,
  platform: ShortcutPlatform,
): { candidates: ParsedShortcutAlternative[]; issues: ShortcutIssue[] } {
  const candidates: ParsedShortcutAlternative[] = [];
  const issues: ShortcutIssue[] = [];
  if (!value.trim()) return { candidates, issues };

  const firstFragmentsBySignature = new Map<string, string>();

  for (const [fragmentIndex, rawFragment] of value.split('|').entries()) {
    const fragment = rawFragment.trim();
    if (!fragment) {
      issues.push({ kind: 'empty', fragment, fragmentIndex });
      continue;
    }

    const parsed = parseShortcut(action, fragment, platform);
    if (!parsed) {
      issues.push({ kind: 'invalid', fragment, fragmentIndex });
      continue;
    }

    const signature = shortcutSignature(parsed);
    const duplicateOf = firstFragmentsBySignature.get(signature);
    if (duplicateOf !== undefined) {
      issues.push({ kind: 'duplicate', fragment, fragmentIndex, duplicateOf });
      continue;
    }

    firstFragmentsBySignature.set(signature, fragment);
    candidates.push({ ...parsed, fragment, fragmentIndex });
  }

  return { candidates, issues };
}

export function validateShortcuts(
  values: ShortcutSettings,
  platform: ShortcutPlatform,
): ShortcutValidation {
  const candidatesByAction = new Map<ShortcutActionId, ParsedShortcutAlternative[]>();
  const issues = new Map<ShortcutActionId, ShortcutIssue[]>();
  const candidatesBySignature = new Map<
    string,
    Array<{ action: ShortcutActionId; candidate: ParsedShortcutAlternative }>
  >();

  for (const action of SHORTCUT_ACTION_IDS) {
    const value = values[action];
    const parsed = parseAlternatives(action, value, platform);
    if (parsed.candidates.length > 0) candidatesByAction.set(action, parsed.candidates);
    if (parsed.issues.length > 0) issues.set(action, parsed.issues);
    for (const candidate of parsed.candidates) {
      const signature = shortcutSignature(candidate);
      const candidates = candidatesBySignature.get(signature) ?? [];
      candidates.push({ action, candidate });
      candidatesBySignature.set(signature, candidates);
    }
  }

  const bindings = new Map<ShortcutActionId, ParsedShortcutAlternative[]>();
  for (const [action, candidates] of candidatesByAction) {
    const active: ParsedShortcutAlternative[] = [];
    for (const candidate of candidates) {
      const signature = shortcutSignature(candidate);
      const owners = candidatesBySignature.get(signature) ?? [];
      if (owners.length > 1) {
        const actionIssues = issues.get(action) ?? [];
        actionIssues.push({
          kind: 'conflict',
          fragment: candidate.fragment,
          fragmentIndex: candidate.fragmentIndex,
          conflictingActions: owners
            .map((owner) => owner.action)
            .filter((ownerAction) => ownerAction !== action),
        });
        issues.set(action, actionIssues);
      } else {
        active.push(candidate);
      }
    }
    if (active.length > 0) bindings.set(action, active);
  }

  for (const actionIssues of issues.values()) {
    actionIssues.sort((left, right) => left.fragmentIndex - right.fragmentIndex);
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
