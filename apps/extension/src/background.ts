import { concatBytes, fromBase64, toBase64, utf8Encode, viewerResponseHeaders, viewerServicePolicy, withViewerPolicy } from "@ghostly/core";
import type { EngineStatus, HttpRequestReply, RuntimeMessage, ViewerPage } from "./messages";
import { fromOwnPage } from "./shared/sender";
import { parseViewerUrl, viewerUrl, VIEWER_URL_PATTERN } from "./shared/viewer";
import { rememberPendingUpdate, takePagesToReopen } from "./updates";
import { localOriginAllowed } from "./localAllowList";
import servicesEn from "../../ui/src/locales/en/services.json";

/**
 * The service worker does what only it can: keep the peer (the offscreen
 * document) alive, open the UI, and drive the viewer tabs.
 */

// -- peer lifecycle ----------------------------------------------------------

let starting: Promise<void> | null = null;

/**
 * Makes sure the peer runs, as the profile in use (WISP 04). Every caller waits on the same attempt, so
 * a switch seen by two pages at once restarts the peer once. Nothing of this lives in the worker between
 * events: the document, and the profile registry the document reads, are the state.
 */
function ensureEngine(): Promise<void> {
  if (starting) return starting;
  // Forgotten only if it is still the one in progress: a restart asked meanwhile took its place (`restartEngine`).
  const tracked: Promise<void> = startEngine().finally(() => { if (starting === tracked) starting = null; });
  starting = tracked;
  return tracked;
}

async function startEngine(): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) await createEngineDocument();
  const status = await waitForEngine();
  if (status.profile === status.active && !status.stopped) return;
  // A page made another profile the one in use. The running peer stops and its document closes before
  // the next one opens: never two peers, and never one peer over two profiles' data.
  // Or the peer stopped for good and nobody asked for the next one: the page that ran "Clear all data" went away
  // before it could (`restart-engine`), or a worker went away mid-restart. That document goes too, as after a switch.
  await replaceEngine(status.profile === status.active ? undefined : status.activeId);
}

/** Peers started one after another for switches made while each one started, before the pages are told to retry. */
const MAX_REPLACEMENTS = 20;

/** `next`: the id of the profile the new peer runs as, when a switch is what replaces it. */
async function replaceEngine(next?: string): Promise<void> {
  // A page that switched again while the next peer started (another tab's) waits on this start, and must get the
  // profile it named, not the one before: that peer goes too, as often as the registry moved (only a click moves it).
  // Should it never settle, the pages hear of it: none is told the peer runs while it runs another profile.
  for (let attempt = 0; attempt < MAX_REPLACEMENTS; attempt++) {
    // A contact's app open as the profile before is no page of the next one's: its tab closes before that peer answers.
    // One still opening (it waited on this start, or made its tab after it) counts this close too, and leaves no tab.
    viewersClosed++;
    await closeViewers();
    await clearNotices(next);
    await chrome.runtime.sendMessage({ target: "engine", type: "stop" } satisfies RuntimeMessage).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    await createEngineDocument();
    // Just made: one that does not answer is replaced at the next start (`waitForEngine`).
    const status = (await answerOf()) ?? notStarted();
    // Again: a tab still on the peer before posted one while that peer stopped. The next profile's pages wait on this start.
    await clearNotices(next);
    if (status.profile === status.active) return;
    next = status.activeId;
  }
  throw new Error("Switching profiles…");
}

/** A new peer in place of the running one, which stopped for good ("Clear all data"); after any start in progress. */
function restartEngine(): Promise<void> {
  const previous = starting ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => replaceEngine());
  const tracked: Promise<void> = next.finally(() => { if (starting === tracked) starting = null; });
  // The caller hears of a failure through `next`; this copy may have nobody else waiting on it.
  tracked.catch(() => {});
  starting = tracked;
  return next;
}

async function createEngineDocument(): Promise<void> {
  await chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification: "Ghostly keeps WebRTC connections to your peers while the browser is open.",
    })
    // A worker stopped mid-start may have created it already; that one is the peer.
    .catch(async (error) => {
      if (!(await chrome.offscreen.hasDocument())) throw error;
    });
}

/**
 * The peer's answer. A document that never gives one (its script threw as it loaded, a chunk did not load) is no peer,
 * and nothing else closes it: every later try (a page's, a new tab's, the minute check) would wait on it again. It goes,
 * and a new one is waited on before the start fails; one that does not answer either goes at the next try.
 */
