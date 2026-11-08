type Placement = readonly [HTMLElement, readonly HTMLElement[]];
interface LayoutChange {
  readonly before: readonly HTMLElement[];
  readonly after: readonly HTMLElement[];
}
function changes(placements: readonly Placement[]): LayoutChange[] {
  return placements.flatMap(([host, after]) => {
    const before = [...host.children] as HTMLElement[];
    return before.length === after.length &&
      before.every((element, index) => element === after[index])
      ? []
      : [{ before, after }];
  });
}
/** Q opts in. No geometry is read for an unchanged retained order; work is capped per commit. */
export class TaskTreeMotion {
  private readonly animations = new Set<Animation>();
  private readonly inert = new Map<HTMLElement, boolean>();
  private generation = 0;
  private removing = false;
  private removed = false;
  private geometry = new Map<HTMLElement, DOMRect | undefined>();
  constructor(private readonly host: HTMLElement) {}
  cancel(): void {
    this.generation++;
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const [element, inert] of this.inert) element.inert = inert;
    this.inert.clear();
    this.removing = false;
    this.removed = false;
    this.geometry.clear();
  }
  before(placements: readonly Placement[], retry: () => void): boolean {
    if (
      typeof this.host.animate !== 'function' ||
      this.host.win.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return true;
    if (this.removing) return false;
    const layout = changes(placements);
    const outgoing = [
      ...new Set(
        layout.flatMap((change) => {
          const retained = new Set(change.after);
          return change.before.filter((element) => !retained.has(element));
        }),
      ),
    ].slice(0, 80);
    if (!this.removed && outgoing.length > 0) {
      this.remove(outgoing, retry);
      return false;
    }
    const elements = [...new Set(layout.flatMap((change) => change.after))].slice(0, 80);
    this.geometry = new Map(
      elements.map((element) => [
        element,
        element.isConnected ? element.getBoundingClientRect() : undefined,
      ]),
    );
    return true;
  }
  after(): void {
    for (const [element, before] of this.geometry) {
      if (before === undefined)
        this.animate(element, [
          { opacity: 0, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'none' },
        ]);
      else {
        const after = element.getBoundingClientRect(),
          x = before.left - after.left,
          y = before.top - after.top;
        if (Math.abs(x) + Math.abs(y) > 0.5)
          this.animate(element, [
            { transform: `translate(${x}px, ${y}px)` },
            { transform: 'none' },
          ]);
      }
    }
    this.geometry.clear();
    this.inert.clear();
  }
  private animate(element: HTMLElement, frames: Keyframe[]): Animation {
    const animation = element.animate(frames, { duration: 150, easing: 'ease-out' });
    this.animations.add(animation);
    void animation.finished.then(
      () => {
        this.animations.delete(animation);
      },
      () => {
        this.animations.delete(animation);
      },
    );
    return animation;
  }
  private remove(elements: readonly HTMLElement[], retry: () => void): void {
    const generation = this.generation;
    this.removing = true;
    const pending = elements.map((element) => {
      this.inert.set(element, element.inert);
      element.inert = true;
      return this.animate(element, [{ opacity: 1 }, { opacity: 0 }]).finished.catch(() => {});
    });
    const finish = (): void => {
      if (generation !== this.generation) return;
      this.removing = false;
      this.removed = true;
      retry();
    };
    void Promise.all(pending).then(finish, finish);
  }
}
