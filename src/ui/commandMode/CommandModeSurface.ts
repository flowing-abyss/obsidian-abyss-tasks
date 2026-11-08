import { Component, Menu, parseLinktext, setIcon, setTooltip, type App } from 'obsidian';
import type { CommandSessionOwner } from '../../ai/CommandSessionOwner';
import type { HistoricalCommandSession } from '../../ai/commandRecovery';
import type { CommandSessionSnapshot } from '../../ai/commandTypes';
import type { ProjectsSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { showMenuAtMouseEventWithFocus } from '../nativeMenuFocus';
import { runAsyncAction } from '../runAsyncAction';
import type { CaptureExtension, CaptureExtensionHost } from '../taskCapture/CaptureSurface';
import { CommandNotes } from './CommandNotes';
import { CommandProjects } from './CommandProjects';
import {
  CommandTree,
  type CommandPresentationMemory,
  type CommandTreeOptions,
} from './CommandTree';

export interface CommandSurfaceMemory {
  active: boolean;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  presentation?: CommandPresentationMemory;
}
export interface CommandModeOptions extends Pick<
  CommandTreeOptions,
  'formatDate' | 'getDateClass' | 'getTagColor' | 'showSource'
> {
  readonly app: App;
  readonly owner: () => CommandSessionOwner;
  readonly memory: CommandSurfaceMemory;
  readonly registry: StatusRegistry;
  readonly projectSettings: () => ProjectsSettings;
  readonly context: () => string;
  readonly close: () => void;
  readonly navigate: (target: string, revision: string, intent: 'feedback' | 'reveal') => boolean;
}
type PrimaryAction = 'send' | 'save' | 'stop';
function busy(state: CommandSessionSnapshot): boolean {
  return ['thinking', 'searching', 'writing'].includes(state.status.kind);
}
function readyToSave(state: CommandSessionSnapshot): boolean {
  return (
    state.status.kind === 'ready' &&
    state.proposal.changes.length > 0 &&
    state.activeQuestion === null &&
    !state.blocked &&
    state.pendingTransition == null &&
    (state.recovery ?? 'live') === 'live'
  );
}
function mainObject(state: HistoricalCommandSession['snapshot']): string | undefined {
  const first = state.proposal.changes[0];
  if (first === undefined) return state.actual[0]?.markdownTitle;
  if (first.kind === 'task')
    return first.plan.after?.markdownTitle ?? first.plan.before?.markdownTitle;
  if (first.kind === 'project') return first.before.name;
  if (first.kind === 'note') return first.plan.path;
  return undefined;
}
function sessionLabel(record: HistoricalCommandSession): string {
  const state = record.snapshot;
  const label =
    mainObject(state) ??
    state.exchanges.find((entry) => entry.role === 'user')?.text ??
    'Untitled session';
  return `${label.slice(0, 80)} · ${new Date(record.updatedAt).toLocaleString()}`;
}
export class CommandModeSurface implements CaptureExtension {
  private readonly component = new Component();
  private readonly phase: HTMLElement;
  private readonly content: HTMLElement;
  private readonly treeHost: HTMLElement;
  private readonly latest: HTMLElement;
  private readonly question: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly toolbar: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private primaryAction: PrimaryAction = 'send';
  private readonly projects: CommandProjects;
  private readonly notes: CommandNotes;
  private tree: CommandTree | undefined;
  private owner: CommandSessionOwner | undefined;
  private unsubscribe: (() => void) | undefined;
  private menu: Menu | undefined;
  private releaseMenu = (): void => {};
  private live = true;
  private readonly initializing: boolean = true;
  private inputGeneration = 0;
  private navigated = '';
  private phaseTimer: number | undefined;
  private pendingPhase = '';
  constructor(
    private readonly capture: CaptureExtensionHost,
    private readonly options: CommandModeOptions,
  ) {
    this.component.load();
    this.toolbar = capture.shell.createDiv({
      cls: 'abyss-command-toolbar',
      attr: { role: 'toolbar', 'aria-label': 'Quick capture controls' },
    });
    const history = this.button('History', 'history');
    this.toggle = this.button('CommandMode', 'sparkles');
    const microphone = this.button('Microphone', 'mic');
    microphone.disabled = true;
    microphone.setAttribute('aria-description', 'Voice input is not available yet.');
    this.primary = this.button('Send', 'arrow-up');
    this.phase = capture.element.createDiv({
      cls: 'abyss-command-phase',
      attr: { role: 'status' },
    });
    this.phase.id = `abyss-command-phase-${++nextSurface}`;
    this.content = capture.element.createDiv({ cls: 'abyss-command-content' });
    const projectHost = this.content.createDiv({ cls: 'abyss-command-projects' });
    this.projects = new CommandProjects(projectHost, options, this.component, (href, path) =>
      this.allowLink(href, path),
    );
    this.treeHost = this.content.createDiv({ cls: 'abyss-command-tree' });
    this.notes = new CommandNotes(
      this.content.createDiv({ cls: 'abyss-command-notes' }),
      options.app,
      this.component,
      (href, path) => this.allowLink(href, path),
    );
    this.latest = this.content.createDiv({ cls: 'abyss-command-latest' });
    this.question = this.content.createDiv({ cls: 'abyss-command-question' });
    this.component.registerDomEvent(history, 'click', (event) => {
      this.openMenu(history, event);
    });
    this.component.registerDomEvent(this.toggle, 'click', () => {
      this.setActive(!this.active());
    });
    this.component.registerDomEvent(this.toggle, 'contextmenu', (event) => {
      event.preventDefault();
      this.openMenu(this.toggle, event);
    });
    this.component.registerDomEvent(this.toggle, 'keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        this.openMenu(this.toggle);
      }
    });
    this.component.registerDomEvent(this.primary, 'click', () => {
      this.activatePrimary();
    });
    this.component.registerDomEvent(
      this.content,
      'click',
      (event) => {
        this.guardPlannedLink(event);
      },
      true,
    );
    this.component.registerDomEvent(capture.input, 'select', () => {
      this.remember();
    });
    this.setActive(options.memory.active);
    this.initializing = false;
  }
  private button(label: string, icon: string): HTMLButtonElement {
    const button = this.toolbar.createEl('button', {
      cls: 'clickable-icon',
      attr: { type: 'button', 'aria-label': label },
    });
    setIcon(button, icon);
    setTooltip(button, label);
    return button;
  }
  active(): boolean {
    return this.options.memory.active;
  }
  private setActive(active: boolean): void {
    if (!active) {
      this.inputGeneration++;
      this.clearPhaseTimer();
    }
    this.options.memory.active = active;
    this.toggle.setAttribute('aria-pressed', String(active));
    this.phase.hidden = !active;
    this.content.hidden = !active;
    if (active) {
      this.owner ??= this.options.owner();
      this.owner.updateContext(this.options.context());
      this.owner.open();
      this.options.memory.presentation ??= new Map();
      this.tree ??= new CommandTree(this.treeHost, {
        ...this.options,
        owner: this.owner,
        component: this.component,
        presentation: this.options.memory.presentation,
        isCurrent: () => this.live && this.active(),
        failure: (message) => {
          this.failure(message);
        },
        allowLink: (href, path) => this.allowLink(href, path),
      });
      this.unsubscribe ??= this.owner.subscribe((state) => {
        this.render(state);
      });
      this.capture.input.setAttribute('aria-label', 'Command');
      this.capture.input.placeholder = 'What would you like to do?';
      this.capture.input.readOnly = false;
      this.capture.input.setAttribute('aria-describedby', this.phase.id);
      this.capture.input.setSelectionRange(
        this.options.memory.selectionStart,
        this.options.memory.selectionEnd,
      );
      this.content.scrollTop = this.options.memory.scrollTop;
    } else {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.owner !== undefined)
        runAsyncAction(this.owner.hide(), 'Could not retain command session');
      this.capture.input.setAttribute('aria-label', 'Add task');
      this.capture.input.placeholder = 'Task name…';
      this.setPrimary('send', false);
    }
    if (!this.initializing) this.capture.refresh();
  }
  input(text: string): void {
    this.inputGeneration++;
    this.owner?.setInput(text);
    this.remember();
  }
  submit(): void {
    const owner = this.owner;
    if (!this.active() || owner === undefined || !this.live) return;
    if (this.capture.input.value.trim() === '' && busy(owner.snapshot())) return;
    owner.updateContext(this.options.context());
    const text = this.capture.input.value,
      basis = owner.snapshot(),
      generation = ++this.inputGeneration;
    runAsyncAction(
      (async () => {
        await owner.submit(text, {
          sessionId: basis.id,
          proposalRevision: basis.proposal.revision,
        });
        const next = owner.snapshot();
        if (
          this.live &&
          this.active() &&
          generation === this.inputGeneration &&
          next.id === basis.id &&
          next.input === text &&
          next.status.kind !== 'error'
        )
          owner.setInput('');
      })(),
      'Could not run command',
    );
  }
  private activatePrimary(): void {
    if (!this.active()) {
      this.capture.submitOrdinary();
      return;
    }
    if (this.primaryAction !== 'stop') {
      this.submit();
      return;
    }
    this.inputGeneration++;
    if (this.owner !== undefined) runAsyncAction(this.owner.stop(), 'Could not stop command');
  }
  private setPrimary(action: PrimaryAction, disabled: boolean): void {
    const labels = { send: 'Send', save: 'Save proposal', stop: 'Stop' };
    const icons = { send: 'arrow-up', save: 'check', stop: 'square' };
    if (this.primary.getAttribute('aria-label') !== labels[action]) {
      setIcon(this.primary, icons[action]);
      this.primary.setAttribute('aria-label', labels[action]);
      setTooltip(this.primary, labels[action]);
    }
    this.primaryAction = action;
    this.primary.disabled = disabled;
  }
  private renderPrimary(state: CommandSessionSnapshot): void {
    if (state.input.trim() !== '') {
      this.setPrimary('send', false);
      return;
    }
    if (busy(state)) this.setPrimary('stop', false);
    else if (readyToSave(state)) this.setPrimary('save', false);
    else this.setPrimary('send', true);
  }
  escape(): void {
    this.remember();
    if (this.owner !== undefined)
      runAsyncAction(this.owner.hide(), 'Could not retain command session');
    this.options.close();
  }
  private remember(): void {
    if (!this.active()) return;
    this.options.memory.selectionStart = this.capture.input.selectionStart ?? 0;
    this.options.memory.selectionEnd = this.capture.input.selectionEnd ?? 0;
    this.options.memory.scrollTop = this.content.scrollTop;
  }
  private failure(message: string): void {
    this.clearPhaseTimer();
    if (this.live) this.phase.textContent = message;
  }
  private render(state: CommandSessionSnapshot): void {
    if (!this.live || !this.active()) return;
    if (this.capture.input.value !== state.input) this.capture.input.value = state.input;
    const isBusy = busy(state);
    this.renderPrimary(state);
    this.capture.input.setAttribute('aria-busy', String(isBusy));
    this.capture.input.setAttribute('aria-invalid', String(state.status.kind === 'error'));
    this.renderPhase(state, isBusy);
    const last = [...state.exchanges].reverse().find((entry) => entry.role === 'user');
    this.latest.textContent = last?.text ?? '';
    this.latest.hidden = last === undefined;
    this.question.textContent = state.activeQuestion ?? '';
    this.question.hidden = state.activeQuestion === null;
    this.projects.update(state);
    this.notes.update(state);
    this.tree?.update(state);
    this.navigateSaved(state);
    this.reveal(state);
  }
  private renderPhase(state: CommandSessionSnapshot, isBusy: boolean): void {
    const waiting = state.activeQuestion !== null && !isBusy && state.status.kind !== 'error';
    let message = state.status.message;
    if (waiting) message = 'Needs your answer.';
    else if (state.input.trim() === '' && readyToSave(state)) message = 'Ready. Enter to save.';
    if (!isBusy) {
      this.clearPhaseTimer();
      this.phase.textContent = message;
      return;
    }
    this.pendingPhase = message;
    if (this.phaseTimer !== undefined || this.phase.textContent === message) return;
    this.phaseTimer = this.phase.win.setTimeout(() => {
      this.phaseTimer = undefined;
      if (this.live && this.active()) this.phase.textContent = this.pendingPhase;
    }, 150);
  }
  private clearPhaseTimer(): void {
    this.phase.win.clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
  }
  private navigateSaved(state: CommandSessionSnapshot): void {
    const task = state.focus.find(
      (focus) => focus.kind === 'task' && focus.plan === undefined && focus.revision !== undefined,
    );
    if (state.status.kind === 'saved' && task?.kind === 'task' && task.revision !== undefined) {
      const key = `${state.id}:${task.target}:${task.revision}`;
      if (this.navigated !== key) {
        this.navigated = key;
        this.options.navigate(task.target, task.revision, 'feedback');
      }
    }
  }
  private reveal(state: CommandSessionSnapshot): void {
    const request = state.reveal,
      owner = this.owner;
    if (request === undefined || owner?.claimReveal(request) !== true) return;
    runAsyncAction(
      Promise.resolve().then(() => {
        let accepted = false;
        try {
          if (this.live && this.active())
            accepted = this.options.navigate(request.target, request.revision, 'reveal');
        } finally {
          owner.acknowledgeReveal(request, accepted);
        }
      }),
      'Could not open task',
    );
  }
  private openMenu(trigger: HTMLElement, event?: MouseEvent): void {
    this.menu?.hide();
    this.owner ??= this.options.owner();
    const owner = this.owner;
    const menu = new Menu();
    this.menu = menu;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-haspopup', 'menu');
    menu.addItem((item) =>
      item
        .setTitle('New session')
        .setIcon('plus')
        .onClick(() => {
          this.setActive(true);
          runAsyncAction(owner.newSession(), 'Could not start a new session');
        }),
    );
    this.populateMenu(menu, owner);
    menu.onHide(() => {
      this.releaseMenu();
      this.releaseMenu = () => {};
      if (this.menu === menu) this.menu = undefined;
      trigger.setAttribute('aria-expanded', 'false');
      if (this.live && trigger.isConnected) trigger.focus({ preventScroll: true });
    });
    const bounds = trigger.getBoundingClientRect();
    const win = trigger.ownerDocument.defaultView;
    if (win === null) return;
    const click =
      event ??
      new win.MouseEvent('click', {
        clientX: bounds.left,
        clientY: bounds.bottom,
      });
    if (event === undefined) Object.defineProperty(click, 'target', { value: trigger });
    showMenuAtMouseEventWithFocus(menu, click, (surface) => {
      surface.classList.add('abyss-command-history-menu');
      this.releaseMenu = this.capture.registerSurface(surface);
      surface.addEventListener('keydown', (key) => {
        if (key.key === 'Escape' && !key.isComposing) {
          key.preventDefault();
          key.stopPropagation();
          menu.hide();
        }
      });
    });
  }
  private populateMenu(menu: Menu, owner: CommandSessionOwner): void {
    const snapshot = owner.snapshot();
    if (snapshot.pendingTransition != null) {
      for (const [label, value] of [
        ['Save and continue', 'save'],
        ['Keep for later', 'keep'],
        ['Discard draft', 'discard'],
        ['Cancel', 'cancel'],
      ] as const)
        menu.addItem((item) =>
          item.setTitle(label).onClick(() => {
            runAsyncAction(owner.resolveTransition(value), 'Could not change session');
          }),
        );
    }
    if (snapshot.recovery === 'historical')
      menu.addItem((item) =>
        item.setTitle('Review current source').onClick(() => {
          runAsyncAction(owner.review(), 'Could not review session');
        }),
      );
    if (snapshot.blocked)
      menu.addItem((item) =>
        item.setTitle('Acknowledge uncertain result and start new').onClick(() => {
          runAsyncAction(owner.acknowledgeUncertainty(), 'Could not retain uncertain result');
        }),
      );
    menu.addSeparator();
    for (const record of owner.recent()) {
      menu.addItem((item) =>
        item
          .setTitle(sessionLabel(record))
          .setChecked(record.snapshot.id === snapshot.id)
          .onClick(() => {
            this.setActive(true);
            runAsyncAction(owner.select(record.snapshot.id), 'Could not open session');
          }),
      );
    }
    if (snapshot.exchanges.length > 0) {
      menu.addSeparator();
      for (const exchange of snapshot.exchanges)
        menu.addItem((item) =>
          item
            .setTitle(`${exchange.role === 'user' ? 'You' : 'Assistant'}: ${exchange.text}`)
            .setDisabled(true),
        );
    }
  }
  private guardPlannedLink(event: MouseEvent): void {
    const win = this.content.ownerDocument.defaultView;
    if (win === null || !(event.target instanceof win.Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a.internal-link');
    if (anchor === null) return;
    const href = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
    const source =
      anchor.closest<HTMLElement>('[data-task-source-path]')?.dataset['taskSourcePath'];
    if (source !== undefined && this.allowLink(href, source)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  private allowLink(href: string, sourcePath: string): boolean {
    const { path } = parseLinktext(href);
    if (this.options.app.metadataCache.getFirstLinkpathDest(path, sourcePath) !== null) return true;
    this.failure('This note does not exist yet.');
    return false;
  }
  destroy(): void {
    if (!this.live) return;
    this.remember();
    this.live = false;
    this.clearPhaseTimer();
    this.menu?.hide();
    this.releaseMenu();
    this.unsubscribe?.();
    this.tree?.destroy();
    this.projects.destroy();
    this.notes.destroy();
    this.component.unload();
    this.toolbar.remove();
    this.phase.remove();
    this.content.remove();
  }
}
let nextSurface = 0;
