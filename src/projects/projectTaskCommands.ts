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

function projectDestination(
  ports: {
    reads: ProjectIntegrationReads;
    sources: ProjectSourceReadApi;
    settings: () => ProjectsSettings;
  },
  proof: ProjectReadSummary,
  action: 'capture' | 'move',
): ProjectTaskDestination {
  const { reads, sources, settings } = ports;
  const insertion = projectTaskInsertion(settings(), action);
  const accepted = sources.get(proof.path);
  const original = accepted.type === 'ok' ? accepted.value : undefined;
  const frontmatter = JSON.stringify(original?.metadata.frontmatter);
  const originalIdentity = original?.identity;
  const sameSelection = (): boolean =>
    originalIdentity === proof.identity &&
    JSON.stringify(projectTaskInsertion(settings(), action)) === JSON.stringify(insertion);
  return {
    filePath: proof.path,
    insertion,
    refreshPrepared: () => {
      const fresh = reads.summary(proof.path);
      const source = sources.get(proof.path);
      if (
        fresh.type !== 'ok' ||
        fresh.value?.identity !== proof.identity ||
        fresh.value.semantics !== proof.semantics ||
        source.type !== 'ok' ||
        source.value?.identity !== proof.identity ||
        JSON.stringify(source.value.metadata.frontmatter) !== frontmatter ||
        !sameSelection()
      )
        return undefined;
      return projectDestination(ports, fresh.value, action);
    },
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

export function createProjectTaskCommands(
  reads: ProjectIntegrationReads,
  sources: ProjectSourceReadApi,
  service: TaskProjectCommands,
  settings: () => ProjectsSettings,
): ProjectTaskCommands {
  const destination = (
    proof: ProjectReadSummary,
    action: 'capture' | 'move',
  ): ProjectTaskDestination => projectDestination({ reads, sources, settings }, proof, action);
  return {
    prepareDestination(proof) {
      const fresh = reads.summary(proof.path);
      if (fresh.type === 'error') return fresh;
      if (
        fresh.value?.identity !== proof.identity ||
        fresh.value.version !== proof.version ||
        fresh.value.semantics !== proof.semantics
      )
        return { type: 'error', reason: 'stale' };
      return { type: 'ok', value: destination(proof, 'capture'), observation: fresh.observation };
    },
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
      const acquired = sources.acquire(root.ref.filePath);
      const target = destination(proof, 'move');
      return async () => {
        const source = await acquired;
        if (source.type === 'error') return projectTaskFailure(source.reason);
        const original = source.value;
        if (
          original?.roots.some(
            ({ ref }) => ref.line === root.ref.line && ref.revision === root.ref.revision,
          ) !== true
        )
          return projectTaskFailure('stale');
        const { path, identity, version } = original;
        const sourceProof = { path, identity, version };
        return service.moveProjectRoot(target, {
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
      };
    },
  };
}
