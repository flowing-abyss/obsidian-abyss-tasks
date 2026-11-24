import { isRealmHTMLElement } from '../../ui/domRealm';
import { prefersReducedMotion } from '../../ui/reducedMotion';

// CSS pixels and milliseconds. Limit coast integration after a slow paint so the
// next canonical window stays within reach; a paused renderer must not catch up in one jump.
const INTENT_PX = 4;
const MAX_SPEED = 9;
const DECAY_MS = 270;
const MAX_FRAME_MS = 40;
const RELEASE_WINDOW_MS = 120;
const STOP_SPEED = 0.04;

function keepsNativeTravel(node: HTMLElement, owner: Window): boolean {
  if (node.isContentEditable) return true;
  const style = owner.getComputedStyle(node);
  if (style.touchAction === 'none' || style.touchAction === 'pan-x') return true;
  return (
    ['auto', 'scroll'].includes(style.overflowY) &&
    (['none', 'contain'].includes(style.overscrollBehaviorY) ||
      node.scrollHeight > node.clientHeight)
  );
}

function singleContact(event: TouchEvent, ended = false): Touch | undefined {
  const contacts = ended ? event.changedTouches : event.touches;
  return event.cancelable &&
    !event.defaultPrevented &&
    contacts.length === 1 &&
    (!ended || event.touches.length === 0)
    ? contacts[0]
    : undefined;
}

function touchOrigin(
  event: TouchEvent,
  scroll: HTMLElement,
  owner: NonNullable<Document['defaultView']>,
): { first: Touch; target: GlobalEventHandlers; path: HTMLElement[] } | undefined {
  const first = singleContact(event);
  const target = event.target;
  if (first === undefined || (!isRealmHTMLElement(target) && !(target instanceof owner.SVGElement)))
    return;
  const path: HTMLElement[] = [];
  for (const node of event.composedPath()) {
    if (node === scroll) break;
    if (!isRealmHTMLElement(node)) continue;
    if (
      node.matches(
        '[data-timeline-part], input, select, textarea, [draggable="true"]:not(.abyss-task-card)',
      ) ||
      node.contentEditable === 'true' ||
      node.contentEditable === 'plaintext-only'
    )
      return;
    path.push(node);
  }
  return { first, target, path };
}

function shouldCoast(speed: number, sinceMove: number, owner: Window): boolean {
  return (
    sinceMove < RELEASE_WINDOW_MS && Math.abs(speed) > STOP_SPEED && !prefersReducedMotion(owner)
  );
}

class TaskListTravel {
  #frame: number | undefined;
  #pending = 0;
  #speed = 0;
  #coastTime: number | undefined;

