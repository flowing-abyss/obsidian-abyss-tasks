import { Component, Menu, parseLinktext, setIcon, setTooltip, type App } from 'obsidian';
import { discardedHistoryPreview } from '../../ai/commandHistoryMetadata';
import { commandMessage } from '../../ai/commandMessages';
import type { CommandSessionOwner } from '../../ai/CommandSessionOwner';
import type { CommandSessionSnapshot, CommandSubmissionBasis } from '../../ai/commandTypes';
import { CommandVoiceController } from '../../ai/voice/CommandVoiceController';
import type { CommandTranscriptionPort } from '../../ai/voice/ProviderTranscription';
import type { ProjectsSettings } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import { showMenuAtMouseEventWithFocus } from '../nativeMenuFocus';
import { runAsyncAction } from '../runAsyncAction';
import type { CaptureExtension, CaptureExtensionHost } from '../taskCapture/CaptureSurface';
import { CommandChangeViewport } from './CommandChangeViewport';
import { CommandElapsedTime, type CommandElapsedMemory } from './CommandElapsedTime';
import { CommandHistoryPopover } from './CommandHistoryPopover';
import { CommandNotes } from './CommandNotes';
import { CommandProjects } from './CommandProjects';
import {
  CommandTree,
  type CommandPresentationMemory,
  type CommandTreeOptions,
} from './CommandTree';
import { CommandVoiceWaveform } from './CommandVoiceWaveform';

export interface CommandSurfaceMemory extends CommandElapsedMemory {
  active: boolean;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  presentation?: CommandPresentationMemory;
  scrolledChange?: string;
}
export interface CommandModeOptions extends Pick<
  CommandTreeOptions,
  'formatDate' | 'getDateClass' | 'getTagColor' | 'showSource'
