import type { TaskStatusRule, TaskStatusType } from '../tasks/domain/types';
import type { TaskStatusDef } from './types';

export function toStatusRules(defs: readonly TaskStatusDef[]): TaskStatusRule[] {
  const defaultIdByType = new Map<TaskStatusType, string>();
  for (const def of defs) {
    const chosen = defaultIdByType.get(def.type);
    if (
      chosen === undefined ||
      (def.core && !(defs.find((item) => item.id === chosen)?.core ?? false))
    ) {
      defaultIdByType.set(def.type, def.id);
    }
  }
  return defs.map((def) => ({
    id: def.id,
    symbol: def.symbol,
    type: def.type,
    defaultForType: defaultIdByType.get(def.type) === def.id,
  }));
}