async function waitForEngine(): Promise<EngineStatus> {
  const status = await answerOf();
  if (status) return status;
  await chrome.offscreen.closeDocument().catch(() => {});
  await createEngineDocument();
  return (await answerOf()) ?? notStarted();
}

function notStarted(): never {
  throw new Error("The Ghostly peer did not start. Reopen the extension to retry.");
}

/** The document exists before its script listens; wait until the peer answers, or 5 seconds. */
async function answerOf(): Promise<EngineStatus | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const status = (await chrome.runtime.sendMessage({ target: "engine", type: "ping" } satisfies RuntimeMessage)) as EngineStatus | undefined;
      if (status) return status;
    } catch {
      // nobody is listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

chrome.runtime.onStartup.addListener(() => void ensureEngine());

/**
 * The peer runs with no page open (it fetches mailbox texts that live minutes, answers contacts), so it comes back by
 * itself: each start of the worker makes sure it runs, as Chrome fires neither `onStartup` nor `onInstalled` when the
 * extension is turned on again, and an alarm wakes the worker once a minute, should the document go away with no tab
 * open (its renderer crashed, or it was ended from Chrome's task manager). Set once: setting it again puts it off.
 */
const PEER_CHECK = "peer-check";
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PEER_CHECK) void ensureEngine().catch(() => {});
});
void chrome.alarms.get(PEER_CHECK).then((alarm) => { if (!alarm) return chrome.alarms.create(PEER_CHECK, { periodInMinutes: 1 }); }).catch(() => {});
void ensureEngine().catch(() => {});

/**
 * A first install also opens the app in a tab: without it nothing showed, and a new user had to find the toolbar
 * button. The tab opens even when the peer does not start, so the page can say why. An update opens again the pages
 * "Update and restart" closed; one that came by itself opens nothing, as the person is somewhere else.
 */
chrome.runtime.onInstalled.addListener((details) => {
  const started = ensureEngine();
  if (details?.reason === "install") void started.catch(() => {}).then(() => showApp()).catch(() => {});
  else if (details?.reason === "update") void started.catch(() => {}).then(reopenAfterUpdate).catch(() => {});
  else void started.catch(() => {});
});

async function reopenAfterUpdate(): Promise<void> {
  for (const url of await takePagesToReopen()) await chrome.tabs.create({ url });
}

/**
 * Chrome has a newer version but will not swap it in while Ghostly is running,
 * and doing so would end every connection the peer holds. Remember it so the
 * UI can offer it; Chrome applies it by itself once nothing is left running.
 */
chrome.runtime.onUpdateAvailable.addListener((details) => {
  void rememberPendingUpdate(details.version);
});

// The app opens even when the peer does not start, as on a first install: the page says why.
chrome.action.onClicked.addListener(() => {
  void ensureEngine().catch(() => {}).then(() => showApp()).catch(() => {});
});

/** Brings the app's tab forward, or opens one; on `route` (`/chat/…`) when given. */
async function showApp(route?: string): Promise<void> {
  const url = chrome.runtime.getURL("app.html");
  const existing = await openAppTab(url);
  if (existing) {
    // Only the fragment changes: the page stays, and its router goes there.
    await chrome.tabs.update(existing.tabId, route ? { active: true, url: `${url}#${route}` } : { active: true });
    if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: route ? `${url}#${route}` : url });
  }
}

// -- notifications -------------------------------------------------------------

/**
 * A click on one of Ghostly's notifications. Chrome keeps one in the system's list after the page that showed it
 * closed or reloaded, and that page was the only one to know its chat (apps/ui/src/lib/notifications.ts): the page
 * still open opens its own, and for any other the worker shows the app, on the chat the page kept for it in session
 * storage (`notice:<id>`). Either way it leaves the list.
 */
async function openNotification(id: string): Promise<void> {
  void chrome.notifications.clear(id).catch(() => {});
  const key = `notice:${id}`;
  const chat = await inNoticeOrder(async () => {
    const kept: unknown = (await chrome.storage.session.get(key))[key];
    await chrome.storage.session.remove(key);
    return kept;
  });
  const owned = await chrome.runtime.sendMessage({ target: "app", type: "notification-open", id } satisfies RuntimeMessage).catch(() => false);
  if (owned === true) return;
  await ensureEngine().catch(() => {});
  await showApp(typeof chat === "string" ? chatRoute(chat) : undefined);
}

