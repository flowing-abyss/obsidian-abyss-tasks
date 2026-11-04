export interface TaskOccurrenceAddress {
  readonly filePath: string;
  readonly rootRevision: string;
  readonly rootLine: number;
  /** Physical line offset from the confirmed root, not a child index. */
  readonly nodeOffset: number;
}
