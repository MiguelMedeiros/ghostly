/**
 * A small stand-in for the `chrome.*` API the extension uses, faithful where the
 * code depends on it:
 *
 * - `runtime.sendMessage` reaches every `onMessage` listener; the first one to
 *   call `sendResponse` answers, a listener keeps the channel open only by
 *   returning `true`, and nobody answering rejects the way Chrome does.
 * - Listeners remember which context registered them (`background`,
 *   `offscreen`, `page`), so a service-worker restart drops exactly the
 *   worker's listeners and in-memory state while `storage.session`, tabs and
 *   the offscreen document live on — as in Chrome.
 * - `offscreen.createDocument` runs the hook the test gives it, which loads the
 *   offscreen module in the `offscreen` context; `offscreen.closeDocument` fires
 *   its `pagehide`, drops its listeners, disconnects the ports it answered and
 *   releases the Web Locks it held, as a closed page does.
 * - `storage.session.onChanged` fires for every change, in the listeners of every context, as Chrome's.
 * - `localStorage` and `navigator.locks` are the origin's: every context shares
 *   them, as the extension's pages and its offscreen document do.
 *
 * Everything the extension asks of the browser is recorded in `calls`.
 */

export type Context = "background" | "offscreen" | "page";

type Listener = (...args: never[]) => unknown;

