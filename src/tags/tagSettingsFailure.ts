/**
 * The Notice for a failed tag settings save. `description` is a verb phrase ("archive tag"): rolled
 * back, the action failed; kept, an earlier request's save failed while a newer save kept its change.
 */
export function tagSettingsFailureNotice(description: string, rolledBack: boolean): string {
  return rolledBack
    ? `Could not ${description}. Your changes were rolled back.`
    : `An earlier request to ${description} was not saved. Newer changes were kept.`;
}
