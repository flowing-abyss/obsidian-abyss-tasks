import type {
  ProjectsTablePreference,
  ProjectTableColumnPreference,
  ProjectTasksTablePreference,
} from '../../settings/types';

export type TablePreference = ProjectsTablePreference | ProjectTasksTablePreference;

export function safeFieldLabel(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[-_]+/gu, ' ')
    .trim();
  if (!words) return 'Field';
  return `${words[0]!.toUpperCase()}${words.slice(1).toLowerCase()}`;
}

export function tableVisibleFields(preference: TablePreference): readonly string[] {
  return preference.columns.filter(({ visible }) => visible).map(({ propertyId }) => propertyId);
}

export function resizeTableColumn<T extends TablePreference>(
  preference: T,
  propertyId: string,
  width: number,
): T {
  return {
    ...preference,
    columns: preference.columns.map((column) =>
      column.propertyId === propertyId ? { ...column, width } : column,
    ),
  };
}

export function toggleTableColumn<T extends TablePreference>(preference: T, propertyId: string): T {
  const known = preference.columns.some((column) => column.propertyId === propertyId);
  const columns: readonly ProjectTableColumnPreference[] = known
    ? preference.columns.map((column) =>
        column.propertyId === propertyId ? { ...column, visible: !column.visible } : column,
      )
    : [...preference.columns, { propertyId, visible: true }];
  return { ...preference, columns };
}

export function moveTableColumn<T extends TablePreference>(
  preference: T,
  propertyId: string,
  direction: -1 | 1,
): T {
  const columns = [...preference.columns];
  const index = columns.findIndex((column) => column.propertyId === propertyId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= columns.length) return preference;
  const [column] = columns.splice(index, 1);
  columns.splice(destination, 0, column!);
  return { ...preference, columns };
}

export function setTableGroupCollapsed<T extends TablePreference>(
  preference: T,
  groupKey: string,
  collapsed: boolean,
): T {
  const keys = new Set(preference.collapsedGroups);
  if (collapsed) keys.add(groupKey);
  else keys.delete(groupKey);
  return { ...preference, collapsedGroups: [...keys] };
}
