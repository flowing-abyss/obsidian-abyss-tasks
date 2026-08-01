export interface TaskBehaviorSettings {
  readonly taskLifecycle: {
    readonly addCreatedDate: boolean;
    readonly addCompletionDate: boolean;
  };
  readonly recurrence: {
    readonly newOccurrencePlacement: 'before' | 'after';
    readonly removeScheduledDate: boolean;
  };
}

export type TaskBehaviorSettingsProvider = () => TaskBehaviorSettings;
