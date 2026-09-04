import type { TaskStatus, TaskStatusRule, TaskStatusType } from './types';

const TYPE_TO_STATUS: Record<TaskStatusType, TaskStatus> = {
  todo: 'open',
  'in-progress': 'in-progress',
  done: 'done',
  cancelled: 'cancelled',
};

function normalizeSymbol(symbol: string): string {
  return symbol === 'X' ? 'x' : symbol;
}

export class StatusCatalog {
  private rules: TaskStatusRule[] = [];
  private bySymbolMap = new Map<string, TaskStatusRule>();

  constructor(rules: readonly TaskStatusRule[]) {
    this.replace(rules);
  }

  replace(rules: readonly TaskStatusRule[]): void {
    this.rules = rules.map((rule) => ({ ...rule }));
    this.bySymbolMap = new Map();
    for (const rule of this.rules) {
      if (!this.bySymbolMap.has(rule.symbol)) this.bySymbolMap.set(rule.symbol, rule);
    }
  }

  statusForSymbol(symbol: string): TaskStatus {
    const rule = this.ruleForSymbol(symbol);
    return rule != null ? TYPE_TO_STATUS[rule.type] : 'open';
  }

  ruleForSymbol(symbol: string): TaskStatusRule | undefined {
    const rule = this.bySymbolMap.get(normalizeSymbol(symbol));
    return rule != null ? { ...rule } : undefined;
  }

  defaultForType(type: TaskStatusType): TaskStatusRule | undefined {
    const rule = this.rules.find(
      (candidate) => candidate.type === type && candidate.defaultForType,
    );
    return rule != null ? { ...rule } : undefined;
  }

  all(): TaskStatusRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }
}
