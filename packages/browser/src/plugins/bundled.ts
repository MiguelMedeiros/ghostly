import type { GhostlyAdapterPlugin } from "./registry";

/**
 * The adapter plugins compiled into this build. Empty unless the build lists some: `GHOSTLY_PLUGINS`
 * names their modules (comma-separated paths from the repository root, each default-exporting a
 * `GhostlyAdapterPlugin`), and the Vite plugin in `packages/browser/vite-plugin.ts` swaps this module
 * for one that imports them. Release builds never set it; the e2e build carries the SDK example.
 */
export const BUNDLED_PLUGINS: readonly GhostlyAdapterPlugin[] = [];
