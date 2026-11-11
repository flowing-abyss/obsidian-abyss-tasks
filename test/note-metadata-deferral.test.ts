import { afterEach, expect, it, vi } from 'vitest';
import { CanonicalNoteTaskProtection } from '../src/tasks/infrastructure/obsidian/NoteTaskProtection';
import type { OwnedSourceMutation } from '../src/tasks/infrastructure/TaskRefAuthority';
import { deferred, expectDefined, flushMicrotasks, metadataChangedEmitter } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const before = 'Context\n\n- [ ] Same\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n';
const replacement = 'Context\nShift\n\n';
const candidate = replacement + before.slice(9);
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});

async function setup() {
  const h = await publicApiHarness({ 'a.md': before });
  owners.push(h);
  const file = expectDefined(h.app.vault.getFileByPath('a.md') ?? undefined);
  const acquired = await h.index.projectSources().acquire(file.path);
  if (acquired.type !== 'ok' || acquired.value === undefined) throw new Error('Missing source');
  const source = acquired.value;
  const protection = new CanonicalNoteTaskProtection(h.app, h.index, h.authority);
  const stage = () =>
    expectDefined(
      protection.stage(
        source,
        candidate,
        { from: 0, to: 9, kind: 'prose', editable: true },
        replacement,
      ),
    );
  const observe = vi.spyOn(h.authority, 'deferObservation');
  const emit = (text = before) => {
    metadataChangedEmitter(h.app)(file, text, {});
  };
  return { ...h, file, stage, emit, observe };
}

it('defers only the accepted prior echo after forward, with no new read or source publication', async () => {
  const h = await setup();
  const stage = h.stage();
  const read = vi.spyOn(h.app.vault, 'read');
  expect(stage.forward(before)).toBe(candidate);
  const observation = h.reads.capture();
  h.emit();
  expect(h.observe).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(h.reads.capture()).toEqual(observation);
  expect(h.authority.ownsForwardedSource('a.md', candidate)).toBe(true);
  stage.release();
});

it('does not acquire deferral after stage meaning has changed before forward', async () => {
  const h = await setup();
  const stage = h.stage();
  h.index.updateIntegrationSemantics('changed');
  expect(stage.forward(before)).toBeUndefined();
  h.emit();
  expect(h.observe).toHaveBeenCalledWith('a.md', before);
  stage.release();
});

it('retires deferral after a candidate event even if a later prior event has the original stamp', async () => {
  const h = await setup();
  const stage = h.stage();
  expect(stage.forward(before)).toBe(candidate);
  h.emit(candidate);
  h.emit();
  expect(h.observe).toHaveBeenCalledWith('a.md', before);
  expect(h.authority.ownsForwardedSource('a.md', candidate)).toBe(false);
  await flushMicrotasks();
  stage.release();
});

it.each(['stamp', 'meaning', 'scope', 'source', 'contrary', 'owner'] as const)(
  'does not defer a prior echo after changed %s evidence',
  async (change) => {
    const h = await setup();
    const stage = h.stage();
    expect(stage.forward(before)).toBe(candidate);
    if (change === 'stamp') h.file.stat.mtime += 1;
    if (change === 'meaning') h.index.updateIntegrationSemantics('changed');
    if (change === 'scope') await h.index.refreshSourceExclusion(() => false);
    if (change === 'source') h.index.installCommittedContent('a.md', before);
    if (change === 'owner') h.authority.discard('a.md');
    h.observe.mockClear();
    h.emit(change === 'contrary' ? before.replace('Context', 'Changed') : before);
    if (change === 'contrary') h.emit();
    await flushMicrotasks();
    expect(h.observe).toHaveBeenCalled();
    expect(h.authority.ownsForwardedSource('a.md', candidate)).toBe(false);
    stage.release();
  },
);

it.each(['install', 'reject', 'release'] as const)(
  'retires prior deferral synchronously before %s can await',
  async (operation) => {
    const h = await setup();
    const stage = h.stage();
    expect(stage.forward(before)).toBe(candidate);
    const read = deferred<string>();
    vi.spyOn(h.app.vault, 'read').mockReturnValue(read.promise);
    let pending: Promise<boolean | void> | undefined;
    if (operation === 'release') stage.release();
    else pending = stage[operation](h.file);
    h.emit();
    expect(h.observe).toHaveBeenCalledWith('a.md', before);
    read.resolve(before);
    await pending;
    stage.release();
  },
);

it('does not let an old lease recognize a new owner of the same exact candidate', async () => {
  const h = await setup();
  const old = h.stage();
  expect(old.forward(before)).toBe(candidate);
  h.authority.discard('a.md');
  let owner: OwnedSourceMutation | undefined;
  const reserve = h.authority.reserveStructuralMutation.bind(h.authority);
  vi.spyOn(h.authority, 'reserveStructuralMutation').mockImplementation((...args) => {
    owner = reserve(...args);
    return owner;
  });
  const next = h.stage();
  expect(expectDefined(owner).forward('a.md', before)).toBe(candidate);
  h.emit();
  expect(h.observe).toHaveBeenCalledWith('a.md', before);
  expect(h.authority.ownsForwardedSource('a.md', candidate)).toBe(false);
  old.release();
  next.release();
});

it('does not release the deferral acquired by a later stage', async () => {
  const h = await setup();
  const old = h.stage();
  expect(old.forward(before)).toBe(candidate);
  h.authority.discard('a.md');
  const next = h.stage();
  expect(next.forward(before)).toBe(candidate);
  old.release();
  h.emit();
  expect(h.observe).not.toHaveBeenCalled();
  expect(h.authority.ownsForwardedSource('a.md', candidate)).toBe(true);
  next.release();
});

it('rejects genuine external reversion after the native write has updated its stamp', async () => {
  const h = await setup();
  const stage = h.stage();
  expect(stage.forward(before)).toBe(candidate);
  await h.app.vault.modify(h.file, candidate);
  await h.app.vault.modify(h.file, before);
  h.file.stat.mtime += 1;
  h.emit();
  await flushMicrotasks();
  expect(h.observe).toHaveBeenCalledWith('a.md', before);
  expect(h.authority.ownsForwardedSource('a.md', candidate)).toBe(false);
  expect(await stage.install(h.file)).toBe(false);
  expect(await h.read('a.md')).toBe(before);
  stage.release();
});

it('does not defer events from a replacement file or keep ownership after disposal', async () => {
  const h = await setup();
  const stage = h.stage();
  expect(stage.forward(before)).toBe(candidate);
  await h.app.fileManager.trashFile(h.file);
  const replacementFile = await h.app.vault.create('a.md', before);
  metadataChangedEmitter(h.app)(replacementFile, before, {});
  await flushMicrotasks();
  expect(h.observe).toHaveBeenCalledWith('a.md', before);
  expect(await stage.install(replacementFile)).toBe(false);
  h.index.destroy();
  expect(stage.forward(before)).toBeUndefined();
  stage.release();
});
