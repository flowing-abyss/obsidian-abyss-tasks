import { Component, Menu, parseLinktext, setIcon, setTooltip, type App } from 'obsidian';
import type { CommandSessionOwner } from '../../ai/CommandSessionOwner';
import { commandMessage } from '../../ai/commandMessages';
import type { HistoricalCommandSession } from '../../ai/commandRecovery';
import type {
  CommandChange,
  CommandSessionSnapshot,
  CommandSubmissionBasis,
} from '../../ai/commandTypes';
import { CommandVoiceController } from '../../ai/voice/CommandVoiceController';
import type { CommandTranscriptionPort } from '../../ai/voice/ProviderTranscription';
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
  readonly transcription?: CommandTranscriptionPort;
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
  if (first.kind.startsWith('project-')) return projectObject(first);
  if (first.kind === 'note') return first.plan.path;
  return undefined;
}
function projectObject(change: CommandChange): string | undefined {
  if (change.kind === 'project-create') return change.name;
  if (change.kind === 'project-move') return change.before.markdownTitle;
  return undefined;
}
function sessionLabel(record: HistoricalCommandSession): string {
  const state = record.snapshot;
  const label =
    mainObject(state) ??
    state.exchanges.find((entry) => entry.role === 'user')?.text ??
    commandMessage('Untitled session');
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
  private readonly microphone: HTMLButtonElement;
  private voice: CommandVoiceController | undefined;
  private primaryAction: PrimaryAction = 'send';
  private readonly projects: CommandProjects;
  private readonly notes: CommandNotes;
  private tree: CommandTree | undefined;
  private owner: CommandSessionOwner | undefined;
  private noteReview: ReturnType<CommandSessionOwner['registerNoteReview']> | undefined;
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
      attr: { role: 'toolbar', 'aria-label': commandMessage('Quick capture controls') },
    });
    const history = this.button(commandMessage('History'), 'history');
    this.toggle = this.button(commandMessage('CommandMode'), 'sparkles');
    this.microphone = this.button(commandMessage('Microphone'), 'mic');
    this.microphone.disabled = options.transcription === undefined;
    this.component.registerDomEvent(this.microphone, 'click', () => {
      if (!this.active()) this.setActive(true);
      if (this.voice !== undefined)
        runAsyncAction(this.voice.toggle(), commandMessage('Could not start voice input'));
    });
    this.primary = this.button(commandMessage('Send'), 'arrow-up');
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
      {
        allowLink: (href, path) => this.allowLink(href, path),
        changed: () => {
          if (!this.live || !this.active() || this.owner === undefined) return;
          const state = this.owner.snapshot();
          this.renderPrimary(state);
          this.renderPhase(state, busy(state));
        },
      },
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
    this.bindInputSizing();
    this.setActive(options.memory.active);
    this.initializing = false;
  }
  private bindInputSizing(): void {
    const win = this.capture.input.win as Window & { ResizeObserver?: typeof ResizeObserver };
    if (typeof win.ResizeObserver === 'function') {
      let width = -1;
      const observer = new win.ResizeObserver(() => {
        const next = this.capture.input.clientWidth;
        if (width === next) return;
        width = next;
        this.sizeInput();
      });
      observer.observe(this.capture.input);
      this.component.register(() => {
        observer.disconnect();
      });
    }
    this.component.registerDomEvent(this.capture.input, 'input', () => {
      this.sizeInput();
    });
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
      const owner = this.activateOwner();
      this.bindNoteReview();
      owner.updateContext(this.options.context());
      owner.open();
      this.options.memory.presentation ??= new Map();
      this.tree ??= new CommandTree(this.treeHost, {
        ...this.options,
        owner,
        component: this.component,
        presentation: this.options.memory.presentation,
        isCurrent: () => this.live && this.active(),
        failure: (message) => {
          this.failure(message);
        },
        allowLink: (href, path) => this.allowLink(href, path),
      });
      this.unsubscribe ??= owner.subscribe((state) => {
        this.render(state);
      });
      this.capture.input.setAttribute('aria-label', commandMessage('Command'));
      this.capture.input.placeholder = commandMessage('What would you like to do?');
      this.capture.input.readOnly = false;
      this.capture.input.setAttribute('aria-describedby', this.phase.id);
      this.capture.input.setSelectionRange(
        this.options.memory.selectionStart,
        this.options.memory.selectionEnd,
      );
      this.content.scrollTop = this.options.memory.scrollTop;
    } else {
      this.voice?.stop();
      this.releaseNoteReview();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.owner !== undefined)
        runAsyncAction(this.owner.hide(), commandMessage('Could not retain command session'));
      this.capture.input.setAttribute('aria-label', commandMessage('Add task'));
      this.capture.input.placeholder = commandMessage('Task name…');
      this.setPrimary('send', false);
    }
    if (!this.initializing) this.capture.refresh();
  }
  private activateOwner(): CommandSessionOwner {
    this.owner ??= this.options.owner();
    this.bindVoice();
    return this.owner;
  }
  input(text: string): void {
    this.inputGeneration++;
    this.voice?.clearMessage();
    this.owner?.setInput(text);
    this.remember();
  }
  private bindNoteReview(): void {
    this.noteReview ??= this.owner?.registerNoteReview(
      (basis) => this.live && this.active() && this.notes.reviewStatus(basis) === 'ready',
    );
  }
  private releaseNoteReview(): void {
    this.noteReview?.dispose();
    this.noteReview = undefined;
  }
  private bindVoice(): void {
    if (
      this.voice !== undefined ||
      this.owner === undefined ||
      this.options.transcription === undefined
    )
      return;
    const win = this.capture.input.ownerDocument.defaultView;
    if (win === null) return;
    this.voice = new CommandVoiceController({
      owner: this.owner,
      window: win,
      transcription: this.options.transcription,
      retain: (text) => {
        this.inputGeneration++;
        this.owner?.setInput(text);
      },
      submit: (text, basis, admission) => this.submitText(text, basis, admission),
      changed: () => {
        if (!this.live || !this.active() || this.owner === undefined) return;
        const state = this.owner.snapshot();
        this.renderPrimary(state);
        this.renderPhase(state, busy(state));
        this.renderMicrophone(state);
      },
    });
  }
  private renderMicrophone(state: CommandSessionSnapshot): void {
    const mode = state.voiceMode ?? 'manual';
    if (this.microphone.dataset['voiceMode'] !== mode) {
      this.microphone.dataset['voiceMode'] = mode;
      setIcon(this.microphone, mode === 'continuous' ? 'radio' : 'mic');
      setTooltip(
        this.microphone,
        mode === 'continuous' ? commandMessage('Continuous voice') : commandMessage('Microphone'),
      );
    }
    this.microphone.setAttribute('aria-pressed', String(this.voice?.active() === true));
    this.microphone.setAttribute(
      'aria-description',
      mode === 'continuous'
        ? commandMessage('Continuous voice. Click to start or stop listening.')
        : commandMessage('Manual voice. Enter, send, or click again to submit.'),
    );
  }
  submit(): void {
    const owner = this.owner;
    if (!this.active() || owner === undefined || !this.live) return;
    if (this.finishVoice()) return;
    if (this.capture.input.value.trim() === '' && busy(owner.snapshot())) return;
    const state = owner.snapshot();
    this.voice?.clearMessage();
    runAsyncAction(
      this.submitText(this.capture.input.value, {
        sessionId: state.id,
        proposalRevision: state.proposal.revision,
      }),
      commandMessage('Could not run command'),
    );
  }
  private finishVoice(): boolean {
    if (this.voice?.active() === true) {
      this.voice.finish();
      return true;
    }
    return this.voice?.pending() === true && this.capture.input.value.trim() === '';
  }
  private async submitText(
    text: string,
    basis: CommandSubmissionBasis,
    admission?: () => boolean,
  ): Promise<void> {
    const owner = this.owner;
    if (owner === undefined) return;
    owner.updateContext(this.options.context());
    const generation = ++this.inputGeneration,
      input = owner.captureInput();
    await owner.submit(text, basis, this.noteReview?.token, admission);
    const next = owner.snapshot();
    if (
      this.live &&
      this.active() &&
      generation === this.inputGeneration &&
      input.current() &&
      next.id === basis.sessionId &&
      next.input === text &&
      next.status.kind !== 'error'
    )
      owner.clearInput();
  }
  private activatePrimary(): void {
    if (!this.active()) {
      this.capture.submitOrdinary();
      return;
    }
    if (this.voice?.active() === true || this.primaryAction !== 'stop') {
      this.submit();
      return;
    }
    this.inputGeneration++;
    if (this.owner !== undefined)
      runAsyncAction(this.owner.stop(), commandMessage('Could not stop command'));
  }
  private setPrimary(action: PrimaryAction, disabled: boolean): void {
    const labels = {
      send: commandMessage('Send'),
      save: commandMessage('Save proposal'),
      stop: commandMessage('Stop'),
    };
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
    if (this.voice?.active() === true) {
      this.setPrimary('send', false);
      return;
    }
    if (this.voice?.pending() === true && state.input === '') {
      this.setPrimary('send', true);
      return;
    }
    if (state.input.trim() !== '') {
      this.setPrimary('send', false);
      return;
    }
    if (busy(state)) this.setPrimary('stop', false);
    else if (readyToSave(state)) this.setPrimary('save', this.noteReviewStatus(state) !== 'ready');
    else this.setPrimary('send', true);
  }
  escape(): void {
    this.voice?.stop();
    this.remember();
    if (this.owner !== undefined)
      runAsyncAction(this.owner.hide(), commandMessage('Could not retain command session'));
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
    const input = this.capture.input;
    if (input.value !== state.input) {
      const start = input.selectionStart ?? 0,
        end = input.selectionEnd ?? start;
      input.value = state.input;
      input.setSelectionRange(start, end);
    }
    this.sizeInput();
    const isBusy = busy(state);
    this.notes.update(state);
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
    this.tree?.update(state);
    this.navigateSaved(state);
    this.reveal(state);
  }
  private sizeInput(): void {
    const input = this.capture.input;
    if (!this.live || input.tagName !== 'TEXTAREA') return;
    const textarea = input as HTMLTextAreaElement;
    const style = input.win.getComputedStyle(input);
    const line = cssPixels(style.lineHeight, cssPixels(style.fontSize, 16) * 1.5);
    const padding = cssPixels(style.paddingTop, 0) + cssPixels(style.paddingBottom, 0);
    const scroll = textarea.scrollTop;
    textarea.rows = 1;
    textarea.rows = Math.max(1, Math.min(6, Math.ceil((textarea.scrollHeight - padding) / line)));
    textarea.scrollTop = scroll;
  }
  private renderPhase(state: CommandSessionSnapshot, isBusy: boolean): void {
    const waiting = state.activeQuestion !== null && !isBusy && state.status.kind !== 'error';
    if (this.renderVoicePhase(state)) return;
    let message = state.status.message;
    if (waiting) message = commandMessage('Needs your answer.');
    else if (state.input.trim() === '' && readyToSave(state))
      message = this.noteReviewMessage(state);
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
  private renderVoicePhase(state: CommandSessionSnapshot): boolean {
    const voice = this.voice?.status();
    if (voice === undefined) return false;
    if (voice.kind === 'listening' && state.status.message !== '') return false;
    if (voice.kind === 'recognizing' && state.status.kind === 'writing') return false;
    this.clearPhaseTimer();
    this.phase.textContent = voice.message;
    return true;
  }
  private noteReviewStatus(state: CommandSessionSnapshot): 'ready' | 'pending' | 'failed' {
    return this.notes.reviewStatus({
      sessionId: state.id,
      proposalRevision: state.proposal.revision,
    });
  }
  private noteReviewMessage(state: CommandSessionSnapshot): string {
    const review = this.noteReviewStatus(state);
    if (review === 'ready') return commandMessage('Ready. Enter to save.');
    if (review === 'failed')
      return commandMessage(
        'Could not display the note preview. Edit it or reopen CommandMode to retry.',
      );
    return commandMessage('Loading note preview…');
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
      commandMessage('Could not open task'),
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
        .setTitle(commandMessage('New session'))
        .setIcon('plus')
        .onClick(() => {
          this.setActive(true);
          runAsyncAction(owner.newSession(), commandMessage('Could not start a new session'));
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
      const basis = {
        sessionId: snapshot.id,
        proposalRevision: snapshot.proposal.revision,
        pendingTransition: snapshot.pendingTransition,
      };
      const surface = this.noteReview?.token;
      for (const [label, value] of [
        [commandMessage('Save and continue'), 'save'],
        [commandMessage('Keep for later'), 'keep'],
        [commandMessage('Discard draft'), 'discard'],
        [commandMessage('Cancel'), 'cancel'],
      ] as const)
        menu.addItem((item) =>
          item.setTitle(label).onClick(() => {
            runAsyncAction(
              owner.resolveTransition(value, basis, surface),
              commandMessage('Could not change session'),
            );
          }),
        );
    }
    if (snapshot.recovery === 'historical')
      menu.addItem((item) =>
        item.setTitle(commandMessage('Review current source')).onClick(() => {
          runAsyncAction(owner.review(), commandMessage('Could not review session'));
        }),
      );
    if (snapshot.blocked)
      menu.addItem((item) =>
        item.setTitle(commandMessage('Acknowledge uncertain result and start new')).onClick(() => {
          runAsyncAction(
            owner.acknowledgeUncertainty(),
            commandMessage('Could not retain uncertain result'),
          );
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
            runAsyncAction(
              owner.select(record.snapshot.id),
              commandMessage('Could not open session'),
            );
          }),
      );
    }
    if (snapshot.exchanges.length > 0) {
      menu.addSeparator();
      for (const exchange of snapshot.exchanges)
        menu.addItem((item) =>
          item
            .setTitle(
              `${exchange.role === 'user' ? commandMessage('You') : commandMessage('Assistant')}: ${exchange.text}`,
            )
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
    this.failure(commandMessage('This note does not exist yet.'));
    return false;
  }
  destroy(): void {
    if (!this.live) return;
    this.remember();
    this.live = false;
    this.voice?.dispose();
    this.clearPhaseTimer();
    this.menu?.hide();
    this.releaseMenu();
    this.unsubscribe?.();
    this.releaseNoteReview();
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

function cssPixels(value: string, fallback: number): number {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : fallback;
}
