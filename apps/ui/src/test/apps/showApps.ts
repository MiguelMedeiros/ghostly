import { vi } from "vitest";
import { setAppOpener } from "../../lib/apps/open";
import { fakeEngine } from "../fakeEngine";

/**
 * Apps shows here from the first draw (`useAppsAvailable`): the build's flag, a runner, an opener, and a runner served
 * by the host itself as Desktop's is, so no server is asked for its policy. Undo with `hideApps`.
 */
export function showApps(): void {
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  fakeEngine.appRunnerServed = true;
  setAppOpener(vi.fn(async () => {}));
}

/** Undoes `showApps` (the engine's runner goes with its own reset). */
export function hideApps(): void {
  vi.unstubAllEnvs();
  setAppOpener(null);
}
