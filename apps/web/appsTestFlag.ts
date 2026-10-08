import type { Plugin } from "vite";

/** The client a build makes: the web app (apps/web), Desktop's UI (apps/ui, inside `tauri build`) or the extension. */
export type AppsTestBuild = "web" | "desktop" | "extension";

/**
 * VITE_APPS_TEST=1 makes the e2e suite's build: mini-apps on in the engine (apps/web/src/host.ts, and Desktop's
 * apps/ui/src/desktop/host.ts with its test store fetcher appsTestFetch) and the test hook that runs one through the
 * real runner and broker (apps/ui/src/lib/apps/testHook.ts). It is read when the build is made, never at runtime.
 * Only "1" or nothing, and never in a build that ships:
 * - an image build (GHOSTLY_BUILD, which is what gets deployed: apps/web/Dockerfile also empties it);
 * - a Desktop build that is not a debug one. The Tauri CLI sets TAURI_ENV_DEBUG="true" for its build command only
 *   with `tauri build --debug` (every e2e build of Desktop) and `tauri dev`; a release `tauri build` sets none at all,
 *   so anything but "true" is refused, a bare `vite build apps/ui` included;
 * - the extension, which has no e2e build with mini-apps.
 * The release workflow also empties it for the Desktop and extension builds (.github/workflows/release.yml).
 */
export function checkAppsTestFlag(env: Record<string, string | undefined>, build: AppsTestBuild): boolean {
  const flag = env.VITE_APPS_TEST;
  if (flag === undefined || flag === "") return false;
  if (flag !== "1") throw new Error(`VITE_APPS_TEST is "1" or unset, not ${JSON.stringify(flag)}`);
  if (env.GHOSTLY_BUILD) throw new Error("VITE_APPS_TEST is for the e2e suite's build: an image build (GHOSTLY_BUILD) must not carry it");
  if (build === "extension") throw new Error("VITE_APPS_TEST is for the e2e suite's web and Desktop builds: an extension build must not carry it");
  if (build === "desktop" && env.TAURI_ENV_DEBUG !== "true") {
    throw new Error("VITE_APPS_TEST is for the e2e suite's build: a Desktop release build (anything but tauri build --debug or tauri dev) must not carry it");
  }
  return true;
}

/** What the build compiles in: `config.env` holds what `import.meta.env` will, a .env file at the env directory included. */
export function buildAppsTestEnv(configEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...process.env, VITE_APPS_TEST: configEnv.VITE_APPS_TEST };
}

/**
 * The check as a Vite plugin, on the env the build compiles in, so a VITE_APPS_TEST from a .env file at the env
 * directory (the repository root) counts as one from the shell does.
 */
export function appsTestGuard(build: AppsTestBuild): Plugin {
  return {
    name: "ghostly-apps-test-guard",
    configResolved(config) {
      checkAppsTestFlag(buildAppsTestEnv(config.env), build);
    },
  };
}
