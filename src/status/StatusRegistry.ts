import { toStatusRules } from '../settings/statusCatalogAdapter';
import type { TaskStatusDef } from '../settings/types';
import { StatusCatalog } from '../tasks/domain/StatusCatalog';
import type { TaskStatus, TaskStatusType } from '../tasks/domain/types';
import { TYPE_ORDER } from './statusConstants';

export class StatusRegistry {
  private defs: TaskStatusDef[] = [];
  private readonly catalog: StatusCatalog;
  private byIdMap = new Map<string, TaskStatusDef>();
  private orderByIdMap = new Map<string, number>();

  constructor(defs: TaskStatusDef[]) {
    this.catalog = new StatusCatalog(toStatusRules(defs));
    this.replace(defs);
  }

  replace(defs: TaskStatusDef[]): void {
    this.defs = defs;
    this.catalog.replace(toStatusRules(defs));
    this.byIdMap = new Map();
    this.orderByIdMap = new Map();
    defs.forEach((d, i) => {
      if (!this.byIdMap.has(d.id)) this.byIdMap.set(d.id, d);
      if (!this.orderByIdMap.has(d.id)) this.orderByIdMap.set(d.id, i);
    });
  }

  bySymbol(char: string): TaskStatusDef | undefined {
    const rule = this.catalog.ruleForSymbol(char);
    return rule != null ? this.byIdMap.get(rule.id) : undefined;
  }

  typeForSymbol(char: string): TaskStatus {
    return this.catalog.statusForSymbol(char);
  }

  byType(type: TaskStatusType): TaskStatusDef[] {
    return this.defs.filter((d) => d.type === type);
  }

  grouped(): Array<{ type: TaskStatusType; statuses: TaskStatusDef[] }> {
    return TYPE_ORDER.map((type) => ({ type, statuses: this.byType(type) })).filter(
      (g) => g.statuses.length > 0,
    );
  }

  defaultTodo(): TaskStatusDef {
    return this.requiredDefault('todo');
  }

  defaultDone(): TaskStatusDef {
    return this.requiredDefault('done');
  }

  defaultForType(type: TaskStatusType): TaskStatusDef | undefined {
    const rule = this.catalog.defaultForType(type);
    return rule != null ? this.byIdMap.get(rule.id) : undefined;
  }

  orderIndex(char: string): number {
    const rule = this.catalog.ruleForSymbol(char);
    return rule != null
      ? (this.orderByIdMap.get(rule.id) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  }

  all(): TaskStatusDef[] {
    return this.defs;
  }

  private requiredDefault(type: TaskStatusType): TaskStatusDef {
    const fallback = this.defaultForType(type) ?? this.defs[0];
    if (fallback === undefined) {
      throw new Error('Status registry requires at least one status');
    }
    return fallback;
  }
}
