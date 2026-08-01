import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The component layer's unit tests. Browser-shaped assertions (overflow,
 * computed font size, contrast) live in Playwright — see e2e/gallery.spec.ts.
 * This project covers the things a real browser cannot check better than a
 * type: glyph derivation, the quotation invariant, and the required rationale.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: false,
  },
});
