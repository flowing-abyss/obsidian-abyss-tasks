/** The Notice for a failed tag settings save: rolled back, or kept by a newer save. */
export function tagSettingsFailureNotice(description: string, rolledBack: boolean): string {
  return rolledBack
    ? `Could not ${description}. Your changes were rolled back.`
    : `Could not save an earlier ${description}. Newer changes were kept.`;
}
