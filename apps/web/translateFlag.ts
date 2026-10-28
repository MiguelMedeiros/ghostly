import type { Plugin } from "vite";
import type { AppsTestBuild } from "./appsTestFlag";

/**
 * VITE_TRANSLATE=1 turns auto-translation in chats on while it is being built: what of it shows asks
 * apps/ui/src/lib/translateFlag.ts. It is read when the build is made, never at runtime. Only "1" or
 * nothing, and never in a build that ships, until the feature does (the same rule as VITE_APPS_TEST, appsTestFlag.ts):
 * - an image build (GHOSTLY_BUILD; apps/web/Dockerfile also empties it, for an image built without one);
 * - a Desktop build that is not a debug one (`tauri build --debug` and `tauri dev` set TAURI_ENV_DEBUG="true", a
 *   release `tauri build` sets none, a bare `vite build apps/ui` neither);
 * - the extension, which gets no translation in the first version.
 */
export function checkTranslateFlag(env: Record<string, string | undefined>, build: AppsTestBuild): boolean {
  const flag = env.VITE_TRANSLATE;
  if (flag === undefined || flag === "") return false;
  if (flag !== "1") throw new Error(`VITE_TRANSLATE is "1" or unset, not ${JSON.stringify(flag)}`);
  if (env.GHOSTLY_BUILD) throw new Error("VITE_TRANSLATE is for development builds until translation ships: an image build (GHOSTLY_BUILD) must not carry it");
  if (build === "extension") throw new Error("VITE_TRANSLATE is for the web and Desktop development builds: an extension build must not carry it");
  if (build === "desktop" && env.TAURI_ENV_DEBUG !== "true") {
    throw new Error("VITE_TRANSLATE is for development builds until translation ships: a Desktop release build (anything but tauri build --debug or tauri dev) must not carry it");
  }
  return true;
}

/** The check as a Vite plugin, on the env the build compiles in (a .env file at the env directory included). */
export function translateGuard(build: AppsTestBuild): Plugin {
  return {
    name: "ghostly-translate-guard",
    configResolved(config) {
      checkTranslateFlag({ ...process.env, VITE_TRANSLATE: config.env.VITE_TRANSLATE }, build);
    },
  };
}
