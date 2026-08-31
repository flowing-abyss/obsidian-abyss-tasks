interface CollectionActionDescriptor<TValue> {
  readonly id: string;
  readonly label: string;
  readonly value: TValue;
  readonly icon?: string;
}

interface CollectionFieldDescriptor {
  readonly id: string;
  readonly label: string;
  readonly visible?: boolean;
}

/** Entity capabilities consumed by the single collection toolbar contract. */
export interface CollectionSchema<TFilter, TGroup, TSort> {
  readonly filterActions: readonly CollectionActionDescriptor<TFilter>[];
  readonly groupActions: readonly CollectionActionDescriptor<TGroup>[];
  readonly sortActions: readonly CollectionActionDescriptor<TSort>[];
  readonly fields?: readonly CollectionFieldDescriptor[];
}
