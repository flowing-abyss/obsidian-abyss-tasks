// The link edit modal on a mounted RightPanel over a real index and repository, or on its own, with
// links drawn as Obsidian's reading view draws them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLinks } from '../src/markdown/links';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import type { NoteSuggest } from '../src/ui/NoteSuggest';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  editSettingControl,
  expectDefined,
  flushMicrotasks,
  useRealMoment,
} from './helpers';
import { inspectorCleanups, inspectorHarness } from './support/inspectorHarness';
import {
  captureLinkModals,
  captureMenus,
  clickSave,
  mockReadingView,
  modalInputs,
  rightClick,
  settleRender,
} from './support/linkEditHarness';

useRealMoment();

afterEach(() => {
  for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  activeDocument.body.empty();
});

/** The index title of the source's first task line, as the codec collapses it. */
function titleOf(source: string): string {
  const line = expectDefined(source.split('\n')[0]);
  return expectDefined(
    new TaskMarkdownCodec(canonicalStatusCatalog()).parseLine(line, {
      filePath: 'tasks.md',
      line: 1,
    }),
  ).title;
}

/** Opens "Edit link…" on the inspector title's first link, as a right-click does. */
async function titleLinkModal(line: string) {
  mockReadingView();
  const menus = captureMenus();
  const modals = captureLinkModals();
  const h = await inspectorHarness(line, titleOf(line));
  await settleRender();
  rightClick(expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-title-view a')));
  expectDefined(menus[0]).pick('Edit link…');
  return { h, modal: modals.last() };
}

describe('the alias field holds only a written alias', () => {
  it('Y2a an unaliased link shows an empty alias with the note name as its placeholder', async () => {
    const { modal } = await titleLinkModal('- [ ] Current [[Note]]\n');
    const { display } = modalInputs(modal);
    expect(display.value).toBe('');
    expect(display.placeholder).toBe('Note');
  });

  it.each([
    ['- [ ] Current [[Note]]\n', 'Other', '- [ ] Current [[Other]]'],
    ['- [ ] Current [[Folder/Note.md]]\n', 'Folder/Other.md', '- [ ] Current [[Folder/Other.md]]'],
    ['- [ ] Current [[Note|Alias]]\n', 'Other', '- [ ] Current [[Other|Alias]]'],
  ])('Y2b retargeting %j to %s writes %s', async (line, target, written) => {
    const { h, modal } = await titleLinkModal(line);
    editSettingControl(modalInputs(modal).target, target);
    clickSave(modal);
    await flushMicrotasks(40);
    expect((await h.read()).split('\n')[0]).toBe(written);
  });

  it('Y2c the placeholder follows the typed target', async () => {
    const { modal } = await titleLinkModal('- [ ] Current [[Note]]\n');
    const { target, display } = modalInputs(modal);
    editSettingControl(target, 'Folder/Other.md');
    expect(display.placeholder).toBe('Other');
  });

  it('Y2d a typed alias equal to the note name is written when it differs from the target', async () => {
    const { h, modal } = await titleLinkModal('- [ ] Current [[Folder/Note]]\n');
    editSettingControl(modalInputs(modal).display, 'Note');
    clickSave(modal);
    await flushMicrotasks(40);
    expect((await h.read()).split('\n')[0]).toBe('- [ ] Current [[Folder/Note|Note]]');
  });

  it('Y2e Save with nothing changed writes nothing and closes', async () => {
    const { h, modal } = await titleLinkModal('- [ ] Current [[Note]]\n');
    clickSave(modal);
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current [[Note]]\n');
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it('Y2g Save with nothing changed keeps a spaced link as it is written', async () => {
    const { h, modal } = await titleLinkModal('- [ ] Current [[ Note ]]\n');
    clickSave(modal);
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current [[ Note ]]\n');
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it('Y2h the placeholder follows a picked note', async () => {
    const app = await createAppWithFiles({ 'Folder/v1.2 notes.md': '' });
    const modals = captureLinkModals();
    const token = expectDefined(parseLinks('[[Note]]')[0]);
    new LinkEditModal(app, token, vi.fn(), 'tasks.md').open();
    const modal = modals.last();
    const file = expectDefined(app.vault.getMarkdownFiles()[0]);
    const suggest = (modal as unknown as { noteSuggest_abyssPrivate: NoteSuggest })
      .noteSuggest_abyssPrivate;
    suggest.selectSuggestion(file);
    expect(modalInputs(modal).target.value).toBe('v1.2 notes');
    expect(modalInputs(modal).display.placeholder).toBe('v1.2 notes');
  });

  it('Y2i a Markdown link shows its text and no placeholder', async () => {
    const app = await createAppWithFiles({});
    const modals = captureLinkModals();
    const token = expectDefined(parseLinks('[Docs](https://example.com/x)')[0]);
    new LinkEditModal(app, token, vi.fn(), 'tasks.md').open();
    const { display } = modalInputs(modals.last());
    expect(display.value).toBe('Docs');
    expect(display.placeholder).toBe('');
  });

  it.each([
    ['alias', 'B', String.raw`[[Note\|B]]`],
    ['note', 'Other', String.raw`[[Other\|A]]`],
    ['alias', String.raw`a\|b`, String.raw`[[Note\|a\|b]]`],
  ] as const)(
    'Y2o a link read from a description table row with its %s edited to %s is sent as %s',
    async (field, typed, sent) => {
      const app = await createAppWithFiles({});
      const modals = captureLinkModals();
      const onSave = vi.fn();
      const token = expectDefined(parseLinks(String.raw`| [[Note\|A]] | x |`)[0]);
      new LinkEditModal(app, token, onSave, 'tasks.md').open();
      const inputs = modalInputs(modals.last());
      editSettingControl(field === 'note' ? inputs.target : inputs.display, typed);
      clickSave(modals.last());
      expect(onSave).toHaveBeenCalledExactlyOnceWith(sent);
    },
  );
});
