/**
 * A mini-app host kept in memory, for the broker's tests and the e2e build's hook (testHook.ts): no engine, every
 * call written down with the app reference the broker gave it, so a test sees which app the broker took a request for.
 */
import type { AppFrameEvent, AppSendError } from "@ghostly/core";
import type { MiniAppJson, MiniAppLinkedFile } from "@ghostly/core/miniApp";
import type { AppRangeAsk, AppRangesHost, AppsPlatform } from "../platform";

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
  /** What the person picks at the next `files.pick`: these files (path and bytes), or nothing (`cancelled`). */
  nextPick: { path: string; bytes: Uint8Array; modified?: number }[] | "cancel";
  /** The links each app keeps, by reference: the entry, its bytes now (a test changes them to make it `changed`). */
  readonly linked: Map<string, Map<string, { entry: MiniAppLinkedFile; bytes: Uint8Array | null }>>;
  /** The read lane: what the contact's app serves, by serve id (its bytes), as `remote.read` reads it. */
  readonly remote: Map<string, Uint8Array>;
  /** What this side's apps serve now, by serve id. */
  readonly serves: Map<string, { linkId: string; ref: string; file: string }>;
  /** What `ranges.serve` answers next (null: it serves). */
  serveResult: "not-open" | "offline" | "peer-closed" | null;
  /** The contact's app asks a range of a serve: what the broker answered. */
  askRange(linkId: string, ask: AppRangeAsk): Promise<Parameters<AppRangesHost["answer"]>[1]>;
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
  const linked: MemoryHost["linked"] = new Map();
  const remote: MemoryHost["remote"] = new Map(), serves: MemoryHost["serves"] = new Map();
  const asks = new Set<(linkId: string, ask: AppRangeAsk) => void>();
  const answers = new Map<string, (answer: Parameters<AppRangesHost["answer"]>[1]) => void>();
  let nextServe = 0;
  let nextId = 0;
  const linksOf = (ref: string) => {
    let map = linked.get(ref);
    if (!map) linked.set(ref, (map = new Map()));
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
      return bytes.slice();
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
    nextPick: "cancel",
    linked,
    linkedFiles: {
      pick: async (ref, _title, options) => {
        calls.push({ op: "files.pick", ref, key: `${options.folder ? "folder" : "files"} ${options.accept.join(",")}` });
        const picked = host.nextPick;
        host.nextPick = "cancel";
        if (picked === "cancel") throw new Error("cancelled: Nothing was picked");
        const links = linksOf(ref);
        return picked.map(({ path, bytes, modified = 1 }) => {
          const id = `link${String(nextId++).padStart(18, "0")}`;
          const entry: MiniAppLinkedFile = { id, path, size: bytes.length, modified, available: true };
          links.set(id, { entry, bytes });
          return entry;
        });
      },
      list: async (ref, _title) => { calls.push({ op: "files.list", ref }); return [...linksOf(ref).values()].map((l) => l.entry); },
      entry: async (ref, id) => { calls.push({ op: "files.entry", ref, key: id }); return linksOf(ref).get(id)?.entry ?? null; },
      read: async (ref, id, offset, length) => {
        calls.push({ op: "files.read", ref, key: id });
        const link = linksOf(ref).get(id);
        if (!link || !link.bytes) throw new Error("gone: No such file");
        if (link.bytes.length !== link.entry.size) throw new Error("changed: The file changed");
        return link.bytes.slice(offset, offset + length);
      },
      forget: async (ref, id) => {
        calls.push({ op: "files.forget", ref, key: id });
        if (id === "all") linksOf(ref).clear();
        else linksOf(ref).delete(id);
      },
    },
    remote,
    serves,
    serveResult: null,
    ranges: {
      serve: async (linkId, ref, file) => {
        calls.push({ op: "ranges.serve", ref, linkId, key: file });
        if (host.serveResult) return { error: host.serveResult };
        const serve = `serve${String(nextServe++).padStart(17, "0")}`;
        serves.set(serve, { linkId, ref, file });
        return { serve };
      },
      unserve: async (linkId, serve) => { calls.push({ op: "ranges.unserve", ref: serves.get(serve)?.ref ?? "", linkId, key: serve }); serves.delete(serve); },
      read: async (linkId, ref, serve, offset, length) => {
        calls.push({ op: "ranges.read", ref, linkId, key: serve });
        const bytes = remote.get(serve);
        return bytes ? { bytes: bytes.slice(offset, offset + length), size: bytes.length } : { error: "not-served" };
      },
      onAsk: (listener) => { asks.add(listener); return () => { asks.delete(listener); }; },
      answer: async (linkId, answer) => { answers.get(`${linkId} ${answer.app} ${answer.request}`)?.(answer); },
    },
    askRange: (linkId, ask) => new Promise((resolve) => {
      answers.set(`${linkId} ${ask.app} ${ask.request}`, resolve);
      for (const listener of [...asks]) listener(linkId, ask);
    }),
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