/** The app's address for a notification's chat, as the page opens it (AttentionFeedback); none for another profile's. */
function chatRoute(chat: string): string | undefined {
  if (chat.startsWith("profile:")) return undefined;
  return chat.startsWith("group:") ? `/group/${encodeURIComponent(chat.slice(6))}` : `/chat/${encodeURIComponent(chat)}`;
}

/**
 * A new peer (another profile, or the one after Clear all data): a notification the pages kept a chat for would open a
 * chat this one does not have ("This chat is gone"), so it leaves the system's list, as Desktop's and Android's do
 * (`sweepLeftOver`). Another profile's notice (`profile:<id>`) stays: that profile did not stop. One about `next`, the
 * profile now in use, goes too: its "New messages in" is read once it is open, as the pages' `clearPeek` does where a
 * notice can be taken back by its chat (useProfilePeek.ts).
 */
function clearNotices(next?: string): Promise<void> {
  return inNoticeOrder(() => clearNoticesNow(next));
}

async function clearNoticesNow(next?: string): Promise<void> {
  const kept = await chrome.storage.session.get(null).catch(() => ({}) as Record<string, unknown>);
  const gone = (chat: string) => !chat.startsWith("profile:") || (typeof next === "string" && chat === `profile:${next}`);
  const keys = Object.keys(kept).filter((key) => key.startsWith("notice:") && gone(String(kept[key])));
  if (!keys.length) return;
  await chrome.storage.session.remove(keys).catch(() => {});
  await Promise.all(keys.map((key) => chrome.notifications?.clear(key.slice("notice:".length)).catch(() => false)));
}

/**
 * The worker's reads and writes of the `notice:<id>` keys, one after another: each reads the keys, then writes, and two
 * running at once would both read before either wrote (a burst's messages, asked for in the same moment, each made a
 * notification of its own). Session storage stays what says which notification is a chat's: this order lives only as long
 * as the worker, and the next worker reads the keys afresh.
 */
let noticeWork: Promise<unknown> = Promise.resolve();

function inNoticeOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = noticeWork.catch(() => {}).then(task);
  noticeWork = run;
  return run;
}

/**
 * A notification the peer asked for, of a message no tab heard (attentionNotices.ts), with its chat kept as a page keeps
 * one's (`notice:<id>`), so a click opens it. A chat's next one takes the place of the one before, as a burst's do in a tab,
 * also when the burst's messages are asked for at once.
 */
function showNotice(body: string, chat?: string): Promise<void> {
  return inNoticeOrder(() => showNoticeNow(body, chat));
}

async function showNoticeNow(body: string, chat?: string): Promise<void> {
  if (!chrome.notifications) return;
  const kept = chat ? await chrome.storage.session.get(null).catch(() => ({}) as Record<string, unknown>) : {};
  const id = Object.keys(kept).find((key) => key.startsWith("notice:") && kept[key] === chat)?.slice("notice:".length) ?? crypto.randomUUID();
  if (chat) await chrome.storage.session.set({ [`notice:${id}`]: chat });
  await chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: "Ghostly", message: body, silent: true });
}

/** `chrome.notifications` exists only once the optional permission is granted, maybe while the worker runs. */
function listenToNotifications(): void {
  const clicks = chrome.notifications?.onClicked;
  if (clicks && !clicks.hasListener(onNotificationClicked)) clicks.addListener(onNotificationClicked);
}
const onNotificationClicked = (id: string) => void openNotification(id).catch(() => {});
listenToNotifications();
chrome.permissions.onAdded.addListener(listenToNotifications);

/**
 * The person turned off the extension's site access to a host of this machine (`chrome://extensions`, or the puzzle
 * menu): the peer stops sharing the apps there, as "Share" turned off does, until they are turned on again. Ghostly's own
 * `permissions.remove` fires this too, once no app is left at that host: then there is nothing to turn off.
 */
chrome.permissions.onRemoved.addListener(({ origins }) => {
  if (!origins?.length) return;
  void ensureEngine()
    .then(() => chrome.runtime.sendMessage({ target: "engine", type: "local-access-removed", origins } satisfies RuntimeMessage))
    .catch(() => {});
});

