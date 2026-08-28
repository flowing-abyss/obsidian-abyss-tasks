export interface BoardViewPreference {
  readonly version: 1;
  readonly columnOrder: readonly string[];
  readonly collapsedColumnIds: readonly string[];
  readonly hiddenColumnIds: readonly string[];
  readonly [key: string]: unknown;
}

export interface BoardColumnRoles<ColumnId extends string = string> {
  readonly terminalLeftIds?: readonly ColumnId[];
  readonly terminalRightIds?: readonly ColumnId[];
}

const KNOWN_FIELDS = new Set([
  'version',
  'columnOrder',
  'collapsedColumnIds',
  'hiddenColumnIds',
  'statusIds',
  'dormantStatusIds',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function extras(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_FIELDS.has(key)));
}

function terminalOrder(
  activeOrder: readonly string[],
  configuredOrder: readonly string[],
  roles: BoardColumnRoles,
): string[] {
  const left = new Set(roles.terminalLeftIds ?? []);
  const right = new Set(roles.terminalRightIds ?? []);
  const configuredLeft = configuredOrder.filter((id) => left.has(id));
  const configuredRight = configuredOrder.filter((id) => right.has(id));
  const regular = activeOrder.filter((id) => !left.has(id) && !right.has(id));
  return [...configuredLeft, ...regular, ...configuredRight];
}

function replaceKnown(
  preference: BoardViewPreference,
  values: Pick<BoardViewPreference, 'columnOrder' | 'collapsedColumnIds' | 'hiddenColumnIds'>,
): BoardViewPreference {
  if (
    same(preference.columnOrder, values.columnOrder) &&
    same(preference.collapsedColumnIds, values.collapsedColumnIds) &&
    same(preference.hiddenColumnIds, values.hiddenColumnIds)
  ) {
    return preference;
  }
  return { ...preference, version: 1, ...values };
}

export function buildBoardPreference(columnIds: readonly string[]): BoardViewPreference {
  return {
    version: 1,
    columnOrder: unique(columnIds),
    collapsedColumnIds: [],
    hiddenColumnIds: [],
  };
}

/**
 * Reconciles a stored override without deleting dormant IDs. Active IDs are
 * projected first; unknown IDs remain at the tail for future restoration.
 * Hidden has deterministic precedence over collapsed for active columns.
 */
export function reconcileBoardPreference(
  preference: BoardViewPreference,
  configuredColumnIds: readonly string[],
  roles: BoardColumnRoles = {},
): BoardViewPreference {
  const configured = unique(configuredColumnIds);
  const configuredSet = new Set(configured);
  const stored = unique(preference.columnOrder);
  const active = stored.filter((id) => configuredSet.has(id));
  const activeSet = new Set(active);
  active.push(...configured.filter((id) => !activeSet.has(id)));
  const guardedActive = terminalOrder(active, configured, roles);
  const dormant = stored.filter((id) => !configuredSet.has(id));

  const hidden = unique(preference.hiddenColumnIds);
  const activeHidden = new Set(hidden.filter((id) => configuredSet.has(id)));
  const collapsed = unique(preference.collapsedColumnIds).filter(
    (id) => !configuredSet.has(id) || !activeHidden.has(id),
  );

  return replaceKnown(preference, {
    columnOrder: [...guardedActive, ...dormant],
    collapsedColumnIds: collapsed,
    hiddenColumnIds: hidden,
  });
}

/** Converts legacy Project status arrays and future-safe objects into one schema. */
export function migrateBoardPreference(
  value: unknown,
  configuredColumnIds: readonly string[],
  roles: BoardColumnRoles = {},
): BoardViewPreference {
  const candidate = record(value);
  if (!candidate)
    return reconcileBoardPreference(
      buildBoardPreference(configuredColumnIds),
      configuredColumnIds,
      roles,
    );
  const currentOrder = stringArray(candidate['columnOrder']);
  const legacyOrder = [
    ...stringArray(candidate['statusIds']),
    ...stringArray(candidate['dormantStatusIds']),
  ];
  const preference: BoardViewPreference = {
    ...extras(candidate),
    version: 1,
    columnOrder: currentOrder.length > 0 ? currentOrder : legacyOrder,
    collapsedColumnIds: stringArray(candidate['collapsedColumnIds']),
    hiddenColumnIds: stringArray(candidate['hiddenColumnIds']),
  };
  return reconcileBoardPreference(preference, configuredColumnIds, roles);
}

