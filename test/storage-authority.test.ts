import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectStorageAccesses,
  STORAGE_AUTHORIZATIONS,
  storageAuthorityViolations,
} from './architecture/storageAuthority';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
function repoFile(file: string): string {
  return `${ROOT}/${file}`;
}
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2021,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  types: [],
};
const prelude =
  "import { App, Plugin, Vault as NoteVault, TFile } from 'obsidian';\ndeclare const app: App, plugin: Plugin, file: TFile;\n";
const denied = [
  ["await app.vault.adapter.write('a.md', 'text');", 'DataAdapter.write'],
  ["await app.vault.adapter.append('a.md', 'text');", 'DataAdapter.append'],
  ['await app.fileManager.processFrontMatter(file, () => {});', 'FileManager.processFrontMatter'],
  ["const writer: NoteVault = app.vault; await writer.create('a.md', '- [ ] x');", 'Vault.create'],
  ["await app.vault['modify'](file, 'text');", 'Vault.modify'],
  ["await app.vault?.['append']?.(file, 'text');", 'Vault.append'],
  ['await app.vault.process(file, text => text);', 'Vault.process'],
  ['const extracted = app.vault.modify;', 'Vault.modify'],
  ['const bound = app.vault.process.bind(app.vault);', 'Vault.process'],
  ['const { create: extracted } = app.vault;', 'Vault.create'],
  ["const { ['append']: extracted } = app.vault.adapter;", 'DataAdapter.append'],
  ['await plugin.saveData({});', 'Plugin.saveData'],
  ['const extracted = plugin["saveData"];', 'Plugin.saveData'],
  [
    'declare const optionalVault: NoteVault | undefined; await optionalVault?.["modify"]?.(file, "text");',
    'Vault.modify',
  ],
] as const;
const safe = `
await app.vault.cachedRead(file);
await app.vault.adapter.read('a.md');
await app.vault.createFolder('folder');
await app.vault.createBinary('image.png', new ArrayBuffer(0));
const port = { write: async (_path: string, _data: string) => {} };
await port.write('state.json', '{}');
const transformer = { process: (text: string) => text, create: () => {}, saveData: () => {} };
transformer.process('text'); transformer.create(); transformer.saveData();
const tasks = { execute: async (_command: { type: 'delete' }) => {} };
await tasks.execute({ type: 'delete' });
const element = document.createElement('div'); element.append('text');
new Map<string, string>().delete('key');
`;
// These source-shaped fixtures independently enumerate the audited operation owners.
const allowed = [
  ['src/projects/ProjectManager.ts', 'ProjectManager', 'applyEditsGuarded', 'Vault.process'],
  ['src/projects/ProjectManager.ts', 'ProjectManager', 'createProjectFile', 'Vault.process'],
  ['src/projects/ProjectManager.ts', 'ProjectManager', 'writeStatusRename', 'Vault.process'],
  ['src/projects/ProjectManager.ts', 'ProjectManager', 'restoreStatusRename', 'Vault.process'],
  ['src/notes/NoteTemplateService.ts', 'NoteTemplateService', 'createPreparedNote', 'Vault.create'],
  ['src/notes/NoteTemplateService.ts', 'NoteTemplateService', 'applyTemplate', 'Vault.process'],
  ['src/tags/TagManager.ts', 'TagManager', 'applyVaultRenames', 'Vault.process'],
  [
    'src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts',
    'ObsidianTaskRepository',
    'processFile_abyssPrivate',
    'Vault.process',
  ],
] as const;

function fixtureProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, version, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(fileName);
    return source === undefined
      ? original(fileName, version, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, version, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => ROOT,
        getCanonicalFileName: (name) => name,
        getNewLine: () => '\n',
      }),
    );
  }
  return program;
}

let program: ts.Program;
const sourceMap = new Map<string, string>();
for (const [index, [source]] of denied.entries()) {
  sourceMap.set(repoFile(`src/ui/storage-probe-${index}.ts`), prelude + source);
}
sourceMap.set(repoFile('src/ui/storage-safe.ts'), prelude + safe);
// Use each real class name once, with all authorized methods grouped in it.
for (const [file, className] of allowed) {
  const methods = allowed
    .filter(([candidate]) => candidate === file)
    .map(
      ([, , method, api]) =>
        `async ${method}() { ${api === 'Vault.create' ? "await app.vault.create('a.md', '');" : 'await app.vault.process(file, text => text);'} }`,
    );
  sourceMap.set(repoFile(file), `${prelude}export class ${className} { ${methods.join('\n')} }`);
}
sourceMap.set(
  repoFile('src/main.ts'),
  `${prelude}
export class TaskCalendarPlugin extends Plugin {
  persistencePort() {
    const adapter = this.app.vault.adapter;
    return {
      saveStatic: (data: unknown) => this.saveData(data),
      state: { write: (path: string, data: string) => adapter.write(path, data) },
    };
  }
}`,
);

