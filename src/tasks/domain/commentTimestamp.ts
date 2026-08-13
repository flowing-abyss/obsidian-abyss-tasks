/** A validated Atom/RFC3339 timestamp produced by the application clock. */
export type AtomDateTime = string & { readonly __atomDateTime: unique symbol };

export function atomDateTime(value: string): AtomDateTime {
  return value as AtomDateTime;
}
