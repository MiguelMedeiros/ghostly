/**
 * A mini-app host kept in memory, for the broker's tests and the e2e build's hook (testHook.ts): no engine, every
 * call written down with the app reference the broker gave it, so a test sees which app the broker took a request for.
 */
import type { AppFrameEvent, AppSendError } from "@ghostly/core";
import type { MiniAppJson } from "@ghostly/core/miniApp";
import type { AppsPlatform } from "../platform";

export interface MemoryHostCall {
  op: string;
  ref: string;
  scope?: string;
  linkId?: string;
  key?: string;
}

export interface MemoryHost extends AppsPlatform {
  readonly calls: MemoryHostCall[];
  /** The bundles' files, by app reference and path. */
  readonly files: Map<string, Map<string, Uint8Array>>;
  /** What each app keeps, by `<ref> <scope>`. */
  readonly stored: Map<string, Map<string, MiniAppJson>>;
  /** The data frames apps sent, as the engine would have. */
  readonly sent: { linkId: string; ref: string; data: MiniAppJson }[];
  /** A frame from the contact. */
  receive(linkId: string, frame: AppFrameEvent): void;
  /** What `chat.send` answers next (null: it went). */
  sendResult: AppSendError | null;
}

/** The chat app id this host gives an app in a chat: not the real derivation, just one per chat and app. */
export const memoryAppId = (linkId: string, ref: string) => btoa(`${linkId}|${ref}`).replace(/[^A-Za-z0-9]/g, "").padEnd(22, "A").slice(0, 22);

export function memoryHost(runnerUrl = "/app-frame.html", netRunnerUrl: string | null = "/app-frame-net.html"): MemoryHost {
  const calls: MemoryHostCall[] = [];
  const files = new Map<string, Map<string, Uint8Array>>();
  const stored = new Map<string, Map<string, MiniAppJson>>();
  const listeners = new Set<(linkId: string, frame: AppFrameEvent) => void>();
  const peers = new Map<string, { version: string }>();
  const sent: MemoryHost["sent"] = [];
  const scopeOf = (ref: string, scope: string) => {
    const key = `${ref} ${scope}`;
    let map = stored.get(key);
    if (!map) stored.set(key, (map = new Map()));
    return map;
  };
  const host: MemoryHost = {
    runnerUrl,
    ...(netRunnerUrl ? { netRunnerUrl } : {}),
    calls,
    files,
    stored,
    sent,
    sendResult: null,
    entry: async (ref) => { calls.push({ op: "entry", ref }); throw new Error("not-installed"); },
    file: async (ref, path) => {
      calls.push({ op: "file", ref, key: path });
      const bytes = files.get(ref)?.get(path);
      if (!bytes) throw new Error("not-found");
      return bytes;
    },
    storage: {
      get: async (ref, scope, key) => {
        calls.push({ op: "storage.get", ref, scope, key });
        const map = scopeOf(ref, scope);
        return map.has(key) ? { value: map.get(key)! } : null;
      },
      set: async (ref, scope, key, value) => { calls.push({ op: "storage.set", ref, scope, key }); scopeOf(ref, scope).set(key, value); },
      delete: async (ref, scope, key) => { calls.push({ op: "storage.delete", ref, scope, key }); scopeOf(ref, scope).delete(key); },
      keys: async (ref, scope) => { calls.push({ op: "storage.keys", ref, scope }); return [...scopeOf(ref, scope).keys()]; },
    },
    chat: {
      open: async (linkId, ref) => { calls.push({ op: "chat.open", ref, linkId }); return { app: memoryAppId(linkId, ref) }; },
      close: async (linkId, ref) => { calls.push({ op: "chat.close", ref, linkId }); },
      send: async (linkId, ref, data) => {
        calls.push({ op: "chat.send", ref, linkId });
        if (host.sendResult) return host.sendResult;
        sent.push({ linkId, ref, data });
        return null;
      },
      onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      peer: (linkId, app) => peers.get(`${linkId} ${app}`) ?? null,
    },
    receive(linkId, frame) {
      if (!("d" in frame)) {
        if (frame.o === "open") peers.set(`${linkId} ${frame.app}`, { version: frame.v });
        else peers.delete(`${linkId} ${frame.app}`);
      }
      for (const listener of [...listeners]) listener(linkId, frame);
    },
  };
  return host;
}
