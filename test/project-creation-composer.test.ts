import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectCreationComposer } from '../src/panels/projects/ProjectCreationComposer';
import { ProjectCreationError } from '../src/projects/projectCreation';
import { expectDefined, flushMicrotasks, freshContainer } from './helpers';

afterEach(() => {
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

function harness(create = vi.fn().mockResolvedValue('Projects/New.md')) {
  const host = freshContainer();
  activeDocument.body.append(host);
  const anchor = host.createEl('button', { text: 'New project' });
  const created = vi.fn();
  const failed = vi.fn();
  const openProject = vi.fn();
  const composer = new ProjectCreationComposer({
    host,
    boundary: host,
    create,
    created,
    failed,
    openProject,
  });
  return { host, anchor, composer, create, created, failed, openProject };
}

function submit(host: HTMLElement, name: string): void {
  const input = expectDefined(host.querySelector<HTMLInputElement>('.abyss-project-creation-name'));
  input.value = name;
  expectDefined(host.querySelector<HTMLButtonElement>('.abyss-project-creation-submit')).click();
}

describe('ProjectCreationComposer', () => {
  it('captures contextual status and blocks duplicate submissions while pending', async () => {
    let resolve: ((path: string) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const h = harness(create);
    h.composer.open({ anchor: h.anchor, statusId: 'done', statusLabel: 'Done' });
    submit(h.host, 'New');
    expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-submit'),
    ).click();

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ name: 'New', statusId: 'done' });
    resolve?.('Projects/New.md');
    await flushMicrotasks();
    expect(h.created).toHaveBeenCalledWith('Projects/New.md', 'done');
    h.composer.open({ anchor: h.anchor, statusId: 'done', statusLabel: 'Done' });
    expect(
      expectDefined(h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name')).value,
    ).toBe('');
  });

  it('retains the draft and retries only status on an owned partial failure', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectCreationError('status failed', {
          createdPath: 'Projects/New.md',
          phase: 'status',
          statusId: 'done',
          cause: new Error('disk full'),
        }),
      )
      .mockResolvedValueOnce('Projects/New.md');
    const h = harness(create);
    h.composer.open({ anchor: h.anchor, statusId: 'done', statusLabel: 'Done' });
    submit(h.host, 'New');
    await flushMicrotasks();

    expect(
      expectDefined(h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name')).value,
    ).toBe('New');
    expect(
      expectDefined(h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-submit'))
        .textContent,
    ).toBe('Retry status');
    submit(h.host, 'New');
    await flushMicrotasks();

    expect(create).toHaveBeenNthCalledWith(2, {
      name: 'New',
      statusId: 'done',
      recoveryPath: 'Projects/New.md',
    });
  });

  it('offers the owned note instead of allowing a duplicate after template failure', async () => {
    const create = vi.fn().mockRejectedValue(
      new ProjectCreationError('template failed', {
        createdPath: 'Projects/New.md',
        phase: 'template',
        cause: new Error('Templater failed'),
      }),
    );
    const h = harness(create);
    h.composer.open({ anchor: h.anchor, statusId: 'done', statusLabel: 'Done' });
    submit(h.host, 'New');
    await flushMicrotasks();

    const anchor = h.anchor;
    expect(
      expectDefined(h.host.querySelector<HTMLElement>('.abyss-project-creation-status'))
        .textContent,
    ).toBe('Status: Done');

    expect(
      expectDefined(h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-submit'))
        .disabled,
    ).toBe(true);
    expectDefined(h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-open')).click();
    expect(h.openProject).toHaveBeenCalledWith('Projects/New.md');

    expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-cancel'),
    ).click();
    h.composer.open({ anchor: h.anchor, statusId: 'planned', statusLabel: 'Planned' });
    const input = expectDefined(
      h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    expect(
      expectDefined(h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-submit'))
        .disabled,
    ).toBe(true);
    expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-another'),
    ).click();
    expect(
      expectDefined(h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-submit'))
        .disabled,
    ).toBe(false);
    expect(
      expectDefined(h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name')).value,
    ).toBe('');
    expect(h.host.querySelector('.abyss-project-creation-name')).toBe(input);
    expect(h.anchor).toBe(anchor);
    expect(
      expectDefined(h.host.querySelector<HTMLElement>('.abyss-project-creation-status'))
        .textContent,
    ).toBe('Status: Planned');
    submit(h.host, 'Different');
    await flushMicrotasks();
    expect(create).toHaveBeenLastCalledWith({ name: 'Different', statusId: 'planned' });
  });

  it('removes a retained recovery status label for a fresh draft without status context', async () => {
    const create = vi.fn().mockRejectedValue(
      new ProjectCreationError('template failed', {
        createdPath: 'Projects/New.md',
        phase: 'template',
        cause: new Error('Templater failed'),
      }),
    );
    const h = harness(create);
    h.composer.open({ anchor: h.anchor, statusId: 'done', statusLabel: 'Done' });
    submit(h.host, 'New');
    await flushMicrotasks();
    expect(h.host.querySelector('.abyss-project-creation-status')?.textContent).toBe(
      'Status: Done',
    );

    expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-cancel'),
    ).click();
    h.composer.open({ anchor: h.anchor });
    const input = expectDefined(
      h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    );
    expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-creation-another'),
    ).click();

    expect(h.host.querySelector('.abyss-project-creation-status')).toBeNull();
    expect(h.host.querySelector('.abyss-project-creation-name')).toBe(input);
  });

  it('closes on Escape and restores the trigger without cancelling pending ownership', async () => {
    let resolve: ((path: string) => void) | undefined;
    const h = harness(
      vi.fn(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      ),
    );
    h.composer.open({ anchor: h.anchor, statusId: 'active', statusLabel: 'Active' });
    submit(h.host, 'New');
    expectDefined(
      h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name'),
    ).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(h.host.querySelector('.abyss-project-creation-composer')).toBeNull();
    expect(h.anchor).toBe(activeDocument.activeElement);
    resolve?.('Projects/New.md');
    await flushMicrotasks();
    expect(h.created).toHaveBeenCalledWith('Projects/New.md', 'active');
  });

  it('owns document Escape after focus falls back without reclaiming deliberate external focus', async () => {
    const create = vi.fn().mockRejectedValue(
      new ProjectCreationError('template failed', {
        createdPath: 'Projects/New.md',
        phase: 'template',
        cause: new Error('Templater failed'),
      }),
    );
    const h = harness(create);
    h.composer.open({ anchor: h.anchor, statusId: 'done', statusLabel: 'Done' });
    submit(h.host, 'New');
    await flushMicrotasks();
    expectDefined(h.host.querySelector<HTMLInputElement>('.abyss-project-creation-name')).blur();
    expect(activeDocument.activeElement).toBe(activeDocument.body);

    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(h.host.querySelector('.abyss-project-creation-composer')).toBeNull();
    expect(activeDocument.activeElement).toBe(h.anchor);

    h.composer.open({ anchor: h.anchor, statusId: 'planned', statusLabel: 'Planned' });
    const external = activeDocument.body.createEl('button', { text: 'Outside composer' });
    external.focus();
    activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(h.host.querySelector('.abyss-project-creation-composer')).toBeNull();
    expect(activeDocument.activeElement).toBe(external);
  });

  it('clamps a preferred-width composer inside a narrow overview without moving layout children', () => {
    const h = harness();
    Object.defineProperties(h.host, {
      clientWidth: { configurable: true, value: 240 },
      clientHeight: { configurable: true, value: 180 },
    });
    const childCount = h.host.childElementCount;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === h.host) return new DOMRect(100, 100, 240, 180);
      if (this === h.anchor) return new DOMRect(310, 140, 24, 24);
      if (this.classList.contains('abyss-project-creation-composer')) {
        return new DOMRect(0, 0, Number.parseFloat(this.style.width), 100);
      }
      return new DOMRect();
    });

    h.composer.open({ anchor: h.anchor });
    const composer = expectDefined(
      h.host.querySelector<HTMLElement>('.abyss-project-creation-composer'),
    );

    expect(composer.style.width).toBe('224px');
    expect(composer.style.left).toBe('8px');
    expect(h.host.childElementCount).toBe(childCount + 1);
    expect(h.anchor.parentElement).toBe(h.host);
  });
});