/**
 * A tab that shows the app already, on any of its pages (`app.html#/chat/…`). Asked of the extension's own contexts:
 * `chrome.tabs.query({ url })` needs the `tabs` permission, which Ghostly does not have, and finds nothing without it.
 */
async function openAppTab(url: string): Promise<{ tabId: number; windowId: number } | null> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
  const app = contexts.find((context) => context.tabId >= 0 && context.documentUrl?.split("#")[0] === url);
  return app ? { tabId: app.tabId, windowId: app.windowId } : null;
}

// Only the extension's own pages are heard (`fromOwnPage`).
chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.target !== "background" || !fromOwnPage(sender)) return false;
  if (message.type === "ensure-engine") {
    void ensureEngine().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message.type === "restart-engine") {
    void restartEngine().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message.type === "notify") {
    if (typeof message.body !== "string" || !message.body || (message.chat !== undefined && typeof message.chat !== "string")) return false;
    void showNotice(message.body.slice(0, 200), message.chat).catch(() => {}).then(() => sendResponse(true));
    return true;
  }
  if (message.type === "open-payment-link") {
    // Only a payment link, and only the characters one is made of: nothing else leaves the extension this way.
    const uri = typeof message.uri === "string" && /^(lightning|bitcoin|monero):[A-Za-z0-9?=&%.:_-]{1,4096}$/.test(message.uri) ? message.uri : null;
    if (!uri) { sendResponse({ ok: false, error: "Not a payment link" }); return false; }
    void chrome.tabs.create({ url: uri }).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type === "open-service") {
    // Hide my IP from contacts is on: a contact's app does not open in a tab (see "viewer" below).
    if (message.relayOnly === true) { sendResponse({ ok: false, error: RELAY_ONLY_REFUSED }); return false; }
    void openViewer(message.peerPubKeyZ32, message.serviceId, message.tag, message.profile, viewerPageOf(message.page), viewersClosed).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type === "local-access-allowed") {
    if (typeof message.profile !== "string" || typeof message.origin !== "string") { sendResponse(false); return false; }
    void localOriginAllowed(message.profile, message.origin).then((allowed) => sendResponse(allowed === true), () => sendResponse(false));
    return true;
  }
  if (message.type === "close-services") {
    viewersClosed++;
    void closeViewers().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// -- viewer --------------------------------------------------------------------
//
// A remote web application needs a real origin: relative URLs, ES modules,
// fetch/XHR, cookies and history all hang off it, and it must not share an
// origin with the extension. No such origin exists on the network, so the tab
// is pointed at a virtual one (`https://<service>.<peer>.<tag>.invalid`) and every
// request to it is answered through the DevTools protocol with the response the
// peer sent over WebRTC. Nothing else in the tab is intercepted, and no other
// tab is touched.
//
// A tab serves the one service it was opened for. The app in it is a
// contact's code: if it could reach another virtual origin, it would talk to
// another contact's app as the user. Nor may it reach the person's own
// services: every answer carries Ghostly's connection policy
// (`withViewerPolicy`), which keeps it off plain http, whatever the browser's
// own guard for local addresses allows. A top-level navigation is beyond any
// policy, and once the tab leaves the virtual origin it is no viewer any more.
//
// So no tab opens while Hide my IP from contacts is on (`RELAY_ONLY_REFUSED`):
// the app could send the tab, or a frame, to a server of the contact's, and
// Chrome connects there before any policy or DevTools refuses the page, which
// shows that server this device's address. A frame whose page's `frame-src`
// refuses it is connected to all the same (Chromium, 2026-11). Desktop's window
// never leaves the app's origin (`may_navigate` in apps/desktop/src/viewer.rs).
//
// The `debugger` permission reaches every tab, so its use is kept narrow here,
// the only place in the extension that calls `chrome.debugger`:
// - pages ask for a service (peer key and service id), never for a tab;
// - DevTools attaches only to the tab `openViewer` itself just created, and
//   every command goes to a tab with a viewer binding, which only `openViewer`
//   writes and which is forgotten once the debugger leaves the tab;
// - only the four commands the viewer needs are ever sent.

const PROTOCOL_VERSION = "1.3";

/** Why a contact's app does not open while Hide my IP from contacts is on; the app says it in its language (errorText.ts). */
const RELAY_ONLY_REFUSED = "A contact's app does not open in the browser extension while Hide my IP from contacts is on";

/** The DevTools commands a viewer tab needs. Nothing else is ever sent. */
const VIEWER_COMMANDS = new Set(["Fetch.enable", "Page.enable", "Fetch.fulfillRequest", "Fetch.failRequest"]);

/**
 * Added to Ghostly's policy on every page a viewer serves: the app opens no window or tab of its own, which would run
 * on its origin with no DevTools and no binding, so no close (lock, profile switch, Hide my IP) would reach it. The web
 * view's frame has the same flags (apps/web/src/svc/opener.ts); Desktop's viewer opens no window either.
 */
const sandboxed = (policy: string) => `${policy}; sandbox allow-scripts allow-same-origin allow-forms`;

interface PausedRequest {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    postDataEntries?: { bytes?: string }[];
  };
}

