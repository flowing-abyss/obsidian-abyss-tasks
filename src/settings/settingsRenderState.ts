interface SettingsFocusSnapshot {
  readonly sectionTitle: string;
  readonly cardId?: string;
  readonly key: string;
  readonly ordinal: number;
  readonly control: HTMLElement;
}

interface FocusScope {
  readonly sectionTitle: string;
  readonly scope: HTMLElement;
  readonly cardId: string | undefined;
}

export interface SettingsRenderContext {
  readonly focus: SettingsFocusSnapshot | undefined;
  readonly scroller: HTMLElement | null;
  readonly scrollTop: number | undefined;
}

function isInput(element: HTMLElement): element is HTMLInputElement {
  return element.tagName === 'INPUT';
}

function isDraftControl(control: HTMLElement): control is HTMLInputElement | HTMLTextAreaElement {
  if (control.tagName === 'TEXTAREA') return true;
  return (
    isInput(control) &&
    ['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(control.type)
  );
}

function focusableElements(scope: HTMLElement): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]'),
  );
}

function focusKey(control: HTMLElement): string {
  return (
    control.getAttribute('aria-label') ??
    control.dataset['shortcutAction'] ??
    control.closest<HTMLElement>('.setting-item')?.querySelector<HTMLElement>('.setting-item-name')
      ?.textContent ??
    control.className
  );
}

function sameControl(candidate: HTMLElement, control: HTMLElement, key: string): boolean {
  return focusKey(candidate) === key && candidate.tagName === control.tagName;
}

function captureScope(active: HTMLElement): FocusScope | null {
  const section = active.closest<HTMLElement>('[data-section-title]');
  const sectionTitle = section?.dataset['sectionTitle'];
  if (section === null || sectionTitle === undefined) return null;
  const card = active.closest<HTMLElement>('[data-card-id]');
  return {
    sectionTitle,
    scope: card ?? section,
    cardId: card?.dataset['cardId'],
  };
}

function captureFocus(container: HTMLElement): SettingsFocusSnapshot | undefined {
  const active = container.doc.activeElement;
  if (active === null || !container.contains(active) || !('focus' in active)) return undefined;
  const control = active as HTMLElement;
  const capturedScope = captureScope(control);
  if (capturedScope === null) return undefined;
  const key = focusKey(control);
  const matches = focusableElements(capturedScope.scope).filter((candidate) =>
    sameControl(candidate, control, key),
  );
  const ordinal = matches.indexOf(control);
  if (ordinal < 0) return undefined;
  return {
    sectionTitle: capturedScope.sectionTitle,
    ...(capturedScope.cardId === undefined ? {} : { cardId: capturedScope.cardId }),
    key,
    ordinal,
    control,
  };
}

function findScope(container: HTMLElement, snapshot: SettingsFocusSnapshot): HTMLElement | null {
  const section = Array.from(container.querySelectorAll<HTMLElement>('[data-section-title]')).find(
    (candidate) => candidate.dataset['sectionTitle'] === snapshot.sectionTitle,
  );
  if (section === undefined) return null;
  let scope = section;
  if (snapshot.cardId !== undefined) {
    const card = Array.from(section.querySelectorAll<HTMLElement>('[data-card-id]')).find(
      (candidate) => candidate.dataset['cardId'] === snapshot.cardId,
    );
    if (card === undefined) return null;
    scope = card;
  }
  return scope;
}

function restoreFocus(
  container: HTMLElement,
  snapshot: SettingsFocusSnapshot | undefined,
): HTMLElement | null {
  if (snapshot === undefined) return null;
  const scope = findScope(container, snapshot);
  if (scope === null) return null;
  const candidates = focusableElements(scope).filter((candidate) =>
    sameControl(candidate, snapshot.control, snapshot.key),
  );
  const target = candidates[snapshot.ordinal];
  if (target === undefined) return null;
  if (isDraftControl(snapshot.control) && isDraftControl(target)) {
    target.value = snapshot.control.value;
    if (
      typeof snapshot.control.selectionStart === 'number' &&
      typeof snapshot.control.selectionEnd === 'number'
    ) {
      target.setSelectionRange(
        snapshot.control.selectionStart,
        snapshot.control.selectionEnd,
        snapshot.control.selectionDirection ?? undefined,
      );
    }
  }
  return target;
}

export function captureSettingsRenderContext(container: HTMLElement): SettingsRenderContext {
  const scroller = container.closest<HTMLElement>('.vertical-tab-content');
  return { focus: captureFocus(container), scroller, scrollTop: scroller?.scrollTop };
}

export function restoreSettingsRenderContext(
  container: HTMLElement,
  context: SettingsRenderContext,
  explicitFocus?: () => HTMLElement | null,
): void {
  const focus = explicitFocus?.() ?? restoreFocus(container, context.focus);
  focus?.focus({ preventScroll: true });
  if (context.scroller !== null && context.scrollTop !== undefined) {
    context.scroller.scrollTop = context.scrollTop;
  }
}
