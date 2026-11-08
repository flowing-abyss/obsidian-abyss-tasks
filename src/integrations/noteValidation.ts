import type {
  ApiResultV1,
  NoteSelectorV1,
  PrepareNoteV1,
  ReadNoteV1,
  SearchNotesV1,
} from '../../api';
import { NOTE_LIMITS } from '../notes/noteApi';
import { integer, invalid, path, record, text, validated } from './validation';

function optional<T>(
  input: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T,
): { [key: string]: T } {
  return input[key] === undefined ? {} : { [key]: parse(input[key]) };
}
function token(value: unknown): string {
  return text(value, 512);
}
function prose(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}
function notePath(value: unknown): string {
  const result = path(value);
  return result.trim() === result &&
    !/^[a-z]:/iu.test(result) &&
    result.toLowerCase().endsWith('.md')
    ? result
    : invalid();
}
function origin(
  value: unknown,
  alias: boolean,
): { from: string; expectedFromRevision: string; alias?: string } {
  const r = record(
    value,
    alias ? ['from', 'expectedFromRevision', 'alias'] : ['from', 'expectedFromRevision'],
  );
  return {
    from: token(r['from']),
    expectedFromRevision: token(r['expectedFromRevision']),
    ...optional(r, 'alias', (v) => text(v, 4096)),
  };
}
function selector(value: unknown): NoteSelectorV1 {
  const r = record(value, ['target', 'expectedRevision', 'path', 'section', 'link']);
  if (r['target'] !== undefined) {
    const v = record(value, ['target', 'expectedRevision']);
    return { target: token(v['target']), ...optional(v, 'expectedRevision', token) };
  }
  if (r['path'] !== undefined) {
    record(value, ['path']);
    return { path: notePath(r['path']) };
  }
  if (r['section'] !== undefined) {
    record(value, ['section']);
    return { section: token(r['section']) };
  }
  record(value, ['link']);
  const link = record(r['link'], ['from', 'expectedFromRevision', 'wikiLink']);
  return {
    link: {
      from: token(link['from']),
      expectedFromRevision: token(link['expectedFromRevision']),
      wikiLink: text(link['wikiLink'], 8192),
    },
  };
}
export function validateNoteRead(value: unknown): ApiResultV1<ReadNoteV1> {
  return validated(() => {
    const r = record(value, ['selector', 'limitCharacters', 'limitSections', 'cursor', 'linkFor']);
    return {
      selector: selector(r['selector']),
      ...optional(r, 'limitCharacters', (v) => integer(v, 2, NOTE_LIMITS.maxPageCharacters)),
      ...optional(r, 'limitSections', (v) => integer(v, 1, NOTE_LIMITS.maxSectionsPerPage)),
      ...optional(r, 'cursor', token),
      ...optional(r, 'linkFor', (v) => {
        const context = record(v, ['from', 'expectedFromRevision', 'fromPath', 'alias']);
        if (context['fromPath'] === undefined) return origin(v, true);
        record(v, ['fromPath', 'alias']);
        return {
          fromPath: notePath(context['fromPath']),
          ...optional(context, 'alias', (a) => text(a, 4096)),
        };
      }),
    };
  });
}
export function validateNoteSearch(value: unknown): ApiResultV1<SearchNotesV1> {
  return validated(() => {
    const r = record(value, ['query', 'fields', 'path', 'folder', 'limit', 'cursor']);
    const fields = r['fields'];
    if (fields !== undefined && fields !== 'name' && fields !== 'body' && fields !== 'all')
      return invalid();
    return {
      query: text(r['query'], 4096),
      ...(fields === undefined ? {} : { fields }),
      ...optional(r, 'path', notePath),
      ...optional(r, 'folder', (v) => path(v, true)),
      ...optional(r, 'limit', (v) => integer(v, 1, NOTE_LIMITS.maxSearchMatches)),
      ...optional(r, 'cursor', token),
    };
  });
}
export function validateNotePrepare(value: unknown): ApiResultV1<PrepareNoteV1> {
  return validated(() => {
    const r = record(value, [
      'kind',
      'target',
      'expectedRevision',
      'operation',
      'path',
      'title',
      'text',
      'template',
      'expectedTemplateRevision',
    ]);
    if (r['kind'] === 'edit') {
      record(value, ['kind', 'target', 'expectedRevision', 'operation']);
      const operation = record(r['operation'], ['type', 'section', 'text']);
      if (operation['type'] !== 'append' && operation['type'] !== 'replace-section')
        return invalid();
      return {
        kind: 'edit',
        target: token(r['target']),
        expectedRevision: token(r['expectedRevision']),
        operation: {
          type: operation['type'],
          section: token(operation['section']),
          text: prose(operation['text']),
        },
      };
    }
    if (r['kind'] !== 'create') return invalid();
    record(value, ['kind', 'path', 'title', 'text', 'template', 'expectedTemplateRevision']);
    if ((r['template'] === undefined) !== (r['expectedTemplateRevision'] === undefined))
      return invalid();
    return {
      kind: 'create',
      path: notePath(r['path']),
      title: text(r['title'], 4096),
      text: prose(r['text']),
      ...optional(r, 'template', token),
      ...optional(r, 'expectedTemplateRevision', token),
    };
  });
}
