import { exactLinkToken, type LinkToken } from '../../markdown/links';

export interface ProjectPropertyValuePresentation {
  readonly value: string;
  readonly label: string;
  readonly link?: LinkToken;
  readonly detail?: string;
}

/** Describes one atomic property value without changing the raw value that will be saved. */
export function projectPropertyValuePresentation(value: string): ProjectPropertyValuePresentation {
  const link = exactLinkToken(value);
  return link === undefined ? { value, label: value } : { value, label: link.display, link };
}

/** Builds readable suggestions and disambiguates only links whose visible labels collide. */
export function projectPropertyValuePresentations(
  values: readonly string[],
): ProjectPropertyValuePresentation[] {
  const presentations: ProjectPropertyValuePresentation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLocaleLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    presentations.push(projectPropertyValuePresentation(value));
  }
  const labelCounts = new Map<string, number>();
  for (const { label } of presentations) {
    const normalized = label.toLocaleLowerCase();
    labelCounts.set(normalized, (labelCounts.get(normalized) ?? 0) + 1);
  }
  return presentations.map((presentation) =>
    presentation.link !== undefined &&
    (labelCounts.get(presentation.label.toLocaleLowerCase()) ?? 0) > 1
      ? { ...presentation, detail: presentation.link.target }
      : presentation,
  );
}

export function projectTagLabel(value: string): string {
  return value.startsWith('#') ? value : `#${value}`;
}