/** Resets active presentation while retaining every dormant stored override. */
export function resetBoardPreference(
  preference: BoardViewPreference,
  configuredColumnIds: readonly string[],
  roles: BoardColumnRoles = {},
): BoardViewPreference {
  const reconciled = reconcileBoardPreference(preference, configuredColumnIds, roles);
  const configured = unique(configuredColumnIds);
  const configuredSet = new Set(configured);
  const dormantOrder = reconciled.columnOrder.filter((id) => !configuredSet.has(id));
  return replaceKnown(reconciled, {
    columnOrder: [...terminalOrder(configured, configured, roles), ...dormantOrder],
    collapsedColumnIds: reconciled.collapsedColumnIds.filter((id) => !configuredSet.has(id)),
    hiddenColumnIds: reconciled.hiddenColumnIds.filter((id) => !configuredSet.has(id)),
  });
}

export function reorderBoardColumn(
  preference: BoardViewPreference,
  configuredColumnIds: readonly string[],
  columnId: string,
  targetIndex: number,
  roles: BoardColumnRoles = {},
): BoardViewPreference {
  const configured = unique(configuredColumnIds);
  const configuredSet = new Set(configured);
  const left = new Set(roles.terminalLeftIds ?? []);
  const right = new Set(roles.terminalRightIds ?? []);
  if (!configuredSet.has(columnId) || left.has(columnId) || right.has(columnId)) return preference;
  const active = unique([
    ...preference.columnOrder.filter((id) => configuredSet.has(id)),
    ...configured,
  ]);
  const regular = active.filter((id) => !left.has(id) && !right.has(id));
  const sourceIndex = regular.indexOf(columnId);
  if (sourceIndex < 0) return preference;
  const destinationIndex = Math.max(0, Math.min(regular.length - 1, targetIndex));
  if (sourceIndex === destinationIndex) return preference;
  const next = [...regular];
  next.splice(sourceIndex, 1);
  next.splice(destinationIndex, 0, columnId);
  const dormant = preference.columnOrder.filter((id) => !configuredSet.has(id));
  return replaceKnown(preference, {
    columnOrder: [...terminalOrder(next, configured, roles), ...dormant],
    collapsedColumnIds: preference.collapsedColumnIds,
    hiddenColumnIds: preference.hiddenColumnIds,
  });
}

export function moveBoardColumn(
  preference: BoardViewPreference,
  configuredColumnIds: readonly string[],
  columnId: string,
  direction: 'left' | 'right',
  roles: BoardColumnRoles = {},
): BoardViewPreference {
  const configured = unique(configuredColumnIds);
  const configuredSet = new Set(configured);
  const terminal = new Set([...(roles.terminalLeftIds ?? []), ...(roles.terminalRightIds ?? [])]);
  if (!configuredSet.has(columnId) || terminal.has(columnId)) return preference;
  const active = unique([
    ...preference.columnOrder.filter((id) => configuredSet.has(id)),
    ...configured,
  ]);
  const regular = active.filter((id) => !terminal.has(id));
  const index = regular.indexOf(columnId);
  const destination = index + (direction === 'left' ? -1 : 1);
  if (index < 0 || destination < 0 || destination >= regular.length) return preference;
  return reorderBoardColumn(preference, configured, columnId, destination, roles);
}

export function hideBoardColumn(
  preference: BoardViewPreference,
  columnId: string,
): BoardViewPreference {
  const hidden = unique([...preference.hiddenColumnIds, columnId]);
  const collapsed = preference.collapsedColumnIds.filter((id) => id !== columnId);
  return replaceKnown(preference, {
    columnOrder: preference.columnOrder,
    collapsedColumnIds: collapsed,
    hiddenColumnIds: hidden,
  });
}

export function collapseBoardColumn(
  preference: BoardViewPreference,
  columnId: string,
): BoardViewPreference {
  const collapsed = unique([...preference.collapsedColumnIds, columnId]);
  const hidden = preference.hiddenColumnIds.filter((id) => id !== columnId);
  return replaceKnown(preference, {
    columnOrder: preference.columnOrder,
    collapsedColumnIds: collapsed,
    hiddenColumnIds: hidden,
  });
}

export function restoreBoardColumn(
  preference: BoardViewPreference,
  columnId: string,
): BoardViewPreference {
  return replaceKnown(preference, {
    columnOrder: preference.columnOrder,
    collapsedColumnIds: preference.collapsedColumnIds.filter((id) => id !== columnId),
    hiddenColumnIds: preference.hiddenColumnIds.filter((id) => id !== columnId),
  });
}
