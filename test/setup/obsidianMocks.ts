import { vi } from 'vitest';

// Takes the place of obsidian-test-mocks/vitest-setup, which does both of the following in every
// suite. Every suite gets the mocked `obsidian` module. The package's setup() extends the DOM's
// prototypes and installs Obsidian's global helpers (the additions to `Array`, `String`, `Math`,
// `Number`, and `Object`, `createEl` and its family, `sleep`, `activeWindow`, a global `app`, and
// more), so it runs only where a DOM exists: a suite on the Node environment (a
// `// @vitest-environment node` first line) has none of them.
if (typeof Document === 'function') {
  const { setup } = await import('obsidian-test-mocks/setup');
  setup();
  // Connected hidden surfaces observe layout before jsdom can supply any geometry.
  // Geometry-focused suites replace these native defaults with controllable observers.
  window.ResizeObserver = class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
}
vi.mock('obsidian', async () => {
  const obsidian = await import('obsidian-test-mocks/obsidian');
  const { InspectorModalMock } = await import('../support/inspectorModalMock');
  return {
    ...obsidian,
    Modal: InspectorModalMock,
  };
});
