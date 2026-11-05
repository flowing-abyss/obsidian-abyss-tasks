import type { ProjectsSettings } from '../settings/types';
import {
  projectTaskFailure,
  type ProjectSourceReadApi,
  type ProjectTaskDestination,
  type ProjectTaskExecution,
  type TaskProjectCommands,
  type TaskReadNode,
  type TaskReadObservation,
} from '../tasks';
import type {
  ProjectIntegrationReads,
  ProjectReadSummary,
  ProjectTaskCommands,
} from './projectApi';
import { projectTaskInsertion } from './projectTaskInsertion';

export function createProjectTaskCommands(
  reads: ProjectIntegrationReads,
  sources: ProjectSourceReadApi,
  service: TaskProjectCommands,
  settings: () => ProjectsSettings,
): ProjectTaskCommands {
  function destination(
    proof: ProjectReadSummary,
    action: 'capture' | 'move',
  ): ProjectTaskDestination {
    return {
      filePath: proof.path,
      insertion: projectTaskInsertion(settings(), action),
      check: (file, live, candidate) => {
        if (!reads.matchesFile(proof, file)) return 'stale';
        const result = reads.guard(proof, live, candidate);
        return result.type === 'error' ? result.reason : undefined;
      },
      checkCopy: (file, content) => {
        const fresh = reads.summary(proof.path);
        if (
          fresh.type === 'error' ||
          fresh.value?.identity !== proof.identity ||
          fresh.value.semantics !== proof.semantics
        )
          return false;
        return (
          reads.matchesFile(fresh.value, file) &&
          reads.guard(fresh.value, content, content).type === 'ok'
        );
      },
    };
  }
  return {
    prepareCreate(proof: ProjectReadSummary, title: string): ProjectTaskExecution {
      return service.prepareProjectCreate(destination(proof, 'capture'), title);
    },
    prepareMove(
      proof: ProjectReadSummary,
      node: TaskReadNode,
      observation: TaskReadObservation,
    ): ProjectTaskExecution {
      if (node.value.target.type !== 'task') return async () => projectTaskFailure('unsupported');
      const root = node.value.root;
      const source = sources.get(root.ref.filePath);
      if (source.type === 'error') return async () => projectTaskFailure(source.reason);
      const original = source.value;
      if (
        original?.roots.some(
          ({ ref }) => ref.line === root.ref.line && ref.revision === root.ref.revision,
        ) !== true
      )
        return async () => projectTaskFailure('stale');
      const { path, identity, version } = original;
      const sourceProof = { path, identity, version };
      const target = destination(proof, 'move');
      return () =>
        service.moveProjectRoot(target, {
          root,
          check: (file, live, candidate) => {
            if (!sources.matchesFile(sourceProof, file)) return 'stale';
            const result = sources.candidate(sourceProof, live, candidate);
            if (result.type === 'error') return result.reason;
            if (
              result.observation.scopeRevision !== observation.scopeRevision ||
              result.observation.semanticsRevision !== observation.semanticsRevision
            )
              return 'stale';
            return undefined;
          },
        });
    },
  };
}
