import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  attachFilesAsLinks,
  defaultPastedName,
  enableAttachmentDrop,
  enableAttachmentPaste,
  insertAtCaret,
  resolveDraggedItems,
  whenPasteSettled,
} from '../src/ui/attachmentDrop';
import { createAppWithFiles, deferred, flushMicrotasks, methodOf } from './helpers';

const file = (name: string): File => ({ name }) as unknown as File;

async function tfile(path: string): Promise<TFile> {
  const app = await createAppWithFiles({ [path]: '' });
  const candidate = app.vault.getAbstractFileByPath(path);
  if (!(candidate instanceof TFile)) throw new Error(`Missing test file ${path}`);
  return candidate;
}

describe('defaultPastedName', () => {
  it('derives a filename from the image MIME type', () => {
    expect(defaultPastedName('image/png')).toBe('pasted-image.png');
    expect(defaultPastedName('image/jpeg')).toBe('pasted-image.jpg');
    expect(defaultPastedName('image/svg+xml')).toBe('pasted-image.svg');
  });
  it('falls back to the raw image subtype when unmapped', () => {
    expect(defaultPastedName('image/tiff')).toBe('pasted-image.tiff');
  });
  it('uses pasted-file for non-image blobs', () => {
    expect(defaultPastedName('application/pdf')).toBe('pasted-file');
    expect(defaultPastedName('')).toBe('pasted-file');
  });
});

describe('insertAtCaret', () => {
  const ta = (value: string, start: number, end = start): HTMLTextAreaElement => {
    const el = createEl('textarea');
    el.value = value;
    el.setSelectionRange(start, end);
    return el;
  };

  it('inserts into an empty textarea without a leading space', () => {
    const el = ta('', 0);
    insertAtCaret(el, '[[a.png|image]]');
    expect(el.value).toBe('[[a.png|image]]');
  });
  it('adds a separating space after existing non-space text', () => {
    const el = ta('note', 4);
    insertAtCaret(el, '[[a.png|image]]');
    expect(el.value).toBe('note [[a.png|image]]');
  });
  it('pads both sides when inserting between existing words so nothing fuses', () => {
    // value 'a b', caret at index 2 (after the space) → no lead space, trailing space added
    const el = ta('a b', 2);
    insertAtCaret(el, 'X');
    expect(el.value).toBe('a X b');
  });
  it('adds a trailing space when following text is non-space (caret before it)', () => {
    const el = ta('after', 0);
    insertAtCaret(el, '[[a.png|image]]');
    expect(el.value).toBe('[[a.png|image]] after');
  });
});

describe('attachFilesAsLinks', () => {
  it('names a nameless clipboard blob from its MIME type before saving', async () => {
    const bytes = new Uint8Array([1]).buffer;
    const pasted = {
      name: '',
      type: 'image/png',
      arrayBuffer: () => Promise.resolve(bytes),
    } as unknown as File;
    const saved = await tfile('pasted-image.png');
    const app = {
      fileManager: {
        getAvailablePathForAttachment: vi.fn().mockResolvedValue('pasted-image.png'),
        generateMarkdownLink: vi.fn().mockReturnValue('[[pasted-image.png|image]]'),
      },
      vault: { createBinary: vi.fn().mockResolvedValue(saved) },
    } as unknown as App;

    const links = await attachFilesAsLinks(app, [pasted], 'Tasks/T.md');

    expect(methodOf(app.fileManager, 'getAvailablePathForAttachment')).toHaveBeenCalledWith(
      'pasted-image.png',
      'Tasks/T.md',
    );
    expect(links).toEqual(['[[pasted-image.png|image]]']);
  });
});

