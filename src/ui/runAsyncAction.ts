/**
 * Starts an asynchronous UI action while keeping rejected promises observable.
 * Event listeners cannot await their handlers, so this is the shared boundary
 * between synchronous DOM events and application promises.
 */
export function runAsyncAction(action: Promise<unknown>, context: string): void {
  action.catch((error: unknown) => {
    console.error(`[abyss-tasks] ${context}`, error);
  });
}
