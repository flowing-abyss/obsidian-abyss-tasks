import type { NoteSectionV1, NoteSummaryV1 } from '../../api';
import type { AcceptedNoteSource } from '../notes/NoteSourceApi';
import {
  NOTE_LIMITS,
  NoteFailure,
  type NoteApplicationApi,
  type NoteRange,
} from '../notes/noteApi';

interface NoteHandle {
  readonly path: string;
  readonly identity: object;
  expiresAt: number;
}
interface SectionHandle {
  readonly note: string;
  readonly version: number;
  readonly range: NoteRange;
  expiresAt: number;
}
/** Bounded borrowed-source identities only; no content index or write authority. */
export class NoteReadRegistry {
  private sequence = 0;
  private reserved = 0;
  private disposed = false;
  private readonly notes = new Map<string, NoteHandle>();
  private readonly sections = new Map<string, SectionHandle>();
  constructor(
    readonly port: NoteApplicationApi,
    readonly epoch: string,
    private readonly now: () => number,
  ) {}
  private clean(): void {
    const now = this.now();
    for (const [token, value] of this.notes) if (value.expiresAt <= now) this.notes.delete(token);
    for (const [token, value] of this.sections)
      if (value.expiresAt <= now || !this.notes.has(value.note)) this.sections.delete(token);
  }
  token(kind: string): string {
    return `${this.epoch}:${kind}:${++this.sequence}`;
  }
  revision(source: AcceptedNoteSource): string {
    return `${this.epoch}:note-revision:${source.version}`;
  }
  summary(source: AcceptedNoteSource): NoteSummaryV1 {
    if (this.disposed) throw new NoteFailure('DISPOSED');
    this.clean();
    let found = [...this.notes].find(
      ([, note]) => note.identity === source.identity && note.path === source.path,
    );
    if (found === undefined) {
      if (this.notes.size + this.reserved >= NOTE_LIMITS.maxNoteHandles)
        throw new NoteFailure('RESOURCE_LIMIT');
      found = [this.token('note'), { path: source.path, identity: source.identity, expiresAt: 0 }];
      this.notes.set(...found);
    }
    found[1].expiresAt = this.now() + NOTE_LIMITS.handleTtlMs;
    const raw = source.metadata.frontmatter['aliases'] ?? source.metadata.frontmatter['alias'];
    let aliases: string[] = [];
    if (typeof raw === 'string') aliases = [raw];
    else if (Array.isArray(raw))
      aliases = raw.filter((item): item is string => typeof item === 'string');
    if (aliases.length > 256 || aliases.reduce((total, alias) => total + alias.length, 0) > 65536)
      throw new NoteFailure('RESOURCE_LIMIT');
    return {
      target: found[0],
      revision: this.revision(source),
      path: source.path,
      name: source.path.replace(/^.*\//u, '').replace(/\.md$/iu, ''),
      aliases,
    };
  }
  private handle(target: string): NoteHandle {
    this.clean();
    const note = this.notes.get(target);
    if (note === undefined) throw new NoteFailure('STALE_TARGET');
    return note;
  }
  async acquire(target: string, revision?: string): Promise<AcceptedNoteSource> {
    const note = this.handle(target);
    const read = await this.port.sources.acquire(note.path);
    if (read.type === 'error') throw new NoteFailure('INCOMPLETE_READ');
    const source = read.value;
    if (source?.identity !== note.identity) throw new NoteFailure('STALE_TARGET');
    if (revision !== undefined && revision !== this.revision(source))
      throw new NoteFailure('REVISION_CONFLICT');
    note.expiresAt = this.now() + NOTE_LIMITS.handleTtlMs;
    return source;
  }
  available(target: string, revision?: string): boolean {
    try {
      const note = this.handle(target),
        read = this.port.sources.get(note.path);
      return (
        read.type === 'ok' &&
        read.value?.identity === note.identity &&
        (revision === undefined || revision === this.revision(read.value))
      );
    } catch {
      return false;
    }
  }
  section(source: AcceptedNoteSource, range: NoteRange): NoteSectionV1 {
    this.clean();
    const note = this.summary(source).target;
    let found = [...this.sections].find(
      ([, section]) =>
        section.note === note &&
        section.version === source.version &&
        section.range.from === range.from &&
        section.range.to === range.to &&
        section.range.kind === range.kind &&
        section.range.editable === range.editable &&
        section.range.appendOnly === range.appendOnly,
    );
    if (found === undefined) {
      if (this.sections.size >= NOTE_LIMITS.maxSectionHandles)
        throw new NoteFailure('RESOURCE_LIMIT');
      found = [
        this.token('section'),
        { note, version: source.version, range: { ...range }, expiresAt: 0 },
      ];
      this.sections.set(...found);
    }
    found[1].expiresAt = this.now() + NOTE_LIMITS.handleTtlMs;
    return {
      target: found[0],
      kind: range.kind,
      ...(range.label === undefined ? {} : { label: range.label }),
      canAppend: range.editable,
      canReplace: range.editable && range.appendOnly !== true,
    };
  }
  async selected(target: string): Promise<{ source: AcceptedNoteSource; range: NoteRange }> {
    this.clean();
    const section = this.sections.get(target);
    if (section === undefined) throw new NoteFailure('STALE_SECTION');
    const source = await this.acquire(section.note);
    if (source.version !== section.version) throw new NoteFailure('REVISION_CONFLICT');
    section.expiresAt = this.now() + NOTE_LIMITS.handleTtlMs;
    return { source, range: section.range };
  }
  reserve(): { release(): void; project(source: AcceptedNoteSource): NoteSummaryV1 } {
    this.clean();
    if (this.disposed || this.notes.size + this.reserved >= NOTE_LIMITS.maxNoteHandles)
      throw new NoteFailure('RESOURCE_LIMIT');
    this.reserved++;
    let active = true;
    const release = (): void => {
      if (active) {
        active = false;
        this.reserved--;
      }
    };
    return {
      release,
      project: (source) => {
        release();
        return this.summary(source);
      },
    };
  }
  dispose(): void {
    this.disposed = true;
    this.notes.clear();
    this.sections.clear();
  }
}
