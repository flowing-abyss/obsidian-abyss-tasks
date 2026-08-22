export interface InteractionOwnershipPort<Action extends string = string> {
  acquire(options: {
    readonly blocksShortcuts: boolean;
    readonly allowActions?: readonly Action[];
  }): { release(): void };
}

interface InteractionOwner<Action extends string> {
  readonly blocksShortcuts: boolean;
  readonly allowActions: ReadonlySet<Action>;
}

export class InteractionRegistry<
  Action extends string,
> implements InteractionOwnershipPort<Action> {
  private readonly owners = new Set<InteractionOwner<Action>>();
  private destroyed = false;

  acquire(options: {
    readonly blocksShortcuts: boolean;
    readonly allowActions?: readonly Action[];
  }): { release(): void } {
    if (this.destroyed) return { release: () => undefined };
    const owner: InteractionOwner<Action> = {
      blocksShortcuts: options.blocksShortcuts,
      allowActions: new Set(options.allowActions ?? []),
    };
    this.owners.add(owner);
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.owners.delete(owner);
      },
    };
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
    this.owners.clear();
  }
}

export const noInteractionOwnership: InteractionOwnershipPort = {
  acquire: () => ({ release: () => undefined }),
};
