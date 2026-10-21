// Runs before every test file (vitest.config.js: setupFiles).
//
// vi.waitFor polls every 50 ms and gives up after one second of the
// machine's clock. What the DOM tests wait for is promises, fake timers and
// module loading, none of which needs a second; but on a busy machine (a CI
// runner under load, a laptop running other jobs) a worker can go a second
// without the CPU, and the wait then fails with nothing wrong. Its default
// deadline is pushed out far enough that only a state that never comes
// fails it. A test that passes a timeout of its own keeps it.

import { vi } from 'vitest';

const WAIT_FOR_TIMEOUT_MS = 20_000;

const waitFor = vi.waitFor;
vi.waitFor = (callback, options = {}) => waitFor(callback, {
  timeout: WAIT_FOR_TIMEOUT_MS,
  ...(typeof options === 'number' ? { timeout: options } : options),
});
