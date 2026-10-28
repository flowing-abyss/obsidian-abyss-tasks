import type { ProjectsSettings } from '../settings/types';
import type { ProjectSourceObservation } from './ProjectStore';
import { ProjectEditValidationError } from './projectEditError';
import { copyOwnedInferredPropertyClear, type AppliedProjectCellChange } from './projectEdits';
import { findFrontmatterProperty } from './projectFields';
import { resolveStatus } from './status';
import type { Project } from './types';

export type ProjectMutationSessionChange =
  | { readonly type: 'source'; readonly path: string; readonly projectionChanged: boolean }
  | { readonly type: 'projection' }
  | { readonly type: 'settled' };

export interface ProjectMutationSessionOptions {
  readonly revalidateSourceObservation: (observation: ProjectSourceObservation) => Promise<boolean>;
  readonly onChange: (change: ProjectMutationSessionChange) => void;
}

interface ProjectReceiptProjection {
  readonly receipt: AppliedProjectCellChange;
  readonly sourceRevisionAtMutationStart: number;
  readonly ordinal: number;
}

function copyProjectedValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyProjectedValue) : value;
}

function equalProjectedValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalProjectedValue(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function observationMatchesReceipt(
  observation: ProjectSourceObservation,
  receipt: AppliedProjectCellChange,
): boolean {
  const source =
    observation.project === undefined
      ? undefined
      : findFrontmatterProperty(observation.project.frontmatter, receipt.sourceProperty);
  return (
    (source !== undefined) === receipt.appliedExists &&
    (!receipt.appliedExists || equalProjectedValue(source?.value, receipt.value))
  );
}

function projectionKey(receipt: AppliedProjectCellChange): string {
  return `${receipt.path}\u0000${receipt.field.id}`;
}

/** Owns transient mutation ordering and verified-source receipt projection across project surfaces. */
export class ProjectMutationSession {
  private options_abyssPrivate: ProjectMutationSessionOptions | undefined;
  private mutationTail_abyssPrivate: Promise<void> = Promise.resolve();
  private mutationActive_abyssPrivate = false;
  private readonly sourceObservations_abyssPrivate = new Map<string, ProjectSourceObservation>();
  private readonly receiptProjections_abyssPrivate = new Map<string, ProjectReceiptProjection>();
  private activeMutationSourceRevisions_abyssPrivate: ReadonlyMap<string, number> | undefined;
  private nextReceiptOrdinal_abyssPrivate = 0;

  constructor(options: ProjectMutationSessionOptions) {
    this.options_abyssPrivate = options;
  }

  get active(): boolean {
    return this.mutationActive_abyssPrivate;
  }

  run<T>(mutation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.options_abyssPrivate === undefined)
        throw new ProjectEditValidationError('The project session is no longer available.');
      this.mutationActive_abyssPrivate = true;
      this.activeMutationSourceRevisions_abyssPrivate = new Map(
        Array.from(this.sourceObservations_abyssPrivate, ([path, observation]) => [
          path,
          observation.revision,
        ]),
      );
      try {
        return await mutation();
      } finally {
        this.activeMutationSourceRevisions_abyssPrivate = undefined;
        this.mutationActive_abyssPrivate = false;
        this.notify_abyssPrivate({ type: 'settled' });
      }
    };
    const result = this.mutationTail_abyssPrivate.then(run, run);
    this.mutationTail_abyssPrivate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Reconciles receipt projections only from ProjectStore's verified per-path source stream. */
  observe(observation: ProjectSourceObservation): void {
    if (this.options_abyssPrivate === undefined) return;
    const current = this.sourceObservations_abyssPrivate.get(observation.path);
    if (current !== undefined && current.revision >= observation.revision) return;
    this.sourceObservations_abyssPrivate.set(observation.path, observation);
    let changed = false;
    for (const [key, projection] of this.receiptProjections_abyssPrivate) {
      if (
        projection.receipt.path === observation.path &&
        observation.revision > projection.sourceRevisionAtMutationStart
      ) {
        this.receiptProjections_abyssPrivate.delete(key);
        changed = true;
      }
    }
    this.options_abyssPrivate.onChange({
      type: 'source',
      path: observation.path,
      projectionChanged: changed,
    });
  }

  /** Publishes successful editor, paste, drop, Undo, and Redo receipts into this session. */
  publish(receipts: readonly AppliedProjectCellChange[]): void {
    if (this.options_abyssPrivate === undefined) return;
    for (const receipt of receipts) {
      this.publishAppliedReceipt_abyssPrivate(receipt);
    }
    this.notify_abyssPrivate({ type: 'projection' });
  }

  private publishAppliedReceipt_abyssPrivate(receipt: AppliedProjectCellChange): void {
    const activeRevisions = this.activeMutationSourceRevisions_abyssPrivate;
    const sourceRevisionAtMutationStart =
      activeRevisions !== undefined
        ? (activeRevisions.get(receipt.path) ?? 0)
        : (this.sourceObservations_abyssPrivate.get(receipt.path)?.revision ?? 0);
    const observation = this.sourceObservations_abyssPrivate.get(receipt.path);
    const observedDuringMutation =
      observation !== undefined && observation.revision > sourceRevisionAtMutationStart;
    const key = projectionKey(receipt);
    if (observedDuringMutation && observationMatchesReceipt(observation, receipt)) {
      this.receiptProjections_abyssPrivate.delete(key);
      return;
    }
    const ownedClear = copyOwnedInferredPropertyClear(receipt.ownedClear);
    const projection: ProjectReceiptProjection = {
      receipt: {
        ...receipt,
        field: { ...receipt.field },
        value: copyProjectedValue(receipt.value),
        previousValue: copyProjectedValue(receipt.previousValue),
        expectedValue: copyProjectedValue(receipt.expectedValue),
        ...(ownedClear === undefined ? {} : { ownedClear }),
      },
      sourceRevisionAtMutationStart,
      ordinal: ++this.nextReceiptOrdinal_abyssPrivate,
    };
    this.receiptProjections_abyssPrivate.set(key, projection);
    if (observedDuringMutation) {
      this.revalidateReceiptProjection_abyssPrivate(key, projection, observation);
    }
  }

  private revalidateReceiptProjection_abyssPrivate(
    key: string,
    projection: ProjectReceiptProjection,
    observation: ProjectSourceObservation,
  ): void {
    const options = this.options_abyssPrivate;
    if (options === undefined) return;
    void options.revalidateSourceObservation(observation).then(
      (current) => {
        if (!current || this.receiptProjections_abyssPrivate.get(key) !== projection) return;
        if (this.sourceObservations_abyssPrivate.get(observation.path) !== observation) return;
        this.receiptProjections_abyssPrivate.delete(key);
        this.notify_abyssPrivate({ type: 'projection' });
      },
      (error: unknown) => {
        if (this.options_abyssPrivate === undefined) return;
        console.error('[abyss-tasks] Could not revalidate project receipt projection', {
          path: observation.path,
          cause: error,
        });
      },
    );
  }

  project(
    projects: readonly Project[],
    settings: Pick<ProjectsSettings, 'statusProperty' | 'statuses'>,
  ): readonly Project[] {
    const byPath = new Map<string, ProjectReceiptProjection[]>();
    for (const projection of this.receiptProjections_abyssPrivate.values()) {
      const projections = byPath.get(projection.receipt.path) ?? [];
      projections.push(projection);
      byPath.set(projection.receipt.path, projections);
    }
    return projects.map((project) => {
      const projections = byPath.get(project.path);
      if (projections === undefined) return project;
      const frontmatter = { ...project.frontmatter };
      projections.sort((left, right) => left.ordinal - right.ordinal);
      for (const { receipt } of projections) {
        if (receipt.appliedExists) {
          frontmatter[receipt.sourceKey] = copyProjectedValue(receipt.value);
        } else {
          delete frontmatter[receipt.sourceKey];
        }
      }
      return {
        ...project,
        frontmatter,
        ...resolveStatus(settings, frontmatter),
      };
    });
  }

  hasPendingSourceProperty(path: string, properties: readonly string[]): boolean {
    return Array.from(this.receiptProjections_abyssPrivate.values()).some(
      ({ receipt }) =>
        receipt.path === path &&
        properties.some(
          (property) => property.toLocaleLowerCase() === receipt.sourceKey.toLocaleLowerCase(),
        ),
    );
  }

  private notify_abyssPrivate(change: ProjectMutationSessionChange): void {
    this.options_abyssPrivate?.onChange(change);
  }

  dispose(): void {
    this.options_abyssPrivate = undefined;
    this.sourceObservations_abyssPrivate.clear();
    this.receiptProjections_abyssPrivate.clear();
    this.activeMutationSourceRevisions_abyssPrivate = undefined;
  }
}
