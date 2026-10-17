interface InteractionOwnerOptions<Action extends string> {
  readonly blocksShortcuts: boolean;
  readonly allowActions?: readonly Action[];
  /** Only an explicitly owned, connected surface can consume native Back. */
  readonly dismiss?: { readonly element: HTMLElement; readonly close: () => void };
}

export interface InteractionOwnershipPort<Action extends string = string> {
  acquire(options: InteractionOwnerOptions<Action>): { release(): void };
}

interface InteractionOwner<Action extends string> extends Omit<
  InteractionOwnerOptions<Action>,
  'allowActions'
> {
  readonly allowActions: ReadonlySet<Action>;
  release(): void;
}

export class InteractionRegistry<
  Action extends string,
> implements InteractionOwnershipPort<Action> {
  private readonly owners = new Set<InteractionOwner<Action>>();
  private destroyed = false;

  constructor(private readonly parent?: InteractionOwnershipPort<Action>) {}

  acquire(options: InteractionOwnerOptions<Action>): { release(): void } {
    if (this.destroyed) return { release: () => undefined };
    const parent = this.parent?.acquire(options);
    const owner: InteractionOwner<Action> = {
      ...options,
      allowActions: new Set(options.allowActions ?? []),
      release: (): void => {
        if (this.owners.delete(owner)) parent?.release();
      },
    };
    this.owners.add(owner);
    return owner;
  }

  dismissLatest(): boolean {
    for (const owner of [...this.owners].reverse()) {
      if (owner.dismiss?.element.isConnected !== true) continue;
      owner.dismiss.close();
      return true;
    }
    return false;
  }

  allows(action: Action): boolean {
    for (const owner of this.owners) {
      if (owner.blocksShortcuts && !owner.allowActions.has(action)) return false;
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const owner of this.owners) owner.release();
  }
}

export const noInteractionOwnership: InteractionOwnershipPort = {
  acquire: () => ({ release: () => undefined }),
};