beforeAll(() => {
  program = fixtureProgram(sourceMap);
}, 20_000);
function accesses(file: string) {
  const source = program.getSourceFile(repoFile(file));
  if (source === undefined) throw new Error(`Missing fixture ${file}`);
  return collectStorageAccesses(program, [source]);
}

describe('resolved Obsidian storage authority', () => {
  it.each(denied.map(([source, api], index) => ({ source, api, index })))(
    'rejects $api in $source',
    ({ api, index }) => {
      const file = `src/ui/storage-probe-${index}.ts`;
      const found = accesses(file);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ file, api, owner: '<module>', line: 3 });
      expect(storageAuthorityViolations(found, [])).toHaveLength(1);
    },
  );

  it('reports a stable source span and diagnostic ID', () => {
    const found = accesses('src/ui/storage-probe-0.ts');
    expect(found).toEqual([
      {
        file: 'src/ui/storage-probe-0.ts',
        line: 3,
        column: 7,
        api: 'DataAdapter.write',
        owner: '<module>',
      },
    ]);
    expect(storageAuthorityViolations(found, [])).toEqual([
      'storage/unauthorized src/ui/storage-probe-0.ts:3:7 <module> DataAdapter.write',
    ]);
  });

  it('accepts reads, provisioning of folders/binary files, ports and unrelated method names', () => {
    expect(accesses('src/ui/storage-safe.ts')).toEqual([]);
  });

  it('accepts every exact current owner, including the named persistence callbacks', () => {
    const found = [...new Set([...allowed.map(([file]) => file), 'src/main.ts'])].flatMap(accesses);
    expect(found).toHaveLength(10);
    expect(storageAuthorityViolations(found, STORAGE_AUTHORIZATIONS)).toEqual([]);
  });

  it('rejects stale, duplicate and unreasoned authorizations and extra references in an owner', () => {
    const access = {
      file: 'src/main.ts',
      owner: 'TaskCalendarPlugin.persistencePort.saveStatic',
      api: 'Plugin.saveData',
      line: 1,
      column: 1,
    };
    const authorization = {
      file: access.file,
      owner: access.owner,
      api: access.api,
      reason: 'Static preferences port.',
    };
    expect(storageAuthorityViolations([], [authorization])).toEqual([
      'storage/stale src/main.ts#TaskCalendarPlugin.persistencePort.saveStatic#Plugin.saveData',
    ]);
    expect(storageAuthorityViolations([access], [authorization, authorization])).toEqual([
      'storage/duplicate src/main.ts#TaskCalendarPlugin.persistencePort.saveStatic#Plugin.saveData',
    ]);
    expect(storageAuthorityViolations([access], [{ ...authorization, reason: ' ' }])).toEqual([
      'storage/missing-reason src/main.ts#TaskCalendarPlugin.persistencePort.saveStatic#Plugin.saveData',
    ]);
    expect(storageAuthorityViolations([access, { ...access, line: 2 }], [authorization])).toEqual([
      'storage/unauthorized src/main.ts:2:1 TaskCalendarPlugin.persistencePort.saveStatic Plugin.saveData',
    ]);
    expect(
      storageAuthorityViolations(
        [{ ...access, owner: 'TaskCalendarPlugin.render' }],
        [authorization],
      ),
    ).toHaveLength(2);
  });

  it('fails fixture setup on unresolved types or malformed syntax', () => {
    expect(() =>
      fixtureProgram(
        new Map([
          [
            repoFile('test/broken-storage.ts'),
            "import { MissingVault } from 'obsidian'; declare const vault: MissingVault; vault.write();",
          ],
        ]),
      ),
    ).toThrow(/MissingVault/u);
    expect(() =>
      fixtureProgram(new Map([[repoFile('test/broken-storage.ts'), 'const = ;']])),
    ).toThrow();
  }, 20_000);

  it('keeps the real source inventory exact and reasoned', () => {
    const files = ts.sys.readDirectory(repoFile('src'), ['.ts']);
    const sourceProgram = ts.createProgram(files, options);
    const sourceFiles = sourceProgram
      .getSourceFiles()
      .filter((source) => files.includes(source.fileName));
    const found = collectStorageAccesses(sourceProgram, sourceFiles);
    expect(found).toHaveLength(10);
    expect(storageAuthorityViolations(found, STORAGE_AUTHORIZATIONS)).toEqual([]);
  }, 20_000);
});