describe('enableAttachmentPaste + whenPasteSettled', () => {
  const pngApp = (): App =>
    ({
      fileManager: {
        getAvailablePathForAttachment: vi.fn().mockResolvedValue('a.png'),
        generateMarkdownLink: vi.fn().mockReturnValue('[[a.png|image]]'),
      },
      vault: { createBinary: vi.fn().mockResolvedValue({ name: 'a.png' }) },
    }) as unknown as App;

  const pasteEvent = (files: File[]): Event => {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files } });
    return ev;
  };

  it('whenPasteSettled resolves immediately when nothing is pending', async () => {
    const el = createEl('textarea');
    await expect(whenPasteSettled(el)).resolves.toBeUndefined();
  });

  it('inserts only after the async attach settles; whenPasteSettled awaits it', async () => {
    const el = createEl('textarea');
    const inserted: string[] = [];
    const f = {
      name: 'a.png',
      type: 'image/png',
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    } as unknown as File;
    enableAttachmentPaste(el, {
      app: pngApp(),
      sourcePath: 'T.md',
      onInsert: (l) => inserted.push(l),
    });

    el.dispatchEvent(pasteEvent([f]));
    expect(inserted).toEqual([]); // not inserted synchronously

    await whenPasteSettled(el);
    expect(inserted).toEqual(['[[a.png|image]]']); // settled → link inserted
  });

  it('ignores a paste with no files (lets normal text paste proceed)', async () => {
    const el = createEl('textarea');
    const inserted: string[] = [];
    enableAttachmentPaste(el, {
      app: pngApp(),
      sourcePath: 'T.md',
      onInsert: (l) => inserted.push(l),
    });
    el.dispatchEvent(pasteEvent([]));
    await whenPasteSettled(el);
    expect(inserted).toEqual([]);
  });
});

describe('resolveDraggedItems', () => {
  it('returns external files when the drop carries OS files', () => {
    const dt = { files: [file('a.png'), file('b.pdf')] } as unknown as DataTransfer;
    const r = resolveDraggedItems(dt, undefined);
    expect(r.externalFiles.map((f) => f.name)).toEqual(['a.png', 'b.pdf']);
    expect(r.vaultFiles).toEqual([]);
  });

  it('falls back to the vault drag manager when there are no OS files', async () => {
    const dt = { files: [] } as unknown as DataTransfer;
    const r = resolveDraggedItems(dt, { draggable: { file: await tfile('Notes/x.md') } });
    expect(r.externalFiles).toEqual([]);
    expect(r.vaultFiles.map((f) => f.path)).toEqual(['Notes/x.md']);
  });

  it('supports a multi-file vault drag', async () => {
    const dt = { files: [] } as unknown as DataTransfer;
    const r = resolveDraggedItems(dt, {
      draggable: { files: [await tfile('a.md'), await tfile('b.png')] },
    });
    expect(r.vaultFiles.map((f) => f.path)).toEqual(['a.md', 'b.png']);
  });

  it('prefers external files over the drag manager when both exist', async () => {
    const dt = { files: [file('a.png')] } as unknown as DataTransfer;
    const r = resolveDraggedItems(dt, { draggable: { file: await tfile('x.md') } });
    expect(r.externalFiles.map((f) => f.name)).toEqual(['a.png']);
    expect(r.vaultFiles).toEqual([]);
  });

  it('returns empty for a null dataTransfer and no drag manager', () => {
    expect(resolveDraggedItems(null, undefined)).toEqual({ externalFiles: [], vaultFiles: [] });
  });
});