export class FakeEvent<L extends Listener = Listener> {
  readonly listeners: { context: Context; fn: L }[] = [];
  constructor(private readonly world: FakeWorld) {}
  addListener(fn: L): void {
    this.listeners.push({ context: this.world.context, fn });
  }
  removeListener(fn: L): void {
    const index = this.listeners.findIndex((l) => l.fn === fn);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  hasListener(fn: L): boolean {
    return this.listeners.some((l) => l.fn === fn);
  }
  hasListeners(): boolean {
    return this.listeners.length > 0;
  }
  /** Calls every listener in its own context (what it registers belongs there), and returns what each returned. */
  dispatch(...args: Parameters<L>): unknown[] {
    return [...this.listeners].map((l) => {
      const previous = this.world.context;
      this.world.context = l.context;
      try {
        return l.fn(...args);
      } finally {
        this.world.context = previous;
      }
    });
  }
  dropContext(context: Context): void {
    for (let i = this.listeners.length - 1; i >= 0; i--) if (this.listeners[i].context === context) this.listeners.splice(i, 1);
  }
}

export interface FakePort {
  name: string;
  onMessage: FakeEvent<(message: unknown) => void>;
  onDisconnect: FakeEvent<() => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
  /** Messages this end posted. */
  posted: unknown[];
  peer?: FakePort;
  /** Who opened it, on the end `onConnect` hands out. */
  sender?: chrome.runtime.MessageSender;
}

export interface Tab {
  id: number;
  url: string;
  windowId: number;
  active?: boolean;
  /** Its DevTools target (`debugger.getTargets`): the same while the tab lives, whatever it shows; a new one each browser run. */
  targetId?: string;
}

export interface FakeWorld {
  context: Context;
  chrome: typeof chrome;
  calls: { api: string; args: unknown[] }[];
  session: Map<string, unknown>;
  /** `storage.local`: unlike `storage.session`, it outlives a reload of the extension. */
  local: Map<string, unknown>;
  tabs: Map<number, Tab>;
  offscreenDocument: boolean;
  /** Runs when `offscreen.createDocument` is called; loads the offscreen module. */
  onCreateDocument: () => Promise<void>;
  /** Makes the next `debugger.attach` fail, as it does when DevTools is already attached. */
  failDebuggerAttach: string | null;
  manifest: chrome.runtime.Manifest;
  permissionsGranted: boolean;
  /** The host patterns Chrome holds for the extension now: a granted `permissions.request` adds, `permissions.remove` takes away. */
  hostAccess: Set<string>;
  webAuthFlow: (url: string) => Promise<string | undefined>;
  updateCheck: { status: string; version?: string };
  /** Every `event` object, so a restart can drop one context's listeners. */
  events: FakeEvent[];
  /** Loads a module as `context` would: listeners registered while it runs belong to that context. */
  load<T>(context: Context, importer: () => Promise<T>): Promise<T>;
  /** Chrome stops an idle service worker: its listeners and memory go, everything else stays. */
  restartServiceWorker(): void;
  callsTo(api: string): unknown[][];
  /**
   * `runtime.sendMessage` as `sender` sent it. `sendMessage` itself sends as the context calling it:
   * the app page (`app.html`), the offscreen document or the worker, all with the extension's id.
   */
  sendMessageFrom(sender: chrome.runtime.MessageSender, message: unknown): Promise<unknown>;
  /** `runtime.connect` as `sender` opened it; `connect` itself opens as the context calling it. */
  connectFrom(sender: chrome.runtime.MessageSender, name: string): FakePort;
  /** Each `runtime.connect`: the caller's end and the end `onConnect` handed out. */
  ports: { caller: FakePort; receiver: FakePort }[];
  /** The offscreen document's window events. */
  page: EventTarget;
  /** The system's list: the notifications shown and not taken back, by id. */
  notices: Map<string, unknown>;
  /**
   * The person grants the optional "notifications" permission: `chrome.notifications` appears in every context, and
   * `permissions.onAdded` fires. Until then it is undefined, as in Chrome.
   */
  grantNotifications(): void;
  /**
   * The person turns off the extension's site access to a host (`chrome://extensions` → Site access, or the puzzle
   * menu): Chrome drops the pattern and fires `permissions.onRemoved`, as it does for the extension's own `remove`.
   */
  revokeHostAccess(pattern: string): void;
  /** The origin's localStorage, shared by every context. */
  storage: Map<string, string>;
  /** Web Locks held now, by name, with the context holding each. */
  locks: Map<string, Context>;
  /** `chrome.alarms` set now, by name: they outlive the worker, as Chrome's do. */
  alarms: Map<string, { periodInMinutes?: number }>;
  /** Chrome fires alarm `name`, as it does when its time comes (it starts a stopped worker for it). */
  fireAlarm(name: string): void;
  /**
   * The offscreen document goes away by itself (its renderer crashed, or it was ended from Chrome's task manager): the
   * worker is not told, and nothing of it runs any more.
   */
  endOffscreen(): void;
}

export function installFakeChrome(manifest: chrome.runtime.Manifest): FakeWorld {
  let nextTabId = 100;
  const world = {
    context: "page" as Context,
    calls: [] as FakeWorld["calls"],
    session: new Map<string, unknown>(),
    local: new Map<string, unknown>(),
    tabs: new Map<number, Tab>(),
    offscreenDocument: false,
    onCreateDocument: async () => {},
    failDebuggerAttach: null as string | null,
    manifest,
    permissionsGranted: true,
    hostAccess: new Set<string>(),
    webAuthFlow: async (url: string) => `${url}#answer`,
    updateCheck: { status: "no_update" } as { status: string; version?: string },
    events: [] as FakeEvent[],
    ports: [] as FakeWorld["ports"],
  } as FakeWorld;

  const event = <L extends Listener>() => {
    const e = new FakeEvent<L>(world);
    world.events.push(e as unknown as FakeEvent);
    return e;
  };
  const record = (api: string, ...args: unknown[]) => world.calls.push({ api, args });
  const area = (items: Map<string, unknown>, onChanged = event<(changes: Record<string, chrome.storage.StorageChange>) => void>()) => ({
    onChanged,
    /** One key, or every item (`null`), as Chrome's. */
    async get(key: string | null) {
      if (key === null) return Object.fromEntries([...items].map(([k, value]) => [k, structuredClone(value)]));
      return items.has(key) ? { [key]: structuredClone(items.get(key)) } : {};
    },
    async set(values: Record<string, unknown>) {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: items.get(key), newValue: structuredClone(value) };
        items.set(key, structuredClone(value));
      }
      onChanged.dispatch(changes as never);
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (items.has(key)) changes[key] = { oldValue: items.get(key) };
        items.delete(key);
      }
      if (Object.keys(changes).length) onChanged.dispatch(changes as never);
    },
  });

  const onMessage = event<(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => boolean | undefined>();
  const onConnect = event<(port: FakePort) => void>();

  /** Who a context's own `sendMessage` and `connect` come from: the extension, at that context's page. */
  function ownSender(): chrome.runtime.MessageSender {
    const page = world.context === "offscreen" ? "offscreen.html" : world.context === "background" ? "background.js" : "app.html";
    return { id: chromeApi.runtime.id, url: chromeApi.runtime.getURL(page) };
  }

  function makePort(name: string): FakePort {
    const port: FakePort = {
      name,
      onMessage: new FakeEvent(world),
      onDisconnect: new FakeEvent(world),
      posted: [],
      postMessage(message) {
        port.posted.push(message);
        // Structured clone, like the real channel: nothing shared by reference.
        const copy = structuredClone(message);
        queueMicrotask(() => port.peer?.onMessage.dispatch(copy as never));
      },
      disconnect() {
        const peer = port.peer;
        port.peer = undefined;
        if (peer) {
          peer.peer = undefined;
          queueMicrotask(() => peer.onDisconnect.dispatch());
        }
      },
    };
    return port;
  }

  const chromeApi = {
    runtime: {
      id: "nbedaagicniejlmfcncndfjcejaidbcf",
      lastError: undefined,
      onMessage,
      onConnect,
      onMessageExternal: event(),
      onConnectExternal: event(),
      onStartup: event(),
      onInstalled: event(),
      onUpdateAvailable: event<(details: { version: string }) => void>(),
      getManifest: () => world.manifest,
      getURL: (path: string) => `chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf/${path}`,
      sendMessage(message: unknown): Promise<unknown> {
        return world.sendMessageFrom(ownSender(), message);
      },
      connect({ name }: { name: string }) {
        return world.connectFrom(ownSender(), name);
      },
      requestUpdateCheck: async () => {
        record("runtime.requestUpdateCheck");
        return world.updateCheck;
      },
      reload: () => record("runtime.reload"),
      ContextType: { TAB: "TAB", OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      /** The extension's own pages, which it sees without the `tabs` permission: here, the tabs on one of its URLs. */
      async getContexts({ contextTypes }: { contextTypes?: string[] }) {
        if (contextTypes && !contextTypes.includes("TAB")) return [];
        const own = chromeApi.runtime.getURL("");
        return [...world.tabs.values()]
          .filter((tab) => tab.url.startsWith(own))
          .map((tab) => ({ contextType: "TAB", tabId: tab.id, windowId: tab.windowId, documentUrl: tab.url, frameId: 0 }));
      },
    },
    offscreen: {
      Reason: { WEB_RTC: "WEB_RTC" },
      hasDocument: async () => world.offscreenDocument,
      async createDocument(options: unknown) {
        record("offscreen.createDocument", options);
        if (world.offscreenDocument) throw new Error("Only a single offscreen document may be created.");
        world.offscreenDocument = true;
        await world.onCreateDocument();
      },
      async closeDocument() {
        record("offscreen.closeDocument");
        if (!world.offscreenDocument) throw new Error("No current offscreen document.");
        closeOffscreen();
      },
    },
    storage: { session: area(world.session), local: area(world.local) },
    tabs: {
      onRemoved: event<(tabId: number) => void>(),
      async create({ url }: { url: string }) {
        record("tabs.create", url);
        const tab: Tab = { id: nextTabId++, url, windowId: 1 };
        world.tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId: number, props: Partial<Tab>) {
        record("tabs.update", tabId, props);
        const tab = world.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        Object.assign(tab, props);
        return { ...tab };
      },
      /** Without the `tabs` permission (the manifest has none) Chrome hides every tab's URL: asking by URL finds nothing. */
      async query({ url }: { url?: string }) {
        if (url !== undefined) return [];
        return [...world.tabs.values()].map(({ url: _hidden, ...tab }) => ({ ...tab }));
      },
      async remove(tabId: number) {
        record("tabs.remove", tabId);
        world.tabs.delete(tabId);
        chromeApi.tabs.onRemoved.dispatch(tabId as never);
      },
    },
    windows: {
      async update(windowId: number, props: unknown) {
        record("windows.update", windowId, props);
      },
    },
    action: { onClicked: event<() => void>() },
    alarms: {
      onAlarm: event<(alarm: { name: string }) => void>(),
      /** One with the same name takes the place of the one before. */
      async create(name: string, info: { periodInMinutes?: number }) {
        record("alarms.create", name, info);
        world.alarms.set(name, { ...info });
      },
      async get(name: string) {
        const alarm = world.alarms.get(name);
        return alarm ? { name, scheduledTime: 0, ...alarm } : undefined;
      },
    },
    debugger: {
      onEvent: event<(source: chrome.debugger.Debuggee, method: string, params?: object) => void>(),
      onDetach: event<(source: chrome.debugger.Debuggee, reason: string) => void>(),
      async attach(target: chrome.debugger.Debuggee, version: string) {
        record("debugger.attach", target, version);
        if (world.failDebuggerAttach) throw new Error(world.failDebuggerAttach);
      },
      async detach(target: chrome.debugger.Debuggee) {
        record("debugger.detach", target);
      },
      async sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object) {
        record("debugger.sendCommand", target, method, params);
        return {};
      },
      /** Every tab's page, at its URL: the `debugger` permission sees them all, `tabs` or not. */
      async getTargets() {
        return [...world.tabs.values()].map((tab) => ({
          type: "page",
          id: (tab.targetId ??= crypto.randomUUID()),
          tabId: tab.id,
          url: tab.url,
          title: "",
          attached: false,
        }));
      },
    },
    notifications: undefined as unknown,
    permissions: {
      onAdded: event<(permissions: chrome.permissions.Permissions) => void>(),
      onRemoved: event<(permissions: chrome.permissions.Permissions) => void>(),
      async contains({ permissions, origins }: chrome.permissions.Permissions) {
        return (permissions ?? []).every((p) => p === "notifications" && chromeApi.notifications !== undefined) && (origins ?? []).every((o) => world.hostAccess.has(o));
      },
      async request(request: chrome.permissions.Permissions) {
        record("permissions.request", request);
        if (world.permissionsGranted) for (const origin of request.origins ?? []) world.hostAccess.add(origin);
        return world.permissionsGranted;
      },
      async remove(request: chrome.permissions.Permissions) {
        record("permissions.remove", request);
        const held = (request.origins ?? []).every((origin) => world.hostAccess.has(origin));
        const gone = (request.origins ?? []).filter((origin) => world.hostAccess.delete(origin));
        if (gone.length) chromeApi.permissions.onRemoved.dispatch({ permissions: [], origins: gone } as never);
        return held;
      },
      async getAll() {
        return { permissions: chromeApi.notifications === undefined ? [] : ["notifications"], origins: [...world.hostAccess] };
      },
    },
    identity: {
      async launchWebAuthFlow(details: { url: string; interactive: boolean }) {
        record("identity.launchWebAuthFlow", details);
        return world.webAuthFlow(details.url);
      },
    },
  };

  world.notices = new Map();
  const onClicked = event<(id: string) => void>();
  world.grantNotifications = () => {
    chromeApi.notifications = {
      onClicked,
      async create(id: string, options: unknown) {
        record("notifications.create", id, options);
        world.notices.set(id, options);
        return id;
      },
      async clear(id: string) {
        record("notifications.clear", id);
        return world.notices.delete(id);
      },
      async getAll() {
        return Object.fromEntries([...world.notices.keys()].map((id) => [id, true]));
      },
    };
    chromeApi.permissions.onAdded.dispatch({ permissions: ["notifications"] } as never);
  };
  world.revokeHostAccess = (pattern) => {
    if (!world.hostAccess.delete(pattern)) return;
    chromeApi.permissions.onRemoved.dispatch({ permissions: [], origins: [pattern] } as never);
  };

  world.chrome = chromeApi as unknown as typeof chrome;
  // One load at a time: the worker starts the peer as it loads, and the document's script loading inside the worker's
  // load would take the worker's context back as its own when it ends.
  let loading: Promise<unknown> = Promise.resolve();
  world.load = (context, importer) => {
    const run = loading.then(async () => {
      const previous = world.context;
      world.context = context;
      try {
        return await importer();
      } finally {
        world.context = previous;
      }
    });
    loading = run.catch(() => {});
    return run;
  };
  world.restartServiceWorker = () => {
    for (const e of world.events) e.dropContext("background");
  };
  world.alarms = new Map();
  world.fireAlarm = (name) => {
    if (world.alarms.has(name)) chromeApi.alarms.onAlarm.dispatch({ name } as never);
  };
  world.endOffscreen = () => {
    if (world.offscreenDocument) closeOffscreen();
  };
  world.callsTo = (api) => world.calls.filter((c) => c.api === api).map((c) => c.args);
  world.connectFrom = (sender, name) => {
    record("runtime.connect", name);
    const mine = makePort(name);
    const theirs = makePort(name);
    theirs.sender = { ...sender };
    mine.peer = theirs;
    theirs.peer = mine;
    world.ports.push({ caller: mine, receiver: theirs });
    onConnect.dispatch(theirs as never);
    return mine;
  };
  world.sendMessageFrom = (sender, message) => {
    record("runtime.sendMessage", message);
    return new Promise((resolve, reject) => {
      if (!onMessage.hasListeners()) {
        reject(new Error("Could not establish connection. Receiving end does not exist."));
        return;
      }
      let answered = false;
      const sendResponse = (response: unknown) => {
        if (answered) return;
        answered = true;
        resolve(structuredClone(response));
      };
      const kept = onMessage.dispatch(structuredClone(message) as never, { ...sender } as never, sendResponse as never).some((r) => r === true);
      if (!kept && !answered) reject(new Error("The message port closed before a response was received."));
    });
  };

  // The offscreen document is a page: it listens for its own `pagehide`.
  const page = new EventTarget();
  world.page = page;
  const windowListeners: { context: Context; type: string; fn: EventListenerOrEventListenerObject }[] = [];

  world.storage = new Map();
  const localStorage = {
    get length() { return world.storage.size; },
    key: (index: number) => [...world.storage.keys()][index] ?? null,
    getItem: (key: string) => world.storage.get(key) ?? null,
    setItem: (key: string, value: string) => void world.storage.set(key, String(value)),
    removeItem: (key: string) => void world.storage.delete(key),
    clear: () => world.storage.clear(),
  };

  world.locks = new Map();
  const waiting: { name: string; context: Context; grant: () => void }[] = [];
  const release = (name: string) => {
    world.locks.delete(name);
    const next = waiting.findIndex((w) => w.name === name);
    if (next >= 0) waiting.splice(next, 1)[0].grant();
  };
  const locks = {
    request(name: string, callback: () => Promise<unknown>) {
      const context = world.context;
      return new Promise((resolve, reject) => {
        const grant = () => {
          world.locks.set(name, context);
          Promise.resolve(callback()).then(resolve, reject).finally(() => { if (world.locks.get(name) === context) release(name); });
        };
        if (world.locks.has(name)) waiting.push({ name, context, grant });
        else grant();
      });
    },
    query: async () => ({ held: [...world.locks.keys()].map((name) => ({ name })), pending: waiting.map((w) => ({ name: w.name })) }),
  };

  function closeOffscreen(): void {
    page.dispatchEvent(new Event("pagehide"));
    for (const e of world.events) e.dropContext("offscreen");
    for (let i = windowListeners.length - 1; i >= 0; i--) {
      const l = windowListeners[i];
      if (l.context !== "offscreen") continue;
      page.removeEventListener(l.type, l.fn);
      windowListeners.splice(i, 1);
    }
    for (const { receiver } of world.ports) {
      if (!receiver.onMessage.listeners.some((l) => l.context === "offscreen")) continue;
      receiver.onMessage.dropContext("offscreen");
      receiver.onDisconnect.dropContext("offscreen");
      receiver.disconnect();
    }
    for (const [name, context] of [...world.locks]) if (context === "offscreen") release(name);
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].context === "offscreen") waiting.splice(i, 1);
    world.offscreenDocument = false;
  }

  Object.assign(globalThis, {
    chrome: world.chrome,
    localStorage,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      windowListeners.push({ context: world.context, type, fn });
      page.addEventListener(type, fn);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      const index = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (index >= 0) windowListeners.splice(index, 1);
      page.removeEventListener(type, fn);
    },
  });
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  return world;
}

/** Fires one of the fake's `chrome.*` events, typed as Chrome's (which have no way to fire). */
export function fire(event: unknown, ...args: unknown[]): unknown[] {
  return (event as FakeEvent).dispatch(...(args as never[]));
}

/** Lets queued promise callbacks and microtasks run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