  constructor(
    private readonly scroll: HTMLElement,
    private readonly owner: NonNullable<Document['defaultView']>,
    private readonly canPublish: () => boolean,
    private readonly moved: () => void,
  ) {}
  drag(delta: number): void {
    this.#pending += delta;
    this.#schedule();
  }
  coast(speed: number, time: number): void {
    this.#speed = speed;
    this.#coastTime = time;
    this.#schedule();
  }
  stop(): void {
    if (this.#frame !== undefined) this.owner.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#pending = 0;
    this.#coastTime = undefined;
  }
  #schedule(): void {
    this.#frame ??= this.owner.requestAnimationFrame(this.#paint);
  }
  readonly #paint = (now: number): void => {
    this.#frame = undefined;
    if (this.scroll.ownerDocument.defaultView !== this.owner || !this.canPublish()) {
      this.stop();
      return;
    }
    let delta = this.#pending;
    this.#pending = 0;
    if (this.#coastTime !== undefined) {
      const elapsed = Math.max(0, now - this.#coastTime);
      this.#coastTime = now;
      const nextSpeed = this.#speed * Math.exp(-elapsed / DECAY_MS);
      // Travel only the last paint interval. Momentum still decays over the full wall-clock gap.
      delta += nextSpeed * Math.expm1(Math.min(elapsed, MAX_FRAME_MS) / DECAY_MS) * DECAY_MS;
      this.#speed = nextSpeed;
    }
    const before = this.scroll.scrollTop;
    const next = Math.max(
      0,
      Math.min(this.scroll.scrollHeight - this.scroll.clientHeight, before + delta),
    );
    if (next !== before) {
      this.scroll.scrollTop = next;
      this.moved();
    }
    if (
      this.#coastTime !== undefined &&
      Math.abs(this.#speed) > STOP_SPEED &&
      (delta === 0 || this.scroll.scrollTop !== before)
    )
      this.#schedule();
  };
}

function watchContact(
  target: GlobalEventHandlers,
  move: (event: TouchEvent) => void,
  end: (event: TouchEvent) => void,
  cancel: () => void,
): () => void {
  // Touch events keep their original target even after virtual rows leave the document.
  target.addEventListener('touchmove', move, { passive: false });
  target.addEventListener('touchend', end, { passive: false });
  target.addEventListener('touchcancel', cancel);
  return () => {
    target.removeEventListener('touchmove', move);
    target.removeEventListener('touchend', end);
    target.removeEventListener('touchcancel', cancel);
  };
}

/** Keep single-finger vertical travel and the mounted Android task rows on the same paint. */
export function bindTaskListTouch(
  scroll: HTMLElement,
  canPublish: () => boolean,
  moved: () => void,
): () => void {
  const owner = scroll.ownerDocument.defaultView;
  if (owner === null) return () => {};
  const travel = new TaskListTravel(scroll, owner, canPublish, moved);
  let releaseTarget: (() => void) | undefined;
  const release = (): void => {
    releaseTarget?.();
    releaseTarget = undefined;
  };
  const stop = (): void => {
    release();
    travel.stop();
  };
  const start = (event: TouchEvent): void => {
    stop();
    const origin = touchOrigin(event, scroll, owner);
    if (origin === undefined) return;
    const { first, target, path } = origin;
    let lastY = first.clientY;
    let lastTime = event.timeStamp;
    let speed = 0;
    let vertical = false;
    const sample = (event: TouchEvent, touch: Touch | undefined): void => {
      if (touch?.identifier !== first.identifier) {
        stop();
        return;
      }
      const dy = lastY - touch.clientY;
      if (!vertical) {
        const dx = Math.abs(first.clientX - touch.clientX);
        if (Math.max(Math.abs(dy), dx) < INTENT_PX) return;
        if (Math.abs(dy) <= dx || path.some((node) => keepsNativeTravel(node, owner))) {
          stop();
          return;
        }
        vertical = true;
      }
      if (!canPublish()) {
        stop();
        return;
      }
      event.preventDefault();
      if (dy === 0) return;
      const elapsed = event.timeStamp - lastTime;
      if (elapsed > 0) speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, dy / elapsed));
      lastY = touch.clientY;
      lastTime = event.timeStamp;
      travel.drag(dy);
    };
    const move = (event: TouchEvent): void => {
      sample(event, singleContact(event));
    };
    const end = (event: TouchEvent): void => {
      // Android may coalesce the entire swipe into the final changed contact.
      sample(event, singleContact(event, true));
      const coast =
        releaseTarget !== undefined &&
        vertical &&
        shouldCoast(speed, event.timeStamp - lastTime, owner);
      release();
      if (coast) travel.coast(speed, event.timeStamp);
    };
    releaseTarget = watchContact(target, move, end, stop);
  };
  scroll.addEventListener('pointerdown', stop, true);
  scroll.addEventListener('dragstart', stop, true);
  scroll.addEventListener('touchstart', start, { passive: false });
  owner.addEventListener('blur', stop);
  return () => {
    stop();
    scroll.removeEventListener('pointerdown', stop, true);
    scroll.removeEventListener('dragstart', stop, true);
    scroll.removeEventListener('touchstart', start);
    owner.removeEventListener('blur', stop);
  };
}
