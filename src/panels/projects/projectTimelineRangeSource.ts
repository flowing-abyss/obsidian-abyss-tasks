import { ProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectCellChange } from '../../projects/projectEdits';
import {
  findFrontmatterProperty,
  findProjectFieldById,
  isAvailableProjectField,
  type ProjectField,
  type ProjectFieldCatalogItem,
} from '../../projects/projectFields';
import { sameProjectPropertyName } from '../../projects/projectPropertyNames';
import {
  PROJECT_TIMELINE_INVALID_RANGE_REASON,
  projectTimelineRawEditEligibility,
  type ProjectTimelineRawEndpoint,
} from '../../projects/projectTimelineEdits';
import type { ProjectTimelineEndpointEditPlan } from '../../projects/projectTimelineEndpointEdits';
import { projectTimelineRange } from '../../projects/projectTimelineModel';
import type { Project } from '../../projects/types';
import type {
  FrozenProjectTimelineRangeSource,
  ProjectTimelineEndpointEvidence,
  ProjectTimelineRangeCapture,
} from './projectTimelineInteraction';

function copyProjectedValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyProjectedValue) : value;
}
function expectProjectFieldProperty(field: ProjectField): string {
  if (field.property === undefined || field.property.length === 0)
    throw new ProjectEditValidationError(`${field.label} has no configured source property.`);
  return field.property;
}
function timelineDateField(
  fields: readonly ProjectFieldCatalogItem[],
  id: 'start' | 'end',
): ProjectField | undefined {
  const field = findProjectFieldById(fields, id);
  if (field === undefined || !isAvailableProjectField(field)) return undefined;
  if (field.type !== 'date' || field.property === undefined || field.property.length === 0) {
    return undefined;
  }
  return field;
}

function sameTimelineProperty(left: ProjectField, right: ProjectField): boolean {
  return sameProjectPropertyName(
    expectProjectFieldProperty(left),
    expectProjectFieldProperty(right),
  );
}

function ambiguousTimelineSource(
  project: Project,
  fields: readonly ProjectField[],
): ProjectField | undefined {
  return fields.find((field) => {
    const property = expectProjectFieldProperty(field);
    return (
      Object.keys(project.frontmatter).filter((key) => sameProjectPropertyName(key, property))
        .length > 1
    );
  });
}

function captureEndpoint(project: Project, field: ProjectField): ProjectTimelineEndpointEvidence {
  const sourceProperty = expectProjectFieldProperty(field);
  const source = findFrontmatterProperty(project.frontmatter, sourceProperty);
  return {
    field: { ...field },
    sourceProperty,
    sourceKey: source?.key ?? sourceProperty,
    expectedExists: source !== undefined,
    expectedValue: copyProjectedValue(source?.value),
  };
}

export function captureProjectTimelineRange(
  project: Project,
  fields: readonly ProjectFieldCatalogItem[],
  occurrenceId: string,
): ProjectTimelineRangeCapture {
  const range = projectTimelineRange(project, fields);
  if (range.kind === 'malformed') {
    return { kind: 'rejected', reason: PROJECT_TIMELINE_INVALID_RANGE_REASON };
  }
  const start = timelineDateField(fields, 'start');
  const end = timelineDateField(fields, 'end');
  if (start === undefined || end === undefined || sameTimelineProperty(start, end)) {
    return {
      kind: 'rejected',
      reason:
        'Configure distinct available date properties for Start and End before Timeline editing.',
    };
  }
  const ambiguous = ambiguousTimelineSource(project, [start, end]);
  if (ambiguous !== undefined) {
    return {
      kind: 'rejected',
      reason: `${ambiguous.label} has ambiguous source spelling. Repair the duplicate properties before Timeline editing.`,
    };
  }
  const source: FrozenProjectTimelineRangeSource = {
    occurrenceId,
    path: project.path,
    start: captureEndpoint(project, start),
    end: captureEndpoint(project, end),
    range: { ...range },
  };
  const eligibility = projectTimelineRawEditEligibility(
    { exists: source.start.expectedExists, value: source.start.expectedValue },
    { exists: source.end.expectedExists, value: source.end.expectedValue },
  );
  return eligibility.kind === 'eligible'
    ? { kind: 'ready', source }
    : { kind: 'rejected', reason: eligibility.reason };
}

export function projectTimelineRangeChanges(
  source: FrozenProjectTimelineRangeSource,
  plan: Extract<ProjectTimelineEndpointEditPlan, { readonly kind: 'ready' }>,
): readonly ProjectCellChange[] {
  const endpoint = (
    evidence: ProjectTimelineEndpointEvidence,
    desired: ProjectTimelineRawEndpoint,
  ): {
    readonly changed: boolean;
    readonly change: ProjectCellChange;
  } => {
    const desiredExists = desired.exists;
    const desiredValue = desired.value;
    const changed =
      desiredExists !== evidence.expectedExists || !Object.is(desiredValue, evidence.expectedValue);
    return {
      changed,
      change: {
        path: source.path,
        field: { ...evidence.field },
        value: desiredValue,
        expectedValue: copyProjectedValue(evidence.expectedValue),
        expectedExists: evidence.expectedExists,
        sourceProperty: evidence.sourceProperty,
        sourceKey: evidence.sourceKey,
      },
    };
  };
  const start = endpoint(source.start, plan.start);
  const end = endpoint(source.end, plan.end);
  if (!start.changed && !end.changed) return [];
  return [
    start.changed
      ? start.change
      : {
          ...start.change,
          valueExists: source.start.expectedExists,
          restoreSourceValue: true,
        },
    end.changed
      ? end.change
      : {
          ...end.change,
          valueExists: source.end.expectedExists,
          restoreSourceValue: true,
        },
  ];
}
