import {
  normalizeProjectCellAssignment,
  type ProjectCellChange,
} from '../../projects/projectEdits';
import {
  buildProjectTableModel,
  type ProjectTableModelInput,
} from '../../projects/projectTableModel';
import { resolveStatus } from '../../projects/status';
import { evaluateQuery } from '../../query/evaluateQuery';
import type { ProjectsSettings } from '../../settings/types';

export interface ProjectGroupDropForecastInput {
  readonly model: ProjectTableModelInput;
  readonly change: ProjectCellChange & { readonly sourceProperty: string };
  readonly targetGroupKey: string;
  readonly currentTargetPaths: readonly string[];
  readonly projectsSettings: Pick<
    ProjectsSettings,
    'statusProperty' | 'statuses' | 'membershipQuery'
  >;
  readonly tagsReliable: boolean;
}

export type ProjectGroupDropForecast =
  | { readonly kind: 'before'; readonly projectPath: string }
  | { readonly kind: 'append' }
  | { readonly kind: 'none' };

function forecastPosition(
  input: ProjectGroupDropForecastInput,
  projects: ProjectTableModelInput['projects'],
): ProjectGroupDropForecast {
  const group = buildProjectTableModel({ ...input.model, projects }).groups.find(
    ({ key }) => key === input.targetGroupKey,
  );
  const index = group?.projects.findIndex(({ path }) => path === input.change.path) ?? -1;
  if (group === undefined || index < 0) return { kind: 'none' };
  const targetPaths = new Set(input.currentTargetPaths);
  const next = group.projects.slice(index + 1).find(({ path }) => targetPaths.has(path));
  return next === undefined ? { kind: 'append' } : { kind: 'before', projectPath: next.path };
}

/** Predicts only the sorted landing position after an otherwise accepted group assignment. */
export function forecastProjectGroupDrop(
  input: ProjectGroupDropForecastInput,
): ProjectGroupDropForecast {
  const source = input.model.projects.find(({ path }) => path === input.change.path);
  if (source === undefined || input.currentTargetPaths.includes(source.path)) {
    return { kind: 'none' };
  }
  if (input.projectsSettings.membershipQuery.includes('#') && !input.tagsReliable) {
    return { kind: 'none' };
  }
  const assignment = normalizeProjectCellAssignment(input.change);
  const key = input.change.sourceKey ?? input.change.sourceProperty;
  const frontmatter = { ...source.frontmatter };
  if (assignment.exists) frontmatter[key] = assignment.value;
  else delete frontmatter[key];
  const proposed = {
    ...source,
    frontmatter,
    ...resolveStatus(input.projectsSettings, frontmatter),
  };
  if (
    !evaluateQuery(
      input.projectsSettings.membershipQuery,
      proposed.path,
      proposed.tags,
      frontmatter,
    )
  ) {
    return { kind: 'none' };
  }
  const projects = input.model.projects.map((project) =>
    project.path === proposed.path ? proposed : project,
  );
  return forecastPosition(input, projects);
}
