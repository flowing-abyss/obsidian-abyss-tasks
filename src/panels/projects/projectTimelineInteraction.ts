import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import type { ProjectField } from '../../projects/projectFields';
import type {
  ProjectTimelineEditIntent,
  ProjectTimelineRelativeEditIntent,
} from '../../projects/projectTimelineEdits';
import { planProjectTimelineEndpointEdit } from '../../projects/projectTimelineEndpointEdits';
import type { ProjectTimelineRange } from '../../projects/projectTimelineModel';
import {
  TimelinePointerInteraction,
  type TimelinePointerInteractionContext,
} from '../timeline/TimelinePointerInteraction';
export { applyProjectTimelineBarGeometry } from '../timeline/TimelinePointerInteraction';

export interface ProjectTimelineEndpointEvidence extends Pick<
  ProjectCellChange,
  'expectedExists' | 'expectedValue' | 'sourceKey' | 'sourceProperty'
> {
  readonly field: ProjectField;
  readonly expectedExists: boolean;
  readonly sourceKey: string;
  readonly sourceProperty: string;
}

export interface FrozenProjectTimelineRangeSource {
  readonly occurrenceId: string;
  readonly path: string;
  readonly start: ProjectTimelineEndpointEvidence;
  readonly end: ProjectTimelineEndpointEvidence;
  readonly range: ProjectTimelineRange;
}

type ProjectTimelineEndpointBinding = Pick<
  ProjectTimelineEndpointEvidence,
  'field' | 'sourceKey' | 'sourceProperty'
>;

export interface FrozenProjectTimelineRangeBinding {
  readonly occurrenceId: string;
  readonly path: string;
  readonly start: ProjectTimelineEndpointBinding;
  readonly end: ProjectTimelineEndpointBinding;
}

export type ProjectTimelineRangeCapture =
  | { readonly kind: 'ready'; readonly source: FrozenProjectTimelineRangeSource }
  | { readonly kind: 'rejected'; readonly reason: string };

export type ProjectTimelineRangeEditRequest =
  | {
      readonly kind: 'pointer';
      readonly source: FrozenProjectTimelineRangeSource;
      readonly intent: ProjectTimelineEditIntent;
    }
  | {
      readonly kind: 'keyboard';
      readonly target: FrozenProjectTimelineRangeBinding;
      readonly intent: ProjectTimelineRelativeEditIntent;
    };

export interface ProjectTimelineRangeCommitter {
  readonly captureRangeSource: (occurrenceId: string) => ProjectTimelineRangeCapture;
  readonly commitRangeEdit: (
    request: ProjectTimelineRangeEditRequest,
  ) => Promise<ProjectEditResult>;
  readonly reportRangeFailure: (failure: unknown) => void;
}

export function freezeProjectTimelineRangeBinding(
  source: FrozenProjectTimelineRangeSource,
): FrozenProjectTimelineRangeBinding {
  const binding = (endpoint: ProjectTimelineEndpointEvidence): ProjectTimelineEndpointBinding => ({
    field: { ...endpoint.field },
    sourceKey: endpoint.sourceKey,
    sourceProperty: endpoint.sourceProperty,
  });
  return {
    occurrenceId: source.occurrenceId,
    path: source.path,
    start: binding(source.start),
    end: binding(source.end),
  };
}

function sameEndpointBinding(
  expected: ProjectTimelineEndpointBinding,
  actual: ProjectTimelineEndpointEvidence,
): boolean {
  return (
    expected.field.id === actual.field.id &&
    expected.field.type === actual.field.type &&
    expected.field.property === actual.field.property &&
    expected.sourceProperty === actual.sourceProperty &&
    expected.sourceKey === actual.sourceKey
  );
}

export function sameProjectTimelineRangeBinding(
  frozen: FrozenProjectTimelineRangeBinding,
  current: FrozenProjectTimelineRangeSource,
): boolean {
  return (
    frozen.path === current.path &&
    frozen.occurrenceId === current.occurrenceId &&
    sameEndpointBinding(frozen.start, current.start) &&
    sameEndpointBinding(frozen.end, current.end)
  );
}

export function sameProjectTimelineRangeSource(
  frozen: FrozenProjectTimelineRangeSource,
  current: FrozenProjectTimelineRangeSource,
): boolean {
  return (
    sameProjectTimelineRangeBinding(frozen, current) &&
    frozen.start.expectedExists === current.start.expectedExists &&
    Object.is(frozen.start.expectedValue, current.start.expectedValue) &&
    frozen.end.expectedExists === current.end.expectedExists &&
    Object.is(frozen.end.expectedValue, current.end.expectedValue)
  );
}

interface ProjectTimelinePointerInteractionContext
  extends
    ProjectTimelineRangeCommitter,
    Pick<
      TimelinePointerInteractionContext<FrozenProjectTimelineRangeSource>,
      | 'root'
      | 'scroll'
      | 'window'
      | 'finishEditor'
      | 'pinsChanged'
      | 'selectRange'
      | 'previewRange'
      | 'clickEndpoint'
    > {}

/** Project metadata capture and receipts adapt to the shared calendar gesture owner. */
export class ProjectTimelinePointerInteraction extends TimelinePointerInteraction<FrozenProjectTimelineRangeSource> {
  constructor(context: ProjectTimelinePointerInteractionContext) {
    super({
      ...context,
      sameSource: sameProjectTimelineRangeSource,
      plan: (source, intent) =>
        planProjectTimelineEndpointEdit(
          source.range,
          {
            start: { exists: source.start.expectedExists, value: source.start.expectedValue },
            end: { exists: source.end.expectedExists, value: source.end.expectedValue },
          },
          intent,
        ),
      commitRangeEdit: async (request) => {
        const result = await context.commitRangeEdit(request);
        return {
          changed: result.applied.length > 0,
          ...(result.failed.length > 0 ? { failure: result } : {}),
        };
      },
    });
  }
}
