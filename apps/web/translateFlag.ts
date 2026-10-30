import type { Plugin } from "vite";
import type { AppsTestBuild } from "./appsTestFlag";

/**
 * VITE_TRANSLATE=1 puts auto-translation in chats into the build: what of it shows asks apps/ui/src/lib/translateFlag.ts.
 * It is read when the build is made, never at runtime. Only "1" or nothing. The Desktop app carries it from 1.7.0
 * (.github/workflows/release.yml sets it for the Desktop builds of a tag from TRANSLATE_FROM on), debug or release
 * alike; the first version is Desktop only, so it is refused in:
 * - an image build (GHOSTLY_BUILD; apps/web/Dockerfile also empties it, for an image built without one);
 * - the Android or iOS app: `tauri android build` builds apps/ui too, and hands it TAURI_ENV_PLATFORM="android";
 * - the extension.
 */
export function checkTranslateFlag(env: Record<string, string | undefined>, build: AppsTestBuild): boolean {
  const flag = env.VITE_TRANSLATE;
  if (flag === undefined || flag === "") return false;
  if (flag !== "1") throw new Error(`VITE_TRANSLATE is "1" or unset, not ${JSON.stringify(flag)}`);
  if (env.GHOSTLY_BUILD) throw new Error("VITE_TRANSLATE is for the Desktop app: an image build (GHOSTLY_BUILD) must not carry it");
  if (build === "extension") throw new Error("VITE_TRANSLATE is for the Desktop app: an extension build must not carry it");
  if (build === "desktop" && (env.TAURI_ENV_PLATFORM === "android" || env.TAURI_ENV_PLATFORM === "ios")) {
    throw new Error("VITE_TRANSLATE is for the Desktop app: an Android or iOS build must not carry it");
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