interface ViewerBinding {
  peerPubKeyZ32: string;
  serviceId: string;
  tag: string;
  /** Its error page, in the language of the page that opened it. */
  page: ViewerPage;
}

/** The English page, for a request that came without one. */
const ENGLISH_PAGE: ViewerPage = { lang: "en", dir: "ltr", unreachable: servicesEn.window.unreachable, failed: servicesEn.window.failed };

/** What the page sent, if it is a page: short texts, a language tag and a direction; else English. An app name only if short text. */
function viewerPageOf(page: unknown): ViewerPage {
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 500;
  if (typeof page !== "object" || page === null) return ENGLISH_PAGE;
  const { lang, dir, unreachable, failed, app } = page as Record<string, unknown>;
  if (typeof lang !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) || (dir !== "ltr" && dir !== "rtl") || !text(unreachable) || !text(failed)) return ENGLISH_PAGE;
  return { lang, dir, unreachable: unreachable as string, failed: failed as string, ...(text(app) ? { app: app as string } : {}) };
}

// Session storage outlives the service worker, which the browser stops whenever it is idle.
const bindingKey = (tabId: number) => `viewer:${tabId}`;

async function bindingOf(tabId: number): Promise<ViewerBinding | null> {
  const key = bindingKey(tabId);
  return ((await chrome.storage.session.get(key))[key] as ViewerBinding | undefined) ?? null;
}

const forget = (tabId: number) => chrome.storage.session.remove(bindingKey(tabId));

/**
 * The closes of every viewer so far: the pages' `close-services` (Hide my IP turned on, the lock screen) and each new
 * peer (`replaceEngine`: a switch, Clear all data). One that comes while `openViewer` makes its tab finds no binding yet,
 * or none at all while the peer starts: that open counts it and leaves no tab.
 */
let viewersClosed = 0;

chrome.tabs.onRemoved.addListener((tabId) => void forget(tabId));

/**
 * A reload of the extension (Update and restart, chrome://extensions, turned off and on) empties session storage, but a
 * viewer tab is an ordinary tab and stays open, the contact's page and script in it. So each binding is also kept in
 * `storage.local`, as the tab's DevTools targets: a target id is the tab's for as long as it lives, whatever it shows,
 * and never comes back in a later browser run, where tab ids start over. A tab still open with no binding is one of
 * those: it closes as the next worker starts, and at the latest with the next closer (`closeViewers`).
 */
chrome.storage.session.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    const tabId = boundTab(key);
    if (tabId === null) continue;
    void (newValue === undefined ? chrome.storage.local.remove(key) : rememberTargets(tabId)).catch(() => {});
  }
});

