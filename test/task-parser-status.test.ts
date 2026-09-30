// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseTask } from '../src/parser/TaskParser';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { canonicalStatusCatalog } from './helpers';

const statusCatalog = canonicalStatusCatalog();
const ctx = (line = 0) => ({ filePath: 'n.md', line, statusCatalog });

describe('parseTask status', () => {
  it('parses each default symbol to type + statusSymbol', () => {
    expect(parseTask('- [ ] a', ctx())?.status).toBe('open');
    expect(parseTask('- [ ] a', ctx())?.statusSymbol).toBe(' ');
    expect(parseTask('- [/] a', ctx())?.status).toBe('in-progress');
    expect(parseTask('- [x] a', ctx())?.status).toBe('done');
    expect(parseTask('- [X] a', ctx())?.status).toBe('done'); // uppercase done still resolves
    expect(parseTask('- [-] a', ctx())?.status).toBe('cancelled');
    expect(parseTask('- [!] a', ctx())?.statusSymbol).toBe('!');
    expect(parseTask('- [!] a', ctx())?.status).toBe('open');
  });

  it('unknown symbol falls back to open but keeps the raw glyph', () => {
    const t = parseTask('- [@] weird', ctx());
    expect(t?.status).toBe('open');
    expect(t?.statusSymbol).toBe('@');
  });

  it('uses configured status semantics instead of a built-in symbol mapping', () => {
    const configuredCatalog = new StatusCatalog([
      { id: 'custom-done', symbol: '!', type: 'done', defaultForType: true },
      { id: 'custom-todo', symbol: 'x', type: 'todo', defaultForType: true },
    ]);
    expect(
      parseTask('- [!] configured done', {
        filePath: 'n.md',
        line: 0,
        statusCatalog: configuredCatalog,
      })?.status,
    ).toBe('done');
    expect(
      parseTask('- [x] configured todo', {
        filePath: 'n.md',
        line: 1,
        statusCatalog: configuredCatalog,
      })?.status,
    ).toBe('open');
  });

  it('parses statuses in blockquote/callout-nested tasks', () => {
    const t = parseTask('> - [!] nested', ctx());
    expect(t?.statusSymbol).toBe('!');
    expect(t?.status).toBe('open');
  });

  it('keeps ❌ date → cancelled override', () => {
    const t = parseTask('- [ ] a ❌ 2026-01-02', ctx());
    expect(t?.status).toBe('cancelled');
  });

  it('regex-metacharacter symbols do not break parsing', () => {
    expect(parseTask('- [*] star', ctx())?.statusSymbol).toBe('*');
    expect(parseTask('- [>] fwd', ctx())?.statusSymbol).toBe('>');
  });
});
