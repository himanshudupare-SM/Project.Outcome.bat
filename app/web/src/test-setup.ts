import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `globals: false`, so Testing Library cannot auto-register its own teardown.
// Without this, components stay mounted between tests and leak state that
// lives outside the container — body scroll locks, portals, timers.
afterEach(() => {
  cleanup();
});