describe('attachment drop target capture', () => {
  it('captures once before asynchronous file saving and disposes its listeners', async () => {
    const bytes = deferred<ArrayBuffer>();
    const app = await createAppWithFiles({ 'saved.png': '' });
    Object.assign(app, { dragManager: undefined });
    const saved = await tfile('saved.png');
    vi.spyOn(app.fileManager, 'getAvailablePathForAttachment').mockResolvedValue('saved.png');
    vi.spyOn(app.vault, 'createBinary').mockResolvedValue(saved);
    vi.spyOn(app.fileManager, 'generateMarkdownLink').mockReturnValue('[[saved.png]]');
    const element = activeDocument.body.createDiv();
    let target = 'before';
    const received: string[] = [];
    const capture = vi.fn(() => {
      const captured = target;
      return {
        sourcePath: 'tasks.md',
        onLinks: (links: string) => {
          received.push(`${captured}:${links}`);
        },
      };
    });
    const cleanup = enableAttachmentDrop(element, {
      app,
      sourcePath: 'tasks.md',
      onLinks: () => {
        received.push('uncaptured');
      },
      capture,
    });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: [{ name: 'image.png', type: 'image/png', arrayBuffer: () => bytes.promise }],
      },
    });
    element.dispatchEvent(event);
    target = 'after';
    bytes.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => {
      expect(received).toEqual(['before:[[saved.png]]']);
    });
    expect(capture).toHaveBeenCalledOnce();
    cleanup();
    element.dispatchEvent(event);
    await flushMicrotasks();
    expect(capture).toHaveBeenCalledOnce();
    element.remove();
  });

  it('rejects a retired owner before saving any file', async () => {
    const app = await createAppWithFiles({});
    Object.assign(app, { dragManager: undefined });
    const save = vi.spyOn(app.vault, 'createBinary');
    const bytes = vi.fn().mockResolvedValue(new ArrayBuffer(1));
    const element = activeDocument.body.createDiv();
    const onLinks = vi.fn();
    const cleanup = enableAttachmentDrop(element, {
      app,
      sourcePath: 'tasks.md',
      onLinks,
      capture: () => undefined,
    });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [{ name: 'image.png', type: 'image/png', arrayBuffer: bytes }] },
    });
    element.dispatchEvent(event);
    await flushMicrotasks();
    expect(bytes).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(onLinks).not.toHaveBeenCalled();
    cleanup();
    element.remove();
  });
});

describe('attachment paste captured insertion lifetime', () => {
  it('keeps each captured session independent and suppresses insertion after disposal', async () => {
    const app = await createAppWithFiles({ 'saved.png': '' });
    const saved = await tfile('saved.png');
    vi.spyOn(app.fileManager, 'getAvailablePathForAttachment').mockResolvedValue('saved.png');
    vi.spyOn(app.vault, 'createBinary').mockResolvedValue(saved);
    vi.spyOn(app.fileManager, 'generateMarkdownLink').mockReturnValue('[[saved.png]]');
    const el = activeDocument.body.createEl('textarea');
    let session = 0;
    const values: string[] = [];
    const cleanup = enableAttachmentPaste(el, {
      app,
      sourcePath: 'tasks.md',
      onInsert: () => {
        values.push('uncaptured');
      },
      capture: () => {
        const captured = session;
        return {
          sourcePath: 'tasks.md',
          onInsert: (links: string) => {
            if (captured === session) values.push(links);
          },
        };
      },
    });
    const paste = (bytes: Promise<ArrayBuffer>) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { files: [{ name: 'saved.png', arrayBuffer: () => bytes }] },
      });
      el.dispatchEvent(event);
    };
    const stale = deferred<ArrayBuffer>();
    paste(stale.promise);
    session++;
    const live = deferred<ArrayBuffer>();
    paste(live.promise);
    stale.resolve(new ArrayBuffer(1));
    await flushMicrotasks(20);
    expect(values).toEqual([]);
    live.resolve(new ArrayBuffer(1));
    await whenPasteSettled(el);
    expect(values).toEqual(['[[saved.png]]']);
    const disposed = deferred<ArrayBuffer>();
    paste(disposed.promise);
    cleanup();
    disposed.resolve(new ArrayBuffer(1));
    await whenPasteSettled(el);
    expect(values).toEqual(['[[saved.png]]']);
    el.remove();
  });

  it('rejects a retired context before starting attachment work', async () => {
    const app = await createAppWithFiles({});
    const bytes = vi.fn().mockResolvedValue(new ArrayBuffer(1));
    const el = activeDocument.body.createEl('textarea');
    const cleanup = enableAttachmentPaste(el, {
      app,
      sourcePath: 'tasks.md',
      onInsert: () => {},
      capture: () => undefined,
    });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [{ name: 'saved.png', arrayBuffer: bytes }] },
    });
    el.dispatchEvent(event);
    await whenPasteSettled(el);
    expect(bytes).not.toHaveBeenCalled();
    cleanup();
    el.remove();
  });
});
