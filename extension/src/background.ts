import { concatBytes, fromBase64, isValidServiceId, toBase64, utf8Encode } from "@ghostly/core";
import type { HttpRequestReply, RuntimeMessage } from "./shared/rpc";
import { parseViewerUrl, viewerUrl, VIEWER_URL_PATTERN } from "./shared/viewer";

/**
 * The service worker does what only it can: keep the peer (the offscreen
 * document) alive, open the UI, and drive the viewer tabs.
 */

// -- peer lifecycle ----------------------------------------------------------

let creatingOffscreen: Promise<void> | null = null;

async function ensureEngine(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification: "Ghostly keeps WebRTC connections to your peers while the browser is open.",
    })
    .then(waitForEngine)
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

/** The document exists before its script listens; wait until the peer answers. */
async function waitForEngine(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (await chrome.runtime.sendMessage({ target: "engine", type: "ping" } satisfies RuntimeMessage)) return;
    } catch {
      // nobody is listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

chrome.runtime.onStartup.addListener(() => void ensureEngine());
chrome.runtime.onInstalled.addListener(() => void ensureEngine());

chrome.action.onClicked.addListener(async () => {
  await ensureEngine();
  const url = chrome.runtime.getURL("app.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.target !== "background") return false;
  if (message.type === "ensure-engine") {
    void ensureEngine().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message.type === "open-service") {
    void openViewer(message.peerPubKeyZ32, message.serviceId).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  return false;
});

// -- viewer --------------------------------------------------------------------
//
// A remote web application needs a real origin: relative URLs, ES modules,
// fetch/XHR, cookies and history all hang off it, and it must not share an
// origin with the extension. No such origin exists on the network, so the tab
// is pointed at a virtual one (`https://<service>.<peer>.ghostly.invalid`) and
// every request to it is answered through the DevTools protocol with the
// response the peer sent over WebRTC. Nothing else in the tab is intercepted,
// and no other tab is touched.

const PROTOCOL_VERSION = "1.3";

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

async function openViewer(peerPubKeyZ32: string, serviceId: string): Promise<void> {
  if (!isValidServiceId(serviceId)) throw new Error("Invalid service id");
  await ensureEngine();

  const tab = await chrome.tabs.create({ url: "about:blank" });
  if (tab.id === undefined) throw new Error("Could not open a tab");
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
    await chrome.debugger.sendCommand(target, "Fetch.enable", {
      patterns: [{ urlPattern: VIEWER_URL_PATTERN, requestStage: "Request" }],
    });
    await chrome.debugger.sendCommand(target, "Page.enable");
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  await chrome.tabs.update(tab.id, { url: viewerUrl(peerPubKeyZ32, serviceId) });
}

function errorPage(title: string, detail: string): string {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>Ghostly</title>
<body style="font:16px system-ui;background:#0b0b12;color:#d8d8e8;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:32rem;padding:2rem;text-align:center">
<div style="font-size:3rem">👻</div><h1 style="font-size:1.25rem">${escape(title)}</h1>
<p style="color:#8a8aa3">${escape(detail)}</p></div>`;
}

const UNREACHABLE_CODES = new Set(["unreachable", "timeout", "closed", "offline", "unknown-peer"]);

async function fulfill(target: chrome.debugger.Debuggee, paused: PausedRequest): Promise<void> {
  const parsed = parseViewerUrl(paused.request.url);
  if (!parsed) {
    await chrome.debugger.sendCommand(target, "Fetch.failRequest", { requestId: paused.requestId, errorReason: "Failed" });
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
  };

  let reply: HttpRequestReply;
  try {
    await ensureEngine();
    reply = await chrome.runtime.sendMessage(message);
    if (!reply) reply = { ok: false, code: "error", message: "The Ghostly peer did not answer" };
  } catch (error) {
    reply = { ok: false, code: "error", message: String(error) };
  }

  if (reply.ok) {
    await chrome.debugger.sendCommand(target, "Fetch.fulfillRequest", {
      requestId: paused.requestId,
      responseCode: reply.status,
      responseHeaders: reply.headers.map(([name, value]) => ({ name, value })),
      body: reply.bodyB64,
    });
    return;
  }

  const gone = UNREACHABLE_CODES.has(reply.code);
  await chrome.debugger.sendCommand(target, "Fetch.fulfillRequest", {
    requestId: paused.requestId,
    responseCode: gone ? 503 : 502,
    responseHeaders: [
      { name: "content-type", value: "text/html; charset=utf-8" },
      { name: "cache-control", value: "no-store" },
      { name: "x-ghostly-error", value: reply.code },
    ],
    body: toBase64(
      utf8Encode(
        gone
          ? errorPage("This service is not reachable", "Services exist while their ghost is online. The peer is gone, or stopped sharing.")
          : errorPage("The request failed", reply.message),
      ),
    ),
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  const target = { tabId: source.tabId };

  if (method === "Fetch.requestPaused") {
    fulfill(target, params as PausedRequest).catch(() => {
      // tab closed or debugger detached mid-request
    });
  } else if (method === "Page.frameNavigated") {
    // Once the tab leaves the virtual origin there is nothing left to serve.
    const { frame } = params as { frame: { parentId?: string; url: string } };
    if (frame.parentId || frame.url === "about:blank" || parseViewerUrl(frame.url)) return;
    chrome.debugger.detach(target).catch(() => {});
  }
});
