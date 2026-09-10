import { exactLinkToken, type LinkToken } from '../markdown/links';

export interface ProjectPropertyValuePresentation {
  readonly value: string;
  readonly label: string;
  readonly link?: LinkToken;
  readonly detail?: string;
}

export function projectPropertyValuePresentation(value: string): ProjectPropertyValuePresentation {
  const link = exactLinkToken(value);
  return link === undefined ? { value, label: value } : { value, label: link.display, link };
}

export function projectPropertyValuePresentations(
  values: readonly string[],
): ProjectPropertyValuePresentation[] {
  const presentations: ProjectPropertyValuePresentation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    presentations.push(projectPropertyValuePresentation(value));
  }
  const counts = new Map<string, number>();
  for (const { label } of presentations) {
    const normalized = label.toLocaleLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return presentations.map((presentation) =>
    presentation.link !== undefined && (counts.get(presentation.label.toLocaleLowerCase()) ?? 0) > 1
      ? { ...presentation, detail: presentation.link.target }
      : presentation,
  );
}

export function projectTagLabel(value: string): string {
  return value.startsWith('#') ? value : `#${value}`;
}
