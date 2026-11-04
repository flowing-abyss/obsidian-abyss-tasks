export interface TaskOccurrenceAddress {
  readonly filePath: string;
  readonly rootRevision: string;
  readonly rootLine: number;
  /** Physical line offset from the confirmed root, not a child index. */
  readonly nodeOffset: number;
}

export type TaskOccurrenceWitness =
  | {
      readonly kind: 'continued';
      readonly before: TaskOccurrenceAddress;
      readonly after: TaskOccurrenceAddress;
    }
  | { readonly kind: 'removed'; readonly before: TaskOccurrenceAddress }
  | {
      readonly kind: 'created';
      readonly after: TaskOccurrenceAddress;
      readonly reason?: 'recurrence';
    };
