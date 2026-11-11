import type {
  CommandHistoryFileKey,
  CommandSessionStoragePort,
} from '../../src/ai/CommandSessionStore';
import { expectDefined } from '../helpers';

/** In-memory asynchronous host boundary with compare-before-write semantics. */
export function commandSessionStorage(initial: unknown = null) {
  const files = new Map<string, string>();
  let legacy: unknown = initial;
  let sequence = 0;
  const key = (value: CommandHistoryFileKey): string =>
    value.kind === 'state' ? 'state' : value.fileId;
  const storage: CommandSessionStoragePort = {
    listSessions: async () => [...files.keys()].filter((name) => name !== 'state'),
    read: async (value) => files.get(key(value)) ?? null,
    write: async (value, text, previous) => {
      if ((files.get(key(value)) ?? null) !== previous) throw new Error('conflict');
      files.set(key(value), text);
    },
    remove: async (fileId) => {
      files.delete(fileId);
    },
    loadLegacy: () => structuredClone(legacy),
    clearLegacy: () => {
      legacy = null;
    },
  };
  return {
    storage,
    files,
    fileId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    legacy: () => legacy,
    raw: (): unknown =>
      legacy ?? {
        version: 1,
        activeSessionId: files.has('state')
          ? (JSON.parse(expectDefined(files.get('state'))) as { activeSessionId: string | null })
              .activeSessionId
          : null,
        sessions: [...files.entries()]
          .filter(([name]) => name !== 'state')
          .map(([, text]) => JSON.parse(text) as unknown),
      },
  };
}
