import type { AppFrameEvent } from "@ghostly/core";
import type { MiniAppJson } from "@ghostly/core/miniApp";
import type { AppsPlatform } from "../../../../apps/ui/src/lib/platform";
import { engine } from "./engine";

/**
 * What the contact's app last said, per chat and chat app id, heard from the start: an app the person opens after
 * the contact did learns that the contact's side is already open (no frame says it again until the session restarts).
 */
const peers = new Map<string, { version: string }>();
const peerKey = (linkId: string, app: string) => `${linkId} ${app}`;
engine.onAppFrame((linkId, frame) => {
  if ("d" in frame) return;
  if (frame.o === "open") peers.set(peerKey(linkId, frame.app), { version: frame.v });
  else peers.delete(peerKey(linkId, frame.app));
});

/** The mini-app broker's way to the engine (WISP 1200), for a host that frames apps in its runner at `runnerUrl`. */
export function engineApps(runnerUrl: string, netRunnerUrl?: string): AppsPlatform {
  return {
    runnerUrl,
    ...(netRunnerUrl ? { netRunnerUrl } : {}),
    entry: (ref, runAnyway) => engine.call("appEntry", { ref, ...(runAnyway ? { runAnyway } : {}) }),
    file: (ref, path) => engine.call("appFile", { ref, path }),
    storage: {
      get: async (ref, scope, key) => {
        const found = await engine.call("appStorageGet", { ref, scope, key });
        return found ? { value: found.value as MiniAppJson } : null;
      },
      set: (ref, scope, key, value) => engine.call("appStorageSet", { ref, scope, key, value }),
      delete: (ref, scope, key) => engine.call("appStorageDelete", { ref, scope, key }),
      keys: (ref, scope) => engine.call("appStorageKeys", { ref, scope }),
    },
    chat: {
      open: (linkId, ref, version) => engine.call("appOpen", { linkId, ref, version }),
      close: (linkId, ref) => engine.call("appClose", { linkId, ref }),
      send: async (linkId, ref, data) => (await engine.call("appSend", { linkId, ref, data })).error,
      onFrame: (listener: (linkId: string, frame: AppFrameEvent) => void) => engine.onAppFrame(listener),
      peer: (linkId, app) => peers.get(peerKey(linkId, app)) ?? null,
    },
  };
}
