export interface TaskBehaviorSettings {
  readonly taskPrefix: string;
  readonly inbox: {
    readonly mode: 'tag' | 'untagged' | 'both';
    readonly tag: string;
    readonly removeTagOnAssign: boolean;
  };
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