/** The tab a binding's key names, or null for any other key. */
function boundTab(key: string): number | null {
  const match = /^viewer:(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
}

async function rememberTargets(tabId: number): Promise<void> {
  const targets = (await chrome.debugger.getTargets()).filter((target) => target.tabId === tabId).map((target) => target.id);
  if (targets.length) await chrome.storage.local.set({ [bindingKey(tabId)]: targets });
}

async function closeLeftoverViewers(): Promise<void> {
  try {
    const kept = await chrome.storage.local.get(null);
    const targets = await chrome.debugger.getTargets();
    const unbound = async (tabId: number) => !(await bindingOf(tabId));
    // A tab still at a contact's app address with no binding is one too, recorded or not.
    const leftovers = new Set(targets.filter((target) => target.tabId !== undefined && parseViewerUrl(target.url)).map((target) => target.tabId!));
    for (const key of Object.keys(kept)) {
      const tabId = boundTab(key);
      if (tabId === null) continue;
      const ids = kept[key];
      if (Array.isArray(ids) && targets.some((target) => target.tabId === tabId && ids.includes(target.id))) leftovers.add(tabId);
      // A live viewer's record stays; any other is used up here (its tab closes, or it is long gone).
      if (!(await unbound(tabId))) continue;
      await chrome.storage.local.remove(key);
    }
    for (const tabId of leftovers) if (await unbound(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
  } catch {
    // No target list now: the next start or closer tries again, and the records stay for it.
  }
}
void closeLeftoverViewers();

/**
 * Closes every viewer tab, as Desktop closes a contact's app windows (`close_service_windows`): on a profile switch,
 * a new peer, or the lock screen. Its binding goes first, so nothing it still asks for is served.
 */
async function closeViewers(): Promise<void> {
  await closeLeftoverViewers();
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async ({ id }) => {
      if (id === undefined || !(await bindingOf(id))) return;
      await forget(id);
      await chrome.debugger.detach({ tabId: id }).catch(() => {});
      await chrome.tabs.remove(id).catch(() => {});
    }),
  );
}

/** Sends one allowed command to a viewer tab; refuses any other command, and any tab without a binding. */
export async function devtools(tabId: number, method: string, params?: Record<string, unknown>): Promise<void> {
  if (!VIEWER_COMMANDS.has(method)) throw new Error(`DevTools command not allowed: ${method}`);
  if (!(await bindingOf(tabId))) throw new Error("Not a viewer tab");
  await chrome.debugger.sendCommand({ tabId }, method, params);
}

/**
 * `profile`: the page's (`EngineStatus.profile`); `closedAt`: `viewersClosed` when the page asked. The tab is only made,
 * and only shows the app, while the peer runs that profile and no close came since.
 */
async function openViewer(peerPubKeyZ32: string, serviceId: string, tag: string, profile: unknown, page: ViewerPage, closedAt: number): Promise<void> {
  const url = viewerUrl(peerPubKeyZ32, serviceId, tag);
  const parsed = parseViewerUrl(url);
  if (!parsed || parsed.serviceId !== serviceId || parsed.peerPubKeyZ32 !== peerPubKeyZ32 || parsed.tag !== tag || typeof profile !== "string") throw new Error("Invalid service");
  await ensureEngine();
  // The open ends as the tab would have, had it been made a moment sooner: closed with the others. So it does when the
  // peer it waited on is another profile's: a switch in another tab while it started, or one the document read as it
  // loaded (no peer was replaced, nothing closed). The tab is the page's profile's origin, and no other peer serves it.
  const running = async () => {
    const status = (await chrome.runtime.sendMessage({ target: "engine", type: "ping" } satisfies RuntimeMessage).catch(() => undefined)) as EngineStatus | undefined;
    return status && !status.stopped ? status.profile : undefined;
  };
  const closed = async () => viewersClosed !== closedAt || (await running()) !== profile;
  if (await closed()) return;

  // The one tab DevTools ever attaches to: the one created right here, for this service.
  const tab = await chrome.tabs.create({ url: "about:blank" });
  if (tab.id === undefined) throw new Error("Could not open a tab");
  await chrome.storage.session.set({ [bindingKey(tab.id)]: { peerPubKeyZ32, serviceId, tag, page } satisfies ViewerBinding });
  try {
    await chrome.debugger.attach({ tabId: tab.id }, PROTOCOL_VERSION);
    await devtools(tab.id, "Fetch.enable", {
      patterns: [{ urlPattern: VIEWER_URL_PATTERN, requestStage: "Request" }],
    });
    await devtools(tab.id, "Page.enable");
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    // `closeViewers` took the tab while DevTools attached to it.
    if (await closed()) return;
    throw error;
  }
  // From here on the binding is written: a close that comes later finds the tab (`closeViewers`).
  if (await closed()) {
    await forget(tab.id);
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  await chrome.tabs.update(tab.id, { url });
}

function errorPage(page: Pick<ViewerPage, "lang" | "dir">, text: string): string {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="${escape(page.lang)}" dir="${page.dir}"><meta charset="utf-8"><title>Ghostly</title>
<body style="font:16px system-ui;background:#0b0b12;color:#d8d8e8;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:32rem;padding:2rem;text-align:center">
<div style="font-size:3rem" aria-hidden="true">👻</div><h1 style="font-size:1.25rem;font-weight:500">${escape(text)}</h1></div>`;
}

const UNREACHABLE_CODES = new Set(["unreachable", "timeout", "closed", "offline", "unknown-peer"]);

async function fulfill(tabId: number, paused: PausedRequest): Promise<void> {
  const binding = await bindingOf(tabId);
  // Not a tab this worker opened, or not any more: no command goes to it. Chrome only sends events from a
  // tab the debugger is on, so letting go of it is all that is left, and its request goes on unanswered.
  if (!binding) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return;
  }
  const parsed = parseViewerUrl(paused.request.url);
  if (!parsed || parsed.peerPubKeyZ32 !== binding.peerPubKeyZ32 || parsed.serviceId !== binding.serviceId || parsed.tag !== binding.tag) {
    await devtools(tabId, "Fetch.failRequest", { requestId: paused.requestId, errorReason: "BlockedByClient" });
    return;
  }

  let bodyB64: string | null = null;
  const entries = paused.request.postDataEntries?.filter((e) => e.bytes);
  if (entries?.length === 1) bodyB64 = entries[0].bytes!;
  else if (entries && entries.length > 1) bodyB64 = toBase64(concatBytes(...entries.map((e) => fromBase64(e.bytes!))));
  else if (paused.request.postData !== undefined) bodyB64 = toBase64(utf8Encode(paused.request.postData));

  const message: RuntimeMessage = {
    target: "engine",
    type: "http-request",
    peerPubKeyZ32: parsed.peerPubKeyZ32,
    serviceId: parsed.serviceId,
    method: paused.request.method,
    path: parsed.path,
    headers: Object.entries(paused.request.headers),
    bodyB64,
    ...(binding.page.app ? { app: binding.page.app } : {}),
  };

  let reply: HttpRequestReply;
  try {
    await ensureEngine();
    // The peer may be another profile's now, or a new one: that closed this tab (`closeViewers`) and nothing goes to it.
    if (!(await bindingOf(tabId))) return;
    reply = await chrome.runtime.sendMessage(message);
    if (!reply) reply = { ok: false, code: "error", message: "The Ghostly peer did not answer" };
  } catch (error) {
    reply = { ok: false, code: "error", message: String(error) };
  }

  if (reply.ok) {
    await devtools(tabId, "Fetch.fulfillRequest", {
      requestId: paused.requestId,
      responseCode: reply.status,
      // Ghostly's policy is the header's last one, after the contact's.
      responseHeaders: withViewerPolicy(viewerResponseHeaders(reply.headers)).map(([name, value]) => ({ name, value: name === "content-security-policy" ? sandboxed(value) : value })),
      body: reply.bodyB64,
    });
    return;
  }

  const gone = UNREACHABLE_CODES.has(reply.code);
  // As on the Desktop: the person reads a sentence in their language, the engine's English goes to the console.
  if (!gone && !reply.shown) console.warn("Service request failed:", reply.code, reply.message);
  const { page } = binding;
  // The contact's machine answered in place of their app: the peer said why, from this side (viewerWords.ts).
  const html = reply.shown ? errorPage(reply.shown, reply.shown.text) : errorPage(page, gone ? page.unreachable : page.failed);
  await devtools(tabId, "Fetch.fulfillRequest", {
    requestId: paused.requestId,
    responseCode: reply.status ?? (gone ? 503 : 502),
    responseHeaders: [
      { name: "content-type", value: "text/html; charset=utf-8" },
      { name: "cache-control", value: "no-store" },
      { name: "x-ghostly-error", value: reply.code },
      { name: "content-security-policy", value: sandboxed(viewerServicePolicy(false)) },
    ],
    body: toBase64(utf8Encode(html)),
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const { tabId } = source;
  if (tabId === undefined) return;

  if (method === "Fetch.requestPaused") {
    fulfill(tabId, params as unknown as PausedRequest).catch(() => {
      // tab closed or debugger detached mid-request
    });
  } else if (method === "Page.frameNavigated") {
    // Once the tab leaves the virtual origin there is nothing left to serve, and it is no viewer any more.
    const { frame } = params as { frame: { parentId?: string; url: string } };
    if (frame.parentId || frame.url === "about:blank" || parseViewerUrl(frame.url)) return;
    void forget(tabId).then(() => chrome.debugger.detach({ tabId }).catch(() => {}));
  }
});

// The person cancelled Chrome's "started debugging" bar, or the tab went away: the binding goes with the debugger.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) void forget(source.tabId);
});
