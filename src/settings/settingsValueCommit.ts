export interface SettingsValueCommitRegistrar {
  register(control: HTMLInputElement, commit: () => boolean | void): void;
}

interface RegisteredValueCommit {
  readonly control: HTMLInputElement;
  readonly commit: () => boolean | void;
  committedValue: string;
}

/** Owns delegated natural commit boundaries for the editable values in one settings render. */
export class SettingsValueCommit implements SettingsValueCommitRegistrar, EventListenerObject {
  private readonly registrations_abyssPrivate = new Map<HTMLInputElement, RegisteredValueCommit>();
  private readonly ownerWindow_abyssPrivate: Window | null;
  private readonly flushWindow_abyssPrivate = (): void => {
    this.flush();
  };

  constructor(private readonly root_abyssPrivate: HTMLElement) {
    this.ownerWindow_abyssPrivate = root_abyssPrivate.ownerDocument.defaultView;
    root_abyssPrivate.addEventListener('input', this);
    root_abyssPrivate.addEventListener('change', this);
    root_abyssPrivate.addEventListener('blur', this, true);
    root_abyssPrivate.addEventListener('keydown', this);
    this.ownerWindow_abyssPrivate?.addEventListener('blur', this.flushWindow_abyssPrivate);
  }

  register(control: HTMLInputElement, commit: () => boolean | void): void {
    this.registrations_abyssPrivate.set(control, {
      control,
      commit,
      committedValue: control.value,
    });
  }

  handleEvent(event: Event): void {
    const registration = this.registrations_abyssPrivate.get(event.target as HTMLInputElement);
    if (registration === undefined) return;
    if (event.type === 'input' && registration.control.type !== 'color') return;
    if (event.type === 'keydown') {
      if (registration.control.type === 'color') return;
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'Enter' || keyboardEvent.isComposing) return;
      keyboardEvent.preventDefault();
    }
    this.commit_abyssPrivate(registration);
  }

  flush(): void {
    for (const registration of this.registrations_abyssPrivate.values()) {
      this.commit_abyssPrivate(registration);
    }
  }

  dispose(): void {
    const root = this.root_abyssPrivate;
    root.removeEventListener('input', this);
    root.removeEventListener('change', this);
    root.removeEventListener('blur', this, true);
    root.removeEventListener('keydown', this);
    this.ownerWindow_abyssPrivate?.removeEventListener('blur', this.flushWindow_abyssPrivate);
    this.registrations_abyssPrivate.clear();
  }

  private commit_abyssPrivate(registration: RegisteredValueCommit): void {
    if (registration.control.value === registration.committedValue) return;
    const committedValue = registration.committedValue;
    registration.committedValue = registration.control.value;
    const accepted = registration.commit();
    registration.committedValue = accepted === false ? committedValue : registration.control.value;
  }
}