> {
  readonly app: App;
  readonly availability?: () => { agent: boolean; voice: boolean };
  readonly availabilityRevision?: () => number;
  readonly transcription?: CommandTranscriptionPort;
  readonly owner: () => CommandSessionOwner | Promise<CommandSessionOwner>;
  readonly memory: CommandSurfaceMemory;
  readonly registry: StatusRegistry;
  readonly projectSettings: () => ProjectsSettings;
  readonly context: () => string;
  readonly close: (restoreFocus?: boolean) => void;
  readonly navigate: (target: string, revision: string, intent: 'feedback' | 'reveal') => boolean;
}
type PrimaryAction = 'send' | 'save' | 'stop';
const contentFields = [
  'id',
  'proposal',
  'entities',
  'focus',
  'exchanges',
  'journal',
  'presentation',
  'actual',
  'recovery',
  'recoveryEvidence',
  'blocked',
] as const satisfies ReadonlyArray<keyof CommandSessionSnapshot>;
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
function needsResolution(state: CommandSessionSnapshot): boolean {
  return (
    state.activeQuestion !== null ||
    state.status.kind === 'error' ||
    state.blocked ||
    state.pendingTransition != null
  );
}
export class CommandModeSurface implements CaptureExtension {
  private readonly component = new Component();
  private readonly phase: HTMLElement;
  private readonly phaseLabel: HTMLElement;
  private readonly voicePhase: HTMLElement;
  private readonly elapsed: CommandElapsedTime;
  private readonly content: HTMLElement;
  private readonly viewport: CommandChangeViewport;
  private scrollGeneration = 0;
  private readonly treeHost: HTMLElement;
  private readonly latest: HTMLElement;
  private readonly question: HTMLElement;
  private readonly historyButton: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private readonly toolbar: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly microphone: HTMLButtonElement;
  private readonly waveform: CommandVoiceWaveform;
  private voice: CommandVoiceController | undefined;
  private primaryAction: PrimaryAction = 'send';
  private readonly projects: CommandProjects;
  private readonly notes: CommandNotes;
  private tree: CommandTree | undefined;
  private owner: CommandSessionOwner | undefined;
  private noteReview: ReturnType<CommandSessionOwner['registerNoteReview']> | undefined;
  private unsubscribe: (() => void) | undefined;
  private menu: Menu | undefined;
  private history: CommandHistoryPopover | undefined;
  private releaseMenu = (): void => {};
  private live = true;
  private commandActive = false;
  private modeGeneration = 0;
  private popupGeneration = 0;
  private readonly visibility = Symbol();
  private readonly initializing: boolean = true;
  private inputGeneration = 0;
  private contentState: CommandSessionSnapshot | undefined;
  private availabilityRevision: number | undefined;
  private navigated = '';
  private phaseTimer: number | undefined;
  private pendingPhase = '';
  constructor(
    private readonly capture: CaptureExtensionHost,
    private readonly options: CommandModeOptions,
  ) {
    this.component.load();
    this.waveform = new CommandVoiceWaveform(capture.shell, capture.input);
    this.toolbar = capture.shell.createDiv({
      cls: 'abyss-command-toolbar',
      attr: { role: 'toolbar', 'aria-label': commandMessage('Quick capture controls') },
    });
    this.historyButton = this.button(commandMessage('History'), 'history');
    this.toggle = this.button(commandMessage('CommandMode'), 'sparkles');
    this.microphone = this.button(commandMessage('Microphone'), 'mic');
    this.component.registerDomEvent(this.microphone, 'click', () => {
      const generation = this.modeGeneration;
      this.withOwner(
        (owner) => {
          this.activateOwner(owner);
          this.voice?.toggle();
        },
        () => generation === this.modeGeneration && !this.capture.input.ownerDocument.hidden,
      );
    });
    this.component.registerDomEvent(this.microphone, 'contextmenu', (event) => {
      event.preventDefault();
      this.openMenu(this.microphone, event);
    });
    this.component.registerDomEvent(this.microphone, 'keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        this.openMenu(this.microphone);
      }
    });
    this.primary = this.button(commandMessage('Send'), 'arrow-up');
    this.phase = capture.element.createDiv({
      cls: 'abyss-command-phase',
      attr: { role: 'status' },
    });
    this.phase.id = `abyss-command-phase-${++nextSurface}`;
    this.phaseLabel = this.phase.createSpan();
    this.voicePhase = this.phase.createSpan({ cls: 'abyss-command-voice-phase' });
    this.elapsed = new CommandElapsedTime(
      this.phase.createSpan({ cls: 'abyss-command-elapsed' }),
      options.memory,
    );
    this.content = capture.element.createDiv({ cls: 'abyss-command-content' });
    this.viewport = new CommandChangeViewport(this.content);
    const projectHost = this.content.createDiv({ cls: 'abyss-command-projects' });
    this.projects = new CommandProjects(projectHost, options, this.component, {
      allowLink: (href, path) => this.allowLink(href, path),
      changed: () => {
        if (this.live && this.active() && this.owner !== undefined)
          this.scrollChanges(this.owner.snapshot());
      },
    });
    this.treeHost = this.content.createDiv({ cls: 'abyss-command-tree' });
    this.notes = new CommandNotes(
      this.content.createDiv({ cls: 'abyss-command-notes' }),
      options.app,
      this.component,
      {
        memory: options.memory,
        allowLink: (href, path) => this.allowLink(href, path),
        changed: () => {
          if (!this.live || !this.active() || this.owner === undefined) return;
          const state = this.owner.snapshot();
          this.renderPrimary(state);
          this.renderPhase(state, busy(state));
          this.scrollChanges(state);
        },
      },
    );
    this.latest = capture.element.createDiv({ cls: 'abyss-command-latest' });
    this.question = capture.element.createDiv({ cls: 'abyss-command-question' });
    this.bindControls();
    this.bindInputSizing();
    this.setActive(options.memory.active);
    this.renderMicrophone();
    this.initializing = false;
  }
  private bindControls(): void {
    this.component.registerDomEvent(this.historyButton, 'click', () => {
      this.openHistory();
    });
    this.component.registerDomEvent(this.toggle, 'click', () => {
      this.setActive(!this.active());
    });
    this.component.registerDomEvent(this.primary, 'contextmenu', (event) => {
      event.preventDefault();
      this.openMenu(this.primary, event);
    });
    this.component.registerDomEvent(this.primary, 'keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        this.openMenu(this.primary);
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
    this.component.registerDomEvent(this.capture.input, 'select', () => {
      this.remember();
    });
    this.component.registerDomEvent(this.capture.input, 'focus', () => {
      this.updateAvailability();
      if (this.active() && this.owner !== undefined) this.renderPrimary(this.owner.snapshot());
    });
  }
  private updateAvailability(availability = this.options.availability?.()): void {
    this.availabilityRevision = this.options.availabilityRevision?.();
    const agent = availability?.agent !== false;
    this.toggle.hidden = !agent;
    this.updateHistoryAvailability(agent);
    this.microphone.hidden =
      availability?.voice === false ||
      this.options.transcription === undefined ||
      (this.active() && !agent);
    this.microphone.disabled = this.microphone.hidden === true;
  }
  private updateHistoryAvailability(available: boolean): void {
    this.historyButton.hidden = !available;
    this.historyButton.disabled = !available;
    if (!available) this.history?.close(false);
  }
  private bindInputSizing(): void {
    const win = this.capture.input.win as Window & { ResizeObserver?: typeof ResizeObserver };
    if (typeof win.ResizeObserver === 'function') {
      let width = -1,
        frame: number | undefined;
      const observer = new win.ResizeObserver(() => {
        const next = this.capture.input.clientWidth;
        if (width === next) return;
        width = next;
        this.waveform.resize();
        frame ??= win.requestAnimationFrame(() => {
          frame = undefined;
          this.sizeInput();
        });
      });
      observer.observe(this.capture.input);
      this.component.register(() => {
        observer.disconnect();
        if (frame !== undefined) win.cancelAnimationFrame(frame);
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
    return this.commandActive;
  }
  private setActive(requested: boolean, reason: 'open' | 'history' | 'preference' = 'open'): void {
    const availability = this.options.availability?.();
    const active = requested && availability?.agent !== false;
    this.retirePreviousInput(active);
    const generation = ++this.modeGeneration;
    this.commandActive = active;
    this.updateAvailability(availability);
    this.options.memory.active = active;
    this.capture.element.classList.remove('abyss-capture-surface--voice');
    this.toggle.setAttribute('aria-pressed', String(active));
    this.phase.hidden = !active;
    this.content.hidden = !active;
    this.latest.hidden = !active || this.latest.textContent === '';
    this.question.hidden = !active || this.question.textContent === '';
    if (active) {
      this.withOwner(
        (owner) => {
          this.activateCommand(owner, reason);
        },
        () => generation === this.modeGeneration,
        () => {
          this.capture.input.readOnly = true;
          this.capture.input.setAttribute('aria-busy', 'true');
          this.phaseLabel.textContent = commandMessage('Opening session…');
          this.setPrimary('send', true);
        },
      );
    } else this.deactivateCommand();
    if (!this.initializing) this.capture.refresh();
  }
  private retirePreviousInput(active: boolean): void {
    if (active) {
      if (!this.active()) this.voice?.stop();
      return;
    }
    this.inputGeneration++;
    this.clearPhaseTimer();
    this.elapsed.dispose();
  }
  private activateCommand(
    owner: CommandSessionOwner,
    reason: 'open' | 'history' | 'preference',
  ): void {
    this.activateOwner(owner);
    this.bindNoteReview();
    owner.updateContext(this.options.context());
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
    this.restoreCommandInput();
    if (reason === 'open') this.startContinuous();
  }
  private deactivateCommand(): void {
    this.tree?.destroy();
    this.tree = undefined;
    this.contentState = undefined;
    this.voice?.stop();
    this.releaseNoteReview();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.owner !== undefined)
      runAsyncAction(
        this.owner.hide(this.visibility),
        commandMessage('Could not retain command session'),
      );
    this.capture.input.setAttribute('aria-label', commandMessage('Add task'));
    this.capture.input.placeholder = commandMessage('Task name…');
    this.setPrimary('send', false);
  }
  private restoreCommandInput(): void {
    this.capture.input.setAttribute('aria-label', commandMessage('Command'));
    this.capture.input.placeholder = commandMessage('What would you like to do?');
    this.capture.input.readOnly = false;
    this.capture.input.setAttribute('aria-describedby', this.phase.id);
    this.capture.input.setSelectionRange(
      this.options.memory.selectionStart,
      this.options.memory.selectionEnd,
    );
    this.content.scrollTop = this.options.memory.scrollTop;
  }
  private withOwner(
    action: (owner: CommandSessionOwner) => void,
    current: () => boolean,
    loading?: () => void,
  ): void {
    const resolved = this.owner ?? this.options.owner();
    const accept = (owner: CommandSessionOwner): void => {
      if (!this.live || !current()) return;
      this.owner = owner;
      action(owner);
    };
    if (!(resolved instanceof Promise)) {
      accept(resolved);
      return;
    }
    loading?.();
    runAsyncAction(
      resolved.then(accept, (error: unknown) => {
        if (!this.live || !current()) return;
        this.failure(commandMessage('Could not open command history.'));
        throw error;
      }),
      commandMessage('Could not open command history.'),
    );
  }
  private activateOwner(owner: CommandSessionOwner): void {
    owner.open(this.visibility);
    this.bindVoice();
  }
  edited(): void {
    this.refreshChangedAvailability();
    this.waveform.clear();
    this.voice?.edited();
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
      visibility: this.visibility,
      window: win,
      transcription: this.options.transcription,
      mode: () => this.voiceMode(),
      continuousAvailable: () => {
        this.updateAvailability();
        return this.voiceMode() === 'continuous';
      },
      input: () => this.capture.input.value,
      retain: (text) => {
        this.inputGeneration++;
        if (this.active()) this.owner?.setInput(text);
        else this.capture.replaceOrdinaryInput(text);
      },
      submit: (text, basis, admission) => {
        const owner = this.submissionOwner();
        if (owner === undefined) return Promise.resolve(false);
        owner.updateContext(this.options.context());
        return owner.enqueueVoice(
          text,
          basis,
          { noteReview: this.noteReview?.token, visibility: this.visibility },
          admission,
        );
      },
      send: (text, basis, admission) => {
        if (!this.live || !admission()) return;
        if (this.active())
          runAsyncAction(
            this.submitText(text, basis, admission),
            commandMessage('Could not run command'),
          );
        else this.capture.submitOrdinary();
      },
      activity: (samples, listening) => {
        const speaking = String(samples !== undefined);
        if (this.microphone.dataset['speaking'] !== speaking)
          this.microphone.dataset['speaking'] = speaking;
        if (listening) this.waveform.draw(samples);
        else this.waveform.clear();
      },
      changed: () => {
        if (!this.live || this.owner === undefined) return;
        if (!this.active()) {
          this.renderOrdinaryVoice();
          return;
        }
        const state = this.owner.snapshot();
        this.renderPrimary(state);
        this.renderPhase(state, busy(state));
        this.renderMicrophone();
      },
    });
    this.renderMicrophone();
  }
  private startContinuous(): void {
    if (
      this.microphone.hidden === false &&
      this.toggle.hidden === false &&
      this.voice !== undefined
    )
      this.voice.startContinuous();
  }
  private voiceMode(): 'manual' | 'continuous' {
    return this.active() && this.toggle.hidden === false && this.microphone.hidden === false
      ? (this.owner?.snapshot().voiceMode ?? 'manual')
      : 'manual';
  }
  private renderOrdinaryVoice(): void {
    const status = this.voice?.status();
    this.voicePhase.hidden = true;
    this.phase.hidden = status === undefined;
    this.capture.element.classList.toggle('abyss-capture-surface--voice', status !== undefined);
    if (status !== undefined) this.phaseLabel.textContent = status.message;
    this.setPrimary('send', false);
    if (this.owner !== undefined) this.renderMicrophone();
  }
  pendingInput(): boolean {
    return this.voice?.active() === true || this.voice?.pending() === true;
  }
  private renderMicrophone(): void {
    const mode = this.voiceMode(),
      active = this.voice?.microphoneActive() === true;
    if (!active) this.waveform.clear();
    const icon = microphoneIcon(mode, active);
    if (this.microphone.dataset['voiceIcon'] !== icon) {
      this.microphone.dataset['voiceIcon'] = icon;
      setIcon(this.microphone, icon);
      if (icon === 'square')
        this.microphone.querySelector('svg')?.setAttribute('fill', 'currentColor');
    }
    this.describeMicrophone(mode);
    this.microphone.setAttribute(
      'aria-label',
      commandMessage(mode === 'manual' && active ? 'Stop dictation' : 'Microphone'),
    );
    this.microphone.dataset['voiceMode'] = mode;
    this.microphone.dataset['speaking'] = String(this.voice?.speaking() === true);
    this.microphone.setAttribute('aria-pressed', String(active));
    this.capture.input.toggleAttribute('data-recording', active);
  }
  private describeMicrophone(mode: 'manual' | 'continuous'): void {
    const status = this.voice?.status();
    const message =
      status?.message ??
      commandMessage(
        this.toggle.hidden === true ? 'Microphone' : 'Microphone · right-click for input mode',
      );
    const parts = [commandMessage(mode === 'continuous' ? 'Continuous' : 'Dictation'), message];
    const queued = this.owner?.queuedVoice() ?? 0;
    if (queued > 0) parts.push(`${queued} ${commandMessage('queued')}`);
    const description = parts.join(' · ');
    setTooltip(this.microphone, description);
    this.microphone.setAttribute('aria-description', description);
  }
  submit(): void {
    const owner = this.owner;
    if (!this.live) return;
    if (this.finishVoice()) return;
    if (!this.active()) {
      this.capture.submitOrdinary();
      return;
    }
    if (owner === undefined) return;
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
    return this.voiceMode() === 'manual' && this.voice?.requestSend() === true;
  }
  private submissionOwner(): CommandSessionOwner | undefined {
    this.updateAvailability();
    if (this.toggle.hidden === true) {
      this.setPrimary('send', true);
      return undefined;
    }
    return this.owner;
  }
  private async submitText(
    text: string,
    basis: CommandSubmissionBasis,
    admission?: () => boolean,
  ): Promise<void> {
    const owner = this.submissionOwner();
    if (owner === undefined) return;
    owner.updateContext(this.options.context());
    const generation = ++this.inputGeneration,
      input = owner.captureInput(),
      submission = owner.captureSubmission(this.visibility);
    const current = (): boolean =>
      this.live &&
      this.active() &&
      input.current() &&
      submission.current() &&
      admission?.() !== false;
    if (text.trim() === '')
      await owner.confirmAndStart(basis.proposalRevision, this.noteReview?.token, this.visibility);
    else
      await owner.submit(
        text,
        basis,
        { noteReview: this.noteReview?.token, visibility: this.visibility },
        current,
      );
    const next = owner.snapshot();
    if (
      generation === this.inputGeneration &&
      input.current() &&
      next.id === basis.sessionId &&
      next.input === text &&
      next.status.kind !== 'error'
    )
      owner.clearInput();
  }
  private activatePrimary(): void {
    if (this.primaryAction !== 'stop') {
      this.submit();
      return;
    }
    if (this.finishVoice()) return;
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
    this.refreshChangedAvailability();
    if (this.toggle.hidden === true) {
      this.setPrimary('send', true);
      return;
    }
    this.renderAvailablePrimary(state);
  }
  private refreshChangedAvailability(): void {
    if (this.availabilityRevision !== this.options.availabilityRevision?.())
      this.updateAvailability();
  }
  private renderAvailablePrimary(state: CommandSessionSnapshot): void {
    if (this.renderDictationPrimary()) return;
    if (state.input.trim() !== '') {
      this.setPrimary('send', false);
      return;
    }
    if (busy(state)) this.setPrimary('stop', false);
    else if (readyToSave(state)) this.setPrimary('save', this.noteReviewStatus(state) !== 'ready');
    else this.setPrimary('send', needsResolution(state));
  }
  private renderDictationPrimary(): boolean {
    if (this.voiceMode() !== 'manual') return false;
    if (this.voice?.active() === true) {
      this.setPrimary('send', false);
      return true;
    }
    if (this.voice?.pending() === true) {
      this.setPrimary('send', false);
      return true;
    }
    return false;
  }
  escape(restoreFocus = true): void {
    this.voice?.stop();
    this.remember();
    if (this.owner !== undefined)
      runAsyncAction(
        this.owner.hide(this.visibility),
        commandMessage('Could not retain command session'),
      );
    this.options.close(restoreFocus);
  }
  private remember(): void {
    if (!this.active()) return;
    this.options.memory.selectionStart = this.capture.input.selectionStart ?? 0;
    this.options.memory.selectionEnd = this.capture.input.selectionEnd ?? 0;
    this.options.memory.scrollTop = this.content.scrollTop;
  }
  private failure(message: string): void {
    this.clearPhaseTimer();
    if (this.live) this.phaseLabel.textContent = message;
  }
  private render(state: CommandSessionSnapshot): void {
    if (!this.live || !this.active()) return;
    const input = this.capture.input;
    if (input.value !== state.input) {
      const start = input.selectionStart ?? 0,
        end = input.selectionEnd ?? start;
      input.value = state.input;
      input.setSelectionRange(start, end);
      this.sizeInput();
    }
    if (input.value !== '') this.waveform.clear();
    const isBusy = busy(state);
    this.renderContent(state);
    this.renderPrimary(state);
    this.capture.input.setAttribute('aria-busy', String(isBusy));
    this.capture.input.setAttribute('aria-invalid', String(state.status.kind === 'error'));
    this.renderPhase(state, isBusy);
    this.renderLatest(state);
    this.question.textContent = state.activeQuestion ?? '';
    this.question.hidden = state.activeQuestion === null;
    this.scrollChanges(state);
    this.navigateSaved(state);
    this.reveal(state);
  }
  private renderContent(state: CommandSessionSnapshot): void {
    const previous = this.contentState;
    this.contentState = state;
    if (previous !== undefined && contentFields.every((key) => state[key] === previous[key]))
      return;
    const evidence = discardedHistoryPreview(state);
    const display =
      evidence !== undefined
        ? {
            ...state,
            proposal: evidence.proposal,
            focus: evidence.focus,
            preparations: evidence.preparations,
          }
        : state;
    this.notes.update(display);
    this.projects.update(display);
    this.tree?.update(display);
    this.content.classList.toggle(
      'abyss-command-content--populated',
      this.tree?.hasTasks === true ||
        this.content.querySelector('.abyss-project-dashboard-header, .abyss-command-note') !== null,
    );
  }
  private renderLatest(state: CommandSessionSnapshot): void {
    const last = [...state.exchanges].reverse().find((entry) => entry.role === 'user');
    this.latest.textContent = last?.text ?? '';
    this.latest.hidden = last === undefined || last.text === state.input;
  }
  private scrollChanges(state: CommandSessionSnapshot): void {
    const generation = ++this.scrollGeneration;
    const key = `${state.id}:${state.proposal.revision}:${state.exchanges.length}`;
    if (
      busy(state) ||
      this.options.memory.scrolledChange === key ||
      this.noteReviewStatus(state) === 'pending'
    )
      return;
    if (this.tree === undefined) return;
    void Promise.all([this.tree.settled, this.projects.settled]).then(
      ([result, projectsReady]) => {
        if (
          result.type !== 'ready' ||
          !projectsReady ||
          !this.live ||
          !this.active() ||
          generation !== this.scrollGeneration
        )
          return;
        this.viewport.update(state.id);
        this.options.memory.scrolledChange = key;
      },
      () => {
        this.failure(commandMessage('Could not render the task text.'));
      },
    );
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
    textarea.rows = Math.max(
      1,
      Math.min(6, Math.ceil((textarea.scrollHeight - padding - 1) / line)),
    );
    textarea.scrollTop = scroll;
  }
  private renderPhase(state: CommandSessionSnapshot, isBusy: boolean): void {
    this.elapsed.update(
      `${state.id}:${state.exchanges.filter((entry) => entry.role === 'user').length}`,
      isBusy,
    );
    const waiting = state.activeQuestion !== null && !isBusy && state.status.kind !== 'error';
    this.renderVoicePhase();
    let message = phaseMessage(state.status.message);
    if (waiting) message = commandMessage('Needs your answer.');
    else if (state.input.trim() === '' && readyToSave(state))
      message = this.noteReviewMessage(state);
    if (!isBusy) {
      this.clearPhaseTimer();
      this.phaseLabel.textContent = message;
      return;
    }
    this.pendingPhase = message;
    if (this.phaseTimer !== undefined || this.phaseLabel.textContent === message) return;
    this.phaseTimer = this.phase.win.setTimeout(() => {
      this.phaseTimer = undefined;
      if (this.live && this.active()) this.phaseLabel.textContent = this.pendingPhase;
    }, 150);
  }
  private renderVoicePhase(): void {
    const voice = this.voice?.status(),
      queued = this.owner?.queuedVoice() ?? 0;
    const message =
      voice?.message ??
      (this.voiceMode() === 'continuous' ? commandMessage('Microphone stopped') : '');
    this.voicePhase.textContent = [
      message,
      ...(queued > 0 ? [`${queued} ${commandMessage('queued')}`] : []),
    ]
      .filter(Boolean)
      .join(' · ');
    this.voicePhase.hidden = this.voicePhase.textContent === '';
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
  private openHistory(): void {
    this.updateAvailability();
    if (this.historyButton.disabled) return;
    if (this.history !== undefined) {
      this.history.close();
      return;
    }
    this.menu?.hide();
    const generation = ++this.popupGeneration;
    this.withOwner(
      (owner) => {
        this.updateAvailability();
        if (!this.historyButton.disabled) this.showHistory(this.historyButton, owner);
      },
      () => generation === this.popupGeneration,
    );
  }
  private showHistory(trigger: HTMLElement, owner: CommandSessionOwner): void {
    this.history = new CommandHistoryPopover({
      capture: this.capture,
      anchor: trigger,
      owner,
      available: () => {
        this.updateAvailability();
        return !this.historyButton.disabled;
      },
      selected: () => {
        if (this.live) this.setActive(true, 'history');
      },
      closed: () => {
        this.history = undefined;
      },
    });
  }
  private openMenu(trigger: HTMLElement, event?: MouseEvent): void {
    if (!this.canOpenMenu(trigger)) return;
    this.history?.close(false);
    this.menu?.hide();
    const generation = ++this.popupGeneration;
    this.withOwner(
      (owner) => {
        this.showMenu(owner, trigger, event);
      },
      () => generation === this.popupGeneration,
    );
  }
  private showMenu(owner: CommandSessionOwner, trigger: HTMLElement, event?: MouseEvent): void {
    const menu = new Menu();
    this.menu = menu;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-haspopup', 'menu');
    if (trigger === this.microphone) this.populateVoiceMenu(menu, owner);
    else this.populateMenu(menu, owner);
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
  private canOpenMenu(trigger: HTMLElement): boolean {
    return this.toggle.hidden === false || (this.active() && trigger !== this.microphone);
  }
  private populateVoiceMenu(menu: Menu, owner: CommandSessionOwner): void {
    for (const [mode, label] of [
      ['manual', 'Dictation'],
      ['continuous', 'Continuous'],
    ] as const) {
      menu.addItem((item) =>
        item
          .setTitle(commandMessage(label))
          .setChecked(this.voiceMode() === mode)
          .onClick(() => {
            if (mode === 'manual' && this.voiceMode() === 'continuous') this.voice?.stop();
            this.setActive(true, 'preference');
            owner.setVoiceMode(mode, this.visibility);
          }),
      );
    }
  }
  private populateMenu(menu: Menu, owner: CommandSessionOwner): void {
    if (this.toggle.hidden === false)
      menu.addItem((item) =>
        item
          .setTitle(commandMessage('New session'))
          .setIcon('plus')
          .onClick(() => {
            this.setActive(true);
            runAsyncAction(owner.newSession(), commandMessage('Could not start a new session'));
          }),
      );
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
    if (this.owner !== undefined)
      runAsyncAction(
        this.owner.hide(this.visibility),
        commandMessage('Could not retain command session'),
      );
    this.voice?.dispose();
    this.waveform.destroy();
    this.clearPhaseTimer();
    this.elapsed.dispose();
    this.menu?.hide();
    this.history?.close(false);
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
    this.latest.remove();
    this.question.remove();
  }
}
let nextSurface = 0;

function microphoneIcon(mode: 'manual' | 'continuous', active: boolean): string {
  if (mode === 'continuous') return active ? 'audio-lines' : 'radio';
  return active ? 'square' : 'mic';
}

function cssPixels(value: string, fallback: number): number {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : fallback;
}

function phaseMessage(message: string): string {
  return message === '' ? commandMessage('Waiting for your command.') : message;
}
