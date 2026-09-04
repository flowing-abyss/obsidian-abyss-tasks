import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  aliasForExtension,
  aliasForName,
  buildAttachmentLink,
  saveExternalFile,
} from '../src/attachments/AttachmentService';
import { createAppWithFiles, methodOf } from './helpers';

async function tfile(path: string): Promise<TFile> {
  const app = await createAppWithFiles({ [path]: '' });
  const candidate = app.vault.getAbstractFileByPath(path);
  if (!(candidate instanceof TFile)) throw new Error(`Missing test file ${path}`);
  return candidate;
}

describe('aliasForExtension', () => {
  it('maps image extensions (case-insensitive, dot optional) to image', () => {
    for (const ext of ['png', 'JPG', '.jpeg', 'Gif', 'webp', 'svg', 'bmp', 'avif']) {
      expect(aliasForExtension(ext)).toBe('image');
    }
  });
  it('maps pdf to PDF', () => {
    expect(aliasForExtension('pdf')).toBe('PDF');
    expect(aliasForExtension('.PDF')).toBe('PDF');
  });
  it('maps word-processing docs to doc', () => {
    for (const ext of ['doc', 'DOCX', '.odt', 'rtf', 'pages']) {
      expect(aliasForExtension(ext)).toBe('doc');
    }
  });
  it('maps spreadsheets to table', () => {
    for (const ext of ['xls', 'XLSX', '.xlsm', 'csv', 'ods', 'numbers']) {
      expect(aliasForExtension(ext)).toBe('table');
    }
  });
  it('maps anything else (incl. empty) to file', () => {
    expect(aliasForExtension('zip')).toBe('file');
    expect(aliasForExtension('')).toBe('file');
    expect(aliasForExtension('exe')).toBe('file');
  });
});

describe('aliasForName', () => {
  it('derives alias from the filename extension', () => {
    expect(aliasForName('photo.PNG')).toBe('image');
    expect(aliasForName('report.pdf')).toBe('PDF');
    expect(aliasForName('spec.docx')).toBe('doc');
    expect(aliasForName('budget.xlsx')).toBe('table');
    expect(aliasForName('archive.tar.gz')).toBe('file');
    expect(aliasForName('noext')).toBe('file');
  });
});

describe('saveExternalFile', () => {
  it('requests a path for the filename+sourcePath and writes the bytes there', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const file = { name: 'a.png', arrayBuffer: () => Promise.resolve(bytes) } as unknown as File;
    const created = await tfile('attach/a.png');
    const app = {
      fileManager: { getAvailablePathForAttachment: vi.fn().mockResolvedValue('attach/a.png') },
      vault: { createBinary: vi.fn().mockResolvedValue(created) },
    } as unknown as App;

    const result = await saveExternalFile(app, file, 'Tasks/T.md');

    expect(methodOf(app.fileManager, 'getAvailablePathForAttachment')).toHaveBeenCalledWith(
      'a.png',
      'Tasks/T.md',
    );
    expect(methodOf(app.vault, 'createBinary')).toHaveBeenCalledWith('attach/a.png', bytes);
    expect(result).toBe(created);
  });
});

describe('buildAttachmentLink', () => {
  it('delegates to generateMarkdownLink with the alias', async () => {
    const file = await tfile('attach/a.png');
    const app = {
      fileManager: { generateMarkdownLink: vi.fn().mockReturnValue('[[attach/a.png|image]]') },
    } as unknown as App;
    const link = buildAttachmentLink(app, file, 'Tasks/T.md', 'image');
    expect(methodOf(app.fileManager, 'generateMarkdownLink')).toHaveBeenCalledWith(
      file,
      'Tasks/T.md',
      undefined,
      'image',
    );
    expect(link).toBe('[[attach/a.png|image]]');
  });
});
