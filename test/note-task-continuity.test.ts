import { expect, it, vi } from 'vitest';
import { NoteApplicationService } from '../src/notes/NoteApplicationService';
import { NoteHostAdapter } from '../src/notes/NoteHostAdapter';
import { CanonicalNoteTaskProtection } from '../src/tasks/infrastructure/obsidian/NoteTaskProtection';
import { runTaskFileMutation } from '../src/tasks/infrastructure/obsidian/taskFileMutationQueue';
import nativeEchoCache from './fixtures/note-bom-echo-cache.json';
import { expectDefined, flushMicrotasks, metadataChangedEmitter } from './helpers';
import { ready, taskEditPreparationHarness } from './support/taskEditPreparationHarness';

it.each([false, true])(
  'retains sealed task refresh through accepted prose displacement of duplicate roots (composed=%s)',
  async (composed) => {
    const before =
      'Contact\n\n- [ ] Same\n  - [ ] Child\n\nMiddle prose\n\n- [ ] Same\n  - [ ] Child\n';
    const h = await taskEditPreparationHarness(before);
    try {
      const second = expectDefined(h.index.list()[1]);
      const plan = ready(await h.service.prepare(second, []));
      const notes = new NoteApplicationService(h.app, h.sources, {
        capture: () => h.index.integrationReads().capture(),
        host: new NoteHostAdapter(h.app, h.sources, (source) => h.index.noteStructure(source)),
        protection: new CanonicalNoteTaskProtection(h.app, h.index, h.authority),
        serialize: (path, work) => runTaskFileMutation(h.app, path, work),
      });
      const read = await h.sources.acquire(h.file.path);
      if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing source');
      const range = notes.sections(read.value).find((section) => section.editable);
      if (range === undefined) throw new Error('Missing prose');
      let prepared = notes.prepareEdit(read.value, range, 'Contact\nAddress\n\n', false);
      if (composed) {
        const middle = expectDefined(
          notes
            .sections(read.value)
            .find(
              (part) =>
                part.editable &&
                read.value?.content.slice(part.from, part.to).includes('Middle prose') === true,
            ),
        );
        prepared = expectDefined(prepared.refineSection)(middle, 'More middle context', true);
      }
      expect(await prepared.commit()).toMatchObject({ noteEffects: 'committed' });
      const moved = h.index.list()[1];
      if (moved === undefined) throw new Error('Missing displaced root');
      expect(await plan.refresh(moved)).toMatchObject({ type: 'ready' });
    } finally {
      h.index.destroy();
    }
  },
);

it.each(['same', 'competing', 'replacement', 'scope'] as const)(
  'handles normalized native BOM echo during readback: %s',
  async (mode) => {
    const before =
      '\uFEFF---\r\naliases: [Сценарий]\r\n---\r\n# Работа\r\n\r\nКороткое описание. [[Контакт#Детали|клиника]]\r\n\r\n- [ ] Повтор\r\n  - [ ] Шаг\r\n    - [ ] Деталь\r\n- [ ] Повтор\r\n  - [ ] Шаг\r\n    - [ ] Деталь\r\n';
    const h = await taskEditPreparationHarness(before);
    try {
      const second = expectDefined(h.index.list()[1]);
      const plan = ready(await h.service.prepare(second, []));
      const notes = new NoteApplicationService(h.app, h.sources, {
        capture: () => h.index.integrationReads().capture(),
        host: new NoteHostAdapter(h.app, h.sources, (source) => h.index.noteStructure(source)),
        protection: new CanonicalNoteTaskProtection(h.app, h.index, h.authority),
        serialize: (path, work) => runTaskFileMutation(h.app, path, work),
      });
      const acquired = await h.sources.acquire(h.file.path);
      if (acquired.type !== 'ok' || acquired.value === undefined) throw new Error('Missing source');
      const range = notes.sections(acquired.value).find((part) => part.editable);
      if (range === undefined) throw new Error('Missing prose');
      const edit = notes.prepareEdit(
        acquired.value,
        range,
        'Дополнительный контекст.\r\nЕщё одна строка.',
        true,
      );
      const read = h.app.vault.read.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => (await read(file)).slice(1));
      const binary = h.app.vault.readBinary.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'readBinary').mockImplementationOnce(async (file) => {
        const bytes = await binary(file);
        if (mode === 'competing')
          await h.app.vault.modify(file, '\uFEFFDifferent\r\n- [ ] Other\r\n');
        if (mode === 'replacement') {
          await h.app.fileManager.trashFile(file);
          await h.app.vault.create(
            file.path,
            new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
          );
        }
        if (mode === 'scope') await h.index.refreshSourceExclusion(() => true);
        metadataChangedEmitter(h.app)(
          file,
          mode === 'competing' ? (await read(file)).slice(1) : new TextDecoder().decode(bytes),
          mode === 'competing' ? {} : nativeEchoCache,
        );
        return bytes;
      });
      expect(await edit.commit()).toMatchObject({ noteEffects: 'committed' });
      await flushMicrotasks();
      if (mode !== 'same') {
        const resolution = h.index.resolve(second.ref);
        expect(
          resolution.type === 'rebased' && resolution.basis.authorityTransition !== undefined,
        ).toBe(false);
        return;
      }
      const moved = h.index.list()[1];
      if (moved === undefined) throw new Error('Missing moved root');
      const resolved = h.index.resolve(second.ref);
      expect(resolved.type).toBe('rebased');
      if (resolved.type === 'rebased') expect(resolved.basis.authorityTransition).toBeDefined();
      const refreshed = ready(await plan.refresh(moved));
      const child = refreshed.after?.subtasks[0];
      if (child === undefined) throw new Error('Missing previously unexpanded child');
      const edited = ready(
        refreshed.append({
          type: 'patch',
          target: { type: 'subtask', ref: child.ref },
          patch: { markdownTitle: { type: 'set', value: 'Updated child' } },
        }),
      );
      expect(await edited.commit()).toMatchObject({ type: 'ok' });
      const final = await read(h.file);
      expect(final.indexOf('Updated child')).toBeGreaterThan(final.lastIndexOf('- [ ] Повтор'));
      expect(final.match(/ {2}- \[ \] Шаг/gu)).toHaveLength(1);
    } finally {
      h.index.destroy();
    }
  },
);
